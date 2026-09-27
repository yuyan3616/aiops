import type { ObservabilityToolName, ToolExecution } from "./tools";
import type {
  ExpertFinding,
  ExpertKind,
  Investigation,
  QueryEnvelope,
  RcaTask,
  TimeRange,
  TraceAnomaly,
  CriticalTracePath,
  MetricAnomaly,
} from "./types";

export interface RecordedToolExecution {
  callId: string;
  execution: ToolExecution;
}

export interface ExpertContext {
  investigation: Investigation;
  task: RcaTask;
  hypothesisIds: {
    local: string;
    downstream: string;
    infrastructure: string;
    candidate?: string;
  };
  candidate?: {
    service: string;
    operation?: string;
    host?: string;
  };
  invoke: (
    tool: ObservabilityToolName,
    arguments_: Record<string, unknown>,
  ) => Promise<RecordedToolExecution>;
}

export interface ExpertAgent {
  kind: ExpertKind;
  investigate(context: ExpertContext): Promise<ExpertFinding>;
}

function rangeArguments(caseId: string, range: TimeRange): Record<string, unknown> {
  return { caseId, from: range.from, to: range.to };
}

function resultOf<T>(recorded: RecordedToolExecution): T {
  return recorded.execution.result as T;
}

export class TraceExpert implements ExpertAgent {
  readonly kind = "trace" as const;

  async investigate(context: ExpertContext): Promise<ExpertFinding> {
    const { task } = context;
    await context.invoke("get_trace_fields", { caseId: task.caseId });
    const dependencyCall = await context.invoke("get_service_dependencies", {
      caseId: task.caseId,
      service: task.alert.service,
    });
    const dependencies = resultOf<
      QueryEnvelope<{
        dependencies: Array<{ source: string; target: string; relation: string }>;
      }>
    >(dependencyCall);
    const directServices = new Set(
      dependencies.data.dependencies
        .map((item) => item.target.toLowerCase())
        .filter((target) => /^[a-z][a-z0-9-]*$/.test(target)),
    );
    const focusEndCall = await context.invoke("query_traces", {
      ...rangeArguments(task.caseId, task.alert.window),
      service: task.alert.service,
      operation: task.alert.operation,
      timeBasis: "end",
      topN: 20,
    });
    const focusEnd = resultOf<
      QueryEnvelope<{
        anomalies: TraceAnomaly[];
        criticalPaths: CriticalTracePath[];
        propagationCandidates: Array<{
          service: string;
          operation: string;
          host?: string;
          observations: number;
          medianDurationMs: number;
        }>;
      }>
    >(focusEndCall);
    const focusStartCall = await context.invoke("query_traces", {
      ...rangeArguments(task.caseId, task.alert.window),
      service: task.alert.service,
      operation: task.alert.operation,
      timeBasis: "start",
      topN: 10,
    });
    const focusStart = resultOf<typeof focusEnd>(focusStartCall);
    const breadthCall = await context.invoke("query_traces", {
      ...rangeArguments(task.caseId, task.alert.window),
      timeBasis: "end",
      topN: 50,
    });
    const breadth = resultOf<typeof focusEnd>(breadthCall);
    const dependencyAnomalies = breadth.data.anomalies.filter(
      (item) =>
        directServices.has(item.service.toLowerCase()) &&
        item.ratio >= 3 &&
        item.incidentCount >= 2,
    );
    const grouped = new Map<string, TraceAnomaly[]>();
    for (const anomaly of dependencyAnomalies) {
      const values = grouped.get(anomaly.service) ?? [];
      values.push(anomaly);
      grouped.set(anomaly.service, values);
    }
    const ranked = [...grouped.entries()]
      .map(([service, anomalies]) => ({
        service,
        anomalies,
        score: Math.max(...anomalies.map((item) => item.ratio)),
        hosts: new Set(anomalies.map((item) => item.host).filter(Boolean)),
      }))
      .sort((left, right) => right.score - left.score);
    const dependencyCandidate = ranked[0];
    const representative = dependencyCandidate?.anomalies[0];
    const completedPath = focusEnd.data.criticalPaths[0];
    const staleCompletion = Boolean(
      completedPath &&
      Date.parse(completedPath.path[0]?.startTime ?? task.alert.window.from) <
        Date.parse(task.alert.window.from),
    );
    if (!dependencyCandidate || !representative) {
      return {
        summary:
          "Trace data did not expose a newly degraded direct dependency aligned with the alert onset.",
        evidence: [
          {
            caseId: task.caseId,
            modality: "trace",
            timeRange: task.alert.window,
            summary:
              "No direct dependency had a ≥3× trace-latency increase with repeated observations in the alert window. Long spans completing in-window were not treated as causal when they began before the window.",
            rawRef: breadth.rawRef,
            supports: [],
            contradicts: [context.hypothesisIds.downstream],
            sourceQuery: breadth.query,
            toolCallId: breadthCall.callId,
            facts: {
              directServices: [...directServices],
              freshAlertOperationStarts: focusStart.matchedRows,
              staleCompletion,
            },
          },
        ],
        candidateEntities: [],
        nextChecks: [
          "Inspect service-local metrics and errors because traces did not localize the delay.",
        ],
      };
    }
    const operation = representative.operation;
    const host =
      dependencyCandidate.hosts.size === 1 ? [...dependencyCandidate.hosts][0] : undefined;
    const entity = `${dependencyCandidate.service}::${operation}`;
    const ratios = dependencyCandidate.anomalies
      .slice(0, 4)
      .map((item) => `${item.host ?? item.operation}: ${item.ratio.toFixed(1)}×`)
      .join(", ");
    return {
      summary: `Trace onset analysis identifies ${dependencyCandidate.service} as the newly degraded direct dependency (${ratios}).`,
      evidence: [
        {
          caseId: task.caseId,
          modality: "trace",
          entity,
          timeRange: task.alert.window,
          summary: `${dependencyCandidate.service}/${operation} trace p95 increased from ${representative.baselineP95Ms.toFixed(3)} ms to ${representative.incidentP95Ms.toFixed(3)} ms (${representative.ratio.toFixed(1)}×) across ${dependencyCandidate.hosts.size} observed host(s), aligned with the alert window. Pre-window long-span completions were retained as context but not selected as the onset cause.`,
          rawRef: representative.rawRef,
          supports: [context.hypothesisIds.downstream],
          contradicts: [],
          sourceQuery: breadth.query,
          toolCallId: breadthCall.callId,
          facts: {
            directServices: [...directServices],
            dependencyAnomalies: dependencyCandidate.anomalies,
            freshAlertOperationStarts: focusStart.matchedRows,
            staleCompletedPath: staleCompletion ? completedPath : undefined,
          },
        },
      ],
      candidateEntities: [dependencyCandidate.service, entity, ...(host ? [host] : [])],
      candidateMechanism: "new dependency-wide latency onset propagated to the alert operation",
      nextChecks: [
        `Verify ${dependencyCandidate.service} latency, throughput, and resources against its pre-alert baseline.`,
        `Inspect ${dependencyCandidate.service} logs without assuming an error message exists.`,
        `Check events and topology around ${dependencyCandidate.service}.`,
      ],
    };
  }
}

export class MetricsExpert implements ExpertAgent {
  readonly kind = "metrics" as const;

  async investigate(context: ExpertContext): Promise<ExpertFinding> {
    const candidate = context.candidate;
    if (!candidate) throw new Error("Metrics expert requires a trace-localized candidate");
    await context.invoke("get_metric_catalog", { caseId: context.task.caseId });
    const recorded = await context.invoke("query_metrics", {
      ...rangeArguments(context.task.caseId, context.task.alert.window),
      service: candidate.service,
      topN: 50,
    });
    const result = resultOf<
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
      }>
    >(recorded);
    const temporalLatency = result.data.anomalies
      .filter(
        (item) =>
          item.metric.toLowerCase().includes("latency") &&
          item.direction === "increase" &&
          item.ratio >= 3,
      )
      .sort((left, right) => right.ratio - left.ratio);
    const latencyPeers = result.data.peerOutliers
      .filter((item) => item.metric.toLowerCase().includes("latency") && item.ratio > 1)
      .sort((left, right) => right.ratio - left.ratio);
    const latency =
      latencyPeers.find((item) => !candidate.host || item.entity === candidate.host) ??
      latencyPeers[0];
    const resourceIncreases = result.data.anomalies.filter((item) => {
      const metric = item.metric.toLowerCase();
      return (
        item.direction === "increase" &&
        (metric.includes("cpu") || metric.includes("memory") || metric.includes("disk")) &&
        item.ratio >= 1.5
      );
    });
    const evidence: ExpertFinding["evidence"] = [];
    const temporal = temporalLatency[0];
    if (temporal) {
      evidence.push({
        caseId: context.task.caseId,
        modality: "metric",
        entity: temporal.entity,
        timeRange: context.task.alert.window,
        summary: `${temporal.entity} ${temporal.metric} rose from median ${temporal.baselineMedian.toFixed(4)} to ${temporal.incidentMedian.toFixed(4)} (${temporal.ratio.toFixed(1)}×) at the incident onset.`,
        rawRef: temporal.rawRef,
        supports: context.hypothesisIds.candidate
          ? [context.hypothesisIds.candidate]
          : [context.hypothesisIds.downstream],
        contradicts: [context.hypothesisIds.local],
        sourceQuery: result.query,
        toolCallId: recorded.callId,
        facts: {
          temporalLatency: temporalLatency.slice(0, 10),
          throughputChanges: result.data.anomalies
            .filter(
              (item) =>
                (item.metric.includes("request_count") || item.metric.includes("workload")) &&
                item.direction === "decrease",
            )
            .slice(0, 10),
        },
      });
    } else if (latency) {
      evidence.push({
        caseId: context.task.caseId,
        modality: "metric",
        entity: latency.entity,
        timeRange: context.task.alert.window,
        summary: `${latency.entity} is a peer outlier for ${latency.metric}: incident median ${latency.incidentMedian.toFixed(3)} versus peer median ${latency.peerMedian.toFixed(3)} (${latency.ratio.toFixed(1)}×).`,
        rawRef: latency.rawRef,
        supports: context.hypothesisIds.candidate
          ? [context.hypothesisIds.candidate]
          : [context.hypothesisIds.downstream],
        contradicts: [context.hypothesisIds.local],
        sourceQuery: result.query,
        toolCallId: recorded.callId,
        facts: latency,
      });
    }
    evidence.push({
      caseId: context.task.caseId,
      modality: "metric",
      entity: candidate.service,
      timeRange: context.task.alert.window,
      summary:
        resourceIncreases.length === 0
          ? `No ≥1.5× CPU, memory, or disk increase was observed for ${candidate.service} in the queried metric catalog; available metrics do not support resource saturation.`
          : `${resourceIncreases.length} resource metric increases were observed for ${candidate.service}; infrastructure saturation remains possible.`,
      rawRef: result.rawRef,
      supports: resourceIncreases.length > 0 ? [context.hypothesisIds.infrastructure] : [],
      // Missing resource pressure rules out only that mechanism. It does not
      // rule out a network or policy failure, so do not reject the broader
      // infrastructure hypothesis from negative CPU/memory evidence alone.
      contradicts: [],
      sourceQuery: result.query,
      toolCallId: recorded.callId,
      facts: { resourceIncreases: resourceIncreases.slice(0, 10) },
    });
    return {
      summary: temporal
        ? `Metrics confirm a new latency onset in ${temporal.entity}.`
        : latency
          ? `Metrics localize the latency to ${latency.entity} relative to its peers.`
          : `Metrics do not provide a peer-level latency outlier for ${candidate.service}.`,
      evidence,
      candidateEntities: temporal
        ? [candidate.service, temporal.entity]
        : latency
          ? [candidate.service, latency.entity]
          : [candidate.service],
      candidateMechanism:
        resourceIncreases.length === 0
          ? "latency without observed compute or storage saturation"
          : "latency associated with resource pressure",
      nextChecks: [
        `Inspect ${candidate.service} request logs for slow successful responses and explicit failures.`,
      ],
    };
  }
}

export class LogExpert implements ExpertAgent {
  readonly kind = "log" as const;

  async investigate(context: ExpertContext): Promise<ExpertFinding> {
    const candidate = context.candidate;
    if (!candidate) throw new Error("Log expert requires a trace-localized candidate");
    await context.invoke("get_log_fields", { caseId: context.task.caseId });
    const errorCall = await context.invoke("query_logs", {
      ...rangeArguments(context.task.caseId, context.task.alert.window),
      service: candidate.service,
      ...(candidate.host ? { pod: candidate.host } : {}),
      limit: 30,
    });
    const errors = resultOf<
      QueryEnvelope<{
        keywordCounts: Record<string, number>;
        samples: Array<Record<string, unknown>>;
        durationSignals: Array<Record<string, unknown>>;
        noRelevantEvidence: boolean;
      }>
    >(errorCall);
    // Always inspect unfiltered records for slow successful access logs. An
    // unrelated exporter error must not prevent this second, causal check.
    const accessCall = await context.invoke("query_logs", {
      ...rangeArguments(context.task.caseId, context.task.alert.window),
      service: candidate.service,
      ...(candidate.host ? { pod: candidate.host } : {}),
      keywords: [],
      limit: 30,
    });
    const access = resultOf<typeof errors>(accessCall);
    const slow = access.data.durationSignals[0];
    const applicationErrorSamples = errors.data.samples.filter((sample) => {
      const content = String(sample.content ?? "").toLowerCase();
      const exporterNoise =
        content.includes("opentelemetry") &&
        (content.includes("export") || content.includes("collector"));
      return !exporterNoise;
    });
    const errorCount = applicationErrorSamples.length;
    const exporterNoiseCount = errors.data.samples.length - applicationErrorSamples.length;
    const summary = slow
      ? `${candidate.host ?? candidate.service} emitted a successful access log with ${String(slow.durationSeconds)} s duration; no explicit error keyword was required to observe the delay.`
      : errorCount > 0
        ? `${errorCount} error-keyword log records were found for ${candidate.service}.`
        : `No explicit errors or parseable slow access logs were found for ${candidate.service}.`;
    return {
      summary,
      evidence: [
        {
          caseId: context.task.caseId,
          modality: "log",
          entity: candidate.host ?? candidate.service,
          timeRange: context.task.alert.window,
          summary,
          rawRef: access.rawRef,
          supports:
            slow && context.hypothesisIds.candidate
              ? [context.hypothesisIds.candidate]
              : errorCount > 0
                ? [context.hypothesisIds.downstream]
                : [],
          contradicts: [],
          sourceQuery: access.query,
          toolCallId: accessCall.callId,
          facts: {
            keywordCounts: errors.data.keywordCounts,
            applicationErrorCount: errorCount,
            exporterNoiseCount,
            applicationErrorSamples: applicationErrorSamples.slice(0, 10),
            slowestAccessLog: slow,
          },
        },
      ],
      candidateEntities: [candidate.service, ...(candidate.host ? [candidate.host] : [])],
      candidateMechanism: slow
        ? "slow successful request processing rather than an explicit application error"
        : undefined,
      nextChecks: slow ? [] : ["Retain uncertainty because logs do not identify the mechanism."],
    };
  }
}

export class EventTopologyExpert implements ExpertAgent {
  readonly kind = "event-topology" as const;

  async investigate(context: ExpertContext): Promise<ExpertFinding> {
    const candidate = context.candidate;
    if (!candidate) throw new Error("Event/topology expert requires a candidate");
    const target = candidate.host ?? candidate.service;
    const topologyCall = await context.invoke("get_topology", {
      caseId: context.task.caseId,
      entity: target,
      depth: 2,
    });
    const topology = resultOf<
      QueryEnvelope<{
        entities: Array<{ id: string; type: string; name: string }>;
        edges: Array<Record<string, unknown>>;
      }>
    >(topologyCall);
    const eventCall = await context.invoke("query_events", {
      ...rangeArguments(context.task.caseId, context.task.alert.window),
      entity: target,
      limit: 50,
    });
    const events = resultOf<
      QueryEnvelope<{
        samples: Array<Record<string, unknown>>;
        noRelevantEvidence: boolean;
      }>
    >(eventCall);
    const node = topology.data.entities.find((item) => item.type === "k8s.node");
    const pod = topology.data.entities.find((item) => item.type === "k8s.pod");
    const noEvents = events.data.noRelevantEvidence;
    return {
      summary: noEvents
        ? `Topology maps ${target}${node ? ` to node ${node.name}` : ""}; no relevant Kubernetes event was recorded in the alert window.`
        : `Topology maps ${target}${node ? ` to node ${node.name}` : ""}; ${events.matchedRows} relevant event records require consideration.`,
      evidence: [
        {
          caseId: context.task.caseId,
          modality: "topology",
          entity: target,
          timeRange: context.task.alert.window,
          summary: `${target} resolves to ${pod?.name ?? candidate.service}${node ? ` on ${node.name}` : ""}; this anchors the trace entity to infrastructure for follow-up.`,
          rawRef: topology.rawRef,
          // Topology establishes reachability and identity, not causality.
          supports: [],
          contradicts: [],
          sourceQuery: topology.query,
          toolCallId: topologyCall.callId,
          facts: { pod, node, edgeCount: topology.data.edges.length },
        },
        {
          caseId: context.task.caseId,
          modality: "event",
          entity: target,
          timeRange: context.task.alert.window,
          summary: noEvents
            ? `No relevant Kubernetes event for ${target} was present in the alert window; events provide no positive support for an environment change.`
            : `${events.matchedRows} Kubernetes event records matched ${target} in the alert window.`,
          rawRef: events.rawRef,
          supports: noEvents ? [] : [context.hypothesisIds.infrastructure],
          // Absence of an event is neutral: policy and network changes are not
          // guaranteed to appear in a Kubernetes event stream.
          contradicts: [],
          sourceQuery: events.query,
          toolCallId: eventCall.callId,
          facts: { events: events.data.samples },
        },
      ],
      candidateEntities: [candidate.service, ...(candidate.host ? [candidate.host] : [])],
      nextChecks: noEvents
        ? []
        : ["Correlate matching Kubernetes events with the first latency increase."],
    };
  }
}

export function createExpertRegistry(): Map<ExpertKind, ExpertAgent> {
  const experts: ExpertAgent[] = [
    new TraceExpert(),
    new MetricsExpert(),
    new LogExpert(),
    new EventTopologyExpert(),
  ];
  return new Map(experts.map((expert) => [expert.kind, expert]));
}
