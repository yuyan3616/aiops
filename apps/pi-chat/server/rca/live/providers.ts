import { LiveHttpClient, type LiveHttpClientOptions } from "./http-client";
import {
  LIVE_LIMITS,
  LIVE_CONTRACT_VERSION,
  LiveBackendError,
  type LiveLogRecord,
  type LiveProviderResult,
  type LiveTarget,
  type LiveTrace,
  type LiveTraceSummary,
  type MetricDescriptor,
  type MetricQueryData,
  type MetricSeries,
  redactTelemetryText,
  safeAttributeValue,
  sensitiveTelemetryKey,
  validSpanId,
  validTraceId,
  validateTimeRange,
} from "./types";
import type { TimeRange } from "../types";

export interface ProviderSet {
  trace?: TraceProvider;
  log?: LogProvider;
  metrics?: MetricsProvider;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function now(): string {
  return new Date().toISOString();
}

function unixSeconds(value: string): string {
  return String(Math.floor(Date.parse(value) / 1000));
}

function nanoToIso(value: string): string | undefined {
  try {
    const ns = BigInt(value);
    return new Date(Number(ns / 1_000_000n)).toISOString();
  } catch {
    return undefined;
  }
}

function boundedString(value: unknown, max = 1024): string | undefined {
  if (typeof value !== "string") return undefined;
  return redactTelemetryText(value).slice(0, max);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}


function normalizeOtelId(value: unknown, bytes: 8 | 16): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  const lower = id.toLowerCase();
  if (/^[0-9a-f]+$/.test(lower) && lower.length === bytes * 2) return lower;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(id)) return undefined;
  try {
    const decoded = Buffer.from(id, "base64");
    if (decoded.length !== bytes) return undefined;
    const hex = decoded.toString("hex");
    return /^0+$/.test(hex) ? undefined : hex;
  } catch {
    return undefined;
  }
}

function traceId(value: unknown): string | undefined {
  const id = normalizeOtelId(value, 16);
  return id && validTraceId(id) ? id : undefined;
}

function spanId(value: unknown): string | undefined {
  const id = normalizeOtelId(value, 8);
  return id && validSpanId(id) ? id : undefined;
}

function otlpAttributes(value: unknown): Record<string, string | number | boolean> {
  if (!Array.isArray(value)) return {};
  const output: Record<string, string | number | boolean> = {};
  for (const entry of value.slice(0, LIVE_LIMITS.maxSpanAttributes)) {
    const row = object(entry);
    if (!row || typeof row.key !== "string") continue;
    if (sensitiveTelemetryKey(row.key)) continue;
    const raw = object(row.value);
    const candidate =
      raw?.stringValue ??
      raw?.intValue ??
      raw?.doubleValue ??
      raw?.boolValue ??
      row.value;
    const safe = safeAttributeValue(candidate);
    if (safe !== undefined) output[row.key.slice(0, 128)] = safe;
  }
  return output;
}

function resourceService(resource: unknown): string | undefined {
  const attributes = otlpAttributes(object(resource)?.attributes);
  const value = attributes["service.name"];
  return typeof value === "string" ? value : undefined;
}

function spanStatus(value: unknown): "ok" | "error" | "unset" {
  const row = object(value);
  const code = row?.code;
  if (code === 2 || code === "STATUS_CODE_ERROR" || code === "ERROR") return "error";
  if (code === 1 || code === "STATUS_CODE_OK" || code === "OK") return "ok";
  return "unset";
}

function durationMs(startNs: unknown, endNs: unknown): number | undefined {
  if (typeof startNs !== "string" || typeof endNs !== "string") return undefined;
  try {
    const delta = BigInt(endNs) - BigInt(startNs);
    if (delta < 0) return undefined;
    return Number(delta / 1_000n) / 1_000;
  } catch {
    return undefined;
  }
}

function providerResult<T>(
  backendAlias: string,
  range: TimeRange,
  query: Record<string, unknown>,
  data: T,
  options: {
    status?: LiveProviderResult<T>["status"];
    warnings?: string[];
    truncationReasons?: string[];
  } = {},
): LiveProviderResult<T> {
  return {
    status: options.status ?? "success",
    query,
    timeRange: range,
    retrievedAt: now(),
    backendAlias,
    contractVersion: LIVE_CONTRACT_VERSION,
    data,
    warnings: options.warnings ?? [],
    truncationReasons: options.truncationReasons ?? [],
  };
}

export interface TraceSearchInput {
  target: LiveTarget;
  window: TimeRange;
  operation?: string;
  status?: "ok" | "error" | "unset";
  minDurationMs?: number;
  limit?: number;
}

export interface TraceGetInput {
  traceId: string;
  window: TimeRange;
  target: LiveTarget;
}

export class TraceProvider {
  readonly backendAlias: string;
  private readonly client: LiveHttpClient;

  constructor(options: LiveHttpClientOptions) {
    this.client = new LiveHttpClient(options);
    this.backendAlias = options.backendAlias;
  }

  async searchTraces(
    input: TraceSearchInput,
    signal?: AbortSignal,
  ): Promise<LiveProviderResult<{ traces: LiveTraceSummary[]; sampleCount: number }>> {
    validateTimeRange(input.window);
    const service = input.target.service;
    if (!service) {
      return providerResult(this.backendAlias, input.window, { operation: "search_traces" }, {
        traces: [],
        sampleCount: 0,
      }, {
        status: "unsupported",
        warnings: ["Trace search requires a service target; entity/container are not guessed as service."],
      });
    }
    const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 20), LIVE_LIMITS.maxTraces));
    const predicates = [`resource.service.name = ${quote(service)}`];
    const operation = input.operation ?? input.target.operation;
    if (operation) predicates.push(`name = ${quote(operation)}`);
    if (input.status) predicates.push(`status = ${input.status === "error" ? "error" : input.status}`);
    if (typeof input.minDurationMs === "number" && Number.isFinite(input.minDurationMs)) {
      predicates.push(`duration >= ${Math.max(0, input.minDurationMs)}ms`);
    }
    if (input.target.environment) {
      predicates.push(
        `resource.deployment.environment.name = ${quote(input.target.environment)}`,
      );
    }
    const compiled = `{ ${predicates.join(" && ")} }`;
    const search = new URLSearchParams({
      q: compiled,
      start: unixSeconds(input.window.from),
      end: unixSeconds(input.window.to),
      limit: String(limit),
    });
    const raw = await this.client.requestJson<Record<string, unknown>>({
      path: "/api/search",
      search,
      signal,
    });
    const rows = Array.isArray(raw.traces) ? raw.traces : [];
    const traces: LiveTraceSummary[] = [];
    for (const item of rows.slice(0, limit)) {
      const row = object(item);
      if (!row) continue;
      const id = traceId(row.traceID ?? row.traceId);
      if (!id) continue;
      const startNs = typeof row.startTimeUnixNano === "string" ? row.startTimeUnixNano : undefined;
      const itemDuration =
        typeof row.durationMs === "number"
          ? row.durationMs
          : typeof row.durationMs === "string"
            ? Number(row.durationMs)
            : undefined;
      traces.push({
        traceId: id,
        ...(boundedString(row.rootServiceName, 256)
          ? { rootService: boundedString(row.rootServiceName, 256) }
          : {}),
        ...(boundedString(row.rootTraceName, 256)
          ? { rootOperation: boundedString(row.rootTraceName, 256) }
          : {}),
        ...(startNs && nanoToIso(startNs) ? { startTime: nanoToIso(startNs) } : {}),
        ...(Number.isFinite(itemDuration) ? { durationMs: Number(itemDuration) } : {}),
        ...(typeof row.spanCount === "number" ? { spanCount: row.spanCount } : {}),
      });
    }
    const truncated = rows.length > limit;
    return providerResult(
      this.backendAlias,
      input.window,
      {
        operation: "search_traces",
        target: input.target,
        filters: {
          ...(operation ? { operation } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.minDurationMs !== undefined ? { minDurationMs: input.minDurationMs } : {}),
        },
        limit,
      },
      { traces, sampleCount: traces.length },
      {
        status: traces.length === 0 ? "no_data" : truncated ? "partial" : "success",
        warnings: [
          "Tempo search is a bounded sample; sampleCount is not the total matching trace population.",
        ],
        truncationReasons: truncated ? [`trace_search_limit:${limit}`] : [],
      },
    );
  }

  async getTrace(
    input: TraceGetInput,
    signal?: AbortSignal,
  ): Promise<LiveProviderResult<{ trace: LiveTrace }>> {
    validateTimeRange(input.window);
    const id = input.traceId.toLowerCase();
    if (!validTraceId(id)) {
      throw new LiveBackendError("invalid_query", "Invalid trace id", {
        backendAlias: this.backendAlias,
      });
    }
    const raw = await this.client.requestJson<Record<string, unknown>>({
      path: `/api/v2/traces/${encodeURIComponent(id)}`,
      search: new URLSearchParams({
        start: unixSeconds(input.window.from),
        end: unixSeconds(input.window.to),
      }),
      headers: { Accept: "application/json" },
      signal,
    });
    const batches =
      (Array.isArray(raw.batches) ? raw.batches : undefined) ??
      (Array.isArray(raw.resourceSpans) ? raw.resourceSpans : []);
    const spans: LiveTrace["spans"] = [];
    let sawMore = false;
    for (const batch of batches) {
      const batchRow = object(batch);
      const service = resourceService(batchRow?.resource);
      const scopeGroups =
        (Array.isArray(batchRow?.scopeSpans) ? batchRow.scopeSpans : undefined) ??
        (Array.isArray(batchRow?.instrumentationLibrarySpans)
          ? batchRow.instrumentationLibrarySpans
          : []);
      for (const group of scopeGroups) {
        const groupRow = object(group);
        const rawSpans = Array.isArray(groupRow?.spans) ? groupRow.spans : [];
        for (const rawSpan of rawSpans) {
          if (spans.length >= LIVE_LIMITS.maxTraceSpans) {
            sawMore = true;
            break;
          }
          const row = object(rawSpan);
          if (!row) continue;
          const currentTraceId = traceId(row.traceId ?? row.traceID) ?? id;
          const currentSpanId = spanId(row.spanId ?? row.spanID);
          if (!currentSpanId) continue;
          const parent = spanId(row.parentSpanId ?? row.parentSpanID);
          const startNs =
            typeof row.startTimeUnixNano === "string" ? row.startTimeUnixNano : undefined;
          const endNs = typeof row.endTimeUnixNano === "string" ? row.endTimeUnixNano : undefined;
          spans.push({
            traceId: currentTraceId,
            spanId: currentSpanId,
            ...(parent ? { parentSpanId: parent } : {}),
            ...(service ? { service } : {}),
            operation: boundedString(row.name, 256) ?? "unknown",
            ...(startNs && nanoToIso(startNs) ? { startTime: nanoToIso(startNs) } : {}),
            ...(endNs && nanoToIso(endNs) ? { endTime: nanoToIso(endNs) } : {}),
            ...(durationMs(startNs, endNs) !== undefined
              ? { durationMs: durationMs(startNs, endNs) }
              : {}),
            status: spanStatus(row.status),
            attributes: otlpAttributes(row.attributes),
          });
        }
        if (sawMore) break;
      }
      if (sawMore) break;
    }
    const ids = new Set(spans.map((span) => span.spanId));
    const missingParents = spans.some((span) => span.parentSpanId && !ids.has(span.parentSpanId));
    const unfinishedSpans = spans.some((span) => !span.endTime);
    const trace: LiveTrace = {
      traceId: id,
      spans,
      completeness: {
        state: sawMore || missingParents || unfinishedSpans ? "partial" : "unknown",
        truncated: sawMore,
        missingParents,
        unfinishedSpans,
      },
    };
    return providerResult(
      this.backendAlias,
      input.window,
      { operation: "get_trace", traceId: id, target: input.target },
      { trace },
      {
        status: spans.length === 0 ? "no_data" : sawMore ? "partial" : "success",
        warnings: [
          "Trace completeness is unknown unless the backend provides explicit sampling/completeness metadata.",
        ],
        truncationReasons: sawMore ? [`trace_span_limit:${LIVE_LIMITS.maxTraceSpans}`] : [],
      },
    );
  }
}

export interface LogProviderOptions extends LiveHttpClientOptions {
  serviceLabel?: string;
  environmentLabel?: string;
  containerLabel?: string;
}

export interface LogSearchInput {
  target: LiveTarget;
  window: TimeRange;
  severity?: string;
  lifecycleStatus?: string;
  event?: string;
  keywords?: string[];
  traceId?: string;
  spanId?: string;
  mode?: "anomaly" | "all" | "custom";
  limit?: number;
}

function labelName(value: string | undefined, fallback: string): string {
  const candidate = value ?? fallback;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(candidate)) throw new Error("Invalid backend label mapping");
  return candidate;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&");
}

function parseSeverity(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim().toLowerCase().slice(0, 32);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  if (numeric >= 60) return "fatal";
  if (numeric >= 50) return "error";
  if (numeric >= 40) return "warn";
  if (numeric >= 30) return "info";
  if (numeric >= 20) return "debug";
  return "trace";
}

function logTimestamp(rawNs: string): string {
  return nanoToIso(rawNs) ?? new Date(0).toISOString();
}

function parseJsonLine(line: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(line);
    return object(parsed) ?? { message: line };
  } catch {
    return { message: line };
  }
}

function decodeLogLine(
  line: string,
  envelopeNs: string,
  stream: Record<string, unknown>,
): LiveLogRecord {
  const outer = parseJsonLine(line);
  const nestedText =
    typeof outer.log === "string"
      ? outer.log
      : typeof outer.body === "string"
        ? outer.body
        : undefined;
  const inner = nestedText ? parseJsonLine(nestedText.trim()) : outer;
  const rawMessage =
    inner.msg ??
    inner.message ??
    inner.body ??
    outer.msg ??
    outer.message ??
    nestedText ??
    line;
  const eventTime =
    [inner.time, inner.timestamp, outer.time, outer.timestamp].find(
      (value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)),
    );
  const normalizedTrace = traceId(inner.traceId ?? inner.trace_id ?? outer.traceId ?? outer.trace_id);
  const normalizedSpan = spanId(inner.spanId ?? inner.span_id ?? outer.spanId ?? outer.span_id);
  return {
    timestamp: eventTime ? new Date(eventTime).toISOString() : logTimestamp(envelopeNs),
    timestampSource: eventTime ? "event" : "envelope",
    ...(boundedString(inner.service ?? stream.service_name ?? stream.service, 256)
      ? { service: boundedString(inner.service ?? stream.service_name ?? stream.service, 256) }
      : {}),
    ...(parseSeverity(inner.level ?? inner.severity ?? outer.level)
      ? { severity: parseSeverity(inner.level ?? inner.severity ?? outer.level) }
      : {}),
    message: redactTelemetryText(String(rawMessage)).slice(0, LIVE_LIMITS.maxLogMessageChars),
    ...(boundedString(inner.event, 128) ? { event: boundedString(inner.event, 128) } : {}),
    ...(boundedString(inner.lifecycleStatus ?? inner.lifecycle_status, 64)
      ? { lifecycleStatus: boundedString(inner.lifecycleStatus ?? inner.lifecycle_status, 64) }
      : {}),
    ...(boundedString(inner.reason, 256) ? { reason: boundedString(inner.reason, 256) } : {}),
    ...(normalizedTrace ? { traceId: normalizedTrace } : {}),
    ...(normalizedSpan ? { spanId: normalizedSpan } : {}),
    ...(boundedString(stream.container ?? inner.container, 256)
      ? { container: boundedString(stream.container ?? inner.container, 256) }
      : {}),
    ...(boundedString(stream.instance ?? inner.instance, 256)
      ? { instance: boundedString(stream.instance ?? inner.instance, 256) }
      : {}),
  };
}

function logMatches(record: LiveLogRecord, input: LogSearchInput): boolean {
  if (input.severity && record.severity?.toLowerCase() !== input.severity.toLowerCase()) return false;
  if (
    input.lifecycleStatus &&
    record.lifecycleStatus?.toLowerCase() !== input.lifecycleStatus.toLowerCase()
  ) return false;
  if (input.event && record.event?.toLowerCase() !== input.event.toLowerCase()) return false;
  if (input.traceId && record.traceId !== input.traceId.toLowerCase()) return false;
  if (input.spanId && record.spanId !== input.spanId.toLowerCase()) return false;
  return true;
}

export class LogProvider {
  readonly backendAlias: string;
  private readonly client: LiveHttpClient;
  private readonly serviceLabel: string;
  private readonly environmentLabel: string;
  private readonly containerLabel: string;

  constructor(options: LogProviderOptions) {
    this.client = new LiveHttpClient(options);
    this.backendAlias = options.backendAlias;
    this.serviceLabel = labelName(options.serviceLabel, "service_name");
    this.environmentLabel = labelName(options.environmentLabel, "environment");
    this.containerLabel = labelName(options.containerLabel, "container");
  }

  async searchLogs(
    input: LogSearchInput,
    signal?: AbortSignal,
  ): Promise<LiveProviderResult<{ logs: LiveLogRecord[]; sampleCount: number; matched: "unknown" }>> {
    validateTimeRange(input.window);
    const matchers: string[] = [];
    if (input.target.service) matchers.push(`${this.serviceLabel}=${quote(input.target.service)}`);
    if (input.target.environment) {
      matchers.push(`${this.environmentLabel}=${quote(input.target.environment)}`);
    }
    if (input.target.container) {
      matchers.push(`${this.containerLabel}=${quote(input.target.container)}`);
    }
    if (matchers.length === 0) {
      return providerResult(
        this.backendAlias,
        input.window,
        { operation: "search_logs" },
        { logs: [], sampleCount: 0, matched: "unknown" as const },
        {
          status: "unsupported",
          warnings: ["Log search requires a configured service/environment/container label target."],
        },
      );
    }

    const mode = input.mode ?? (input.keywords?.length ? "custom" : "anomaly");
    const defaultKeywords = ["error", "exception", "timeout", "failed", "retry"];
    const keywords =
      mode === "all"
        ? []
        : (input.keywords?.length ? input.keywords : defaultKeywords)
            .map((value) => value.trim())
            .filter(Boolean)
            .slice(0, LIVE_LIMITS.maxKeywords);
    if (mode === "custom" && keywords.length === 0) {
      throw new LiveBackendError("invalid_query", "custom log mode requires keywords", {
        backendAlias: this.backendAlias,
      });
    }
    let query = `{${matchers.join(",")}}`;
    if (keywords.length) {
      query += ` |~ ${quote(`(?i)(${keywords.map(regexEscape).join("|")})`)}`;
    }
    const normalizedTraceId = input.traceId ? traceId(input.traceId) : undefined;
    if (input.traceId && !normalizedTraceId) {
      throw new LiveBackendError("invalid_query", "Invalid log trace id", {
        backendAlias: this.backendAlias,
      });
    }
    const normalizedSpanId = input.spanId ? spanId(input.spanId) : undefined;
    if (input.spanId && !normalizedSpanId) {
      throw new LiveBackendError("invalid_query", "Invalid log span id", {
        backendAlias: this.backendAlias,
      });
    }
    if (normalizedTraceId) query += ` |= ${quote(normalizedTraceId)}`;
    if (normalizedSpanId) query += ` |= ${quote(normalizedSpanId)}`;
    const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 100), LIVE_LIMITS.maxLogs));
    const search = new URLSearchParams({
      query,
      start: String(BigInt(Date.parse(input.window.from)) * 1_000_000n),
      end: String(BigInt(Date.parse(input.window.to)) * 1_000_000n),
      limit: String(limit),
      direction: "backward",
    });
    const raw = await this.client.requestJson<Record<string, unknown>>({
      path: "/loki/api/v1/query_range",
      search,
      signal,
    });
    const result = object(raw.data)?.result;
    const logs: LiveLogRecord[] = [];
    if (Array.isArray(result)) {
      for (const series of result) {
        const row = object(series);
        const stream = object(row?.stream) ?? {};
        const values = Array.isArray(row?.values) ? row.values : [];
        for (const item of values) {
          if (logs.length >= limit) break;
          if (!Array.isArray(item) || typeof item[0] !== "string" || typeof item[1] !== "string") {
            continue;
          }
          const record = decodeLogLine(item[1], item[0], stream);
          if (
            logMatches(record, {
              ...input,
              ...(normalizedTraceId ? { traceId: normalizedTraceId } : {}),
              ...(normalizedSpanId ? { spanId: normalizedSpanId } : {}),
            })
          ) {
            logs.push(record);
          }
        }
        if (logs.length >= limit) break;
      }
    }
    logs.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const atLimit = logs.length >= limit;
    return providerResult(
      this.backendAlias,
      input.window,
      {
        operation: "search_logs",
        target: input.target,
        mode,
        effectiveKeywords: keywords,
        filters: {
          ...(input.severity ? { severity: input.severity } : {}),
          ...(input.lifecycleStatus ? { lifecycleStatus: input.lifecycleStatus } : {}),
          ...(input.event ? { event: input.event } : {}),
          ...(normalizedTraceId ? { traceId: normalizedTraceId } : {}),
          ...(normalizedSpanId ? { spanId: normalizedSpanId } : {}),
        },
        limit,
      },
      { logs, sampleCount: logs.length, matched: "unknown" },
      {
        status: logs.length === 0 ? "no_data" : atLimit ? "partial" : "success",
        warnings: [
          "matched is unknown because this bounded query returns samples rather than a complete backend aggregate.",
        ],
        truncationReasons: atLimit ? [`log_limit:${limit}`] : [],
      },
    );
  }
}

export interface MetricsProviderOptions extends LiveHttpClientOptions {
  serviceLabel?: string;
  environmentLabel?: string;
  containerLabel?: string;
}

export interface MetricDiscoverInput {
  target: LiveTarget;
  window: TimeRange;
  search?: string;
  limit?: number;
}

export interface MetricLabelFilter {
  name: string;
  value: string;
}

export interface MetricQueryInput {
  target: LiveTarget;
  window: TimeRange;
  metric: string;
  operation: "raw" | "rate" | "increase" | "quantile";
  labelFilters?: MetricLabelFilter[];
  aggregation?: "none" | "sum" | "avg" | "max" | "min";
  groupBy?: string[];
  quantile?: number;
  stepSeconds?: number;
}

function metricName(value: string): string {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(value)) {
    throw new LiveBackendError("invalid_query", "Invalid metric name", {
      backendAlias: "prometheus",
    });
  }
  return value;
}

function metricLabel(value: string): string {
  if (sensitiveTelemetryKey(value)) {
    throw new LiveBackendError("invalid_query", "Sensitive metric labels cannot be queried", {
      backendAlias: "prometheus",
    });
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new LiveBackendError("invalid_query", "Invalid metric label", {
      backendAlias: "prometheus",
    });
  }
  return value;
}

function promMatchers(
  target: LiveTarget,
  serviceLabel: string,
  environmentLabel: string,
  containerLabel: string,
  extra: MetricLabelFilter[] = [],
): string[] {
  const output: string[] = [];
  if (target.service) output.push(`${serviceLabel}=${quote(target.service)}`);
  if (target.environment) output.push(`${environmentLabel}=${quote(target.environment)}`);
  if (target.container) output.push(`${containerLabel}=${quote(target.container)}`);
  for (const filter of extra.slice(0, LIVE_LIMITS.maxLabelFilters)) {
    const name = metricLabel(filter.name);
    if (filter.value.length > LIVE_LIMITS.maxLabelValueChars) {
      throw new LiveBackendError("invalid_query", "Metric label value is too long", {
        backendAlias: "prometheus",
      });
    }
    output.push(`${name}=${quote(filter.value)}`);
  }
  return output;
}

function durationSeconds(range: TimeRange): number {
  return Math.max(1, Math.ceil((Date.parse(range.to) - Date.parse(range.from)) / 1000));
}

function descriptorType(value: unknown): MetricDescriptor["type"] {
  return value === "counter" || value === "gauge" || value === "histogram" || value === "summary"
    ? value
    : "unknown";
}

function allowedOps(type: MetricDescriptor["type"]): MetricDescriptor["operations"] {
  if (type === "counter") return ["rate", "increase"];
  if (type === "histogram") return ["quantile"];
  if (type === "gauge") return ["raw"];
  return ["raw"];
}

function aggregatePromql(
  expression: string,
  aggregation: MetricQueryInput["aggregation"],
  groupBy: string[],
): string {
  if (!aggregation || aggregation === "none") return expression;
  const labels = groupBy.map(metricLabel);
  return labels.length
    ? `${aggregation} by (${labels.join(",")}) (${expression})`
    : `${aggregation}(${expression})`;
}

export class MetricsProvider {
  readonly backendAlias: string;
  private readonly client: LiveHttpClient;
  private readonly serviceLabel: string;
  private readonly environmentLabel: string;
  private readonly containerLabel: string;

  constructor(options: MetricsProviderOptions) {
    this.client = new LiveHttpClient(options);
    this.backendAlias = options.backendAlias;
    this.serviceLabel = labelName(options.serviceLabel, "service");
    this.environmentLabel = labelName(options.environmentLabel, "environment");
    this.containerLabel = labelName(options.containerLabel, "container");
  }

  async discoverMetrics(
    input: MetricDiscoverInput,
    signal?: AbortSignal,
  ): Promise<LiveProviderResult<{ metrics: MetricDescriptor[] }>> {
    validateTimeRange(input.window);
    const matchers = promMatchers(
      input.target,
      this.serviceLabel,
      this.environmentLabel,
      this.containerLabel,
    );
    if (matchers.length === 0) {
      return providerResult(
        this.backendAlias,
        input.window,
        { operation: "discover_metrics" },
        { metrics: [] },
        {
          status: "unsupported",
          warnings: ["Metric discovery requires a mapped service/environment/container target."],
        },
      );
    }
    const search = new URLSearchParams({
      "match[]": `{${matchers.join(",")}}`,
      start: unixSeconds(input.window.from),
      end: unixSeconds(input.window.to),
    });
    const deadlineAt = Date.now() + LIVE_LIMITS.deadlineMs;
    const raw = await this.client.requestJson<Record<string, unknown>>({
      path: "/api/v1/series",
      search,
      signal,
      deadlineAt,
    });
    const series = Array.isArray(raw.data) ? raw.data : [];
    const names = [...new Set(series.map((entry) => object(entry)?.__name__).filter(
      (value): value is string => typeof value === "string" && /^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(value),
    ))];
    const searchTerm = input.search?.trim().toLowerCase();
    const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 50), 100));
    const selected = names
      .filter((name) => !searchTerm || name.toLowerCase().includes(searchTerm))
      .slice(0, limit);
    const descriptors = await Promise.all(
      selected.map(async (name): Promise<MetricDescriptor> => {
        const metadataSearch = new URLSearchParams({ metric: name, limit: "1" });
        const metadata = await this.client.requestJson<Record<string, unknown>>({
          path: "/api/v1/metadata",
          search: metadataSearch,
          signal,
          deadlineAt,
        });
        const rows = object(metadata.data)?.[name];
        const first = Array.isArray(rows) ? object(rows[0]) : undefined;
        const type = descriptorType(first?.type);
        const unit = boundedString(first?.unit, 64);
        const labels = [...new Set(
          series
            .filter((entry) => object(entry)?.__name__ === name)
            .flatMap((entry) => Object.keys(object(entry) ?? {}))
            .filter((label) => label !== "__name__" && !sensitiveTelemetryKey(label)),
        )].slice(0, 32);
        return {
          name,
          type,
          ...(unit ? { unit } : {}),
          labels,
          operations: allowedOps(type),
        };
      }),
    );
    const truncated = names.length > selected.length;
    return providerResult(
      this.backendAlias,
      input.window,
      { operation: "discover_metrics", target: input.target, search: input.search, limit },
      { metrics: descriptors },
      {
        status: descriptors.length === 0 ? "no_data" : truncated ? "partial" : "success",
        truncationReasons: truncated ? [`metric_discovery_limit:${limit}`] : [],
      },
    );
  }

  async queryMetrics(
    input: MetricQueryInput,
    descriptor: MetricDescriptor,
    signal?: AbortSignal,
  ): Promise<LiveProviderResult<MetricQueryData>> {
    validateTimeRange(input.window);
    const metric = metricName(input.metric);
    if (descriptor.name !== metric) {
      throw new LiveBackendError("invalid_query", "Metric was not authorized by discovery", {
        backendAlias: this.backendAlias,
      });
    }
    if (!descriptor.operations.includes(input.operation)) {
      return providerResult(
        this.backendAlias,
        input.window,
        { operation: "query_metrics", metric, requestedOperation: input.operation },
        {
          metric,
          operation: input.operation,
          metricType: descriptor.type,
          ...(descriptor.unit ? { unit: descriptor.unit } : {}),
          series: [],
          stepSeconds: 0,
          summary: {
            seriesCount: 0,
            datapointCount: 0,
            resetHandled: false,
            quantileEstimated: false,
          },
        },
        {
          status: "unsupported",
          warnings: [`Operation ${input.operation} is not valid for ${descriptor.type ?? "unknown"} metric ${metric}.`],
        },
      );
    }
    const filters = input.labelFilters ?? [];
    if (filters.length > LIVE_LIMITS.maxLabelFilters) {
      throw new LiveBackendError("invalid_query", "Too many metric label filters", {
        backendAlias: this.backendAlias,
      });
    }
    const matchers = promMatchers(
      input.target,
      this.serviceLabel,
      this.environmentLabel,
      this.containerLabel,
      filters,
    );
    const selectorMetric =
      descriptor.type === "histogram" && input.operation === "quantile" && !metric.endsWith("_bucket")
        ? `${metric}_bucket`
        : metric;
    const selector = `${selectorMetric}{${matchers.join(",")}}`;
    const rangeSeconds = durationSeconds(input.window);
    const rangeSelector = `${Math.max(60, Math.min(rangeSeconds, 3600))}s`;
    let expression: string;
    let quantileEstimated = false;
    let resetHandled = false;
    if (input.operation === "rate") {
      expression = `rate(${selector}[${rangeSelector}])`;
      resetHandled = true;
    } else if (input.operation === "increase") {
      expression = `increase(${selector}[${rangeSelector}])`;
      resetHandled = true;
    } else if (input.operation === "quantile") {
      const q = input.quantile ?? 0.95;
      if (!Number.isFinite(q) || q <= 0 || q >= 1) {
        throw new LiveBackendError("invalid_query", "Histogram quantile must be between 0 and 1", {
          backendAlias: this.backendAlias,
        });
      }
      const groups = [...new Set(["le", ...(input.groupBy ?? []).map(metricLabel)])];
      expression = `histogram_quantile(${q}, sum by (${groups.join(",")}) (rate(${selector}[${rangeSelector}])))`;
      quantileEstimated = true;
      resetHandled = true;
    } else {
      expression = selector;
    }
    if (input.operation !== "quantile") {
      expression = aggregatePromql(expression, input.aggregation, input.groupBy ?? []);
    }

    const maxStepByPoints = Math.ceil(
      rangeSeconds / Math.max(1, Math.floor(LIVE_LIMITS.maxMetricDatapoints / LIVE_LIMITS.maxMetricSeries)),
    );
    const requestedStep = Math.max(1, Math.floor(input.stepSeconds ?? 30));
    const stepSeconds = Math.max(requestedStep, maxStepByPoints);
    const search = new URLSearchParams({
      query: expression,
      start: unixSeconds(input.window.from),
      end: unixSeconds(input.window.to),
      step: String(stepSeconds),
    });
    const raw = await this.client.requestJson<Record<string, unknown>>({
      path: "/api/v1/query_range",
      search,
      signal,
    });
    const rows = Array.isArray(object(raw.data)?.result) ? (object(raw.data)?.result as unknown[]) : [];
    const series: MetricSeries[] = [];
    let datapoints = 0;
    let truncated = false;
    for (const item of rows) {
      if (series.length >= LIVE_LIMITS.maxMetricSeries) {
        truncated = true;
        break;
      }
      const row = object(item);
      if (!row) continue;
      const labels = Object.fromEntries(
        Object.entries(object(row.metric) ?? {})
          .filter(
            ([key, value]) =>
              key !== "__name__" &&
              !sensitiveTelemetryKey(key) &&
              typeof value === "string",
          )
          .slice(0, 32)
          .map(([key, value]) => [key, redactTelemetryText(String(value)).slice(0, 256)]),
      );
      const values = Array.isArray(row.values) ? row.values : [];
      const points: MetricSeries["points"] = [];
      for (const point of values) {
        if (datapoints >= LIVE_LIMITS.maxMetricDatapoints) {
          truncated = true;
          break;
        }
        if (!Array.isArray(point) || point.length < 2) continue;
        const seconds = Number(point[0]);
        const numeric = Number(point[1]);
        if (!Number.isFinite(seconds)) continue;
        points.push({
          timestamp: new Date(seconds * 1000).toISOString(),
          value: Number.isFinite(numeric) ? numeric : null,
        });
        datapoints++;
      }
      series.push({ labels, points });
      if (truncated) break;
    }
    const status =
      series.length === 0 ? "no_data" : truncated || stepSeconds > requestedStep ? "partial" : "success";
    const warnings = [
      ...(stepSeconds > requestedStep
        ? [`stepSeconds adjusted from ${requestedStep} to ${stepSeconds} to respect datapoint limits.`]
        : []),
      ...(quantileEstimated
        ? ["Histogram quantile is estimated from classic buckets and is not an exact raw-request percentile."]
        : []),
    ];
    return providerResult(
      this.backendAlias,
      input.window,
      {
        operation: "query_metrics",
        target: input.target,
        metric,
        metricType: descriptor.type,
        requestedOperation: input.operation,
        labelFilters: filters,
        aggregation: input.aggregation ?? "none",
        groupBy: input.groupBy ?? [],
        stepSeconds,
        ...(input.operation === "quantile" ? { quantile: input.quantile ?? 0.95 } : {}),
      },
      {
        metric,
        operation: input.operation,
        metricType: descriptor.type,
        ...(descriptor.unit ? { unit: descriptor.unit } : {}),
        series,
        stepSeconds,
        summary: {
          seriesCount: series.length,
          datapointCount: datapoints,
          resetHandled,
          quantileEstimated,
        },
      },
      {
        status,
        warnings,
        truncationReasons: truncated
          ? [
              ...(rows.length > LIVE_LIMITS.maxMetricSeries
                ? [`metric_series_limit:${LIVE_LIMITS.maxMetricSeries}`]
                : []),
              ...(datapoints >= LIVE_LIMITS.maxMetricDatapoints
                ? [`metric_datapoint_limit:${LIVE_LIMITS.maxMetricDatapoints}`]
                : []),
            ]
          : [],
      },
    );
  }
}
