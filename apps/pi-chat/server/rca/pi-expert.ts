import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";

import { getParquetRuntimeDiagnostics } from "./parquet";
import {
  buildExpertSystemPrompt,
  getExpertProfile,
  normalizeFindingForProfile,
} from "./profiles/registry";
import {
  compactToolResultForAgent,
  type ObservabilityToolName,
  type ObservabilityToolRegistry,
} from "./tools";
import type {
  AgentExpertFinding,
  AgentRunDiagnostics,
  EvidenceModality,
  ExpertKind,
  Investigation,
  InvestigationBrief,
  RcaTask,
} from "./types";

export interface RecordedAgentToolExecution {
  callId: string;
  observationId?: string;
  execution: {
    result: unknown;
    summary: string;
    rawRef?: string;
  };
}

export interface PiExpertRunContext {
  investigation: Investigation;
  task: RcaTask;
  brief: InvestigationBrief;
  model?: { provider: string; id: string };
  signal?: AbortSignal;
  invoke: (
    tool: ObservabilityToolName,
    arguments_: Record<string, unknown>,
  ) => Promise<RecordedAgentToolExecution>;
  onThinking?: (delta: string) => void | Promise<void>;
}

export interface PiExpertRunResult {
  finding: AgentExpertFinding;
  sessionId: string;
  diagnostics: AgentRunDiagnostics;
}

export class PiExpertRunError extends Error {
  readonly diagnostics: AgentRunDiagnostics;
  readonly sessionId?: string;

  constructor(message: string, diagnostics: AgentRunDiagnostics, sessionId?: string) {
    super(message);
    this.name = "PiExpertRunError";
    this.diagnostics = diagnostics;
    this.sessionId = sessionId;
  }
}

function extractJson(output: string): Record<string, unknown> {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Sub-agent did not return a JSON finding");
    return JSON.parse(match[0]) as Record<string, unknown>;
  }
}

function strings(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, max);
}

function findingStatus(value: unknown): AgentExpertFinding["status"] {
  return value === "succeeded" ||
    value === "failed" ||
    value === "inconclusive" ||
    value === "blocked"
    ? value
    : "inconclusive";
}

function strength(value: unknown): AgentExpertFinding["strength"] {
  return value === "strong" ||
    value === "moderate" ||
    value === "weak" ||
    value === "inconclusive"
    ? value
    : "inconclusive";
}

function mb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}


export class PiExpertRunner {
  private readonly modelRuntime: ModelRuntime;
  private readonly tools: ObservabilityToolRegistry;

  constructor(modelRuntime: ModelRuntime, tools: ObservabilityToolRegistry) {
    this.modelRuntime = modelRuntime;
    this.tools = tools;
  }

  async run(context: PiExpertRunContext): Promise<PiExpertRunResult> {
    if (context.signal?.aborted) {
      throw new DOMException("Investigation cancelled", "AbortError");
    }

    const role = context.brief.role;
    const profile = getExpertProfile(role);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1 },
    });
    const agentDir = getAgentDir();
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => buildExpertSystemPrompt(profile, context.brief),
    });
    await resourceLoader.reload();

    const model = context.model
      ? this.modelRuntime.getModel(context.model.provider, context.model.id)
      : undefined;
    if (context.model && !model) {
      throw new Error(
        `Sub-agent model ${context.model.provider}/${context.model.id} is not available`,
      );
    }

    const parquetStart = getParquetRuntimeDiagnostics();
    let rssPeakBytes = 0;
    let heapUsedPeakBytes = 0;
    let heapTotalPeakBytes = 0;
    let externalPeakBytes = 0;
    let arrayBuffersPeakBytes = 0;
    const sampleProcessMemory = () => {
      const memory = process.memoryUsage();
      rssPeakBytes = Math.max(rssPeakBytes, memory.rss);
      heapUsedPeakBytes = Math.max(heapUsedPeakBytes, memory.heapUsed);
      heapTotalPeakBytes = Math.max(heapTotalPeakBytes, memory.heapTotal);
      externalPeakBytes = Math.max(externalPeakBytes, memory.external);
      arrayBuffersPeakBytes = Math.max(arrayBuffersPeakBytes, memory.arrayBuffers);
    };
    const runtimeDiagnostics = (
      toolCallCount: number,
      thinkingChars: number,
      outputChars: number,
      repairAttempted: boolean,
      repairSucceeded: boolean,
      failure?: Pick<AgentRunDiagnostics, "failureReason" | "failureDetail">,
    ): AgentRunDiagnostics => {
      sampleProcessMemory();
      const parquetEnd = getParquetRuntimeDiagnostics();
      return {
        toolCallCount,
        thinkingChars,
        outputChars,
        repairAttempted,
        repairSucceeded,
        rssPeakMb: mb(rssPeakBytes),
        heapUsedPeakMb: mb(heapUsedPeakBytes),
        heapTotalPeakMb: mb(heapTotalPeakBytes),
        externalPeakMb: mb(externalPeakBytes),
        arrayBuffersPeakMb: mb(arrayBuffersPeakBytes),
        parquetBatchesRead: Math.max(0, parquetEnd.batchesRead - parquetStart.batchesRead),
        parquetRowsScanned: Math.max(0, parquetEnd.rowsScanned - parquetStart.rowsScanned),
        maxConcurrentParquetScansObserved: parquetEnd.maxConcurrentScans,
        activeParquetScansAtEnd: parquetEnd.activeScans,
        ...(failure ?? {}),
      };
    };
    sampleProcessMemory();

    const perToolCalls = new Map<ObservabilityToolName, number>();
    let toolCallCount = 0;
    const toolDefinitions = this.tools.createPiTools({
      names: profile.tools,
      execute: async (name, _toolCallId, parameters) => {
        if (toolCallCount >= profile.maxToolCalls) {
          throw new Error(
            `${profile.label} tool-call budget reached. Finalize from the observations already collected.`,
          );
        }
        const toolBudget = profile.toolBudgets?.[name];
        const currentToolCalls = perToolCalls.get(name) ?? 0;
        if (toolBudget !== undefined && currentToolCalls >= toolBudget) {
          throw new Error(
            `${name} budget reached for ${profile.label}. Finalize from the observations already collected.`,
          );
        }
        perToolCalls.set(name, currentToolCalls + 1);
        toolCallCount++;
        sampleProcessMemory();
        const boundedParameters =
          name === "query_metrics"
            ? {
                ...parameters,
                topN: Math.min(
                  typeof parameters.topN === "number" ? parameters.topN : 12,
                  12,
                ),
              }
            : name === "query_traces"
              ? {
                  ...parameters,
                  topN: Math.min(
                    typeof parameters.topN === "number" ? parameters.topN : 20,
                    20,
                  ),
                }
              : parameters;
        const recorded = await context.invoke(name, {
          ...boundedParameters,
          caseId: context.task.caseId,
        });
        sampleProcessMemory();
        const compactResult = compactToolResultForAgent(name, recorded.execution.result);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  toolCallId: recorded.callId,
                  result: compactResult,
                },
                null,
                2,
              ),
            },
          ],
          details: {
            toolCallId: recorded.callId,
            summary: recorded.execution.summary,
            rawRef: recorded.execution.rawRef,
          },
        };
      },
    });

    const { session } = await createAgentSession({
      cwd: process.cwd(),
      agentDir,
      modelRuntime: this.modelRuntime,
      ...(model ? { model } : {}),
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(),
      noTools: "builtin",
      tools: toolDefinitions.map((tool) => tool.name),
      customTools: toolDefinitions,
    });

    const sessionId = session.sessionManager.getSessionId();
    let output = "";
    let totalOutputChars = 0;
    let thinkingChars = 0;
    let repairAttempted = false;
    let repairSucceeded = false;
    let parseFailure: "json_missing" | "json_invalid" | undefined;
    let parseFailureDetail: string | undefined;
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "message_update") return;
      if (event.assistantMessageEvent.type === "text_delta") {
        output += event.assistantMessageEvent.delta;
        totalOutputChars += event.assistantMessageEvent.delta.length;
      } else if (event.assistantMessageEvent.type === "thinking_delta") {
        thinkingChars += event.assistantMessageEvent.delta.length;
        void context.onThinking?.(event.assistantMessageEvent.delta);
      }
    });
    const abort = () => session.abort();
    context.signal?.addEventListener("abort", abort, { once: true });

    const prompt = {
      brief: context.brief,
      caseId: context.task.caseId,
      alert: {
        title: context.task.alert.title,
        service: context.task.alert.service,
        operation: context.task.alert.operation,
        window: context.task.alert.window,
      },
      currentHypotheses: context.investigation.hypotheses
        .filter((item) => context.brief.hypothesisIds.includes(item.id))
        .map((item) => ({
          id: item.id,
          statement: item.statement,
          status: item.status,
          supportingEvidenceIds: item.supportingEvidenceIds,
          contradictingEvidenceIds: item.contradictingEvidenceIds,
        })),
    };

    let parsed: Record<string, unknown>;
    try {
      try {
        sampleProcessMemory();
        await session.prompt(
          `Investigate this brief. Use tools only as needed, then return the required JSON finding.\n\n${JSON.stringify(
            prompt,
            null,
            2,
          )}`,
        );
        sampleProcessMemory();
        try {
          parsed = extractJson(output);
        } catch (error) {
          repairAttempted = true;
          parseFailure =
            error instanceof SyntaxError ? "json_invalid" : "json_missing";
          parseFailureDetail = error instanceof Error ? error.message : String(error);
          output = "";
          await session.prompt(
            "Your investigation work is complete. Do not call more tools. Return ONLY the required JSON finding now, using the evidence and toolCallId values already collected. Negative/no-anomaly results are valid findings. Do not restart the investigation or broaden the search.",
          );
          sampleProcessMemory();
          parsed = extractJson(output);
          repairSucceeded = true;
        }
      } catch (error) {
        const failureReason =
          context.signal?.aborted
            ? "aborted"
            : parseFailure ??
              (error instanceof SyntaxError ? "json_invalid" : "model_error");
        const detail = error instanceof Error ? error.message : String(error);
        throw new PiExpertRunError(
          detail,
          runtimeDiagnostics(
            toolCallCount,
            thinkingChars,
            totalOutputChars,
            repairAttempted,
            false,
            {
              failureReason,
              failureDetail: detail.slice(0, 1000),
            },
          ),
          sessionId,
        );
      }
    } finally {
      context.signal?.removeEventListener("abort", abort);
      unsubscribe();
      session.dispose();
    }
    const validHypotheses = new Set(context.brief.hypothesisIds);
    const validModalities = new Set(profile.modalities);
    const claims = Array.isArray(parsed.evidenceClaims) ? parsed.evidenceClaims : [];
    const evidenceClaims = claims
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map((item) => ({
        toolCallId: typeof item.toolCallId === "string" ? item.toolCallId : "",
        modality: item.modality as EvidenceModality,
        ...(typeof item.entity === "string" && item.entity.trim()
          ? { entity: item.entity.trim().slice(0, 200) }
          : {}),
        summary:
          typeof item.summary === "string" && item.summary.trim()
            ? item.summary.trim().slice(0, 1000)
            : "Evidence from the referenced tool call.",
        supports: strings(item.supports).filter((id) => validHypotheses.has(id)),
        contradicts: strings(item.contradicts).filter((id) => validHypotheses.has(id)),
      }))
      .filter(
        (claim) =>
          claim.toolCallId.length > 0 &&
          validModalities.has(claim.modality),
      );

    const verdict =
      parsed.verdict === "supports" ||
      parsed.verdict === "contradicts" ||
      parsed.verdict === "no-signal" ||
      parsed.verdict === "mixed" ||
      parsed.verdict === "inconclusive"
        ? parsed.verdict
        : "inconclusive";

    const finding: AgentExpertFinding = {
      status: findingStatus(parsed.status),
      strength: strength(parsed.strength),
      verdict,
      summary:
        typeof parsed.summary === "string" && parsed.summary.trim()
          ? parsed.summary.trim().slice(0, 1500)
          : "Sub-agent completed without a concise summary.",
      conclusions: strings(parsed.conclusions, 5),
      evidenceClaims,
      candidateEntities: strings(parsed.candidateEntities, 20),
      ...(typeof parsed.candidateMechanism === "string" && parsed.candidateMechanism.trim()
        ? { candidateMechanism: parsed.candidateMechanism.trim().slice(0, 1000) }
        : {}),
      suggestedFollowUps: strings(parsed.suggestedFollowUps, 10),
      ...(typeof parsed.blockedOn === "string" && parsed.blockedOn.trim()
        ? { blockedOn: parsed.blockedOn.trim().slice(0, 1000) }
        : {}),
    };

    return {
      sessionId,
      diagnostics: runtimeDiagnostics(
        toolCallCount,
        thinkingChars,
        totalOutputChars,
        repairAttempted,
        repairSucceeded,
        repairAttempted && repairSucceeded && parseFailureDetail
          ? { failureDetail: `initial parse repaired: ${parseFailureDetail.slice(0, 900)}` }
          : undefined,
      ),
      finding: normalizeFindingForProfile(profile, finding),
    };
  }
}
