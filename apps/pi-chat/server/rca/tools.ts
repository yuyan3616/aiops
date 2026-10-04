import type {
  LogSearchInput,
  MetricDiscoverInput,
  MetricQueryInput,
  ProviderSet,
  TraceGetInput,
  TraceSearchInput,
} from "./live/providers";
import {
  LIVE_CONTRACT_VERSION,
  LIVE_LIMITS,
  LiveBackendError,
  type LiveProviderResult,
  type LiveTarget,
  type MetricDescriptor,
  validateTimeRange,
} from "./live/types";
import type { Investigation, TimeRange } from "./types";

export const OBSERVABILITY_TOOL_NAMES = [
  "search_traces",
  "get_trace",
  "search_logs",
  "discover_metrics",
  "query_metrics",
] as const;

export type ObservabilityToolName = (typeof OBSERVABILITY_TOOL_NAMES)[number];

export interface ScopeExtensionRequest {
  target?: Record<string, string>;
  window?: TimeRange;
  reason: string;
}

export interface PreparedToolExecution {
  tool: ObservabilityToolName;
  arguments: Record<string, unknown>;
  target: LiveTarget;
  window: TimeRange;
  scopeExtension?: ScopeExtensionRequest;
}

export interface ToolExecution {
  tool: ObservabilityToolName;
  arguments: Record<string, unknown>;
  result: LiveProviderResult<unknown>;
  rawRef?: string;
  summary: string;
  resultStatus: LiveProviderResult<unknown>["status"];
  actualWindow: TimeRange;
  backendAlias: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function cleanString(value: unknown, max = 256): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function cleanTarget(value: unknown): LiveTarget {
  const row = object(value);
  if (!row) return {};
  return {
    ...(cleanString(row.service) ? { service: cleanString(row.service) } : {}),
    ...(cleanString(row.operation) ? { operation: cleanString(row.operation) } : {}),
    ...(cleanString(row.entity) ? { entity: cleanString(row.entity) } : {}),
    ...(cleanString(row.environment) ? { environment: cleanString(row.environment) } : {}),
    ...(cleanString(row.region) ? { region: cleanString(row.region) } : {}),
    ...(cleanString(row.container) ? { container: cleanString(row.container) } : {}),
  };
}

function mergeTarget(base: LiveTarget, requested: LiveTarget): LiveTarget {
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(requested).filter(
        ([, value]) => typeof value === "string" && value.length > 0,
      ),
    ),
  };
}

function targetChanged(base: LiveTarget, requested: LiveTarget): boolean {
  return Object.entries(requested).some(
    ([key, value]) => value !== undefined && value !== base[key as keyof LiveTarget],
  );
}

function timeRange(value: unknown): TimeRange | undefined {
  const row = object(value);
  const from = cleanString(row?.from, 64);
  const to = cleanString(row?.to, 64);
  return from && to ? { from, to } : undefined;
}

function overlaps(a: TimeRange, b: TimeRange): boolean {
  return Date.parse(a.to) > Date.parse(b.from) && Date.parse(a.from) < Date.parse(b.to);
}

function resolveWindow(
  incident: TimeRange,
  value: unknown,
): { window: TimeRange; extension?: ScopeExtensionRequest } {
  const row = object(value);
  if (!row || row.kind === undefined || row.kind === "incident") return { window: incident };
  if (row.kind !== "baseline" && row.kind !== "expanded") {
    throw new LiveBackendError("invalid_query", "Unknown query window kind", {
      backendAlias: "registry",
    });
  }
  const requested = timeRange(row);
  if (!requested) {
    throw new LiveBackendError("invalid_query", "Explicit window requires from/to", {
      backendAlias: "registry",
    });
  }
  validateTimeRange(requested);
  if (row.kind === "baseline") {
    if (overlaps(incident, requested)) {
      throw new LiveBackendError(
        "invalid_query",
        "Baseline window must not overlap incident window",
        {
          backendAlias: "registry",
        },
      );
    }
    return { window: requested };
  }
  const reason = cleanString(row.reason, 500);
  if (!reason) {
    throw new LiveBackendError("invalid_query", "Expanded window requires a reason", {
      backendAlias: "registry",
    });
  }
  return { window: requested, extension: { window: requested, reason } };
}

function sourceContext(investigation: Investigation) {
  if (investigation.source?.kind !== "live" || !investigation.context) {
    throw new Error("legacy_read_only");
  }
  return investigation.context;
}

function auditArguments(
  raw: Record<string, unknown>,
  target: LiveTarget,
  window: TimeRange,
): Record<string, unknown> {
  const { target: _target, window: _window, scopeReason: _scopeReason, ...rest } = raw;
  return {
    ...rest,
    target,
    window,
    windowKind: object(_window)?.kind ?? "incident",
  };
}

function compactUnknown(value: unknown, arrayLimit: number): unknown {
  if (typeof value === "string") return value.slice(0, 2048);
  if (Array.isArray(value)) {
    const selected = value.slice(0, arrayLimit).map((item) => compactUnknown(item, arrayLimit));
    return value.length > selected.length
      ? [...selected, { omittedItems: value.length - selected.length }]
      : selected;
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      compactUnknown(entry, arrayLimit),
    ]),
  );
}

export function compactToolResultForAgent(_tool: ObservabilityToolName, result: unknown): unknown {
  // Budget the final serialized text, including the Specialist wrapper.
  const fits = (value: unknown) =>
    Buffer.byteLength(JSON.stringify({ toolCallId: "C0000000000", result: value }), "utf8") <=
    LIVE_LIMITS.maxAgentToolBytes - 1024;
  if (fits(result)) return result;
  for (const limit of [20, 10, 5, 2]) {
    const compact = compactUnknown(result, limit);
    const wrapped = {
      agentTextTruncated: true,
      truncationReason: `agent_tool_text_limit:${LIVE_LIMITS.maxAgentToolBytes}`,
      result: compact,
    };
    if (fits(wrapped)) return wrapped;
  }
  const row = object(result);
  return {
    agentTextTruncated: true,
    truncationReason: `agent_tool_text_limit:${LIVE_LIMITS.maxAgentToolBytes}`,
    status: row?.status,
    query: row?.query,
    timeRange: row?.timeRange,
    retrievedAt: row?.retrievedAt,
    backendAlias: row?.backendAlias,
    contractVersion: row?.contractVersion,
    warnings: Array.isArray(row?.warnings) ? row?.warnings.slice(0, 5) : [],
    message: "Result exceeded the Agent text budget; use a narrower structured query.",
  };
}

function resultSummary(tool: ObservabilityToolName, result: LiveProviderResult<unknown>): string {
  const data = object(result.data);
  let count: number | undefined;
  if (tool === "search_traces") count = Array.isArray(data?.traces) ? data.traces.length : 0;
  if (tool === "get_trace") {
    const trace = object(data?.trace);
    count = Array.isArray(trace?.spans) ? trace.spans.length : 0;
  }
  if (tool === "search_logs") count = Array.isArray(data?.logs) ? data.logs.length : 0;
  if (tool === "discover_metrics") count = Array.isArray(data?.metrics) ? data.metrics.length : 0;
  if (tool === "query_metrics") count = Array.isArray(data?.series) ? data.series.length : 0;
  return `${tool}: ${result.status}${count === undefined ? "" : `, returned ${count}`}`;
}

function unsupported(
  backendAlias: string,
  window: TimeRange,
  query: Record<string, unknown>,
  warning: string,
): LiveProviderResult<Record<string, never>> {
  return {
    status: "unsupported",
    query,
    timeRange: window,
    retrievedAt: new Date().toISOString(),
    backendAlias,
    contractVersion: LIVE_CONTRACT_VERSION,
    data: {},
    warnings: [warning],
    truncationReasons: [],
  };
}

export class ObservabilityToolRegistry {
  private readonly providers: ProviderSet;
  private readonly allowedTraceIds = new Map<string, Set<string>>();
  private readonly metricCatalog = new Map<string, Map<string, MetricDescriptor>>();

  constructor(providers: ProviderSet) {
    this.providers = providers;
  }

  clearAuthorization(investigationId: string): void {
    this.allowedTraceIds.delete(investigationId);
    this.metricCatalog.delete(investigationId);
  }

  /** Called only after the ToolCall and its snapshot have been committed. */
  authorizeCompletedResult(investigationId: string, tool: string, result: unknown): void {
    const envelope = object(result);
    if (envelope?.status !== "success" && envelope?.status !== "partial") return;
    const data = object(envelope.data);
    if (tool === "search_traces" && Array.isArray(data?.traces)) {
      const allowed = this.allowedTraceIds.get(investigationId) ?? new Set<string>();
      for (const entry of data.traces) {
        const row = object(entry);
        if (typeof row?.traceId === "string") allowed.add(row.traceId);
      }
      this.allowedTraceIds.set(investigationId, allowed);
    }
    if (tool === "discover_metrics" && Array.isArray(data?.metrics)) {
      const catalog =
        this.metricCatalog.get(investigationId) ?? new Map<string, MetricDescriptor>();
      for (const entry of data.metrics) {
        const descriptor = object(entry) as unknown as MetricDescriptor | undefined;
        if (descriptor && typeof descriptor.name === "string")
          catalog.set(descriptor.name, descriptor);
      }
      this.metricCatalog.set(investigationId, catalog);
    }
  }

  names(): readonly ObservabilityToolName[] {
    return OBSERVABILITY_TOOL_NAMES;
  }

  prepare(
    tool: ObservabilityToolName,
    arguments_: Record<string, unknown>,
    investigation: Investigation,
  ): PreparedToolExecution {
    const context = sourceContext(investigation);
    validateTimeRange(context.window);
    const requestedTarget = cleanTarget(arguments_.target);
    const target = mergeTarget(context.target, requestedTarget);
    const scopeReason = cleanString(arguments_.scopeReason, 500);
    let scopeExtension: ScopeExtensionRequest | undefined;
    if (targetChanged(context.target, requestedTarget)) {
      if (!scopeReason) {
        throw new LiveBackendError("invalid_query", "Target expansion requires scopeReason", {
          backendAlias: "registry",
        });
      }
      scopeExtension = {
        target: Object.fromEntries(
          Object.entries(requestedTarget).filter(([, value]) => typeof value === "string"),
        ) as Record<string, string>,
        reason: scopeReason,
      };
    }
    const resolved = resolveWindow(context.window, arguments_.window);
    if (resolved.extension) {
      scopeExtension = scopeExtension
        ? { ...scopeExtension, window: resolved.window }
        : resolved.extension;
    }
    const audit = auditArguments(arguments_, target, resolved.window);
    return {
      tool,
      arguments: audit,
      target,
      window: resolved.window,
      ...(scopeExtension ? { scopeExtension } : {}),
    };
  }

  async executePrepared(
    investigationId: string,
    prepared: PreparedToolExecution,
    signal?: AbortSignal,
  ): Promise<ToolExecution> {
    if (signal?.aborted) throw new DOMException("Investigation cancelled", "AbortError");
    const args = prepared.arguments;
    let result: LiveProviderResult<unknown>;

    switch (prepared.tool) {
      case "search_traces": {
        if (!this.providers.trace) {
          result = unsupported("tempo", prepared.window, args, "Tempo endpoint is not configured.");
          break;
        }
        const input: TraceSearchInput = {
          target: prepared.target,
          window: prepared.window,
          ...(cleanString(args.operation) ? { operation: cleanString(args.operation) } : {}),
          ...(args.status === "ok" || args.status === "error" || args.status === "unset"
            ? { status: args.status }
            : {}),
          ...(typeof args.minDurationMs === "number"
            ? { minDurationMs: Math.max(0, args.minDurationMs) }
            : {}),
          limit: Math.min(
            typeof args.limit === "number" ? Math.floor(args.limit) : 20,
            LIVE_LIMITS.maxTraces,
          ),
        };
        result = await this.providers.trace.searchTraces(input, signal);
        break;
      }
      case "get_trace": {
        if (!this.providers.trace) {
          result = unsupported("tempo", prepared.window, args, "Tempo endpoint is not configured.");
          break;
        }
        const id = cleanString(args.traceId, 64)?.toLowerCase();
        if (!id || !this.allowedTraceIds.get(investigationId)?.has(id)) {
          throw new LiveBackendError(
            "invalid_query",
            "Trace id must come from a successful search_traces call in this investigation.",
            { backendAlias: "tempo" },
          );
        }
        const input: TraceGetInput = {
          target: prepared.target,
          window: prepared.window,
          traceId: id,
        };
        result = await this.providers.trace.getTrace(input, signal);
        break;
      }
      case "search_logs": {
        if (!this.providers.log) {
          result = unsupported("loki", prepared.window, args, "Loki endpoint is not configured.");
          break;
        }
        const keywords = Array.isArray(args.keywords)
          ? args.keywords
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.trim().slice(0, 256))
              .filter(Boolean)
              .slice(0, LIVE_LIMITS.maxKeywords)
          : undefined;
        const input: LogSearchInput = {
          target: prepared.target,
          window: prepared.window,
          ...(cleanString(args.severity, 32) ? { severity: cleanString(args.severity, 32) } : {}),
          ...(cleanString(args.lifecycleStatus, 64)
            ? { lifecycleStatus: cleanString(args.lifecycleStatus, 64) }
            : {}),
          ...(cleanString(args.event, 128) ? { event: cleanString(args.event, 128) } : {}),
          ...(keywords ? { keywords } : {}),
          ...(cleanString(args.traceId, 64) ? { traceId: cleanString(args.traceId, 64) } : {}),
          ...(cleanString(args.spanId, 32) ? { spanId: cleanString(args.spanId, 32) } : {}),
          ...(args.mode === "all" || args.mode === "custom" || args.mode === "anomaly"
            ? { mode: args.mode }
            : {}),
          limit: Math.min(
            typeof args.limit === "number" ? Math.floor(args.limit) : 100,
            LIVE_LIMITS.maxLogs,
          ),
        };
        result = await this.providers.log.searchLogs(input, signal);
        break;
      }
      case "discover_metrics": {
        if (!this.providers.metrics) {
          result = unsupported(
            "prometheus",
            prepared.window,
            args,
            "Prometheus endpoint is not configured.",
          );
          break;
        }
        const input: MetricDiscoverInput = {
          target: prepared.target,
          window: prepared.window,
          ...(cleanString(args.search, 128) ? { search: cleanString(args.search, 128) } : {}),
          limit: Math.min(typeof args.limit === "number" ? Math.floor(args.limit) : 50, 100),
        };
        result = await this.providers.metrics.discoverMetrics(input, signal);
        break;
      }
      case "query_metrics": {
        if (!this.providers.metrics) {
          result = unsupported(
            "prometheus",
            prepared.window,
            args,
            "Prometheus endpoint is not configured.",
          );
          break;
        }
        const metric = cleanString(args.metric, 256);
        if (!metric) {
          throw new LiveBackendError("invalid_query", "metric is required", {
            backendAlias: "prometheus",
          });
        }
        const descriptor = this.metricCatalog.get(investigationId)?.get(metric);
        if (!descriptor) {
          throw new LiveBackendError(
            "invalid_query",
            "Metric must be returned by discover_metrics in this investigation before querying.",
            { backendAlias: "prometheus" },
          );
        }
        const operation =
          args.operation === "rate" ||
          args.operation === "increase" ||
          args.operation === "quantile" ||
          args.operation === "raw"
            ? args.operation
            : "raw";
        const filters = Array.isArray(args.labelFilters)
          ? args.labelFilters
              .map(object)
              .filter((item): item is Record<string, unknown> => Boolean(item))
              .map((item) => ({
                name: cleanString(item.name, 128) ?? "",
                value: cleanString(item.value, LIVE_LIMITS.maxLabelValueChars) ?? "",
              }))
              .filter((item) => item.name && item.value)
              .slice(0, LIVE_LIMITS.maxLabelFilters)
          : undefined;
        const groupBy = Array.isArray(args.groupBy)
          ? args.groupBy
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.trim())
              .filter(Boolean)
              .slice(0, 8)
          : undefined;
        const input: MetricQueryInput = {
          target: prepared.target,
          window: prepared.window,
          metric,
          operation,
          ...(filters ? { labelFilters: filters } : {}),
          ...(args.aggregation === "sum" ||
          args.aggregation === "avg" ||
          args.aggregation === "max" ||
          args.aggregation === "min" ||
          args.aggregation === "none"
            ? { aggregation: args.aggregation }
            : {}),
          ...(groupBy ? { groupBy } : {}),
          ...(typeof args.quantile === "number" ? { quantile: args.quantile } : {}),
          ...(typeof args.stepSeconds === "number"
            ? { stepSeconds: Math.max(1, Math.floor(args.stepSeconds)) }
            : {}),
        };
        result = await this.providers.metrics.queryMetrics(input, descriptor, signal);
        break;
      }
    }

    if (signal?.aborted) throw new DOMException("Investigation cancelled", "AbortError");
    result.sourceItems = sourceItemsForResult(prepared.tool, result);
    return {
      tool: prepared.tool,
      arguments: prepared.arguments,
      result,
      summary: resultSummary(prepared.tool, result),
      resultStatus: result.status,
      actualWindow: prepared.window,
      backendAlias: result.backendAlias,
      rawRef: `${result.backendAlias}://query/${prepared.tool}`,
    };
  }

  capabilitySummary(): Record<string, boolean> {
    return {
      trace: Boolean(this.providers.trace),
      log: Boolean(this.providers.log),
      metrics: Boolean(this.providers.metrics),
      exemplars: false,
      providerAttemptLifecycle: false,
    };
  }
}

export function sourceItemsForResult(tool: string, result: LiveProviderResult<unknown>): string[] {
  const data = object(result.data);
  if (tool === "get_trace") {
    const spans = object(data?.trace)?.spans;
    return Array.isArray(spans)
      ? spans.flatMap((span) => {
          const id = object(span)?.spanId;
          return typeof id === "string" ? [`span:${id}`] : [];
        })
      : [];
  }
  if (tool === "search_traces")
    return Array.isArray(data?.traces)
      ? data.traces.flatMap((trace) => {
          const id = object(trace)?.traceId;
          return typeof id === "string" ? [`trace:${id}`] : [];
        })
      : [];
  if (tool === "search_logs")
    return Array.isArray(data?.logs) ? data.logs.map((_, index) => `log:${index}`) : [];
  if (tool === "query_metrics")
    return Array.isArray(data?.series) ? data.series.map((_, index) => `series:${index}`) : [];
  return Array.isArray(data?.metrics)
    ? data.metrics.flatMap((metric) => {
        const name = object(metric)?.name;
        return typeof name === "string" ? [`metric:${name}`] : [];
      })
    : [];
}
