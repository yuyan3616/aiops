import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { getRuntimeMetrics, getTelemetryTracer, logTelemetryEvent } from "@server/telemetry";

import type { LifecycleOutcome, RuntimeMetricRecorder } from "./pi-runtime-metrics";

interface ActiveLifecycle {
  id: number;
  span: Span;
  startedAtNs: bigint;
  closed: boolean;
}

interface ActiveAgent extends ActiveLifecycle {
  agentType: "main";
  provider?: string;
  model?: string;
  lastOutcome?: LifecycleOutcome;
  hadChildError: boolean;
  hadIncompleteChild: boolean;
  lowLevelRuns: number;
}

interface ActiveTurn extends ActiveLifecycle {
  turnIndex: number;
  provider?: string;
  model?: string;
  agentId?: number;
  hadChildError: boolean;
  hadIncompleteChild: boolean;
}

interface ActiveProvider extends ActiveLifecycle {
  provider?: string;
  model?: string;
  turnId?: number;
  headerRecorded: boolean;
  httpStatusCode?: number;
}

interface ActiveTool extends ActiveLifecycle {
  toolCallId: string;
  toolName: string;
  turnId?: number;
}

type CompletionReason =
  | "completed"
  | "stream_error"
  | "cancelled"
  | "tool_error"
  | "tool_timeout"
  | "duplicate_start"
  | "superseded_start"
  | "turn_closed"
  | "agent_closed"
  | "session_shutdown"
  | "process_shutdown"
  | "turn_end_mismatch"
  | "child_incomplete";

interface PiTracingDependencies {
  tracer?: Tracer;
  metrics?: RuntimeMetricRecorder;
  log?: typeof logTelemetryEvent;
  nowNs?: () => bigint;
}

export interface PiTracingExtensionOptions {
  conversationId: string;
  dependencies?: PiTracingDependencies;
  registerDispose?: (dispose: () => void) => void;
}

const activeLifecycleClosers = new Set<(reason: CompletionReason) => void>();

function assistantMessageOutcome(message: unknown): LifecycleOutcome {
  if (!message || typeof message !== "object") return "success";
  const candidate = message as {
    role?: string;
    stopReason?: string;
    errorMessage?: string;
  };
  if (candidate.role !== "assistant") return "success";
  if (candidate.stopReason === "aborted") return "cancelled";
  if (candidate.stopReason === "error" || Boolean(candidate.errorMessage)) return "error";
  return "success";
}

function completionReasonForMessage(message: unknown): CompletionReason {
  const outcome = assistantMessageOutcome(message);
  if (outcome === "cancelled") return "cancelled";
  if (outcome === "error") return "stream_error";
  return "completed";
}

function toolFailureDetails(
  result: unknown,
  isError: boolean,
): {
  outcome: LifecycleOutcome;
  reason: CompletionReason;
} {
  if (!isError) return { outcome: "success", reason: "completed" };
  let serialized = "";
  try {
    serialized = JSON.stringify(result)?.toLowerCase().slice(0, 2048) ?? "";
  } catch {
    serialized = String(result).toLowerCase().slice(0, 2048);
  }
  if (/abort|cancel/.test(serialized)) {
    return { outcome: "cancelled", reason: "cancelled" };
  }
  if (/timed?\s*out|timeout/.test(serialized)) {
    return { outcome: "error", reason: "tool_timeout" };
  }
  return { outcome: "error", reason: "tool_error" };
}

function statusCodeForOutcome(outcome: LifecycleOutcome): SpanStatusCode {
  if (outcome === "success") return SpanStatusCode.OK;
  if (outcome === "cancelled") return SpanStatusCode.UNSET;
  return SpanStatusCode.ERROR;
}

function logLevelForOutcome(outcome: LifecycleOutcome): "info" | "warn" | "error" {
  if (outcome === "error") return "error";
  if (outcome === "incomplete") return "warn";
  return "info";
}

export function forceClosePiTracingLifecycles(
  reason: "process_shutdown" | "session_shutdown" = "process_shutdown",
): void {
  for (const close of [...activeLifecycleClosers]) {
    try {
      close(reason);
    } catch {
      // Shutdown must continue even if one telemetry lifecycle is corrupt.
    }
  }
}

export function createPiTracingExtension(options: PiTracingExtensionOptions): ExtensionFactory {
  return async (pi) => {
    const tracer = options.dependencies?.tracer ?? getTelemetryTracer();
    const metrics = options.dependencies?.metrics ?? getRuntimeMetrics();
    const writeLog = options.dependencies?.log ?? logTelemetryEvent;
    let disposed = false;
    const nowNs = options.dependencies?.nowNs ?? (() => process.hrtime.bigint());

    let nextIdentity = 0;
    let agent: ActiveAgent | undefined;
    let activeTurn: ActiveTurn | undefined;
    let activeProvider: ActiveProvider | undefined;
    let providerCallbacksAmbiguous = false;
    const activeTools = new Map<string, ActiveTool>();
    const toolTombstones = new Map<string, true>();
    const toolTombstoneOrder: string[] = [];
    const diagnostics = new Set<string>();

    const safeTelemetry = (operation: string, action: () => void): void => {
      if (disposed) return;
      try {
        action();
      } catch (error) {
        if (diagnostics.has(operation)) return;
        diagnostics.add(operation);
        const errorType = error instanceof Error ? error.name : "Error";
        process.stderr.write(
          `[telemetry] ${JSON.stringify({ event: "pi.telemetry.callback_failed", operation, errorType })}\n`,
        );
      }
    };

    const log: typeof writeLog = (...args) => safeTelemetry("log", () => writeLog(...args));

    const newIdentity = () => ++nextIdentity;
    const parentContext = (parent?: Span) =>
      parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT;
    const elapsedSeconds = (startedAtNs: bigint) =>
      Math.max(0, Number(nowNs() - startedAtNs) / 1_000_000_000);
    const modelFields = (model: { provider?: string; id?: string } | undefined) => ({
      ...(model?.provider ? { provider: model.provider } : {}),
      ...(model?.id ? { model: model.id } : {}),
    });

    const rememberToolTombstone = (toolCallId: string) => {
      if (toolTombstones.has(toolCallId)) return;
      toolTombstones.set(toolCallId, true);
      toolTombstoneOrder.push(toolCallId);
      while (toolTombstoneOrder.length > 256) {
        const oldest = toolTombstoneOrder.shift();
        if (oldest) toolTombstones.delete(oldest);
      }
    };

    const markChildOutcome = (turnId: number | undefined, outcome: LifecycleOutcome): void => {
      if (outcome !== "error" && outcome !== "incomplete") return;
      if (activeTurn && activeTurn.id === turnId) {
        activeTurn.hadChildError = true;
        if (outcome === "incomplete") activeTurn.hadIncompleteChild = true;
      }
      if (agent && !agent.closed) {
        agent.hadChildError = true;
        if (outcome === "incomplete") agent.hadIncompleteChild = true;
      }
    };

    const completeSpan = (
      active: ActiveLifecycle,
      outcome: LifecycleOutcome,
      reason: CompletionReason,
      durationAttribute: string,
    ): number | undefined => {
      if (active.closed) return undefined;
      active.closed = true;
      const durationSeconds = elapsedSeconds(active.startedAtNs);
      safeTelemetry("span_attributes", () => {
        active.span.setAttribute(durationAttribute, durationSeconds * 1000);
        active.span.setAttribute("pi.outcome", outcome);
        active.span.setAttribute("pi.lifecycle.complete", outcome !== "incomplete");
        active.span.setAttribute("pi.lifecycle.reason", reason);
        active.span.setStatus({ code: statusCodeForOutcome(outcome) });
      });
      return durationSeconds;
    };

    const closeProvider = (
      current: ActiveProvider,
      outcome: LifecycleOutcome,
      reason: CompletionReason,
    ): void => {
      const durationSeconds = completeSpan(current, outcome, reason, "pi.provider.duration_ms");
      if (durationSeconds === undefined) return;
      if (activeProvider === current) activeProvider = undefined;
      markChildOutcome(current.turnId, outcome);
      safeTelemetry("recordProviderGenerationCompletion", () =>
        metrics?.recordProviderGenerationCompletion({
          span: current.span,
          durationSeconds,
          provider: current.provider,
          model: current.model,
          outcome,
        }),
      );
      log(
        "pi.provider.generation.completed",
        {
          conversationId: options.conversationId,
          provider: current.provider,
          model: current.model,
          durationMs: durationSeconds * 1000,
          lifecycleStatus: outcome,
          reason,
          ...(current.httpStatusCode !== undefined
            ? { httpStatusCode: current.httpStatusCode }
            : {}),
          providerAttemptLifecycle: false,
        },
        current.span,
        logLevelForOutcome(outcome),
      );
      safeTelemetry("span_end", () => current.span.end());
    };

    const closeTool = (
      current: ActiveTool,
      outcome: LifecycleOutcome,
      reason: CompletionReason,
    ): void => {
      const durationSeconds = completeSpan(current, outcome, reason, "pi.tool.duration_ms");
      if (durationSeconds === undefined) return;
      if (activeTools.get(current.toolCallId) === current) {
        activeTools.delete(current.toolCallId);
      }
      rememberToolTombstone(current.toolCallId);
      markChildOutcome(current.turnId, outcome);
      safeTelemetry("recordToolCompletion", () =>
        metrics?.recordToolCompletion({
          span: current.span,
          durationSeconds,
          toolName: current.toolName,
          outcome,
        }),
      );
      log(
        "pi.tool.call.completed",
        {
          conversationId: options.conversationId,
          toolCallId: current.toolCallId,
          toolName: current.toolName,
          durationMs: durationSeconds * 1000,
          lifecycleStatus: outcome,
          reason,
        },
        current.span,
        logLevelForOutcome(outcome),
      );
      safeTelemetry("span_end", () => current.span.end());
    };

    const closeTurn = (
      current: ActiveTurn,
      outcome: LifecycleOutcome,
      reason: CompletionReason,
    ): void => {
      if (current.closed) return;
      const childOutcome: LifecycleOutcome = outcome === "cancelled" ? "cancelled" : "incomplete";
      if (activeProvider?.turnId === current.id && !activeProvider.closed) {
        closeProvider(activeProvider, childOutcome, "turn_closed");
      }
      for (const tool of [...activeTools.values()]) {
        if (tool.turnId === current.id && !tool.closed) {
          closeTool(tool, childOutcome, "turn_closed");
        }
      }
      if (outcome === "success" && current.hadIncompleteChild) {
        outcome = "incomplete";
        reason = "child_incomplete";
      }
      const durationSeconds = completeSpan(current, outcome, reason, "pi.turn.duration_ms");
      if (durationSeconds === undefined) return;
      if (activeTurn === current) activeTurn = undefined;
      safeTelemetry("parent_attributes", () => {
        current.span.setAttribute("pi.had_child_error", current.hadChildError);
        current.span.setAttribute(
          "pi.lifecycle.complete",
          outcome !== "incomplete" && !current.hadIncompleteChild,
        );
      });
      if (agent && agent.id === current.agentId) {
        agent.lastOutcome = outcome;
        if (outcome === "incomplete") agent.hadIncompleteChild = true;
        if (current.hadChildError || outcome === "error" || outcome === "incomplete") {
          agent.hadChildError = true;
        }
      }
      safeTelemetry("recordTurnCompletion", () =>
        metrics?.recordTurnCompletion({
          span: current.span,
          durationSeconds,
          provider: current.provider,
          model: current.model,
          outcome,
        }),
      );
      log(
        "pi.model.turn.completed",
        {
          conversationId: options.conversationId,
          turnIndex: current.turnIndex,
          provider: current.provider,
          model: current.model,
          durationMs: durationSeconds * 1000,
          lifecycleStatus: outcome,
          reason,
          hadChildError: current.hadChildError,
        },
        current.span,
        logLevelForOutcome(outcome),
      );
      safeTelemetry("span_end", () => current.span.end());
    };

    const closeAgent = (
      current: ActiveAgent,
      outcome: LifecycleOutcome,
      reason: CompletionReason,
    ): void => {
      if (current.closed) return;
      if (activeTurn && activeTurn.agentId === current.id && !activeTurn.closed) {
        closeTurn(activeTurn, outcome === "cancelled" ? "cancelled" : "incomplete", "agent_closed");
      }
      if (activeProvider && !activeProvider.closed) {
        closeProvider(
          activeProvider,
          outcome === "cancelled" ? "cancelled" : "incomplete",
          "agent_closed",
        );
      }
      for (const tool of [...activeTools.values()]) {
        if (!tool.closed) {
          closeTool(tool, outcome === "cancelled" ? "cancelled" : "incomplete", "agent_closed");
        }
      }
      if (outcome === "success" && current.hadIncompleteChild) {
        outcome = "incomplete";
        reason = "child_incomplete";
      }
      const durationSeconds = completeSpan(current, outcome, reason, "pi.agent.duration_ms");
      if (durationSeconds === undefined) return;
      if (agent === current) agent = undefined;
      safeTelemetry("parent_attributes", () => {
        current.span.setAttribute("pi.had_child_error", current.hadChildError);
        current.span.setAttribute(
          "pi.lifecycle.complete",
          outcome !== "incomplete" && !current.hadIncompleteChild,
        );
      });
      safeTelemetry("agent_attributes", () =>
        current.span.setAttribute("pi.agent.low_level_runs", current.lowLevelRuns),
      );
      safeTelemetry("recordAgentCompletion", () =>
        metrics?.recordAgentCompletion({
          span: current.span,
          durationSeconds,
          agentType: current.agentType,
          outcome,
        }),
      );
      log(
        "pi.agent.completed",
        {
          conversationId: options.conversationId,
          agentType: current.agentType,
          provider: current.provider,
          model: current.model,
          durationMs: durationSeconds * 1000,
          lifecycleStatus: outcome,
          reason,
          hadChildError: current.hadChildError,
          lowLevelRuns: current.lowLevelRuns,
        },
        current.span,
        logLevelForOutcome(outcome),
      );
      safeTelemetry("span_end", () => current.span.end());
    };

    const forceClose = (reason: CompletionReason): void => {
      safeTelemetry("force_close", () => {
        if (activeProvider && !activeProvider.closed) {
          closeProvider(activeProvider, "incomplete", reason);
        }
        for (const tool of [...activeTools.values()]) {
          if (!tool.closed) closeTool(tool, "incomplete", reason);
        }
        if (activeTurn && !activeTurn.closed) {
          closeTurn(activeTurn, "incomplete", reason);
        }
        if (agent && !agent.closed) {
          closeAgent(agent, "incomplete", reason);
        }
      });
    };
    activeLifecycleClosers.add(forceClose);
    const dispose = () => {
      if (disposed) return;
      try {
        forceClose("session_shutdown");
      } finally {
        disposed = true;
        activeLifecycleClosers.delete(forceClose);
        activeTools.clear();
        toolTombstones.clear();
        toolTombstoneOrder.length = 0;
      }
    };
    options.registerDispose?.(dispose);

    // Pi reuses transformHeaders for cache refreshes, which have no Agent message_end.
    // Veto them rather than inventing request identities or mispairing the callbacks.
    pi.on("cache_warming_decision", () => ({ action: "stop" }));

    pi.on("agent_start", (_event, ctx) => {
      safeTelemetry("agent_start", () => {
        if (agent && !agent.closed) {
          agent.lowLevelRuns += 1;
          agent.span.setAttribute("pi.agent.low_level_runs", agent.lowLevelRuns);
          log(
            "pi.agent.low_level_run.started",
            {
              conversationId: options.conversationId,
              lowLevelRuns: agent.lowLevelRuns,
            },
            agent.span,
          );
          return;
        }

        const fields = modelFields(ctx.model);
        const span = tracer.startSpan(
          "pi.agent.run",
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              "conversation.id": options.conversationId,
              "agent.type": "main",
              ...(fields.provider ? { "gen_ai.system": fields.provider } : {}),
              ...(fields.model ? { "gen_ai.request.model": fields.model } : {}),
            },
          },
          ROOT_CONTEXT,
        );
        const current: ActiveAgent = {
          id: newIdentity(),
          span,
          startedAtNs: nowNs(),
          closed: false,
          agentType: "main",
          provider: fields.provider,
          model: fields.model,
          hadChildError: false,
          hadIncompleteChild: false,
          lowLevelRuns: 1,
        };
        agent = current;
        log(
          "pi.agent.started",
          {
            conversationId: options.conversationId,
            agentType: "main",
            ...fields,
          },
          span,
        );
      });
    });

    pi.on("turn_start", (event, ctx) => {
      safeTelemetry("turn_start", () => {
        if (activeTurn && !activeTurn.closed) {
          closeTurn(activeTurn, "incomplete", "superseded_start");
        }
        providerCallbacksAmbiguous = false;
        const fields = modelFields(ctx.model);
        const span = tracer.startSpan(
          "pi.model.turn",
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              "conversation.id": options.conversationId,
              "pi.turn.index": event.turnIndex,
              ...(fields.provider ? { "gen_ai.system": fields.provider } : {}),
              ...(fields.model ? { "gen_ai.request.model": fields.model } : {}),
            },
          },
          parentContext(agent?.span),
        );
        const current: ActiveTurn = {
          id: newIdentity(),
          span,
          startedAtNs: nowNs(),
          closed: false,
          turnIndex: event.turnIndex,
          provider: fields.provider,
          model: fields.model,
          agentId: agent?.id,
          hadChildError: false,
          hadIncompleteChild: false,
        };
        activeTurn = current;
        log(
          "pi.model.turn.started",
          {
            conversationId: options.conversationId,
            turnIndex: event.turnIndex,
            ...fields,
          },
          span,
        );
      });
    });

    pi.on("before_provider_headers", (_event, ctx) => {
      safeTelemetry("before_provider_headers", () => {
        if (!activeTurn || activeTurn.closed || providerCallbacksAmbiguous) return;
        if (activeProvider && !activeProvider.closed) {
          // No request ID is exposed: a second start is ambiguous, not a safe replacement.
          providerCallbacksAmbiguous = true;
          closeProvider(activeProvider, "incomplete", "superseded_start");
          return;
        }
        const fields = modelFields(ctx.model);
        const span = tracer.startSpan(
          "pi.provider.generation",
          {
            kind: SpanKind.CLIENT,
            attributes: {
              "conversation.id": options.conversationId,
              "pi.provider.lifecycle_scope": "top_level_generation",
              "pi.provider.attempt_visibility": "provider_internal_retries_unavailable",
              ...(fields.provider ? { "gen_ai.system": fields.provider } : {}),
              ...(fields.model ? { "gen_ai.request.model": fields.model } : {}),
            },
          },
          parentContext(activeTurn?.span ?? agent?.span),
        );
        const current: ActiveProvider = {
          id: newIdentity(),
          span,
          startedAtNs: nowNs(),
          closed: false,
          provider: fields.provider,
          model: fields.model,
          turnId: activeTurn?.id,
          headerRecorded: false,
        };
        activeProvider = current;
        log(
          "pi.provider.generation.started",
          {
            conversationId: options.conversationId,
            ...fields,
            providerAttemptLifecycle: false,
          },
          span,
        );
      });
    });

    pi.on("after_provider_response", (event) => {
      safeTelemetry("after_provider_response", () => {
        const current = activeProvider;
        if (!current || current.closed || current.headerRecorded) return;
        current.headerRecorded = true;
        current.httpStatusCode = event.status;
        const durationSeconds = elapsedSeconds(current.startedAtNs);
        current.span.setAttribute(
          "pi.provider.response_header_duration_ms",
          durationSeconds * 1000,
        );
        current.span.setAttribute("http.response.status_code", event.status);
        const headerOutcome = event.status >= 400 ? "error" : "success";
        safeTelemetry("recordProviderResponseHeader", () =>
          metrics?.recordProviderResponseHeader({
            span: current.span,
            durationSeconds,
            provider: current.provider,
            model: current.model,
            outcome: headerOutcome,
          }),
        );
        log(
          "pi.provider.response_headers",
          {
            conversationId: options.conversationId,
            provider: current.provider,
            model: current.model,
            durationMs: durationSeconds * 1000,
            lifecycleStatus: headerOutcome,
            httpStatusCode: event.status,
          },
          current.span,
          headerOutcome === "error" ? "warn" : "info",
        );
      });
    });

    pi.on("message_end", (event) => {
      safeTelemetry("message_end", () => {
        const message = event.message as { role?: string };
        if (message?.role !== "assistant") return;
        const current = activeProvider;
        if (!current) return;
        const outcome = assistantMessageOutcome(event.message);
        closeProvider(current, outcome, completionReasonForMessage(event.message));
      });
    });

    pi.on("tool_execution_start", (event) => {
      safeTelemetry("tool_execution_start", () => {
        if (activeTools.has(event.toolCallId) || toolTombstones.has(event.toolCallId)) {
          log(
            "pi.tool.duplicate_start.ignored",
            {
              conversationId: options.conversationId,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              lifecycleStatus: "incomplete",
              reason: "duplicate_start",
            },
            activeTurn?.span ?? agent?.span,
            "warn",
          );
          return;
        }
        const span = tracer.startSpan(
          "pi.tool.call",
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              "conversation.id": options.conversationId,
              "tool.name": event.toolName,
              "tool.call_id": event.toolCallId,
            },
          },
          parentContext(activeTurn?.span ?? agent?.span),
        );
        const current: ActiveTool = {
          id: newIdentity(),
          span,
          startedAtNs: nowNs(),
          closed: false,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          turnId: activeTurn?.id,
        };
        activeTools.set(event.toolCallId, current);
        log(
          "pi.tool.call.started",
          {
            conversationId: options.conversationId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          },
          span,
        );
      });
    });

    pi.on("tool_execution_end", (event) => {
      safeTelemetry("tool_execution_end", () => {
        const current = activeTools.get(event.toolCallId);
        if (!current) {
          log(
            "pi.tool.late_end.ignored",
            {
              conversationId: options.conversationId,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
            },
            activeTurn?.span ?? agent?.span,
            "warn",
          );
          return;
        }
        const failure = toolFailureDetails(event.result, event.isError);
        closeTool(current, failure.outcome, failure.reason);
      });
    });

    pi.on("turn_end", (event) => {
      safeTelemetry("turn_end", () => {
        const current = activeTurn;
        if (!current || current.closed) return;
        if (current.turnIndex !== event.turnIndex) {
          log(
            "pi.model.turn.late_end.ignored",
            { conversationId: options.conversationId, turnIndex: event.turnIndex },
            undefined,
            "warn",
          );
          return;
        }
        const outcome = assistantMessageOutcome(event.message);
        closeTurn(current, outcome, completionReasonForMessage(event.message));
      });
    });

    pi.on("agent_settled", () => {
      safeTelemetry("agent_settled", () => {
        const current = agent;
        if (!current || current.closed) return;
        closeAgent(current, current.lastOutcome ?? "success", "completed");
      });
    });

    pi.on("session_shutdown", dispose);
  };
}
