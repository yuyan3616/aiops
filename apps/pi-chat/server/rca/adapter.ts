import { access, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import {
  epochToIso,
  jsonSafe,
  metadataFields,
  readParquetMetadata,
  readParquetRowsBatched,
  timestampMs,
  type ParquetRow,
} from "./parquet";
import { finiteNumber, median, quantile, robustZScore, safeRatio } from "./statistics";
import type {
  AlertContext,
  CriticalTracePath,
  EvidenceModality,
  MetricAnomaly,
  ModalitySchema,
  QueryEnvelope,
  RcaTask,
  TimeRange,
  TraceAnomaly,
  TracePathNode,
  TraceQueryWindowRelation,
} from "./types";

const PARQUET_MODALITIES = ["metrics", "logs", "traces", "events", "alerts"] as const;
type ParquetModality = (typeof PARQUET_MODALITIES)[number];

const REQUIRED_CASE_FILES = [
  "task.json",
  "metrics.parquet",
  "logs.parquet",
  "traces.parquet",
  "events.parquet",
  "alerts.parquet",
  "topology.json",
] as const;

export interface MetricQuery {
  from: string;
  to: string;
  baselineFrom?: string;
  baselineTo?: string;
  service?: string;
  operation?: string;
  entity?: string;
  metric?: string;
  topN?: number;
}

export interface TraceQuery {
  from: string;
  to: string;
  baselineFrom?: string;
  baselineTo?: string;
  service?: string;
  operation?: string;
  host?: string;
  timeBasis?: "start" | "end" | "overlap";
  topN?: number;
}

export interface LogQuery {
  from: string;
  to: string;
  service?: string;
  pod?: string;
  keywords?: string[];
  limit?: number;
}

export interface EventQuery {
  from: string;
  to: string;
  entity?: string;
  level?: string;
  limit?: number;
}

export interface AlertQuery {
  from: string;
  to: string;
  subject?: string;
  limit?: number;
}

interface TraceRow {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  service: string;
  operation: string;
  host: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  statusCode: string;
}

interface TopologyEntity {
  id: string;
  type: string;
  name: string;
  props?: Record<string, unknown>;
}

interface TopologyEdge {
  src: string;
  src_type: string;
  dst: string;
  dst_type: string;
  relation: string;
  [key: string]: unknown;
}

interface TopologyFile {
  case_id: string;
  entities: TopologyEntity[];
  edges: TopologyEdge[];
  stats?: Record<string, unknown>;
  [key: string]: unknown;
}

function includes(value: unknown, search?: string): boolean {
  if (!search) return true;
  return String(value ?? "")
    .toLowerCase()
    .includes(search.toLowerCase());
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function xmlAttribute(text: string, name: string): string | undefined {
  const expression = new RegExp(`${name}="([^"]*)"`);
  return expression.exec(text)?.[1];
}

function clampLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isInteger(value) || (value ?? 0) <= 0) return fallback;
  return Math.min(value ?? fallback, maximum);
}

function defaultBaseline(range: TimeRange): TimeRange {
  const to = Date.parse(range.from);
  const duration = Math.max(Date.parse(range.to) - to, 10 * 60_000);
  return {
    from: new Date(to - duration * 2).toISOString(),
    to: new Date(to).toISOString(),
  };
}

function sourceRef(caseId: string, file: string, query: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(query)).toString("base64url");
  return `rca100://${caseId}/${file}?q=${encoded}`;
}

function timeRange(query: { from: string; to: string }): TimeRange {
  return {
    from: new Date(query.from).toISOString(),
    to: new Date(query.to).toISOString(),
  };
}

function ensureValidRange(query: { from: string; to: string }): { from: number; to: number } {
  const from = Date.parse(query.from);
  const to = Date.parse(query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    throw new Error(`Invalid time range: ${query.from} - ${query.to}`);
  }
  return { from, to };
}

export function traceQueryWindowRelation(
  startMs: number,
  endMs: number,
  window: { from: number; to: number },
): TraceQueryWindowRelation {
  return {
    startedBeforeWindow: startMs < window.from,
    startedInWindow: startMs >= window.from && startMs <= window.to,
    endedInWindow: endMs >= window.from && endMs <= window.to,
    spansEntireWindow: startMs < window.from && endMs > window.to,
  };
}

export class RCA100Adapter {
  readonly casesDir: string;
  constructor(casesDir: string) {
    this.casesDir = resolve(casesDir);
  }

  runtimeAccessiblePaths(caseId: string): string[] {
    return [this.caseDir(caseId)];
  }

  async validateCase(caseId: string): Promise<Record<string, number>> {
    const directory = this.caseDir(caseId);
    const sizes: Record<string, number> = {};
    for (const file of REQUIRED_CASE_FILES) {
      const path = join(directory, file);
      await access(path);
      if (file.endsWith(".parquet")) {
        const metadata = await readParquetMetadata(path);
        sizes[file] = Number(metadata.num_rows);
      } else {
        sizes[file] = 1;
      }
    }
    return sizes;
  }

  async loadTask(caseId: string): Promise<RcaTask> {
    const path = join(this.caseDir(caseId), "task.json");
    const task = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const prompt = String(task.prompt_text ?? "");
    const entity = (task.alert_entity ?? {}) as Record<string, unknown>;
    const window = (task.alert_window ?? {}) as Record<string, unknown>;
    const service =
      xmlAttribute(prompt, "service") ?? String(entity.entity_name ?? "").split("::")[0];
    const operation =
      xmlAttribute(prompt, "operation") ??
      String(entity.entity_name ?? "")
        .split("::")
        .slice(1)
        .join("::");
    const currentValue = finiteNumber(xmlAttribute(prompt, "current_value"));
    const available = Array.isArray(task.available_modalities) ? task.available_modalities : [];
    const modalities = available.filter((item): item is EvidenceModality =>
      ["metrics", "logs", "traces", "events", "alerts", "topology"].includes(String(item)),
    );
    return {
      caseId: String(task.task_id ?? caseId),
      version: String(task.task_version ?? "unknown"),
      alert: {
        eventId: String(task.alert_event_id ?? xmlAttribute(prompt, "event_id") ?? ""),
        title: String(task.alert_title ?? xmlAttribute(prompt, "rule_name") ?? "Alert"),
        triggerTime: String(task.alert_trigger_time ?? xmlAttribute(prompt, "alert_time") ?? ""),
        window: {
          from: String(window.start ?? ""),
          to: String(window.end ?? ""),
        },
        entity: {
          id: String(entity.entity_id ?? ""),
          name: String(entity.entity_name ?? ""),
          type: String(entity.entity_type ?? ""),
          domain: String(entity.entity_domain ?? ""),
        },
        ...(service ? { service } : {}),
        ...(operation ? { operation } : {}),
        ...(currentValue !== undefined ? { currentValue } : {}),
        workspace: String(task.workspace ?? xmlAttribute(prompt, "workspace") ?? ""),
        region: String(task.region_id ?? xmlAttribute(prompt, "region") ?? ""),
      },
      availableModalities: modalities,
    };
  }

  async getAlertContext(caseId: string): Promise<AlertContext> {
    return (await this.loadTask(caseId)).alert;
  }

  async inspectSchema(caseId: string, modality: EvidenceModality): Promise<ModalitySchema> {
    if (modality === "topology") {
      const topology = await this.loadTopology(caseId);
      return {
        modality,
        rowCount: topology.entities.length + topology.edges.length,
        fields: [
          { name: "entities", type: "json[]" },
          { name: "edges", type: "json[]" },
        ],
        file: "topology.json",
      };
    }
    const parquetModality = this.parquetModality(modality);
    const file = `${parquetModality}.parquet`;
    const metadata = await readParquetMetadata(join(this.caseDir(caseId), file));
    return {
      modality,
      rowCount: Number(metadata.num_rows),
      fields: metadataFields(metadata),
      file,
    };
  }

  async getMetricCatalog(
    caseId: string,
    signal?: AbortSignal,
  ): Promise<{
    metrics: Array<{ metric: string; entitySets: string[]; entities: number; rows: number }>;
    timeRange: TimeRange;
  }> {
    const catalog = new Map<
      string,
      { entitySets: Set<string>; entities: Set<string>; rows: number }
    >();
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    const path = join(this.caseDir(caseId), "metrics.parquet");
    await readParquetRowsBatched(
      path,
      ["time", "entity_set", "entity_name", "metric"],
      (rows) => {
        for (const row of rows) {
          const at = timestampMs(row.time, "us");
          if (at !== undefined) {
            minimum = Math.min(minimum, at);
            maximum = Math.max(maximum, at);
          }
          const name = String(row.metric ?? "");
          if (!name) continue;
          const item =
            catalog.get(name) ?? { entitySets: new Set(), entities: new Set(), rows: 0 };
          item.entitySets.add(String(row.entity_set ?? ""));
          item.entities.add(String(row.entity_name ?? ""));
          item.rows++;
          catalog.set(name, item);
        }
      },
      20_000,
      signal,
    );
    return {
      metrics: [...catalog.entries()]
        .map(([metric, item]) => ({
          metric,
          entitySets: [...item.entitySets].sort(),
          entities: item.entities.size,
          rows: item.rows,
        }))
        .sort((left, right) => left.metric.localeCompare(right.metric)),
      timeRange: {
        from: new Date(minimum).toISOString(),
        to: new Date(maximum).toISOString(),
      },
    };
  }

  async queryMetrics(
    caseId: string,
    query: MetricQuery,
    signal?: AbortSignal,
  ): Promise<
    QueryEnvelope<{
      anomalies: MetricAnomaly[];
      peerOutliers: Array<{
        entitySet: string;
        entity: string;
        metric: string;
        incidentMedian: number;
        peerMedian: number;
        ratio: number;
        rawRef: string;
      }>;
      sample: Record<string, unknown>[];
    }>
  > {
    const incident = ensureValidRange(query);
    const baselineRange = query.baselineFrom
      ? { from: query.baselineFrom, to: query.baselineTo ?? query.from }
      : defaultBaseline(timeRange(query));
    const baseline = ensureValidRange(baselineRange);
    const topN = clampLimit(query.topN, 20, 100);
    const sampleLimit = Math.min(topN, 20);
    const groups = new Map<string, { row: ParquetRow; baseline: number[]; incident: number[] }>();
    const sample: Record<string, unknown>[] = [];
    let matchedRows = 0;
    const path = join(this.caseDir(caseId), "metrics.parquet");

    await readParquetRowsBatched(
      path,
      [
        "time",
        "domain",
        "entity_set",
        "entity_id",
        "entity_name",
        "metric",
        "value",
        "service",
      ],
      (rows) => {
        for (const row of rows) {
          const at = timestampMs(row.time, "us");
          if (at === undefined || at < baseline.from || at > incident.to) continue;
          if (
            query.service &&
            !includes(row.service, query.service) &&
            !includes(row.entity_name, query.service)
          ) {
            continue;
          }
          if (query.operation && !includes(row.entity_name, query.operation)) continue;
          if (
            query.entity &&
            !includes(row.entity_name, query.entity) &&
            !includes(row.entity_id, query.entity)
          ) {
            continue;
          }
          if (query.metric && !includes(row.metric, query.metric)) continue;
          matchedRows++;

          const value = finiteNumber(row.value);
          if (value === undefined) continue;
          const key = `${String(row.entity_set)}\u0000${String(row.entity_name)}\u0000${String(
            row.metric,
          )}`;
          const group = groups.get(key) ?? { row, baseline: [], incident: [] };
          if (at >= baseline.from && at < baseline.to) group.baseline.push(value);
          if (at >= incident.from && at <= incident.to) {
            group.incident.push(value);
            if (sample.length < sampleLimit) {
              sample.push({
                time: epochToIso(row.time, "us"),
                entitySet: row.entity_set,
                entity: row.entity_name,
                metric: row.metric,
                value: row.value,
              });
            }
          }
          groups.set(key, group);
        }
      },
      20_000,
      signal,
    );

    const anomalies: MetricAnomaly[] = [];
    for (const group of groups.values()) {
      if (group.baseline.length < 3 || group.incident.length < 1) continue;
      const baselineMedian = median(group.baseline);
      const incidentMedian = median(group.incident);
      const ratio = safeRatio(incidentMedian, baselineMedian);
      const robustZ = robustZScore(group.baseline, incidentMedian);
      const change = Math.log2(Math.max(Math.abs(ratio), 1e-9));
      const score = Math.abs(change) + Math.min(Math.abs(robustZ) / 25, 20);
      const direction = ratio > 1.15 ? "increase" : ratio < 0.85 ? "decrease" : "flat";
      const refQuery = {
        entity: group.row.entity_name,
        metric: group.row.metric,
        incident: timeRange(query),
        baseline: baselineRange,
      };
      anomalies.push({
        entitySet: String(group.row.entity_set ?? ""),
        ...(group.row.entity_id ? { entityId: String(group.row.entity_id) } : {}),
        entity: String(group.row.entity_name ?? ""),
        ...(group.row.service ? { service: String(group.row.service) } : {}),
        metric: String(group.row.metric ?? ""),
        baselineCount: group.baseline.length,
        incidentCount: group.incident.length,
        baselineMedian,
        incidentMedian,
        baselineP95: quantile(group.baseline, 0.95),
        incidentP95: quantile(group.incident, 0.95),
        ratio,
        robustZ,
        direction,
        score,
        rawRef: sourceRef(caseId, "metrics.parquet", refQuery),
      });
    }
    anomalies.sort((left, right) => right.score - left.score);

    const peerGroups = new Map<
      string,
      Array<{ row: ParquetRow; entity: string; incidentMedian: number }>
    >();
    for (const group of groups.values()) {
      if (group.incident.length === 0) continue;
      const key = `${String(group.row.entity_set)}\u0000${String(group.row.metric)}`;
      const peers = peerGroups.get(key) ?? [];
      peers.push({
        row: group.row,
        entity: String(group.row.entity_name ?? ""),
        incidentMedian: median(group.incident),
      });
      peerGroups.set(key, peers);
    }

    const peerOutliers: Array<{
      entitySet: string;
      entityId?: string;
      entity: string;
      service?: string;
      metric: string;
      incidentMedian: number;
      peerMedian: number;
      ratio: number;
      rawRef: string;
    }> = [];
    for (const peers of peerGroups.values()) {
      if (peers.length < 2) continue;
      const peerMedian = median(peers.map((item) => item.incidentMedian));
      for (const item of peers) {
        const ratio = safeRatio(item.incidentMedian, peerMedian);
        if (ratio < 2 && ratio > 0.5) continue;
        peerOutliers.push({
          entitySet: String(item.row.entity_set ?? ""),
          ...(item.row.entity_id ? { entityId: String(item.row.entity_id) } : {}),
          entity: item.entity,
          ...(item.row.service ? { service: String(item.row.service) } : {}),
          metric: String(item.row.metric ?? ""),
          incidentMedian: item.incidentMedian,
          peerMedian,
          ratio,
          rawRef: sourceRef(caseId, "metrics.parquet", {
            entity: item.entity,
            metric: item.row.metric,
            incident: timeRange(query),
            comparison: "peer-median",
          }),
        });
      }
    }
    peerOutliers.sort(
      (left, right) =>
        Math.abs(Math.log2(Math.max(right.ratio, 1e-9))) -
        Math.abs(Math.log2(Math.max(left.ratio, 1e-9))),
    );

    const rawRef = sourceRef(
      caseId,
      "metrics.parquet",
      query as unknown as Record<string, unknown>,
    );
    return {
      caseId,
      modality: "metric",
      query: query as unknown as Record<string, unknown>,
      matchedRows,
      returnedRows: Math.min(anomalies.length, topN),
      truncated: anomalies.length > topN,
      rawRef,
      data: {
        anomalies: anomalies.slice(0, topN),
        peerOutliers: peerOutliers.slice(0, topN),
        sample: jsonSafe(sample) as Record<string, unknown>[],
      },
    };
  }

  async queryTraces(
    caseId: string,
    query: TraceQuery,
    signal?: AbortSignal,
  ): Promise<
    QueryEnvelope<{
      anomalies: TraceAnomaly[];
      topSpans: TracePathNode[];
      criticalPaths: CriticalTracePath[];
      propagationCandidates: Array<{
        service: string;
        operation: string;
        host?: string;
        observations: number;
        medianDurationMs: number;
      }>;
    }>
  > {
    const incident = ensureValidRange(query);
    const baselineRange = query.baselineFrom
      ? { from: query.baselineFrom, to: query.baselineTo ?? query.from }
      : defaultBaseline(timeRange(query));
    const baseline = ensureValidRange(baselineRange);
    const topN = clampLimit(query.topN, 15, 50);
    const basis = query.timeBasis ?? "end";
    const inRange = (row: TraceRow, range: { from: number; to: number }) => {
      if (basis === "start") return row.startMs >= range.from && row.startMs <= range.to;
      if (basis === "overlap") return row.startMs <= range.to && row.endMs >= range.from;
      return row.endMs >= range.from && row.endMs <= range.to;
    };

    const columns = [
      "traceId",
      "spanId",
      "parentSpanId",
      "spanName",
      "startTime",
      "endTime",
      "duration",
      "serviceName",
      "hostname",
      "statusCode",
    ];
    const tracePath = join(this.caseDir(caseId), "traces.parquet");
    const groups = new Map<string, { sample: TraceRow; baseline: number[]; incident: number[] }>();
    const rootByTrace = new Map<string, TraceRow>();
    const topFocus: TraceRow[] = [];
    let matchedRows = 0;

    const retainTopFocus = (row: TraceRow) => {
      topFocus.push(row);
      topFocus.sort((left, right) => right.durationMs - left.durationMs);
      if (topFocus.length > topN) topFocus.length = topN;
    };

    await readParquetRowsBatched(tracePath, columns, (batch) => {
      for (const raw of batch) {
        const row = this.traceRow(raw);
        if (!row) continue;
        const inBaseline = inRange(row, baseline);
        const inIncident = inRange(row, incident);
        if (!inBaseline && !inIncident) continue;

        const key = `${row.service}\u0000${row.operation}\u0000${row.host}`;
        const group = groups.get(key) ?? { sample: row, baseline: [], incident: [] };
        if (inBaseline) group.baseline.push(row.durationMs);
        if (inIncident) group.incident.push(row.durationMs);
        groups.set(key, group);

        if (
          inIncident &&
          includes(row.service, query.service) &&
          includes(row.operation, query.operation) &&
          includes(row.host, query.host)
        ) {
          matchedRows++;
          retainTopFocus(row);
          const existing = rootByTrace.get(row.traceId);
          if (!existing || row.durationMs > existing.durationMs) {
            rootByTrace.set(row.traceId, row);
          }
        }
      }
    }, undefined, signal);

    const anomalies: TraceAnomaly[] = [];
    for (const group of groups.values()) {
      if (group.baseline.length < 5 || group.incident.length < 2) continue;
      const baselineP95Ms = quantile(group.baseline, 0.95);
      const incidentP95Ms = quantile(group.incident, 0.95);
      const ratio = safeRatio(incidentP95Ms + 1, baselineP95Ms + 1);
      anomalies.push({
        service: group.sample.service,
        operation: group.sample.operation,
        ...(group.sample.host ? { host: group.sample.host } : {}),
        baselineCount: group.baseline.length,
        incidentCount: group.incident.length,
        baselineP95Ms,
        incidentP95Ms,
        ratio,
        maxIncidentMs: Math.max(...group.incident),
        rawRef: sourceRef(caseId, "traces.parquet", {
          service: group.sample.service,
          operation: group.sample.operation,
          host: group.sample.host,
          baseline: baselineRange,
          incident: timeRange(query),
          timeBasis: basis,
        }),
      });
    }
    anomalies.sort(
      (left, right) =>
        Math.log2(Math.max(right.ratio, 1)) * Math.log10(right.incidentP95Ms + 10) -
        Math.log2(Math.max(left.ratio, 1)) * Math.log10(left.incidentP95Ms + 10),
    );

    const roots = [...rootByTrace.values()]
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, Math.min(5, topN));
    const selectedTraceIds = new Set(roots.map((row) => row.traceId));
    const rowsByTrace = new Map<string, TraceRow[]>();
    if (selectedTraceIds.size > 0) {
      await readParquetRowsBatched(tracePath, columns, (batch) => {
        for (const raw of batch) {
          const traceId = String(raw.traceId ?? "");
          if (!selectedTraceIds.has(traceId)) continue;
          const row = this.traceRow(raw);
          if (!row) continue;
          const traceRows = rowsByTrace.get(traceId) ?? [];
          traceRows.push(row);
          rowsByTrace.set(traceId, traceRows);
        }
      }, undefined, signal);
    }

    const paths: CriticalTracePath[] = roots.map((root) => {
      const path = this.longestChildPath(root, rowsByTrace.get(root.traceId) ?? [root]);
      return {
        traceId: root.traceId,
        totalDurationMs: root.durationMs,
        path: path.map((row) => this.tracePathNode(row, incident)),
        rawRef: sourceRef(caseId, "traces.parquet", {
          traceId: root.traceId,
          spanId: root.spanId,
        }),
      };
    });

    const candidateGroups = new Map<string, { sample: TracePathNode; durations: number[] }>();
    for (const item of paths) {
      const rootService = item.path[0]?.service;
      for (const node of item.path) {
        if (!node.service || node.service === rootService) continue;
        const key = `${node.service}\u0000${node.operation}\u0000${node.host ?? ""}`;
        const group = candidateGroups.get(key) ?? { sample: node, durations: [] };
        group.durations.push(node.durationMs);
        candidateGroups.set(key, group);
      }
    }
    const propagationCandidates = [...candidateGroups.values()]
      .map((group) => ({
        service: group.sample.service,
        operation: group.sample.operation,
        ...(group.sample.host ? { host: group.sample.host } : {}),
        observations: group.durations.length,
        medianDurationMs: median(group.durations),
      }))
      .sort((left, right) => right.medianDurationMs - left.medianDurationMs)
      .slice(0, topN);
    const rawRef = sourceRef(caseId, "traces.parquet", query as unknown as Record<string, unknown>);
    return {
      caseId,
      modality: "trace",
      query: query as unknown as Record<string, unknown>,
      matchedRows,
      returnedRows: Math.min(matchedRows, topN),
      truncated: matchedRows > topN,
      rawRef,
      data: {
        anomalies: anomalies.slice(0, topN),
        topSpans: topFocus.map((row) => this.tracePathNode(row, incident)),
        criticalPaths: paths,
        propagationCandidates,
      },
    };
  }

  async queryLogs(
    caseId: string,
    query: LogQuery,
    signal?: AbortSignal,
  ): Promise<
    QueryEnvelope<{
      serviceCounts: Record<string, number>;
      keywordCounts: Record<string, number>;
      samples: Array<Record<string, unknown>>;
      durationSignals: Array<Record<string, unknown>>;
      noRelevantEvidence: boolean;
    }>
  > {
    const range = ensureValidRange(query);
    const limit = clampLimit(query.limit, 30, 200);
    const keywords = query.keywords ?? [
      "error",
      "exception",
      "timeout",
      "timed out",
      "connection refused",
      "retry",
      "failed",
      "unavailable",
      "deadline",
      "panic",
      "fatal",
      "reset",
    ];
    const serviceCounts: Record<string, number> = {};
    const keywordCounts: Record<string, number> = {};
    const samples: Array<Record<string, unknown>> = [];
    const durationSignals: Array<Record<string, unknown>> = [];
    let matchedRows = 0;
    const path = join(this.caseDir(caseId), "logs.parquet");

    await readParquetRowsBatched(
      path,
      ["content", "_time_", "_container_name_", "_pod_name_", "__tag__:_node_name_"],
      (rows) => {
        for (const row of rows) {
          const at = timestampMs(row._time_);
          if (at === undefined || at < range.from || at > range.to) continue;
          if (!includes(row._container_name_, query.service)) continue;
          if (!includes(row._pod_name_, query.pod)) continue;

          const service = String(row._container_name_ ?? "unknown");
          serviceCounts[service] = (serviceCounts[service] ?? 0) + 1;
          const content = String(row.content ?? "");
          const lower = content.toLowerCase();
          let matched = keywords.length === 0;
          for (const keyword of keywords) {
            if (!lower.includes(keyword.toLowerCase())) continue;
            keywordCounts[keyword] = (keywordCounts[keyword] ?? 0) + 1;
            matched = true;
          }
          if (matched) {
            matchedRows++;
            if (samples.length < limit) {
              samples.push({
                time: row._time_,
                service: row._container_name_,
                pod: row._pod_name_,
                node: row["__tag__:_node_name_"],
                content: content.slice(0, 1_200),
              });
            }
          }

          const accessDuration = /"\s+\d{3}\s+-?\s+([\d.]+)\s*$/.exec(content)?.[1];
          const durationSeconds = finiteNumber(accessDuration);
          if (durationSeconds !== undefined && durationSeconds >= 1) {
            durationSignals.push({
              time: row._time_,
              service,
              pod: row._pod_name_,
              durationSeconds,
              content: content.slice(0, 600),
            });
            durationSignals.sort(
              (left, right) =>
                Number(right.durationSeconds ?? 0) - Number(left.durationSeconds ?? 0),
            );
            if (durationSignals.length > limit) durationSignals.length = limit;
          }
        }
      },
      20_000,
      signal,
    );

    const rawRef = sourceRef(caseId, "logs.parquet", query as unknown as Record<string, unknown>);
    return {
      caseId,
      modality: "log",
      query: query as unknown as Record<string, unknown>,
      matchedRows,
      returnedRows: samples.length,
      truncated: matchedRows > limit,
      rawRef,
      data: {
        serviceCounts,
        keywordCounts,
        samples: jsonSafe(samples) as Array<Record<string, unknown>>,
        durationSignals: jsonSafe(durationSignals) as Array<Record<string, unknown>>,
        noRelevantEvidence: matchedRows === 0 && durationSignals.length === 0,
      },
    };
  }

  async queryEvents(
    caseId: string,
    query: EventQuery,
    signal?: AbortSignal,
  ): Promise<
    QueryEnvelope<{
      levelCounts: Record<string, number>;
      samples: Array<Record<string, unknown>>;
      noRelevantEvidence: boolean;
    }>
  > {
    const range = ensureValidRange(query);
    const limit = clampLimit(query.limit, 30, 100);
    const levelCounts: Record<string, number> = {};
    const samples: Array<Record<string, unknown>> = [];
    let matchedRows = 0;
    const path = join(this.caseDir(caseId), "events.parquet");

    await readParquetRowsBatched(
      path,
      ["eventId", "hostname", "level", "pod_name", "clusterName"],
      (rows) => {
        for (const row of rows) {
          const event = parseJsonObject(row.eventId);
          const metadata = (event?.metadata ?? {}) as Record<string, unknown>;
          const time =
            event?.lastTimestamp ??
            event?.eventTime ??
            event?.firstTimestamp ??
            metadata.creationTimestamp;
          const at = timestampMs(time);
          if (at === undefined || at < range.from || at > range.to) continue;
          if (query.level && !includes(row.level, query.level)) continue;
          if (query.entity) {
            const haystack = `${String(row.hostname ?? "")} ${String(
              row.pod_name ?? "",
            )} ${JSON.stringify(event ?? {})}`;
            if (!includes(haystack, query.entity)) continue;
          }
          matchedRows++;
          const level = String(row.level ?? "unknown");
          levelCounts[level] = (levelCounts[level] ?? 0) + 1;
          if (samples.length < limit) {
            samples.push({
              time,
              level,
              pod: row.pod_name,
              node: row.hostname,
              reason: event?.reason,
              message: event?.message,
              involvedObject: event?.involvedObject,
            });
          }
        }
      },
      20_000,
      signal,
    );

    const rawRef = sourceRef(caseId, "events.parquet", query as unknown as Record<string, unknown>);
    return {
      caseId,
      modality: "event",
      query: query as unknown as Record<string, unknown>,
      matchedRows,
      returnedRows: samples.length,
      truncated: matchedRows > limit,
      rawRef,
      data: {
        levelCounts,
        samples: jsonSafe(samples) as Array<Record<string, unknown>>,
        noRelevantEvidence: matchedRows === 0,
      },
    };
  }

  async queryAlerts(
    caseId: string,
    query: AlertQuery,
    signal?: AbortSignal,
  ): Promise<QueryEnvelope<{ samples: Array<Record<string, unknown>> }>> {
    const range = ensureValidRange(query);
    const limit = clampLimit(query.limit, 20, 100);
    const samples: Array<Record<string, unknown>> = [];
    let matchedRows = 0;
    const path = join(this.caseDir(caseId), "alerts.parquet");

    await readParquetRowsBatched(
      path,
      ["time", "subject", "severity", "status", "resource", "data", "id"],
      (rows) => {
        for (const row of rows) {
          const at = timestampMs(row.time);
          if (
            at === undefined ||
            at < range.from ||
            at > range.to ||
            !includes(row.subject, query.subject)
          ) {
            continue;
          }
          matchedRows++;
          if (samples.length < limit) {
            samples.push({
              id: row.id,
              time: row.time,
              subject: row.subject,
              severity: row.severity,
              status: row.status,
              resource: parseJsonObject(row.resource),
              data: parseJsonObject(row.data),
            });
          }
        }
      },
      20_000,
      signal,
    );

    const rawRef = sourceRef(caseId, "alerts.parquet", query as unknown as Record<string, unknown>);
    return {
      caseId,
      modality: "alert",
      query: query as unknown as Record<string, unknown>,
      matchedRows,
      returnedRows: samples.length,
      truncated: matchedRows > limit,
      rawRef,
      data: { samples: jsonSafe(samples) as Array<Record<string, unknown>> },
    };
  }

  async getTopology(
    caseId: string,
    entity?: string,
    depth = 1,
  ): Promise<
    QueryEnvelope<{
      entities: TopologyEntity[];
      edges: TopologyEdge[];
      dependencies: Array<{ source: string; target: string; relation: string }>;
    }>
  > {
    const topology = await this.loadTopology(caseId);
    const byId = new Map(topology.entities.map((item) => [item.id, item]));
    let selectedIds = new Set(
      topology.entities
        .filter((item) => !entity || includes(item.id, entity) || includes(item.name, entity))
        .map((item) => item.id),
    );
    const safeDepth = Math.max(0, Math.min(Math.floor(depth), 3));
    for (let iteration = 0; iteration < safeDepth; iteration++) {
      const expanded = new Set(selectedIds);
      for (const edge of topology.edges) {
        if (selectedIds.has(edge.src)) expanded.add(edge.dst);
        if (selectedIds.has(edge.dst)) expanded.add(edge.src);
      }
      selectedIds = expanded;
    }
    const edges = topology.edges.filter(
      (edge) => selectedIds.has(edge.src) && selectedIds.has(edge.dst),
    );
    const entities = [...selectedIds]
      .map((id) => byId.get(id))
      .filter((item): item is TopologyEntity => item !== undefined);
    const dependencies = topology.edges
      .filter((edge) => edge.relation === "calls")
      .map((edge) => ({
        source: byId.get(edge.src)?.name ?? edge.src,
        target: byId.get(edge.dst)?.name ?? edge.dst,
        relation: edge.relation,
      }));
    const query = { entity, depth: safeDepth };
    const rawRef = sourceRef(caseId, "topology.json", query);
    return {
      caseId,
      modality: "topology",
      query,
      matchedRows: entities.length + edges.length,
      returnedRows: entities.length + edges.length,
      truncated: false,
      rawRef,
      data: { entities, edges, dependencies },
    };
  }

  private caseDir(caseId: string): string {
    if (!/^t\d{3,}$/.test(caseId)) throw new Error(`Invalid RCA100 case id: ${caseId}`);
    const directory = resolve(this.casesDir, caseId);
    const child = relative(this.casesDir, directory);
    if (!child || child.startsWith("..") || child.includes("answer_key")) {
      throw new Error(`RCA100 case path escaped cases directory: ${caseId}`);
    }
    return directory;
  }

  private parquetModality(modality: EvidenceModality): ParquetModality {
    const plural =
      modality === "metric"
        ? "metrics"
        : modality === "log"
          ? "logs"
          : modality === "trace"
            ? "traces"
            : modality === "event"
              ? "events"
              : modality === "alert"
                ? "alerts"
                : modality;
    if (!PARQUET_MODALITIES.includes(plural as ParquetModality)) {
      throw new Error(`Modality ${modality} is not a parquet modality`);
    }
    return plural as ParquetModality;
  }

  private async loadTopology(caseId: string): Promise<TopologyFile> {
    const path = join(this.caseDir(caseId), "topology.json");
    return JSON.parse(await readFile(path, "utf8")) as TopologyFile;
  }

  private traceRow(row: ParquetRow): TraceRow | undefined {
    const startIso = epochToIso(row.startTime, "ns");
    const endIso = epochToIso(row.endTime, "ns");
    const durationNs = finiteNumber(row.duration);
    if (!startIso || !endIso || durationNs === undefined) return undefined;
    return {
      traceId: String(row.traceId ?? ""),
      spanId: String(row.spanId ?? ""),
      parentSpanId: String(row.parentSpanId ?? ""),
      service: String(row.serviceName ?? ""),
      operation: String(row.spanName ?? ""),
      host: String(row.hostname ?? ""),
      startMs: Date.parse(startIso),
      endMs: Date.parse(endIso),
      durationMs: durationNs / 1_000_000,
      statusCode: String(row.statusCode ?? ""),
    };
  }

  private longestChildPath(root: TraceRow, traceRows: TraceRow[]): TraceRow[] {
    const children = new Map<string, TraceRow[]>();
    for (const row of traceRows) {
      const list = children.get(row.parentSpanId) ?? [];
      list.push(row);
      children.set(row.parentSpanId, list);
    }
    const path = [root];
    const visited = new Set([root.spanId]);
    let current = root;
    while (true) {
      const candidates = (children.get(current.spanId) ?? [])
        .filter((item) => !visited.has(item.spanId))
        .sort((left, right) => right.durationMs - left.durationMs);
      const next = candidates[0];
      if (!next) break;
      path.push(next);
      visited.add(next.spanId);
      current = next;
    }
    return path;
  }

  private tracePathNode(
    row: TraceRow,
    queryWindow?: { from: number; to: number },
  ): TracePathNode {
    return {
      service: row.service,
      operation: row.operation,
      ...(row.host ? { host: row.host } : {}),
      startTime: new Date(row.startMs).toISOString(),
      endTime: new Date(row.endMs).toISOString(),
      durationMs: row.durationMs,
      spanId: row.spanId,
      ...(row.parentSpanId ? { parentSpanId: row.parentSpanId } : {}),
      ...(row.statusCode ? { statusCode: row.statusCode } : {}),
      ...(queryWindow
        ? { queryWindowRelation: traceQueryWindowRelation(row.startMs, row.endMs, queryWindow) }
        : {}),
    };
  }
}

export function rcaCaseFileNames(): readonly string[] {
  return REQUIRED_CASE_FILES;
}
