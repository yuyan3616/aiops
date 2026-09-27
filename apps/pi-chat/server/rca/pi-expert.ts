import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";

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

const ROLE_TOOLS: Record<ExpertKind, readonly ObservabilityToolName[]> = {
  trace: ["get_trace_fields", "get_service_dependencies", "query_traces"],
  metrics: ["get_metric_catalog", "query_metrics"],
  log: ["get_log_fields", "query_logs"],
  "event-topology": ["get_service_dependencies", "get_topology", "query_events", "query_alerts"],
};

const ROLE_MODALITIES: Record<ExpertKind, readonly EvidenceModality[]> = {
  trace: ["trace", "topology"],
  metrics: ["metric"],
  log: ["log"],
  "event-topology": ["event", "topology", "alert"],
};

function roleLabel(role: ExpertKind): string {
  return {
    trace: "trace investigation",
    metrics: "metrics investigation",
    log: "log investigation",
    "event-topology": "event and topology investigation",
  }[role];
}

function systemPrompt(role: ExpertKind): string {
  const modalities = ROLE_MODALITIES[role].join(", ");
  return `You are a specialist SRE sub-agent for ${roleLabel(role)}.

You receive one falsifiable investigation brief from a main RCA agent. Investigate only that brief.

Rules:
- Decide your own tool sequence from the evidence you observe. Do NOT call every available tool mechanically.
- Start narrow and expand only when the current result leaves a relevant evidence gap.
- The case id is only a routing identifier. Never infer benchmark ground truth from it.
- Treat tool output as evidence; never invent telemetry, counts, timestamps, services, hosts, or raw references.
- A conclusion may cite only toolCallId values actually returned by your tool calls.
- Distinguish facts from inference. Negative evidence is a valid successful result when it directly tests a hypothesis; do not keep searching merely because you found no anomaly.
- Stop when the brief's expected outputs are answered, the path is disproven, or you are blocked.
- For metrics investigations, prefer aggregated anomaly summaries. Do not expand into a broad metric inventory after the brief can already be answered.
- Treat a baseline window as a comparison candidate, not guaranteed healthy ground truth. If the baseline already looks abnormal relative to peers, an earlier window, or the surrounding trend, explicitly report possible baseline contamination and do not use a near-1 incident/baseline ratio to rule out the hypothesis.
- Do not investigate outside notInScope.
- Your evidenceClaims modality must be one of: ${modalities}.
- Final output must be JSON only, with exactly this shape:
{
  "status": "succeeded|failed|inconclusive|blocked",
  "strength": "strong|moderate|weak|inconclusive",
  "verdict": "supports|contradicts|no-signal|mixed|inconclusive",
  "summary": "concise finding",
  "conclusions": ["1-5 direct answers to the brief"],
  "evidenceClaims": [
    {
      "toolCallId": "Cxx returned by a real tool call",
      "modality": "one allowed modality",
      "entity": "optional entity",
      "summary": "what this tool result establishes",
      "supports": ["hypothesis ids from the brief"],
      "contradicts": ["hypothesis ids from the brief"]
    }
  ],
  "candidateEntities": ["optional narrowed entities"],
  "candidateMechanism": "optional mechanism",
  "suggestedFollowUps": ["only follow-ups outside your current evidence"],
  "blockedOn": "only when status=blocked"
}

Do not include markdown fences around the final JSON.`;
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
      systemPromptOverride: () => systemPrompt(role),
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

    let metricsQueries = 0;
    let toolCallCount = 0;
    const toolDefinitions = this.tools.createPiTools({
      names: ROLE_TOOLS[role],
      execute: async (name, _toolCallId, parameters) => {
        if (role === "metrics" && name === "query_metrics") {
          if (metricsQueries >= 6) {
            throw new Error(
              "Metrics query budget reached. Finalize the finding from the observations already collected.",
            );
          }
          metricsQueries++;
        }
        toolCallCount++;
        const boundedParameters =
          name === "query_metrics"
            ? {
                ...parameters,
                topN: Math.min(
                  typeof parameters.topN === "number" ? parameters.topN : 12,
                  12,
                ),
              }
            : parameters;
        const recorded = await context.invoke(name, {
          ...boundedParameters,
          caseId: context.task.caseId,
        });
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
        await session.prompt(
          `Investigate this brief. Use tools only as needed, then return the required JSON finding.\n\n${JSON.stringify(
            prompt,
            null,
            2,
          )}`,
        );
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
          {
            toolCallCount,
            thinkingChars,
            outputChars: totalOutputChars,
            repairAttempted,
            repairSucceeded: false,
            failureReason,
            failureDetail: detail.slice(0, 1000),
          },
          sessionId,
        );
      }
    } finally {
      context.signal?.removeEventListener("abort", abort);
      unsubscribe();
      session.dispose();
    }
    const validHypotheses = new Set(context.brief.hypothesisIds);
    const validModalities = new Set(ROLE_MODALITIES[role]);
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

    return {
      sessionId,
      diagnostics: {
        toolCallCount,
        thinkingChars,
        outputChars: totalOutputChars,
        repairAttempted,
        repairSucceeded,
        ...(repairAttempted && repairSucceeded && parseFailureDetail
          ? { failureDetail: `initial parse repaired: ${parseFailureDetail.slice(0, 900)}` }
          : {}),
      },
      finding: {
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
      },
    };
  }
}
