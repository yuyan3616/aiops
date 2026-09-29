import type { AssistantMessage } from "@earendil-works/pi-ai";
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

interface CollectedToolEvidence {
  toolCallId: string;
  tool: ObservabilityToolName;
  summary: string;
  result: unknown;
}

function boundedFinalizeResult(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized.length <= 5_000) return value;
  return {
    truncated: true,
    preview: serialized.slice(0, 5_000),
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

function extractJson(output: string): Record<string, unknown> {
  const trimmed = output.trim();
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Sub-agent did not return a JSON finding");
    value = JSON.parse(match[0]);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyntaxError("Sub-agent finding must be a JSON object");
  }
  return value as Record<string, unknown>;
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
    const collectedToolEvidence: CollectedToolEvidence[] = [];
    let toolCallCount = 0;
    let toolError: unknown;
    const toolDefinitions = this.tools.createPiTools({
      names: profile.tools,
      execute: async (name, _toolCallId, parameters) => {
        if (toolCallCount >= profile.maxToolCalls) {
          throw new Error(
            `${profile.label} 的工具调用预算已用完。请基于已经收集的 observation 直接收敛。`,
          );
        }
        const toolBudget = profile.toolBudgets?.[name];
        const currentToolCalls = perToolCalls.get(name) ?? 0;
        if (toolBudget !== undefined && currentToolCalls >= toolBudget) {
          throw new Error(
            `${profile.label} 的 ${name} 调用预算已用完。请基于已经收集的 observation 直接收敛。`,
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
        const compactResult = compactToolResultForAgent(name, recorded.execution.result);
        collectedToolEvidence.push({
          toolCallId: recorded.callId,
          tool: name,
          summary: recorded.execution.summary,
          result: boundedFinalizeResult(compactResult),
        });
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
    const usage = new AgentUsageAccumulator();
    let output = "";
    let totalOutputChars = 0;
    let thinkingChars = 0;
    let repairAttempted = false;
    let repairSucceeded = false;
    let parseFailure: "json_missing" | "json_invalid" | undefined;
    let parseFailureDetail: string | undefined;
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

    const finalizeWithoutTools = async (): Promise<string> => {
      const finalizeSettings = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 1 },
      });
      const finalizeLoader = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir,
        settingsManager: finalizeSettings,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPromptOverride: () =>
          [
            buildExpertSystemPrompt(profile, context.brief),
            "# Finalize Mode",
            "调查阶段已经结束。当前 Session 没有任何工具，禁止继续搜索、扩展范围或编造新事实。",
            "只能基于下面提供的 brief、hypotheses 和已收集 tool evidence 生成最终 finding。",
            "最终响应必须且只能是一个 JSON object；不要 markdown fence，不要解释文字。",
          ].join("\n\n"),
      });
      await finalizeLoader.reload();

      const { session: finalizeSession } = await createAgentSession({
        cwd: process.cwd(),
        agentDir,
        modelRuntime: this.modelRuntime,
        ...(model ? { model } : {}),
        resourceLoader: finalizeLoader,
        settingsManager: finalizeSettings,
        sessionManager: SessionManager.inMemory(),
        noTools: "builtin",
        tools: [],
        customTools: [],
      });

      let finalizeOutput = "";
      let finalizeFailure:
        | { reason: "aborted" | "provider_error"; detail?: string }
        | undefined;
      const unsubscribeFinalize = finalizeSession.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          const message = event.message as AssistantMessage;
          usage.record(message);
          finalizeFailure =
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
          finalizeOutput += event.assistantMessageEvent.delta;
          totalOutputChars += event.assistantMessageEvent.delta.length;
        } else if (event.assistantMessageEvent.type === "thinking_delta") {
          thinkingChars += event.assistantMessageEvent.delta.length;
        }
      });
      const abortFinalize = () => finalizeSession.abort();
      context.signal?.addEventListener("abort", abortFinalize, { once: true });

      try {
        await finalizeSession.prompt(
          [
            "请根据已经完成的调查生成规定的 JSON finding。",
            "只能引用 collectedToolEvidence 中真实存在的 toolCallId。",
            "negative/no-anomaly 结果同样是有效 finding。",
            "",
            JSON.stringify(
              {
                brief: context.brief,
                caseId: context.task.caseId,
                alert: prompt.alert,
                currentHypotheses: prompt.currentHypotheses,
                collectedToolEvidence,
              },
              null,
              2,
            ),
          ].join("\n"),
        );
        if (context.signal?.aborted) {
          throw new DOMException("Investigation cancelled", "AbortError");
        }
        if (finalizeFailure) throw new AssistantRunFailure(finalizeFailure);
        return finalizeOutput;
      } finally {
        context.signal?.removeEventListener("abort", abortFinalize);
        unsubscribeFinalize();
        finalizeSession.dispose();
      }
    };

    let parsed: Record<string, unknown>;
    try {
      try {
        sampleProcessMemory();
        lastMessageFailure = undefined;
        await session.prompt(
          `调查下面这个 brief。只在确有需要时使用工具，完成后返回规定的 JSON finding。分析过程和 finding 的自然语言内容优先使用中文；工具名、字段名和枚举值保持原样。\n\n${JSON.stringify(
            prompt,
            null,
            2,
          )}`,
        );
        sampleProcessMemory();
        if (context.signal?.aborted)
          throw new DOMException("Investigation cancelled", "AbortError");
        if (lastMessageFailure) throw new AssistantRunFailure(lastMessageFailure);
        try {
          parsed = extractJson(output);
        } catch (error) {
          repairAttempted = true;
          parseFailure = error instanceof SyntaxError ? "json_invalid" : "json_missing";
          parseFailureDetail = error instanceof Error ? error.message : String(error);
          sampleProcessMemory();

          // Never repair inside the original tool-capable Session. A fresh no-tools
          // Session makes the investigation -> finalize boundary deterministic and
          // prevents a model that exhausted its tool budget from entering another tool loop.
          const finalizeOutput = await finalizeWithoutTools();
          try {
            parsed = extractJson(finalizeOutput);
          } catch (repairError) {
            parseFailure =
              repairError instanceof SyntaxError ? "json_invalid" : "json_missing";
            parseFailureDetail =
              repairError instanceof Error ? repairError.message : String(repairError);
            invalidOutput = true;
            throw repairError;
          }
          repairSucceeded = true;
        }
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
                    ? (parseFailure ?? "json_invalid")
                    : reason === "provider_error"
                      ? "model_error"
                      : "unknown",
              failureDetail: detail,
            },
          ),
          termination: {
            reason,
            detail,
            ...(reason === "provider_error" &&
            parseFailure === undefined &&
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
