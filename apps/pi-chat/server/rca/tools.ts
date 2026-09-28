import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  RCA100Adapter,
  type AlertQuery,
  type EventQuery,
  type LogQuery,
  type MetricQuery,
  type TraceQuery,
} from "./adapter";

export const OBSERVABILITY_TOOL_NAMES = [
  "get_alert_context",
  "get_metric_catalog",
  "get_log_fields",
  "get_trace_fields",
  "query_metrics",
  "query_logs",
  "query_traces",
  "query_events",
  "query_alerts",
  "get_topology",
  "get_service_dependencies",
] as const;

export type ObservabilityToolName = (typeof OBSERVABILITY_TOOL_NAMES)[number];

export interface ToolExecution {
  tool: ObservabilityToolName;
  arguments: Record<string, unknown>;
  result: unknown;
  rawRef?: string;
  summary: string;
}

export interface PiToolExecutionResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}

export interface PiToolFactoryOptions {
  names?: readonly ObservabilityToolName[];
  execute?: (
    name: ObservabilityToolName,
    toolCallId: string,
    parameters: Record<string, unknown>,
  ) => Promise<PiToolExecutionResult>;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Investigation cancelled", "AbortError");
  }
}

function caseId(arguments_: Record<string, unknown>): string {
  const value = arguments_.caseId;
  if (typeof value !== "string" || !value) throw new Error("caseId is required");
  return value;
}

function resultSummary(tool: ObservabilityToolName, result: unknown): string {
  if (result && typeof result === "object" && "matchedRows" in result) {
    const envelope = result as { matchedRows?: unknown; returnedRows?: unknown };
    return `${tool}: matched ${String(envelope.matchedRows ?? 0)}, returned ${String(envelope.returnedRows ?? 0)}`;
  }
  return `${tool}: completed`;
}

function toolResult(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    details: result,
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function compactToolResultForAgent(
  tool: ObservabilityToolName,
  result: unknown,
): unknown {
  const envelope = objectValue(result);
  const data = objectValue(envelope?.data);
  if (!envelope || !data) return result;

  if (tool === "query_traces") {
    const anomalies = Array.isArray(data.anomalies)
      ? data.anomalies
          .filter((item): item is Record<string, unknown> => Boolean(objectValue(item)))
          .slice(0, 8)
          .map((item) => ({
            service: item.service,
            operation: item.operation,
            host: item.host,
            baselineCount: item.baselineCount,
            incidentCount: item.incidentCount,
            baselineP95Ms: item.baselineP95Ms,
            incidentP95Ms: item.incidentP95Ms,
            ratio: item.ratio,
            maxIncidentMs: item.maxIncidentMs,
            rawRef: item.rawRef,
          }))
      : [];

    const topSpans = Array.isArray(data.topSpans)
      ? data.topSpans
          .filter((item): item is Record<string, unknown> => Boolean(objectValue(item)))
          .slice(0, 10)
          .map((item) => ({
            service: item.service,
            operation: item.operation,
            host: item.host,
            startTime: item.startTime,
            endTime: item.endTime,
            durationMs: item.durationMs,
            spanId: item.spanId,
            parentSpanId: item.parentSpanId,
            statusCode: item.statusCode,
          }))
      : [];

    const criticalPaths = Array.isArray(data.criticalPaths)
      ? data.criticalPaths
          .filter((item): item is Record<string, unknown> => Boolean(objectValue(item)))
          .slice(0, 3)
          .map((item) => ({
            traceId: item.traceId,
            totalDurationMs: item.totalDurationMs,
            rawRef: item.rawRef,
            path: Array.isArray(item.path)
              ? item.path
                  .filter((node): node is Record<string, unknown> => Boolean(objectValue(node)))
                  .slice(0, 8)
                  .map((node) => ({
                    service: node.service,
                    operation: node.operation,
                    host: node.host,
                    startTime: node.startTime,
                    endTime: node.endTime,
                    durationMs: node.durationMs,
                    spanId: node.spanId,
                    parentSpanId: node.parentSpanId,
                    statusCode: node.statusCode,
                  }))
              : [],
            pathNodesOmitted:
              Array.isArray(item.path) && item.path.length > 8 ? item.path.length - 8 : 0,
          }))
      : [];

    const propagationCandidates = Array.isArray(data.propagationCandidates)
      ? data.propagationCandidates
          .filter((item): item is Record<string, unknown> => Boolean(objectValue(item)))
          .slice(0, 8)
          .map((item) => ({
            service: item.service,
            operation: item.operation,
            host: item.host,
            observations: item.observations,
            medianDurationMs: item.medianDurationMs,
          }))
      : [];

    return {
      caseId: envelope.caseId,
      modality: envelope.modality,
      query: envelope.query,
      matchedRows: envelope.matchedRows,
      returnedRows: envelope.returnedRows,
      truncated: envelope.truncated,
      rawRef: envelope.rawRef,
      data: {
        anomalies,
        topSpans,
        criticalPaths,
        propagationCandidates,
        omitted: {
          anomalies: Math.max(0, (Array.isArray(data.anomalies) ? data.anomalies.length : 0) - anomalies.length),
          topSpans: Math.max(0, (Array.isArray(data.topSpans) ? data.topSpans.length : 0) - topSpans.length),
          criticalPaths: Math.max(0, (Array.isArray(data.criticalPaths) ? data.criticalPaths.length : 0) - criticalPaths.length),
          propagationCandidates: Math.max(
            0,
            (Array.isArray(data.propagationCandidates) ? data.propagationCandidates.length : 0) -
              propagationCandidates.length,
          ),
        },
      },
    };
  }

  if (tool !== "query_metrics") return result;

  const anomalies = Array.isArray(data.anomalies)
    ? data.anomalies
        .filter((item): item is Record<string, unknown> => Boolean(objectValue(item)))
        .slice(0, 12)
        .map((item) => ({
          entitySet: item.entitySet,
          entity: item.entity,
          service: item.service,
          metric: item.metric,
          baselineCount: item.baselineCount,
          incidentCount: item.incidentCount,
          baselineMedian: item.baselineMedian,
          incidentMedian: item.incidentMedian,
          baselineP95: item.baselineP95,
          incidentP95: item.incidentP95,
          ratio: item.ratio,
          robustZ: item.robustZ,
          direction: item.direction,
          score: item.score,
          rawRef: item.rawRef,
        }))
    : [];

  const peerOutliers = Array.isArray(data.peerOutliers)
    ? data.peerOutliers
        .filter((item): item is Record<string, unknown> => Boolean(objectValue(item)))
        .slice(0, 8)
        .map((item) => ({
          entitySet: item.entitySet,
          entity: item.entity,
          metric: item.metric,
          incidentMedian: item.incidentMedian,
          peerMedian: item.peerMedian,
          ratio: item.ratio,
          rawRef: item.rawRef,
        }))
    : [];

  const directionCounts = anomalies.reduce(
    (counts, item) => {
      const direction = item.direction;
      if (direction === "increase") counts.increase++;
      else if (direction === "decrease") counts.decrease++;
      else counts.flat++;
      return counts;
    },
    { increase: 0, decrease: 0, flat: 0 },
  );

  return {
    caseId: envelope.caseId,
    modality: envelope.modality,
    query: envelope.query,
    matchedRows: envelope.matchedRows,
    returnedRows: envelope.returnedRows,
    truncated: envelope.truncated,
    rawRef: envelope.rawRef,
    data: {
      anomalies,
      peerOutliers,
      directionCounts,
      sampleOmitted: Array.isArray(data.sample) ? data.sample.length : 0,
    },
  };
}

export class ObservabilityToolRegistry {
  readonly adapter: RCA100Adapter;

  constructor(adapter: RCA100Adapter) {
    this.adapter = adapter;
  }

  names(): readonly ObservabilityToolName[] {
    return OBSERVABILITY_TOOL_NAMES;
  }

  async execute(
    tool: ObservabilityToolName,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolExecution> {
    throwIfCancelled(signal);
    const id = caseId(arguments_);
    let result: unknown;
    switch (tool) {
      case "get_alert_context":
        result = await this.adapter.getAlertContext(id);
        break;
      case "get_metric_catalog":
        result = await this.adapter.getMetricCatalog(id, signal);
        break;
      case "get_log_fields":
        result = await this.adapter.inspectSchema(id, "log");
        break;
      case "get_trace_fields":
        result = await this.adapter.inspectSchema(id, "trace");
        break;
      case "query_metrics":
        result = await this.adapter.queryMetrics(id, arguments_ as unknown as MetricQuery, signal);
        break;
      case "query_logs":
        result = await this.adapter.queryLogs(id, arguments_ as unknown as LogQuery, signal);
        break;
      case "query_traces":
        result = await this.adapter.queryTraces(id, arguments_ as unknown as TraceQuery, signal);
        break;
      case "query_events":
        result = await this.adapter.queryEvents(id, arguments_ as unknown as EventQuery, signal);
        break;
      case "query_alerts":
        result = await this.adapter.queryAlerts(id, arguments_ as unknown as AlertQuery, signal);
        break;
      case "get_topology":
        result = await this.adapter.getTopology(
          id,
          typeof arguments_.entity === "string" ? arguments_.entity : undefined,
          typeof arguments_.depth === "number" ? arguments_.depth : 1,
        );
        break;
      case "get_service_dependencies": {
        const topology = await this.adapter.getTopology(
          id,
          typeof arguments_.service === "string" ? arguments_.service : undefined,
          2,
        );
        const service =
          typeof arguments_.service === "string" ? arguments_.service.toLowerCase() : undefined;
        const dependencies = service
          ? topology.data.dependencies.filter(
              (dependency) => dependency.source.toLowerCase() === service,
            )
          : topology.data.dependencies;
        result = {
          caseId: id,
          modality: "topology",
          query: arguments_,
          matchedRows: dependencies.length,
          returnedRows: dependencies.length,
          truncated: false,
          rawRef: topology.rawRef,
          data: { dependencies },
        };
        break;
      }
    }
    throwIfCancelled(signal);
    const rawRef =
      result && typeof result === "object" && "rawRef" in result
        ? String((result as { rawRef?: unknown }).rawRef ?? "")
        : undefined;
    return {
      tool,
      arguments: arguments_,
      result,
      ...(rawRef ? { rawRef } : {}),
      summary: resultSummary(tool, result),
    };
  }

  createPiTools(options: PiToolFactoryOptions = {}): ToolDefinition[] {
    const caseParameter = {
      caseId: Type.String({ description: "RCA100 case id，例如 t039" }),
    };
    const rangeParameters = {
      ...caseParameter,
      from: Type.String({ description: "包含边界的 ISO-8601 开始时间" }),
      to: Type.String({ description: "包含边界的 ISO-8601 结束时间" }),
    };
    const execute =
      (name: ObservabilityToolName) =>
      async (toolCallId: string, parameters: Record<string, unknown>) =>
        options.execute
          ? options.execute(name, toolCallId, parameters)
          : toolResult((await this.execute(name, parameters)).result);

    const definitions = [
      defineTool({
        name: "get_alert_context",
        label: "获取告警上下文",
        description:
          "只加载 RCA100 task 中用户可见的 alert 字段，绝不会返回 ground truth。",
        parameters: Type.Object(caseParameter),
        execute: execute("get_alert_context"),
      }),
      defineTool({
        name: "get_metric_catalog",
        label: "发现 Metrics",
        description: "在查询 metrics 前发现真实 metric 名称和 entity set。",
        parameters: Type.Object(caseParameter),
        execute: execute("get_metric_catalog"),
      }),
      defineTool({
        name: "get_log_fields",
        label: "发现 Log 字段",
        description: "返回真实 logs parquet schema，但不返回 log row。",
        parameters: Type.Object(caseParameter),
        execute: execute("get_log_fields"),
      }),
      defineTool({
        name: "get_trace_fields",
        label: "发现 Trace 字段",
        description: "返回真实 traces parquet schema，但不返回 trace row。",
        parameters: Type.Object(caseParameter),
        execute: execute("get_trace_fields"),
      }),
      defineTool({
        name: "query_metrics",
        label: "查询 Metrics",
        description:
          "在有边界的时间范围内查询并聚合 metrics。只返回 top anomaly summary，不返回整个 parquet 文件。",
        parameters: Type.Object({
          ...rangeParameters,
          baselineFrom: Type.Optional(Type.String()),
          baselineTo: Type.Optional(Type.String()),
          service: Type.Optional(Type.String()),
          operation: Type.Optional(Type.String()),
          entity: Type.Optional(Type.String()),
          metric: Type.Optional(Type.String()),
          topN: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
        }),
        execute: execute("query_metrics"),
      }),
      defineTool({
        name: "query_logs",
        label: "查询 Logs",
        description:
          "按有边界的时间、service、pod 和 keyword 搜索 logs。返回计数、top sample 和 slow access-log signal。",
        parameters: Type.Object({
          ...rangeParameters,
          service: Type.Optional(Type.String()),
          pod: Type.Optional(Type.String()),
          keywords: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
        }),
        execute: execute("query_logs"),
      }),
      defineTool({
        name: "query_traces",
        label: "查询 Traces",
        description:
          "分析有边界的 traces，返回 latency baseline、critical path、propagation candidate 和 top span。",
        parameters: Type.Object({
          ...rangeParameters,
          baselineFrom: Type.Optional(Type.String()),
          baselineTo: Type.Optional(Type.String()),
          service: Type.Optional(Type.String()),
          operation: Type.Optional(Type.String()),
          host: Type.Optional(Type.String()),
          timeBasis: Type.Optional(
            Type.Union([Type.Literal("start"), Type.Literal("end"), Type.Literal("overlap")]),
          ),
          topN: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
        }),
        execute: execute("query_traces"),
      }),
      defineTool({
        name: "query_events",
        label: "查询 Events",
        description:
          "在有边界的时间范围内查询已解析的 Kubernetes events；可能返回没有相关 evidence。",
        parameters: Type.Object({
          ...rangeParameters,
          entity: Type.Optional(Type.String()),
          level: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
        }),
        execute: execute("query_events"),
      }),
      defineTool({
        name: "query_alerts",
        label: "查询 Alerts",
        description: "在有边界的时间范围内查询 alert record。",
        parameters: Type.Object({
          ...rangeParameters,
          subject: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
        }),
        execute: execute("query_alerts"),
      }),
      defineTool({
        name: "get_topology",
        label: "获取 Topology",
        description:
          "返回以 entity 为中心的 topology 子图，最大遍历深度为 3。",
        parameters: Type.Object({
          ...caseParameter,
          entity: Type.Optional(Type.String()),
          depth: Type.Optional(Type.Number({ minimum: 0, maximum: 3 })),
        }),
        execute: execute("get_topology"),
      }),
      defineTool({
        name: "get_service_dependencies",
        label: "获取 Service 依赖",
        description: "从 topology adapter 返回 service call dependency。",
        parameters: Type.Object({
          ...caseParameter,
          service: Type.Optional(Type.String()),
        }),
        execute: execute("get_service_dependencies"),
      }),
    ];
    const allowed = options.names ? new Set(options.names) : undefined;
    return allowed
      ? definitions.filter((definition) => allowed.has(definition.name as ObservabilityToolName))
      : definitions;
  }
}
