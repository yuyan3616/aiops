import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  defineTool,
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
import { AgentUsageAccumulator, safeRuntimeDetail } from "./runtime-accounting";
import {
  compactToolResultForAgent,
  type ObservabilityToolName,
  type ObservabilityToolRegistry,
} from "./tools";
import type {
  AgentExpertFinding,
  AgentRunDiagnostics,
  AgentTermination,
  AgentUsage,
  EvidenceModality,
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
  finding?: AgentExpertFinding;
  sessionId: string;
  diagnostics: AgentRunDiagnostics;
  usage: AgentUsage;
  termination: AgentTermination;
}

export class PiExpertRunError extends Error {
  readonly diagnostics: AgentRunDiagnostics;
  readonly sessionId?: string;
  readonly providerTransient: boolean;
  readonly usage?: AgentUsage;
  readonly termination?: AgentTermination;

  constructor(
    message: string,
    diagnostics: AgentRunDiagnostics,
    sessionId?: string,
    providerTransient = false,
    usage?: AgentUsage,
    termination?: AgentTermination,
  ) {
    super(message);
    this.name = "PiExpertRunError";
    this.diagnostics = diagnostics.failureDetail
      ? { ...diagnostics, failureDetail: safeRuntimeDetail(diagnostics.failureDetail) }
      : diagnostics;
    this.sessionId = sessionId;
    this.providerTransient = providerTransient;
    this.usage = usage;
    this.termination = termination?.detail
      ? { ...termination, detail: safeRuntimeDetail(termination.detail) }
      : termination;
  }
}

function isProviderTransientFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    retryable?: unknown;
  };
  const status = value.status ?? value.statusCode;
  return (
    value.retryable === true ||
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    value.code === "ECONNRESET" ||
    value.code === "ETIMEDOUT"
  );
}

function isProviderFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    status?: unknown;
    statusCode?: unknown;
    retryable?: unknown;
    code?: unknown;
  };
  return (
    typeof (value.status ?? value.statusCode) === "number" ||
    value.retryable === true ||
    (typeof value.code === "string" && /^(?:ECONN|ETIMEDOUT|ENET|EAI_)/.test(value.code))
  );
}

class AssistantRunFailure extends Error {
  readonly reason: "aborted" | "provider_error";

  constructor(failure: { reason: "aborted" | "provider_error"; detail?: string }) {
    super(failure.detail ?? failure.reason);
    this.reason = failure.reason;
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
  return value === "strong" || value === "moderate" || value === "weak" || value === "inconclusive"
    ? value
    : "inconclusive";
}

function mb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

type AgentSessionFactory = typeof createAgentSession;

const SUBMIT_FINDING_TOOL = "submit_finding";

function findingToolParameters() {
  const hypothesisRefs = Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
    maxItems: 20,
  });
  return Type.Object(
    {
      status: Type.Union([
        Type.Literal("succeeded"),
        Type.Literal("failed"),
        Type.Literal("inconclusive"),
        Type.Literal("blocked"),
      ]),
      strength: Type.Union([
        Type.Literal("strong"),
        Type.Literal("moderate"),
        Type.Literal("weak"),
        Type.Literal("inconclusive"),
      ]),
      verdict: Type.Union([
        Type.Literal("supports"),
        Type.Literal("contradicts"),
        Type.Literal("no-signal"),
        Type.Literal("mixed"),
        Type.Literal("inconclusive"),
      ]),
      summary: Type.String({ minLength: 1, maxLength: 1500 }),
      conclusions: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
        maxItems: 5,
      }),
      evidenceClaims: Type.Array(
        Type.Object(
          {
            toolCallId: Type.String({ minLength: 1, maxLength: 64 }),
            modality: Type.Union([
              Type.Literal("metric"),
              Type.Literal("log"),
              Type.Literal("trace"),
              Type.Literal("event"),
              Type.Literal("alert"),
              Type.Literal("topology"),
            ]),
            entity: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
            summary: Type.String({ minLength: 1, maxLength: 1000 }),
            supports: hypothesisRefs,
            contradicts: hypothesisRefs,
          },
          { additionalProperties: false },
        ),
        { maxItems: 20 },
      ),
      candidateEntities: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
        maxItems: 20,
      }),
      candidateMechanism: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
      suggestedFollowUps: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
        maxItems: 10,
      }),
      blockedOn: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    },
    { additionalProperties: false },
  );
}

export class PiExpertRunner {
  private readonly modelRuntime: ModelRuntime;
  private readonly tools: ObservabilityToolRegistry;
  private readonly createSession: AgentSessionFactory;

  constructor(
    modelRuntime: ModelRuntime,
    tools: ObservabilityToolRegistry,
    createSession: AgentSessionFactory = createAgentSession,
  ) {
    this.modelRuntime = modelRuntime;
    this.tools = tools;
    this.createSession = createSession;
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
    const recordedToolCallIds = new Set<string>();
    let toolCallCount = 0;
    let toolError: unknown;
    let activateFinalizePhase: (() => void) | undefined;
    let submittedFindingPayload: Record<string, unknown> | undefined;
    let submissionValidationError: string | undefined;

    const toolDefinitions = this.tools.createPiTools({
      names: profile.tools,
      execute: async (name, _toolCallId, parameters) => {
        if (toolCallCount >= profile.maxToolCalls) {
          activateFinalizePhase?.();
          throw new Error(
            `${profile.label} 的调查工具预算已用完。请停止取证并提交最终 finding。`,
          );
        }
        const toolBudget = profile.toolBudgets?.[name];
        const currentToolCalls = perToolCalls.get(name) ?? 0;
        if (toolBudget !== undefined && currentToolCalls >= toolBudget) {
          throw new Error(
            `${profile.label} 的 ${name} 调用预算已用完。请基于已经收集的 observation 收敛。`,
          );
        }
        perToolCalls.set(name, currentToolCalls + 1);
        toolCallCount++;
        sampleProcessMemory();
        const boundedParameters =
          name === "query_metrics"
            ? {
                ...parameters,
                topN: Math.min(typeof parameters.topN === "number" ? parameters.topN : 12, 12),
              }
            : name === "query_traces"
              ? {
                  ...parameters,
                  topN: Math.min(typeof parameters.topN === "number" ? parameters.topN : 20, 20),
                }
              : parameters;
        let recorded: RecordedAgentToolExecution;
        try {
          recorded = await context.invoke(name, {
            ...boundedParameters,
            caseId: context.task.caseId,
          });
        } catch (error) {
          toolError = error;
          throw error;
        }
        sampleProcessMemory();
        recordedToolCallIds.add(recorded.callId);
        const compactResult = compactToolResultForAgent(name, recorded.execution.result);

        // The protocol action is not part of the investigation budget. Once the
        // final allowed investigation call completes, the next agent turn sees
        // only submit_finding.
        if (toolCallCount >= profile.maxToolCalls) {
          activateFinalizePhase?.();
        }

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

    const validHypotheses = new Set(context.brief.hypothesisIds);
    const validModalities = new Set(profile.modalities);
    const submitFindingTool = defineTool({
      name: SUBMIT_FINDING_TOOL,
      label: "Submit finding",
      description:
        "提交当前专家调查的最终结构化 finding。仅在 Finalize Phase 使用；该协议动作不消耗调查工具预算。",
      promptSnippet: "Submit the final expert finding as validated structured data",
      promptGuidelines: [
        "Finalize Phase 中必须调用 submit_finding，不能用普通 assistant 文本代替。",
        "evidenceClaims 只能引用当前 Session 已成功返回的 toolCallId。",
      ],
      parameters: findingToolParameters(),
      async execute(_toolCallId, params) {
        try {
          for (const claim of params.evidenceClaims) {
            if (!recordedToolCallIds.has(claim.toolCallId)) {
              throw new Error(
                `submit_finding 引用了不存在或未成功完成的 toolCallId: ${claim.toolCallId}`,
              );
            }
            if (!validModalities.has(claim.modality as EvidenceModality)) {
              throw new Error(
                `submit_finding 使用了当前 Profile 不允许的 modality: ${claim.modality}`,
              );
            }
            for (const hypothesisId of [...claim.supports, ...claim.contradicts]) {
              if (!validHypotheses.has(hypothesisId)) {
                throw new Error(
                  `submit_finding 引用了当前 brief 之外的 hypothesis: ${hypothesisId}`,
                );
              }
            }
          }
          submittedFindingPayload = params as unknown as Record<string, unknown>;
          submissionValidationError = undefined;
          return {
            content: [{ type: "text" as const, text: "Finding submitted." }],
            details: { accepted: true },
            terminate: true,
          };
        } catch (error) {
          submissionValidationError = safeRuntimeDetail(error);
          throw error;
        }
      },
    });

    const { session } = await this.createSession({
      cwd: process.cwd(),
      agentDir,
      modelRuntime: this.modelRuntime,
      ...(model ? { model } : {}),
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(),
      noTools: "builtin",
      customTools: [...toolDefinitions, submitFindingTool],
    });

    const investigationToolNames = toolDefinitions.map((tool) => tool.name);
    let finalizePhase = false;
    activateFinalizePhase = () => {
      if (finalizePhase) return;
      finalizePhase = true;
      session.setActiveToolsByName([SUBMIT_FINDING_TOOL]);
    };
    session.setActiveToolsByName(investigationToolNames);

    const sessionId = session.sessionManager.getSessionId();
    const usage = new AgentUsageAccumulator();
    let totalOutputChars = 0;
    let thinkingChars = 0;
    let repairAttempted = false;
    let repairSucceeded = false;
    let protocolFailure: "finding_missing" | "finding_invalid" | undefined;
    let protocolFailureDetail: string | undefined;
    let invalidOutput = false;
    let lastMessageFailure: { reason: "aborted" | "provider_error"; detail?: string } | undefined;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        const message = event.message as AssistantMessage;
        usage.record(message);
        lastMessageFailure =
          message.stopReason === "error" || message.stopReason === "aborted"
            ? {
                reason: message.stopReason === "aborted" ? "aborted" : "provider_error",
                detail: message.errorMessage,
              }
            : undefined;
        return;
      }
      if (event.type !== "message_update") return;
      if (event.assistantMessageEvent.type === "text_delta") {
        totalOutputChars += event.assistantMessageEvent.delta.length;
      } else if (event.assistantMessageEvent.type === "thinking_delta") {
        thinkingChars += event.assistantMessageEvent.delta.length;
        if (!finalizePhase) {
          void context.onThinking?.(event.assistantMessageEvent.delta);
        }
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

    let parsed!: Record<string, unknown>;
    try {
      try {
        sampleProcessMemory();
        lastMessageFailure = undefined;
        await session.prompt(
          `调查下面这个 brief。只在确有需要时使用调查工具，expected outputs 已回答、证据预算耗尽或路径被证伪时停止继续取证。不要输出最终 JSON；Runtime 会进入 Finalize Phase，并通过 submit_finding 接收最终结构化 finding。分析过程优先使用中文；工具名、字段名和枚举值保持原样。\n\n${JSON.stringify(
            prompt,
            null,
            2,
          )}`,
        );
        sampleProcessMemory();
        if (context.signal?.aborted) {
          throw new DOMException("Investigation cancelled", "AbortError");
        }
        if (lastMessageFailure) throw new AssistantRunFailure(lastMessageFailure);

        if (!submittedFindingPayload) {
          activateFinalizePhase();
          lastMessageFailure = undefined;
          await session.prompt(
            [
              "调查阶段已经结束。现在是 Finalize Phase。",
              "不要继续搜索、不要扩展范围，也不要输出普通 JSON 或解释文字。",
              "唯一允许的结束方式是调用 submit_finding。",
              "只能基于当前 Session 已经观察到的工具结果；negative/no-anomaly 结果同样是有效 finding。",
            ].join("\n"),
          );
          sampleProcessMemory();
          if (context.signal?.aborted) {
            throw new DOMException("Investigation cancelled", "AbortError");
          }
          if (lastMessageFailure) throw new AssistantRunFailure(lastMessageFailure);
        }

        if (!submittedFindingPayload) {
          repairAttempted = true;
          protocolFailure = submissionValidationError ? "finding_invalid" : "finding_missing";
          protocolFailureDetail =
            submissionValidationError ?? "Sub-agent did not call submit_finding in Finalize Phase.";
          lastMessageFailure = undefined;
          await session.prompt(
            [
              "你尚未成功提交 finding。",
              submissionValidationError
                ? `上一次 submit_finding 被拒绝：${submissionValidationError}`
                : "上一次响应没有调用 submit_finding。",
              "现在只调用一次 submit_finding，并修正参数；不要输出其他内容。",
            ].join("\n"),
          );
          sampleProcessMemory();
          if (context.signal?.aborted) {
            throw new DOMException("Investigation cancelled", "AbortError");
          }
          if (lastMessageFailure) throw new AssistantRunFailure(lastMessageFailure);
          if (!submittedFindingPayload) {
            invalidOutput = true;
            protocolFailure = submissionValidationError ? "finding_invalid" : "finding_missing";
            protocolFailureDetail =
              submissionValidationError ??
              "Sub-agent did not call submit_finding after protocol retry.";
            throw new Error(protocolFailureDetail);
          }
          repairSucceeded = true;
        }

        parsed = submittedFindingPayload;
      } catch (error) {
        const reason: AgentTermination["reason"] =
          context.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")
            ? "aborted"
            : invalidOutput
              ? "invalid_output"
              : error instanceof AssistantRunFailure
                ? error.reason
                : lastMessageFailure
                  ? lastMessageFailure.reason
                  : error === toolError
                    ? "tool_error"
                    : isProviderFailure(error)
                      ? "provider_error"
                      : "runtime_error";
        const detail = safeRuntimeDetail(error);
        return {
          sessionId,
          usage: usage.snapshot(),
          diagnostics: runtimeDiagnostics(
            toolCallCount,
            thinkingChars,
            totalOutputChars,
            repairAttempted,
            false,
            {
              failureReason:
                reason === "aborted"
                  ? "aborted"
                  : reason === "invalid_output"
                    ? (protocolFailure ?? "finding_invalid")
                    : reason === "provider_error"
                      ? "model_error"
                      : "unknown",
              failureDetail:
                reason === "invalid_output" && protocolFailureDetail
                  ? safeRuntimeDetail(protocolFailureDetail)
                  : detail,
            },
          ),
          termination: {
            reason,
            detail,
            ...(reason === "provider_error" &&
            protocolFailure === undefined &&
            isProviderTransientFailure(error)
              ? { providerTransient: true }
              : {}),
          },
        };
      }
    } finally {
      context.signal?.removeEventListener("abort", abort);
      unsubscribe();
      session.dispose();
    }

    const finalizeFinding = (): PiExpertRunResult => {
      const validHypotheses = new Set(context.brief.hypothesisIds);
      const validModalities = new Set(profile.modalities);
      const claims = Array.isArray(parsed.evidenceClaims) ? parsed.evidenceClaims : [];
      const evidenceClaims = claims
        .filter((item): item is Record<string, unknown> =>
          Boolean(item && typeof item === "object"),
        )
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
        .filter((claim) => claim.toolCallId.length > 0 && validModalities.has(claim.modality));

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
        usage: usage.snapshot(),
        termination: { reason: "completed" },
        diagnostics: runtimeDiagnostics(
          toolCallCount,
          thinkingChars,
          totalOutputChars,
          repairAttempted,
          repairSucceeded,
          repairAttempted && repairSucceeded && parseFailureDetail
            ? { failureDetail: `initial parse repaired: ${safeRuntimeDetail(parseFailureDetail)}` }
            : undefined,
        ),
        finding: normalizeFindingForProfile(profile, finding),
      };
    };
    try {
      return finalizeFinding();
    } catch (error) {
      const detail = safeRuntimeDetail(error);
      return {
        sessionId,
        usage: usage.snapshot(),
        diagnostics: runtimeDiagnostics(
          toolCallCount,
          thinkingChars,
          totalOutputChars,
          repairAttempted,
          repairSucceeded,
          { failureReason: "unknown", failureDetail: detail },
        ),
        termination: { reason: "runtime_error", detail },
      };
    }
  }
}
