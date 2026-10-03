import type { TimeRange } from "../types";

export const LIVE_CONTRACT_VERSION = "1" as const;
export const LIVE_FORMAT_VERSION = 3 as const;

export type LiveResultStatus = "success" | "no_data" | "partial" | "unsupported";

export type LiveBackendErrorCode =
  | "cancelled"
  | "timeout"
  | "unavailable"
  | "unauthorized"
  | "invalid_query"
  | "not_found"
  | "invalid_response"
  | "rate_limited"
  | "storage_error";

export class LiveBackendError extends Error {
  readonly code: LiveBackendErrorCode;
  readonly retryable: boolean;
  readonly backendAlias: string;
  readonly status?: number;

  constructor(
    code: LiveBackendErrorCode,
    message: string,
    options: {
      backendAlias: string;
      retryable?: boolean;
      status?: number;
      cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LiveBackendError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.backendAlias = options.backendAlias;
    this.status = options.status;
  }
}

export interface LiveProviderResult<T> {
  status: LiveResultStatus;
  query: Record<string, unknown>;
  timeRange: TimeRange;
  retrievedAt: string;
  backendAlias: string;
  contractVersion: typeof LIVE_CONTRACT_VERSION;
  data: T;
  warnings: string[];
  truncationReasons: string[];
}

export interface LiveTarget {
  service?: string;
  operation?: string;
  entity?: string;
  environment?: string;
  region?: string;
  container?: string;
}

export interface LiveTraceSummary {
  traceId: string;
  rootService?: string;
  rootOperation?: string;
  startTime?: string;
  durationMs?: number;
  spanCount?: number;
}

export interface LiveSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  service?: string;
  operation: string;
  startTime?: string;
  endTime?: string;
  durationMs?: number;
  status: "ok" | "error" | "unset";
  attributes: Record<string, string | number | boolean>;
}

export interface LiveTrace {
  traceId: string;
  spans: LiveSpan[];
  completeness: {
    state: "unknown" | "partial";
    truncated: boolean;
    missingParents: boolean;
    unfinishedSpans: boolean;
  };
}

export interface LiveLogRecord {
  timestamp: string;
  timestampSource: "event" | "envelope";
  service?: string;
  severity?: string;
  message: string;
  event?: string;
  lifecycleStatus?: string;
  reason?: string;
  traceId?: string;
  spanId?: string;
  container?: string;
  instance?: string;
}

export interface MetricDescriptor {
  name: string;
  type?: "counter" | "gauge" | "histogram" | "summary" | "unknown";
  unit?: string;
  labels: string[];
  operations: Array<"raw" | "rate" | "increase" | "quantile">;
}

export interface MetricPoint {
  timestamp: string;
  value: number | null;
}

export interface MetricSeries {
  labels: Record<string, string>;
  points: MetricPoint[];
}

export interface MetricQueryData {
  metric: string;
  operation: "raw" | "rate" | "increase" | "quantile";
  metricType?: MetricDescriptor["type"];
  unit?: string;
  series: MetricSeries[];
  stepSeconds: number;
  summary: {
    seriesCount: number;
    datapointCount: number;
    resetHandled: boolean;
    quantileEstimated: boolean;
  };
}

export const LIVE_LIMITS = {
  maxWindowMs: 24 * 60 * 60 * 1000,
  maxTraces: 50,
  maxTraceSpans: 1000,
  maxSpanAttributes: 32,
  maxAttributeValueChars: 1024,
  maxLogs: 200,
  maxLogMessageChars: 2048,
  maxMetricSeries: 20,
  maxMetricDatapoints: 2000,
  maxLabelFilters: 8,
  maxLabelValueChars: 256,
  maxKeywords: 20,
  maxAgentToolBytes: 32 * 1024,
  maxBackendBodyBytes: 4 * 1024 * 1024,
  deadlineMs: 15_000,
  maxExpertResultBytes: 128 * 1024,
  maxExemplars: 20,
} as const;

export function validateTimeRange(range: TimeRange): void {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new LiveBackendError("invalid_query", "Invalid time range", {
      backendAlias: "registry",
    });
  }
  if (to - from > LIVE_LIMITS.maxWindowMs) {
    throw new LiveBackendError("invalid_query", "Query window exceeds 24 hours", {
      backendAlias: "registry",
    });
  }
}

export function normalizeUtc(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid timestamp");
  return date.toISOString();
}

export function validTraceId(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value) && !/^0{32}$/.test(value);
}

export function validSpanId(value: string): boolean {
  return /^[0-9a-f]{16}$/.test(value) && !/^0{16}$/.test(value);
}

export function redactTelemetryText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /\b(api[_-]?key|secret|password|passwd|authorization|token)\b\s*[:=]\s*([^\s,;]+)/gi,
      "$1=[REDACTED]",
    );
}

export function safeAttributeValue(value: unknown): string | number | boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    return redactTelemetryText(value).slice(0, LIVE_LIMITS.maxAttributeValueChars);
  }
  return undefined;
}
