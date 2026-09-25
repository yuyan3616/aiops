import type { AgentKind } from "../../../shared/rca-types.ts";
import type { ToolExecutionResult, ToolPlan, RcaToolName } from "../tool-gateway.ts";
import type { CaseContext } from "./task-types.ts";
import { taskError } from "./errors.ts";

const TOOLS_BY_AGENT: Record<AgentKind, ReadonlySet<RcaToolName>> = {
  log: new Set(["query_logs", "analyze_log_patterns"]),
  metric: new Set(["list_metrics", "query_metrics"]),
  trace: new Set(["search_traces", "get_trace"]),
  context: new Set(["query_events", "query_alerts", "get_topology_neighbors"]),
};

const MAX_LIMIT = 100;
const MAX_ARRAY_ITEMS = 16;
const MAX_INPUT_STRING = 1_024;
const MAX_OUTPUT_STRING = 4_000;
const MAX_OUTPUT_ARRAY = 100;
const MAX_SERIALIZED_OUTPUT = 80_000;

function boundedString(value: unknown) {
  if (typeof value !== "string") return value;
  const normalized = value.trim();
  if (normalized.length > MAX_INPUT_STRING) {
    throw taskError("TASK_TOOL_ERROR", `Tool string argument exceeds ${MAX_INPUT_STRING} characters.`);
  }
  return normalized;
}

function normalizeInputValue(value: unknown): unknown {
  if (typeof value === "string") return boundedString(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) {
      throw taskError("TASK_TOOL_ERROR", `Tool array argument exceeds ${MAX_ARRAY_ITEMS} items.`);
    }
    return value.map(normalizeInputValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalizeInputValue(item)]),
    );
  }
  return value;
}

function normalizeIsoRange(args: Record<string, unknown>, caseContext: CaseContext) {
  const caseStart = new Date(caseContext.startTime).getTime();
  const caseEnd = new Date(caseContext.endTime).getTime();
  const read = (name: "startTime" | "endTime", fallback: string) => {
    const raw = typeof args[name] === "string" && args[name] ? String(args[name]) : fallback;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      throw taskError("TASK_TOOL_ERROR", `Invalid ${name}: ${raw}`);
    }
    return parsed;
  };
  const start = read("startTime", caseContext.startTime);
  const end = read("endTime", caseContext.endTime);
  if (start.getTime() > end.getTime()) {
    throw taskError("TASK_TOOL_ERROR", "Tool query startTime must be <= endTime.");
  }
  if (start.getTime() < caseStart || end.getTime() > caseEnd) {
    throw taskError(
      "TASK_TOOL_ERROR",
      `Tool query window must stay inside the incident window ${caseContext.startTime} ~ ${caseContext.endTime}.`,
    );
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

function sanitizeOutput(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, MAX_OUTPUT_STRING);
  if (Array.isArray(value)) return value.slice(0, MAX_OUTPUT_ARRAY).map(sanitizeOutput);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sanitizeOutput(item)]),
    );
  }
  return value;
}

export class ToolGuard {
  guardInput(plan: ToolPlan, caseContext: CaseContext): ToolPlan {
    if (!TOOLS_BY_AGENT[plan.agent].has(plan.name)) {
      throw taskError("TASK_TOOL_ERROR", `${plan.agent} agent is not allowed to call ${plan.name}.`);
    }
    const args = normalizeInputValue(plan.args) as Record<string, unknown>;
    if (args.limit !== undefined) {
      const limit = Number(args.limit);
      args.limit = Number.isFinite(limit) ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit))) : MAX_LIMIT;
    }
    if (args.startTime !== undefined || args.endTime !== undefined) {
      const range = normalizeIsoRange(args, caseContext);
      args.startTime = range.start;
      args.endTime = range.end;
    }
    return { ...plan, args };
  }

  guardOutput(result: ToolExecutionResult): ToolExecutionResult {
    const guarded: ToolExecutionResult = {
      display: result.display.slice(0, MAX_OUTPUT_STRING),
      evidence: result.evidence.slice(0, MAX_OUTPUT_ARRAY).map((item) => ({
        ...item,
        summary: item.summary.slice(0, MAX_OUTPUT_STRING),
        observation: sanitizeOutput(item.observation) as Record<string, unknown>,
        entityRefs: item.entityRefs.slice(0, MAX_ARRAY_ITEMS).map((item) => item.slice(0, 512)),
      })),
    };
    for (const item of guarded.evidence) {
      if (
        !item.taskId ||
        !item.datasetTaskId ||
        !item.modality ||
        !item.source ||
        !item.summary ||
        !item.createdBy ||
        !item.timeRange?.start ||
        !item.timeRange?.end
      ) {
        throw taskError("TASK_TOOL_ERROR", "Tool output contained an invalid Evidence record.");
      }
      const evidenceStart = new Date(item.timeRange.start).getTime();
      const evidenceEnd = new Date(item.timeRange.end).getTime();
      if (Number.isNaN(evidenceStart) || Number.isNaN(evidenceEnd) || evidenceStart > evidenceEnd) {
        throw taskError("TASK_TOOL_ERROR", "Tool output contained an invalid Evidence time range.");
      }
      if (!item.rawRef.startsWith("rca100://") || /answer[_-]?key/i.test(item.rawRef)) {
        throw taskError("TASK_TOOL_ERROR", "Tool output contained an invalid rawRef.");
      }
      if (/[/\\](?:mnt|home|Users|tmp)[/\\]/.test(item.source) || /answer[_-]?key/i.test(item.source)) {
        throw taskError("TASK_TOOL_ERROR", "Tool output contained a backend filesystem path.");
      }
    }
    const serialized = JSON.stringify(guarded);
    if (serialized.length > MAX_SERIALIZED_OUTPUT) {
      throw taskError(
        "TASK_TOOL_ERROR",
        `Tool output exceeds the ${MAX_SERIALIZED_OUTPUT}-character server limit. Narrow the query.`,
      );
    }
    return guarded;
  }
}
