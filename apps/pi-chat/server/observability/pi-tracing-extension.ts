import {
  context,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
} from "@opentelemetry/api";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getTelemetryTracer, logTelemetryEvent } from "@server/telemetry";

interface ActiveSpan {
  span: Span;
  startedAt: number;
}

export interface PiTracingExtensionOptions {
  conversationId: string;
}

function assistantMessageHasError(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const candidate = message as {
    role?: string;
    stopReason?: string;
    errorMessage?: string;
  };
  return (
    candidate.role === "assistant" &&
    (candidate.stopReason === "error" || Boolean(candidate.errorMessage))
  );
}

export function createPiTracingExtension(
  options: PiTracingExtensionOptions,
): ExtensionFactory {
  return async (pi) => {
    const tracer = getTelemetryTracer();
    let agentSpan: ActiveSpan | undefined;
    let turnSpan: ActiveSpan | undefined;
    let providerSpan: ActiveSpan | undefined;
    const toolSpans = new Map<string, ActiveSpan>();
    let agentErrored = false;

    const parentContext = (parent?: Span) =>
      parent ? trace.setSpan(context.active(), parent) : context.active();

    const modelFields = (model: { provider?: string; id?: string } | undefined) => ({
      ...(model?.provider ? { provider: model.provider } : {}),
      ...(model?.id ? { model: model.id } : {}),
    });

    const closeProvider = (isError: boolean, statusCode?: number) => {
      const active = providerSpan;
      providerSpan = undefined;
      if (!active) return;

      const durationMs = Date.now() - active.startedAt;
      active.span.setAttribute("pi.provider.ttfb_ms", durationMs);
      if (statusCode !== undefined) {
        active.span.setAttribute("http.response.status_code", statusCode);
      }
      active.span.setStatus({
        code: isError ? SpanStatusCode.ERROR : SpanStatusCode.OK,
      });
      logTelemetryEvent(
        "pi.provider.ttfb.completed",
        {
          conversationId: options.conversationId,
          durationMs,
          status: isError ? "error" : "success",
          ...(statusCode !== undefined ? { statusCode } : {}),
        },
        active.span,
      );
      active.span.end();
    };

    const closeDanglingTools = () => {
      for (const [toolCallId, active] of toolSpans) {
        toolSpans.delete(toolCallId);
        const durationMs = Date.now() - active.startedAt;
        active.span.setAttribute("pi.tool.duration_ms", durationMs);
        active.span.setStatus({ code: SpanStatusCode.ERROR });
        logTelemetryEvent(
          "pi.tool.call.completed",
          {
            conversationId: options.conversationId,
            toolCallId,
            durationMs,
            status: "error",
            reason: "incomplete",
          },
          active.span,
        );
        active.span.end();
      }
    };

    const closeTurn = (isError: boolean, turnIndex?: number) => {
      if (providerSpan) closeProvider(true);
      closeDanglingTools();

      const active = turnSpan;
      turnSpan = undefined;
      if (!active) return;

      const durationMs = Date.now() - active.startedAt;
      active.span.setAttribute("pi.turn.duration_ms", durationMs);
      active.span.setStatus({
        code: isError ? SpanStatusCode.ERROR : SpanStatusCode.OK,
      });
      logTelemetryEvent(
        "pi.model.turn.completed",
        {
          conversationId: options.conversationId,
          ...(turnIndex !== undefined ? { turnIndex } : {}),
          durationMs,
          status: isError ? "error" : "success",
        },
        active.span,
      );
      active.span.end();
    };

    const closeAgent = (isError: boolean) => {
      if (turnSpan) closeTurn(true);

      const active = agentSpan;
      agentSpan = undefined;
      if (!active) return;

      const durationMs = Date.now() - active.startedAt;
      active.span.setAttribute("pi.agent.duration_ms", durationMs);
      active.span.setStatus({
        code: isError ? SpanStatusCode.ERROR : SpanStatusCode.OK,
      });
      logTelemetryEvent(
        "pi.agent.completed",
        {
          conversationId: options.conversationId,
          durationMs,
          status: isError ? "error" : "success",
        },
        active.span,
      );
      active.span.end();
    };

    pi.on("agent_start", (_event, ctx) => {
      if (agentSpan) closeAgent(true);
      agentErrored = false;

      const fields = modelFields(ctx.model);
      const span = tracer.startSpan("pi.agent.run", {
        kind: SpanKind.INTERNAL,
        attributes: {
          "conversation.id": options.conversationId,
          "agent.type": "main",
          ...(fields.provider ? { "gen_ai.system": fields.provider } : {}),
          ...(fields.model ? { "gen_ai.request.model": fields.model } : {}),
        },
      });
      agentSpan = { span, startedAt: Date.now() };
      logTelemetryEvent(
        "pi.agent.started",
        {
          conversationId: options.conversationId,
          agentType: "main",
          ...fields,
        },
        span,
      );
    });

    pi.on("turn_start", (event, ctx) => {
      if (turnSpan) closeTurn(true);

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
        parentContext(agentSpan?.span),
      );
      turnSpan = { span, startedAt: Date.now() };
      logTelemetryEvent(
        "pi.model.turn.started",
        {
          conversationId: options.conversationId,
          turnIndex: event.turnIndex,
          ...fields,
        },
        span,
      );
    });

    pi.on("before_provider_headers", (_event, ctx) => {
      if (providerSpan) closeProvider(true);

      const fields = modelFields(ctx.model);
      const span = tracer.startSpan(
        "pi.provider.ttfb",
        {
          kind: SpanKind.CLIENT,
          attributes: {
            "conversation.id": options.conversationId,
            ...(fields.provider ? { "gen_ai.system": fields.provider } : {}),
            ...(fields.model ? { "gen_ai.request.model": fields.model } : {}),
          },
        },
        parentContext(turnSpan?.span ?? agentSpan?.span),
      );
      providerSpan = { span, startedAt: Date.now() };
      logTelemetryEvent(
        "pi.provider.ttfb.started",
        {
          conversationId: options.conversationId,
          ...fields,
        },
        span,
      );
    });

    pi.on("after_provider_response", (event) => {
      closeProvider(event.status >= 400, event.status);
    });

    pi.on("tool_execution_start", (event) => {
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
        parentContext(turnSpan?.span ?? agentSpan?.span),
      );
      toolSpans.set(event.toolCallId, { span, startedAt: Date.now() });
      logTelemetryEvent(
        "pi.tool.call.started",
        {
          conversationId: options.conversationId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        },
        span,
      );
    });

    pi.on("tool_execution_end", (event) => {
      const active = toolSpans.get(event.toolCallId);
      if (!active) return;

      toolSpans.delete(event.toolCallId);
      const durationMs = Date.now() - active.startedAt;
      active.span.setAttribute("pi.tool.duration_ms", durationMs);
      active.span.setStatus({
        code: event.isError ? SpanStatusCode.ERROR : SpanStatusCode.OK,
      });
      logTelemetryEvent(
        "pi.tool.call.completed",
        {
          conversationId: options.conversationId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          durationMs,
          status: event.isError ? "error" : "success",
        },
        active.span,
      );
      active.span.end();
    });

    pi.on("turn_end", (event) => {
      const isError = assistantMessageHasError(event.message);
      if (isError) agentErrored = true;
      closeTurn(isError, event.turnIndex);
    });

    pi.on("agent_settled", () => {
      closeAgent(agentErrored);
    });
  };
}
