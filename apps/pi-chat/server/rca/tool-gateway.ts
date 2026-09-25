import { randomUUID } from "node:crypto";

import { DuckDbParquetEngine, parquetSql, sqlLikeContains, sqlLiteral } from "../datasets/rca100/duckdb-engine";
import { Rca100Repository } from "../datasets/rca100/repository";
import type { Rca100CaseDescriptor, Rca100Topology } from "../datasets/rca100/schema";
import type { AgentKind } from "../../shared/rca-types";
import type { PutEvidenceInput } from "./evidence-store";
import type { AgentTask } from "./types";

export type RcaToolName =
  | "query_logs"
  | "analyze_log_patterns"
  | "list_metrics"
  | "query_metrics"
  | "search_traces"
  | "get_trace"
  | "query_events"
  | "query_alerts"
  | "get_topology_neighbors";

export interface ToolPlan {
  id: string;
  agent: AgentKind;
  name: RcaToolName;
  args: Record<string, unknown>;
}

export interface ToolExecutionResult {
  display: string;
  evidence: PutEvidenceInput[];
}

const TOOLS_BY_AGENT: Record<AgentKind, ReadonlySet<RcaToolName>> = {
  log: new Set(["query_logs", "analyze_log_patterns"]),
  metric: new Set(["list_metrics", "query_metrics"]),
  trace: new Set(["search_traces", "get_trace"]),
  context: new Set(["query_events", "query_alerts", "get_topology_neighbors"]),
};

type ColumnInfo = { name: string; type: string };


function clampLimit(value: unknown, fallback = 20, max = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(parsed)));
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function number(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function escapeIdentifier(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}

function formatNumber(value: unknown, digits = 2) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits).replace(/\.00$/, "") : String(value ?? "-");
}

function safeIso(value: unknown, fallback: string) {
  const candidate = text(value);
  if (!candidate) return fallback;
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function micros(iso: string) {
  return Math.floor(new Date(iso).getTime() * 1000);
}

function nanos(iso: string) {
  return Math.floor(new Date(iso).getTime() * 1_000_000);
}

function seconds(iso: string) {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function inIsoRange(value: unknown, start: string, end: string) {
  const raw = text(value);
  if (!raw) return false;
  const timestamp = new Date(raw).getTime();
  if (!Number.isFinite(timestamp)) return false;
  return timestamp >= new Date(start).getTime() && timestamp <= new Date(end).getTime();
}

function firstColumn(columns: ColumnInfo[], candidates: string[]) {
  for (const candidate of candidates) {
    const hit = columns.find((column) => column.name === candidate);
    if (hit) return hit;
  }
  return undefined;
}

function containsColumn(columns: ColumnInfo[], name: string) {
  return columns.some((column) => column.name === name);
}

function normalizeService(value: string) {
  return value.replace(/^service:/, "").trim();
}

function evidence(
  task: AgentTask,
  plan: ToolPlan,
  input: Omit<PutEvidenceInput, "query" | "taskId" | "createdBy">,
): PutEvidenceInput {
  return {
    ...input,
    taskId: task.taskId,
    createdBy: plan.agent,
    query: { tool: plan.name, ...plan.args },
  };
}

export class Rca100ToolGateway {
  constructor(
    private readonly repository = new Rca100Repository(),
    private readonly db = new DuckDbParquetEngine(),
  ) {}

  createPlan(agent: AgentKind, name: RcaToolName, args: Record<string, unknown>): ToolPlan {
    return { id: randomUUID(), agent, name, args };
  }

  async ensureCase(taskId: string) {
    return this.repository.ensureCase(taskId);
  }

  async getTask(taskId: string, ensure = false) {
    return this.repository.getTask(taskId, { ensure });
  }

  async execute(plan: ToolPlan, task: AgentTask): Promise<ToolExecutionResult> {
    if (!TOOLS_BY_AGENT[plan.agent].has(plan.name)) {
      throw new Error(`${plan.agent} agent is not allowed to call ${plan.name}.`);
    }
    const descriptor = await this.repository.openCase(task.taskId);
    switch (plan.name) {
      case "query_logs":
        return this.queryLogs(descriptor, plan, task, false);
      case "analyze_log_patterns":
        return this.queryLogs(descriptor, plan, task, true);
      case "list_metrics":
        return this.listMetrics(descriptor, plan, task);
      case "query_metrics":
        return this.queryMetrics(descriptor, plan, task);
      case "search_traces":
        return this.searchTraces(descriptor, plan, task);
      case "get_trace":
        return this.getTrace(descriptor, plan, task);
      case "query_events":
        return this.queryEvents(descriptor, plan, task);
      case "query_alerts":
        return this.queryAlerts(descriptor, plan, task);
      case "get_topology_neighbors":
        return this.getTopologyNeighbors(descriptor, plan, task);
    }
  }

  private async describe(path: string): Promise<ColumnInfo[]> {
    const rows = await this.db.query(`DESCRIBE SELECT * FROM ${parquetSql(path)}`);
    return rows.map((row) => ({
      name: String(row.column_name ?? row.column ?? row.name ?? ""),
      type: String(row.column_type ?? row.type ?? ""),
    })).filter((column) => column.name);
  }

  private timeRange(task: AgentTask, args: Record<string, unknown>) {
    return {
      start: safeIso(args.startTime, task.startTime),
      end: safeIso(args.endTime, task.endTime),
    };
  }

  private logTimeWhere(column: ColumnInfo | undefined, start: string, end: string) {
    if (!column) return [];
    const identifier = escapeIdentifier(column.name);
    const type = column.type.toUpperCase();
    if (column.name === "_time_" || type.includes("VARCHAR") || type.includes("TIMESTAMP")) {
      return [
        `TRY_CAST(${identifier} AS TIMESTAMPTZ) >= TIMESTAMPTZ ${sqlLiteral(start)}`,
        `TRY_CAST(${identifier} AS TIMESTAMPTZ) <= TIMESTAMPTZ ${sqlLiteral(end)}`,
      ];
    }
    if (type.includes("INT") || type.includes("DECIMAL") || type.includes("DOUBLE")) {
      return [`${identifier} >= ${micros(start)}`, `${identifier} <= ${micros(end)}`];
    }
    return [];
  }

  private async queryLogs(
    descriptor: Rca100CaseDescriptor,
    plan: ToolPlan,
    task: AgentTask,
    patterns: boolean,
  ): Promise<ToolExecutionResult> {
    const columns = await this.describe(descriptor.paths.logs);
    const contentColumn = firstColumn(columns, ["content", "message", "body"]);
    if (!contentColumn) throw new Error("RCA100 logs.parquet has no content/message column.");
    const timeColumn = firstColumn(columns, ["_time_", "time", "timestamp"]);
    const podColumn = firstColumn(columns, ["_pod_name_", "pod_name", "pod"]);
    const namespaceColumn = firstColumn(columns, ["_namespace_", "namespace"]);
    const service = normalizeService(text(plan.args.service) || task.service);
    const keyword = text(plan.args.keyword);
    const level = text(plan.args.level);
    const limit = clampLimit(plan.args.limit, patterns ? 12 : 30, patterns ? 30 : 100);
    const range = this.timeRange(task, plan.args);
    const where = this.logTimeWhere(timeColumn, range.start, range.end);
    const contentSql = escapeIdentifier(contentColumn.name);
    if (service) {
      const alternatives = [sqlLikeContains(contentSql, service)];
      if (podColumn) alternatives.push(sqlLikeContains(escapeIdentifier(podColumn.name), service));
      where.push(`(${alternatives.join(" OR ")})`);
    }
    if (keyword) where.push(sqlLikeContains(contentSql, keyword));
    if (level) {
      const levelColumn = firstColumn(columns, ["level", "severity", "log_level"]);
      where.push(levelColumn ? sqlLikeContains(escapeIdentifier(levelColumn.name), level) : sqlLikeContains(contentSql, level));
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    if (patterns) {
      const rows = await this.db.query(`
        SELECT ${contentSql} AS content, count(*) AS count
        FROM ${parquetSql(descriptor.paths.logs)}
        ${whereSql}
        GROUP BY ${contentSql}
        ORDER BY count DESC
        LIMIT ${limit}
      `);
      const total = rows.reduce((sum, row) => sum + number(row.count), 0);
      const top = rows.slice(0, 5).map((row) => `${formatNumber(row.count, 0)}× ${text(row.content).slice(0, 100)}`);
      const summary = rows.length
        ? `日志模式聚合返回 ${rows.length} 个模式（当前过滤结果合计 ${total} 条）；Top 模式：${top.join("；")}`
        : "当前条件下未发现匹配日志模式。";
      return {
        display: summary,
        evidence: [evidence(task, plan, {
          type: "log",
          modality: "log",
          label: "日志模式聚合",
          source: `RCA100-${descriptor.task.task_version}`,
          summary,
          observation: { matchedPatternCount: rows.length, matchedRowsInTopPatterns: total, patterns: rows.slice(0, 12) },
          rawRef: `rca100://${task.taskId}/logs/patterns/${plan.id}`,
          entityRefs: service ? [service] : [],
          timeRange: range,
        })],
      };
    }

    const selected = [
      timeColumn ? `${escapeIdentifier(timeColumn.name)} AS time` : "NULL AS time",
      `${contentSql} AS content`,
      podColumn ? `${escapeIdentifier(podColumn.name)} AS pod` : "NULL AS pod",
      namespaceColumn ? `${escapeIdentifier(namespaceColumn.name)} AS namespace` : "NULL AS namespace",
    ];
    const rows = await this.db.query(`
      SELECT ${selected.join(", ")}
      FROM ${parquetSql(descriptor.paths.logs)}
      ${whereSql}
      ${timeColumn ? `ORDER BY ${escapeIdentifier(timeColumn.name)} DESC` : ""}
      LIMIT ${limit}
    `);
    const summary = rows.length
      ? `查询命中 ${rows.length} 条日志样本；示例：${rows.slice(0, 3).map((row) => text(row.content).slice(0, 120)).join("；")}`
      : "当前过滤条件下未命中日志。";
    return {
      display: summary,
      evidence: [evidence(task, plan, {
        type: "log",
        modality: "log",
        label: "日志查询结果",
        source: `RCA100-${descriptor.task.task_version}`,
        summary,
        observation: { returned: rows.length, samples: rows.slice(0, 20) },
        rawRef: `rca100://${task.taskId}/logs/query/${plan.id}`,
        entityRefs: service ? [service] : [],
        timeRange: range,
      })],
    };
  }

  private async listMetrics(
    descriptor: Rca100CaseDescriptor,
    plan: ToolPlan,
    task: AgentTask,
  ): Promise<ToolExecutionResult> {
    const columns = await this.describe(descriptor.paths.metrics);
    if (!containsColumn(columns, "metric")) throw new Error("RCA100 metrics.parquet has no metric column.");
    const entity = text(plan.args.entity) || text(plan.args.service) || task.service;
    const keyword = text(plan.args.keyword);
    const where: string[] = [];
    if (keyword) where.push(sqlLikeContains('"metric"', keyword));
    if (entity) {
      const alternatives: string[] = [];
      for (const name of ["entity_name", "service", "entity_id"]) {
        if (containsColumn(columns, name)) alternatives.push(sqlLikeContains(escapeIdentifier(name), entity));
      }
      if (alternatives.length) where.push(`(${alternatives.join(" OR ")})`);
    }
    const rows = await this.db.query(`
      SELECT metric,
        ${containsColumn(columns, "entity_name") ? "entity_name" : "NULL AS entity_name"},
        ${containsColumn(columns, "service") ? "service" : "NULL AS service"},
        count(*) AS samples
      FROM ${parquetSql(descriptor.paths.metrics)}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      GROUP BY ALL
      ORDER BY samples DESC
      LIMIT ${clampLimit(plan.args.limit, 40, 100)}
    `);
    const uniqueMetrics = [...new Set(rows.map((row) => text(row.metric)).filter(Boolean))];
    const summary = rows.length
      ? `发现 ${uniqueMetrics.length} 个相关指标：${uniqueMetrics.slice(0, 18).join("、")}${uniqueMetrics.length > 18 ? "…" : ""}`
      : "没有发现符合过滤条件的指标。";
    return {
      display: summary,
      evidence: [evidence(task, plan, {
        type: "metric",
        modality: "metric",
        label: "指标发现",
        source: `RCA100-${descriptor.task.task_version}`,
        summary,
        observation: { metrics: uniqueMetrics, series: rows.slice(0, 60) },
        rawRef: `rca100://${task.taskId}/metrics/catalog/${plan.id}`,
        entityRefs: entity ? [entity] : [],
        timeRange: this.timeRange(task, plan.args),
      })],
    };
  }

  private async queryMetrics(
    descriptor: Rca100CaseDescriptor,
    plan: ToolPlan,
    task: AgentTask,
  ): Promise<ToolExecutionResult> {
    const columns = await this.describe(descriptor.paths.metrics);
    for (const required of ["time", "metric", "value"]) {
      if (!containsColumn(columns, required)) {
        throw new Error(`RCA100 metrics.parquet has no ${required} column.`);
      }
    }
    const range = this.timeRange(task, plan.args);
    const entity = text(plan.args.entity) || text(plan.args.service) || task.service;
    const requestedMetrics = Array.isArray(plan.args.metrics)
      ? plan.args.metrics.map(text).filter(Boolean)
      : [text(plan.args.metric)].filter(Boolean);
    const keyword = text(plan.args.keyword);
    const where = [`"time" >= ${micros(range.start)}`, `"time" <= ${micros(range.end)}`];
    if (entity) {
      const alternatives: string[] = [];
      for (const name of ["entity_name", "service", "entity_id"]) {
        if (containsColumn(columns, name)) alternatives.push(sqlLikeContains(escapeIdentifier(name), entity));
      }
      if (alternatives.length) where.push(`(${alternatives.join(" OR ")})`);
    }
    if (requestedMetrics.length) {
      where.push(`(${requestedMetrics.map((metric) => sqlLikeContains('"metric"', metric)).join(" OR ")})`);
    } else if (keyword) {
      where.push(sqlLikeContains('"metric"', keyword));
    }

    const summaryRows = await this.db.query(`
      SELECT metric,
        ${containsColumn(columns, "entity_name") ? "entity_name" : "NULL AS entity_name"},
        ${containsColumn(columns, "service") ? "service" : "NULL AS service"},
        count(*) AS samples,
        min(value) AS min_value,
        avg(value) AS avg_value,
        max(value) AS max_value,
        arg_min(value, time) AS first_value,
        arg_max(value, time) AS last_value,
        min(time) AS first_time_us,
        max(time) AS last_time_us
      FROM ${parquetSql(descriptor.paths.metrics)}
      WHERE ${where.join(" AND ")}
      GROUP BY ALL
      ORDER BY max_value DESC NULLS LAST
      LIMIT ${clampLimit(plan.args.limit, 24, 60)}
    `);
    const topSeries = summaryRows.slice(0, 8).map((row) =>
      `${text(row.metric)}@${text(row.entity_name || row.service || entity || "unknown")}: avg=${formatNumber(row.avg_value)}, max=${formatNumber(row.max_value)}, samples=${formatNumber(row.samples, 0)}`,
    );
    const summary = summaryRows.length
      ? `指标查询返回 ${summaryRows.length} 条时序汇总；${topSeries.join("；")}`
      : "当前条件下未查询到指标样本。";
    return {
      display: summary,
      evidence: [evidence(task, plan, {
        type: "metric",
        modality: "metric",
        label: "指标窗口统计",
        source: `RCA100-${descriptor.task.task_version}`,
        summary,
        observation: { series: summaryRows },
        rawRef: `rca100://${task.taskId}/metrics/query/${plan.id}`,
        entityRefs: entity ? [entity] : [],
        timeRange: range,
      })],
    };
  }

  private async searchTraces(
    descriptor: Rca100CaseDescriptor,
    plan: ToolPlan,
    task: AgentTask,
  ): Promise<ToolExecutionResult> {
    const columns = await this.describe(descriptor.paths.traces);
    for (const required of ["traceId", "spanId", "spanName", "serviceName", "startTime", "duration"]) {
      if (!containsColumn(columns, required)) {
        throw new Error(`RCA100 traces.parquet has no ${required} column.`);
      }
    }
    const range = this.timeRange(task, plan.args);
    const service = normalizeService(text(plan.args.service) || task.service);
    const operation = text(plan.args.operation);
    const minDurationMs = Math.max(0, number(plan.args.minDurationMs, 0));
    const status = text(plan.args.status);
    const where = [`"startTime" >= ${nanos(range.start)}`, `"startTime" <= ${nanos(range.end)}`];
    if (service && containsColumn(columns, "serviceName")) where.push(sqlLikeContains('"serviceName"', service));
    if (operation && containsColumn(columns, "spanName")) where.push(sqlLikeContains('"spanName"', operation));
    if (minDurationMs && containsColumn(columns, "duration")) where.push(`"duration" >= ${Math.floor(minDurationMs * 1_000_000)}`);
    if (status && containsColumn(columns, "statusCode")) {
      const numeric = Number(status);
      where.push(Number.isFinite(numeric) ? `"statusCode" = ${numeric}` : sqlLikeContains('"statusMessage"', status));
    }
    const rows = await this.db.query(`
      SELECT traceId, spanId, parentSpanId, spanName, serviceName,
        duration / 1000000.0 AS duration_ms, statusCode, statusMessage, startTime
      FROM ${parquetSql(descriptor.paths.traces)}
      WHERE ${where.join(" AND ")}
      ORDER BY duration DESC
      LIMIT ${clampLimit(plan.args.limit, 30, 100)}
    `);
    const summary = rows.length
      ? `找到 ${rows.length} 个符合条件的 Span；最慢样本：${rows.slice(0, 5).map((row) => `${text(row.serviceName)} / ${text(row.spanName)} ${formatNumber(row.duration_ms)}ms`).join("；")}`
      : "当前条件下未找到符合条件的 Trace Span。";
    return {
      display: summary,
      evidence: [evidence(task, plan, {
        type: "trace",
        modality: "trace",
        label: "慢/异常 Trace 搜索",
        source: `RCA100-${descriptor.task.task_version}`,
        summary,
        observation: { spans: rows.slice(0, 40) },
        rawRef: `rca100://${task.taskId}/traces/search/${plan.id}`,
        entityRefs: service ? [service] : [],
        timeRange: range,
      })],
    };
  }

  private async getTrace(
    descriptor: Rca100CaseDescriptor,
    plan: ToolPlan,
    task: AgentTask,
  ): Promise<ToolExecutionResult> {
    const traceId = text(plan.args.traceId);
    if (!traceId) throw new Error("get_trace requires traceId.");
    const rows = await this.db.query(`
      SELECT traceId, spanId, parentSpanId, spanName, serviceName,
        duration / 1000000.0 AS duration_ms, statusCode, statusMessage, startTime, endTime
      FROM ${parquetSql(descriptor.paths.traces)}
      WHERE traceId = ${sqlLiteral(traceId)}
      ORDER BY startTime ASC, duration DESC
      LIMIT 200
    `);
    const services = [...new Set(rows.map((row) => text(row.serviceName)).filter(Boolean))];
    const summary = rows.length
      ? `Trace ${traceId} 包含 ${rows.length} 个 Span，涉及 ${services.join(" → ") || "未知服务"}；Top 耗时：${[...rows].sort((a, b) => number(b.duration_ms) - number(a.duration_ms)).slice(0, 5).map((row) => `${text(row.serviceName)}/${text(row.spanName)} ${formatNumber(row.duration_ms)}ms`).join("；")}`
      : `未找到 Trace ${traceId}。`;
    return {
      display: summary,
      evidence: [evidence(task, plan, {
        type: "trace",
        modality: "trace",
        label: "Trace 详情",
        source: `RCA100-${descriptor.task.task_version}`,
        summary,
        observation: { traceId, services, spans: rows },
        rawRef: `rca100://${task.taskId}/traces/${traceId}`,
        entityRefs: services,
        timeRange: this.timeRange(task, plan.args),
      })],
    };
  }

  private async queryEvents(
    descriptor: Rca100CaseDescriptor,
    plan: ToolPlan,
    task: AgentTask,
  ): Promise<ToolExecutionResult> {
    const columns = await this.describe(descriptor.paths.events);
    const eventColumn = firstColumn(columns, ["eventId", "event", "content"]);
    if (!eventColumn) throw new Error("RCA100 events.parquet has no event payload column.");
    const keyword = text(plan.args.keyword);
    const resource = text(plan.args.resource) || text(plan.args.service) || task.service;
    const reason = text(plan.args.reason);
    const payloadSql = escapeIdentifier(eventColumn.name);
    const where: string[] = [];
    if (keyword) where.push(sqlLikeContains(payloadSql, keyword));
    if (resource) where.push(sqlLikeContains(payloadSql, resource));
    if (reason) where.push(sqlLikeContains(payloadSql, reason));
    const requestedLimit = clampLimit(plan.args.limit, 30, 100);
    const range = this.timeRange(task, plan.args);
    // eventId contains the Kubernetes Event JSON payload; fetch a bounded candidate set, then
    // apply the incident window after parsing lastTimestamp/eventTime/creationTimestamp.
    const rows = await this.db.query(`
      SELECT ${payloadSql} AS payload,
        ${containsColumn(columns, "pod_name") ? "pod_name" : "NULL AS pod_name"},
        ${containsColumn(columns, "hostname") ? "hostname" : "NULL AS hostname"},
        ${containsColumn(columns, "level") ? "level" : "NULL AS level"}
      FROM ${parquetSql(descriptor.paths.events)}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      LIMIT ${Math.max(200, requestedLimit * 5)}
    `);
    const parsed = rows.flatMap((row) => {
      const raw = text(row.payload);
      try {
        const payload = JSON.parse(raw) as Record<string, unknown>;
        const involved = payload.involvedObject as Record<string, unknown> | undefined;
        const metadata = payload.metadata as Record<string, unknown> | undefined;
        const eventTime = payload.lastTimestamp ?? payload.eventTime ?? metadata?.creationTimestamp;
        if (!inIsoRange(eventTime, range.start, range.end)) return [];
        return [{
          reason: payload.reason,
          message: payload.message,
          type: payload.type,
          lastTimestamp: eventTime,
          object: involved ? `${involved.kind ?? ""}/${involved.name ?? ""}` : undefined,
          pod: row.pod_name,
          host: row.hostname,
        }];
      } catch {
        return [];
      }
    }).slice(0, requestedLimit);
    const summary = parsed.length
      ? `Kubernetes Events 返回 ${parsed.length} 条；示例：${parsed.slice(0, 5).map((row) => `${text(row.reason)} ${text(row.object)} ${text(row.message).slice(0, 80)}`).join("；")}`
      : "当前过滤条件下没有 Kubernetes Event。";
    return {
      display: summary,
      evidence: [evidence(task, plan, {
        type: "context",
        modality: "event",
        label: "Kubernetes Events",
        source: `RCA100-${descriptor.task.task_version}`,
        summary,
        observation: { events: parsed },
        rawRef: `rca100://${task.taskId}/events/query/${plan.id}`,
        entityRefs: resource ? [resource] : [],
        timeRange: range,
      })],
    };
  }

  private async queryAlerts(
    descriptor: Rca100CaseDescriptor,
    plan: ToolPlan,
    task: AgentTask,
  ): Promise<ToolExecutionResult> {
    const columns = await this.describe(descriptor.paths.alerts);
    const subject = text(plan.args.subject) || text(plan.args.service);
    const severity = text(plan.args.severity);
    const status = text(plan.args.status);
    const range = this.timeRange(task, plan.args);
    const where: string[] = [];
    if (containsColumn(columns, "time_s")) {
      where.push(`"time_s" >= ${seconds(range.start)}`, `"time_s" <= ${seconds(range.end)}`);
    }
    if (subject && containsColumn(columns, "subject")) where.push(sqlLikeContains('"subject"', subject));
    if (severity && containsColumn(columns, "severity")) where.push(sqlLikeContains('"severity"', severity));
    if (status && containsColumn(columns, "status")) where.push(sqlLikeContains('"status"', status));
    const select = ["time_s", "subject", "status", "severity", "resource", "labels", "annotations"]
      .filter((name) => containsColumn(columns, name))
      .map(escapeIdentifier);
    if (!select.length) throw new Error("RCA100 alerts.parquet schema is not recognized.");
    const rows = await this.db.query(`
      SELECT ${select.join(", ")}
      FROM ${parquetSql(descriptor.paths.alerts)}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      LIMIT ${clampLimit(plan.args.limit, 30, 100)}
    `);
    const summary = rows.length
      ? `告警数据返回 ${rows.length} 条记录；${rows.slice(0, 6).map((row) => `${text(row.subject)} [${text(row.status)}/${text(row.severity)}]`).join("；")}`
      : "当前条件下未找到额外告警记录。";
    return {
      display: summary,
      evidence: [evidence(task, plan, {
        type: "context",
        modality: "alert",
        label: "关联告警",
        source: `RCA100-${descriptor.task.task_version}`,
        summary,
        observation: { alerts: rows },
        rawRef: `rca100://${task.taskId}/alerts/query/${plan.id}`,
        entityRefs: subject ? [subject] : [],
        timeRange: range,
      })],
    };
  }

  private async getTopologyNeighbors(
    descriptor: Rca100CaseDescriptor,
    plan: ToolPlan,
    task: AgentTask,
  ): Promise<ToolExecutionResult> {
    const topology = await this.repository.loadTopology(task.taskId);
    const entityQuery = text(plan.args.entity) || text(plan.args.service) || task.service;
    const direction = text(plan.args.direction) || "both";
    const relation = text(plan.args.relation);
    const entities = Array.isArray(topology.entities) ? topology.entities : [];
    const edges = Array.isArray(topology.edges) ? topology.edges : [];
    const matching = entities.filter((entity) =>
      [entity.name, entity.id, entity.type].some((value) => text(value).toLowerCase().includes(entityQuery.toLowerCase())),
    );
    const ids = new Set(matching.map((entity) => text(entity.id)).filter(Boolean));
    const byId = new Map(entities.map((entity) => [text(entity.id), entity]));
    const selectedEdges = edges.filter((edge) => {
      if (relation && text(edge.relation) !== relation) return false;
      const src = text(edge.src);
      const dst = text(edge.dst);
      if (direction === "upstream") return ids.has(dst);
      if (direction === "downstream") return ids.has(src);
      return ids.has(src) || ids.has(dst);
    }).slice(0, clampLimit(plan.args.limit, 40, 100));
    const neighbors = selectedEdges.map((edge) => ({
      relation: edge.relation,
      src: this.entitySummary(byId.get(text(edge.src)), text(edge.src)),
      dst: this.entitySummary(byId.get(text(edge.dst)), text(edge.dst)),
    }));
    const entityRefs = [...new Set(neighbors.flatMap((edge) => [text(edge.src.name), text(edge.dst.name)]).filter(Boolean))];
    const summary = matching.length
      ? `拓扑匹配 ${matching.length} 个实体，找到 ${neighbors.length} 条邻接关系；${neighbors.slice(0, 10).map((edge) => `${edge.src.name} -[${text(edge.relation)}]→ ${edge.dst.name}`).join("；")}`
      : `拓扑中未找到与 ${entityQuery} 匹配的实体。`;
    return {
      display: summary,
      evidence: [evidence(task, plan, {
        type: "context",
        modality: "topology",
        label: "拓扑邻接关系",
        source: `RCA100-${descriptor.task.task_version}`,
        summary,
        observation: { queryEntity: entityQuery, matchedEntities: matching.slice(0, 20), edges: neighbors },
        rawRef: `rca100://${task.taskId}/topology/neighbors/${plan.id}`,
        entityRefs,
        timeRange: this.timeRange(task, plan.args),
      })],
    };
  }

  private entitySummary(entity: Rca100Topology["entities"][number] | undefined, fallback: string) {
    return {
      id: text(entity?.id) || fallback,
      name: text(entity?.name) || fallback,
      type: text(entity?.type),
    };
  }
}
