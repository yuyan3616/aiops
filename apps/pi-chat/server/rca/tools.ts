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
  if (tool !== "query_metrics") return result;
  const envelope = objectValue(result);
  const data = objectValue(envelope?.data);
  if (!envelope || !data) return result;

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
      caseId: Type.String({ description: "RCA100 case id, for example t039" }),
    };
    const rangeParameters = {
      ...caseParameter,
      from: Type.String({ description: "inclusive ISO-8601 start time" }),
      to: Type.String({ description: "inclusive ISO-8601 end time" }),
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
        label: "Get alert context",
        description:
          "Load only the user-visible alert fields from an RCA100 task. Never returns ground truth.",
        parameters: Type.Object(caseParameter),
        execute: execute("get_alert_context"),
      }),
      defineTool({
        name: "get_metric_catalog",
        label: "Discover metrics",
        description: "Discover actual metric names and entity sets before querying metrics.",
        parameters: Type.Object(caseParameter),
        execute: execute("get_metric_catalog"),
      }),
      defineTool({
        name: "get_log_fields",
        label: "Discover log fields",
        description: "Return the actual logs parquet schema without returning log rows.",
        parameters: Type.Object(caseParameter),
        execute: execute("get_log_fields"),
      }),
      defineTool({
        name: "get_trace_fields",
        label: "Discover trace fields",
        description: "Return the actual traces parquet schema without returning trace rows.",
        parameters: Type.Object(caseParameter),
        execute: execute("get_trace_fields"),
      }),
      defineTool({
        name: "query_metrics",
        label: "Query metrics",
        description:
          "Query and aggregate metrics for a bounded time range. Returns top anomaly summaries, not the entire parquet file.",
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
        label: "Query logs",
        description:
          "Search logs by bounded time, service, pod, and keywords. Returns counts, top samples, and slow access-log signals.",
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
        label: "Query traces",
        description:
          "Analyze bounded traces with latency baselines, critical paths, propagation candidates, and top spans.",
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
        label: "Query events",
        description:
          "Query parsed Kubernetes events in a bounded time range. May return no relevant evidence.",
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
        label: "Query alerts",
        description: "Query alert records in a bounded time range.",
        parameters: Type.Object({
          ...rangeParameters,
          subject: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
        }),
        execute: execute("query_alerts"),
      }),
      defineTool({
        name: "get_topology",
        label: "Get topology",
        description:
          "Return an entity-centered topology subgraph with a maximum traversal depth of three.",
        parameters: Type.Object({
          ...caseParameter,
          entity: Type.Optional(Type.String()),
          depth: Type.Optional(Type.Number({ minimum: 0, maximum: 3 })),
        }),
        execute: execute("get_topology"),
      }),
      defineTool({
        name: "get_service_dependencies",
        label: "Get service dependencies",
        description: "Return service call dependencies from the topology adapter.",
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
