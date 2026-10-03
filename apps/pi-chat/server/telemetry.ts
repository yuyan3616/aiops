import { trace, type Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { component: "agent-telemetry" },
});

let provider: NodeTracerProvider | undefined;

export function resolveTraceEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const traceEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (traceEndpoint) return traceEndpoint;

  const baseEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!baseEndpoint) return undefined;
  if (baseEndpoint.endsWith("/v1/traces")) return baseEndpoint;
  return `${baseEndpoint.replace(/\/$/, "")}/v1/traces`;
}

export function startTelemetry(env: NodeJS.ProcessEnv = process.env): boolean {
  if (provider) return true;

  const endpoint = resolveTraceEndpoint(env);
  if (!endpoint) {
    logger.info({ event: "otel.tracing.disabled" }, "OpenTelemetry tracing disabled");
    return false;
  }

  try {
    const exporter = new OTLPTraceExporter({ url: endpoint });
    provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        "service.name": env.OTEL_SERVICE_NAME?.trim() || "aiops-rca-target",
        "service.version":
          env.OTEL_SERVICE_VERSION?.trim() || env.PI_CHAT_RELEASE_SHA?.trim() || "unknown",
        "deployment.environment.name":
          env.OTEL_DEPLOYMENT_ENVIRONMENT?.trim() || env.NODE_ENV?.trim() || "development",
      }),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    provider.register();
    logger.info({ event: "otel.tracing.started" }, "OpenTelemetry tracing started");
    return true;
  } catch (error) {
    provider = undefined;
    logger.error(
      {
        event: "otel.tracing.start_failed",
        errorType: error instanceof Error ? error.name : "Error",
      },
      "OpenTelemetry tracing failed to start",
    );
    return false;
  }
}

export async function shutdownTelemetry(): Promise<void> {
  const activeProvider = provider;
  provider = undefined;
  if (!activeProvider) return;

  await activeProvider.shutdown().catch((error) => {
    logger.warn(
      {
        event: "otel.tracing.shutdown_failed",
        errorType: error instanceof Error ? error.name : "Error",
      },
      "OpenTelemetry tracing shutdown failed",
    );
  });
}

export function getTelemetryTracer() {
  return trace.getTracer("pi-chat-agent-runtime");
}

function traceFields(span?: Span): { traceId?: string; spanId?: string } {
  if (!span) return {};
  const spanContext = span.spanContext();
  if (!spanContext.traceId || /^0+$/.test(spanContext.traceId)) return {};
  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
  };
}

export function logTelemetryEvent(
  event: string,
  fields: Record<string, unknown>,
  span?: Span,
): void {
  logger.info(
    {
      event,
      ...fields,
      ...traceFields(span),
    },
    event,
  );
}
