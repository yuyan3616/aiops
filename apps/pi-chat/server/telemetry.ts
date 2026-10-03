import { trace, type Span } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  createPiRuntimeMetricViews,
  PiRuntimeMetrics,
  type RuntimeMetricRecorder,
} from "@server/observability/pi-runtime-metrics";
import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { component: "agent-telemetry" },
});

let traceProvider: NodeTracerProvider | undefined;
let metricProvider: MeterProvider | undefined;
let runtimeMetrics: RuntimeMetricRecorder | undefined;
let started = false;

type TelemetrySignal = "traces" | "metrics";
type TelemetryLogLevel = "info" | "warn" | "error";

export interface TelemetryCapabilities {
  tracing: boolean;
  metrics: boolean;
  exemplars: false;
  providerGenerationLifecycle: boolean;
  providerAttemptLifecycle: false;
}

function resolveSignalEndpoint(
  signal: TelemetrySignal,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const signalEndpoint =
    signal === "traces"
      ? env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
      : env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim();
  if (signalEndpoint) return signalEndpoint;

  const baseEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!baseEndpoint) return undefined;
  const suffix = signal === "traces" ? "/v1/traces" : "/v1/metrics";
  if (baseEndpoint.endsWith(suffix)) return baseEndpoint;
  return `${baseEndpoint.replace(/\/$/, "")}${suffix}`;
}

export function resolveTraceEndpoint(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return resolveSignalEndpoint("traces", env);
}

export function resolveMetricsEndpoint(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return resolveSignalEndpoint("metrics", env);
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveServiceInstanceId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.OTEL_SERVICE_INSTANCE_ID?.trim() || env.HOSTNAME?.trim() || undefined;
}

function telemetryResource(env: NodeJS.ProcessEnv) {
  const serviceInstanceId = resolveServiceInstanceId(env);
  return resourceFromAttributes({
    "service.name": env.OTEL_SERVICE_NAME?.trim() || "aiops-rca-target",
    "service.version":
      env.OTEL_SERVICE_VERSION?.trim() || env.PI_CHAT_RELEASE_SHA?.trim() || "unknown",
    "deployment.environment.name":
      env.OTEL_DEPLOYMENT_ENVIRONMENT?.trim() || env.NODE_ENV?.trim() || "development",
    ...(serviceInstanceId ? { "service.instance.id": serviceInstanceId } : {}),
  });
}

export function startTelemetry(env: NodeJS.ProcessEnv = process.env): boolean {
  if (started) return Boolean(traceProvider || metricProvider);
  started = true;

  const resource = telemetryResource(env);
  const traceEndpoint = resolveTraceEndpoint(env);
  const metricsEndpoint = resolveMetricsEndpoint(env);

  if (traceEndpoint) {
    try {
      const exporter = new OTLPTraceExporter({ url: traceEndpoint });
      const nextTraceProvider = new NodeTracerProvider({
        resource,
        spanProcessors: [new BatchSpanProcessor(exporter)],
      });
      nextTraceProvider.register();
      traceProvider = nextTraceProvider;
      logger.info({ event: "otel.tracing.started" }, "OpenTelemetry tracing started");
    } catch (error) {
      traceProvider = undefined;
      logger.error(
        {
          event: "otel.tracing.start_failed",
          errorType: error instanceof Error ? error.name : "Error",
        },
        "OpenTelemetry tracing failed to start",
      );
    }
  } else {
    logger.info({ event: "otel.tracing.disabled" }, "OpenTelemetry tracing disabled");
  }

  if (metricsEndpoint) {
    try {
      const exporter = new OTLPMetricExporter({ url: metricsEndpoint });
      const exportIntervalMillis = positiveInteger(env.OTEL_METRIC_EXPORT_INTERVAL_MS, 15_000);
      const requestedTimeout = positiveInteger(env.OTEL_METRIC_EXPORT_TIMEOUT_MS, 5_000);
      const exportTimeoutMillis = Math.min(requestedTimeout, exportIntervalMillis);
      const reader = new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis,
        exportTimeoutMillis,
        cardinalityLimits: {
          counter: 1024,
          histogram: 1024,
          default: 1024,
        },
      });
      const nextMetricProvider = new MeterProvider({
        resource,
        readers: [reader],
        views: createPiRuntimeMetricViews(),
      });
      runtimeMetrics = new PiRuntimeMetrics(
        nextMetricProvider.getMeter("pi-chat-agent-runtime", "1.0.0"),
        env,
        (operation, error) => {
          logger.warn(
            {
              event: "otel.metrics.record_failed",
              operation,
              errorType: error instanceof Error ? error.name : "Error",
            },
            "OpenTelemetry metric recording failed",
          );
        },
      );
      metricProvider = nextMetricProvider;
      logger.info(
        {
          event: "otel.metrics.started",
          exportIntervalMillis,
          exportTimeoutMillis,
          exemplars: false,
        },
        "OpenTelemetry metrics started",
      );
    } catch (error) {
      metricProvider = undefined;
      runtimeMetrics = undefined;
      logger.error(
        {
          event: "otel.metrics.start_failed",
          errorType: error instanceof Error ? error.name : "Error",
        },
        "OpenTelemetry metrics failed to start",
      );
    }
  } else {
    logger.info({ event: "otel.metrics.disabled" }, "OpenTelemetry metrics disabled");
  }

  logger.info(
    {
      event: "otel.capabilities",
      ...getTelemetryCapabilities(),
    },
    "OpenTelemetry capability state",
  );
  return Boolean(traceProvider || metricProvider);
}

async function flushAndShutdown(
  signal: "tracing" | "metrics",
  provider:
    | Pick<NodeTracerProvider, "forceFlush" | "shutdown">
    | Pick<MeterProvider, "forceFlush" | "shutdown">
    | undefined,
): Promise<void> {
  if (!provider) return;
  try {
    await provider.forceFlush();
  } catch (error) {
    logger.warn(
      {
        event: `otel.${signal}.flush_failed`,
        errorType: error instanceof Error ? error.name : "Error",
      },
      `OpenTelemetry ${signal} flush failed`,
    );
  }
  try {
    await provider.shutdown();
  } catch (error) {
    logger.warn(
      {
        event: `otel.${signal}.shutdown_failed`,
        errorType: error instanceof Error ? error.name : "Error",
      },
      `OpenTelemetry ${signal} shutdown failed`,
    );
  }
}

export async function shutdownTelemetry(): Promise<void> {
  const activeTraceProvider = traceProvider;
  const activeMetricProvider = metricProvider;
  traceProvider = undefined;
  metricProvider = undefined;
  runtimeMetrics = undefined;
  started = false;

  await Promise.all([
    flushAndShutdown("tracing", activeTraceProvider),
    flushAndShutdown("metrics", activeMetricProvider),
  ]);
}

export function getTelemetryTracer() {
  return trace.getTracer("pi-chat-agent-runtime");
}

export function getRuntimeMetrics(): RuntimeMetricRecorder | undefined {
  return runtimeMetrics;
}

export function getTelemetryCapabilities(): TelemetryCapabilities {
  return {
    tracing: Boolean(traceProvider),
    metrics: Boolean(metricProvider),
    exemplars: false,
    providerGenerationLifecycle: true,
    providerAttemptLifecycle: false,
  };
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
  level: TelemetryLogLevel = "info",
): void {
  const payload = {
    event,
    ...fields,
    ...traceFields(span),
  };
  if (level === "error") {
    logger.error(payload, event);
  } else if (level === "warn") {
    logger.warn(payload, event);
  } else {
    logger.info(payload, event);
  }
}
