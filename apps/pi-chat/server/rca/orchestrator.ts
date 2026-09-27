import { randomUUID } from "node:crypto";

import { InvestigationEventBus, type InvestigationEventListener } from "./events";
import { createExpertRegistry, type ExpertAgent, type RecordedToolExecution } from "./experts";
import { DeterministicRcaPlanner, type RcaPlanner } from "./planner";
import { InvestigationRepository } from "./repository";
import { ObservabilityToolRegistry, type ObservabilityToolName, type ToolExecution } from "./tools";
import type {
  Evidence,
  ExpertFinding,
  ExpertKind,
  ExpertTask,
  Hypothesis,
  HypothesisStatus,
  Investigation,
  RCAResult,
  RcaTask,
  ToolCallRecord,
} from "./types";

export interface InvestigationRunOptions {
  caseId: string;
  investigationId?: string;
  signal?: AbortSignal;
  onEvent?: InvestigationEventListener;
  maxRounds?: number;
}

export interface InvestigationRunResult {
  investigation: Investigation;
  report: string;
}

interface Candidate {
  service: string;
  operation?: string;
  host?: string;
}

interface HypothesisIds {
  local: string;
  downstream: string;
  infrastructure: string;
  candidate?: string;
}

function now(): string {
  return new Date().toISOString();
}

export function createInvestigationId(): string {
  return `INV-${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Investigation cancelled", "AbortError");
}

function statusRank(status: HypothesisStatus): number {
  return {
    rejected: 0,
    possible: 1,
    investigating: 2,
    supported: 3,
    confirmed: 4,
  }[status];
}

export class RcaOrchestrator {
  private readonly tools: ObservabilityToolRegistry;
  private readonly repository: InvestigationRepository;
  private readonly experts: Map<ExpertKind, ExpertAgent>;
  private readonly planner: RcaPlanner;

  constructor(
    tools: ObservabilityToolRegistry,
    repository: InvestigationRepository,
    planner: RcaPlanner = new DeterministicRcaPlanner(),
  ) {
    this.tools = tools;
    this.repository = repository;
    this.experts = createExpertRegistry();
    this.planner = planner;
  }

  async investigate(options: InvestigationRunOptions): Promise<InvestigationRunResult> {
    const id = options.investigationId ?? createInvestigationId();
    const bus = new InvestigationEventBus(id, this.repository);
    if (options.onEvent) bus.subscribe(options.onEvent);
    let investigation: Investigation | undefined;
    try {
      checkCancelled(options.signal);
      const alertStartedAt = now();
      const initialToolCall: ToolCallRecord = {
        id: "C01",
        tool: "get_alert_context",
        query: { caseId: options.caseId },
        status: "running",
        startedAt: alertStartedAt,
      };
      await bus.publish("tool.started", "Loading alert context.", {
        toolCall: initialToolCall,
      });
      let alertExecution: ToolExecution;
      try {
        alertExecution = await this.tools.execute("get_alert_context", initialToolCall.query);
        initialToolCall.status = "completed";
        initialToolCall.resultSummary = alertExecution.summary;
        initialToolCall.rawRef = alertExecution.rawRef;
        initialToolCall.completedAt = now();
      } catch (error) {
        initialToolCall.status = options.signal?.aborted ? "cancelled" : "failed";
        initialToolCall.error = error instanceof Error ? error.message : String(error);
        initialToolCall.completedAt = now();
        await this.repository.appendToolCall(id, initialToolCall);
        await bus.publish("tool.completed", "Loading alert context failed.", {
          toolCall: initialToolCall,
        });
        throw error;
      }
      await bus.publish("tool.completed", "Alert context loaded.", {
        toolCall: initialToolCall,
      });
      const task: RcaTask = {
        caseId: options.caseId,
        version: "runtime",
        alert: alertExecution.result as RcaTask["alert"],
        availableModalities: ["metric", "log", "trace", "event", "alert", "topology"],
      };
      investigation = this.createInvestigation(id, task, initialToolCall);
      await this.repository.appendToolCall(id, initialToolCall);
      await this.repository.save(investigation);
      await bus.publish("investigation.started", `Investigation started for ${task.alert.title}.`, {
        caseId: task.caseId,
        alert: task.alert,
      });
      for (const hypothesis of investigation.hypotheses) {
        await bus.publish("hypothesis.created", `${hypothesis.id}: ${hypothesis.statement}`, {
          hypothesis,
        });
      }

      const ids: HypothesisIds = {
        local: "H01",
        downstream: "H02",
        infrastructure: "H03",
      };
      let candidate: Candidate | undefined;
      const maxRounds = Math.max(1, Math.min(options.maxRounds ?? 8, 12));
      while (investigation.rounds < maxRounds) {
        checkCancelled(options.signal);
        const decision = await this.planner.decide({
          investigation,
          task,
          candidate,
          maxRounds,
        });
        if (decision.action === "finish") {
          await bus.publish("round.completed", `Planner stopped: ${decision.reason}`, {
            round: investigation.rounds,
            plannerSource: decision.source,
            decisionReason: decision.reason,
            hypotheses: investigation.hypotheses,
            evidenceIds: investigation.evidence.map((item) => item.id),
          });
          break;
        }
        const next = decision.action;
        investigation.rounds++;
        const taskRecord = this.createExpertTask(investigation, next, ids);
        await this.markRelevantInvestigating(investigation, next, ids, bus);
        await this.repository.save(investigation);
        await bus.publish(
          "expert.started",
          `${this.expertLabel(next)} investigating: ${decision.reason}`,
          {
            expertTask: taskRecord,
            round: investigation.rounds,
            plannerSource: decision.source,
            decisionReason: decision.reason,
          },
        );
        const expert = this.experts.get(next);
        if (!expert) throw new Error(`Expert ${next} is not registered`);
        const finding = await expert.investigate({
          investigation,
          task,
          hypothesisIds: ids,
          candidate,
          invoke: (tool, arguments_) =>
            this.invokeTool(investigation!, taskRecord, bus, tool, arguments_, options.signal),
        });
        const evidence = await this.acceptFinding(investigation, taskRecord, finding, bus);
        candidate = this.updateCandidate(candidate, finding, next);
        if (candidate && !ids.candidate) {
          const hypothesis = this.createCandidateHypothesis(investigation, candidate);
          ids.candidate = hypothesis.id;
          await bus.publish("hypothesis.created", `${hypothesis.id}: ${hypothesis.statement}`, {
            hypothesis,
          });
        }
        const previousStatuses = new Map(
          investigation.hypotheses.map((hypothesis) => [hypothesis.id, hypothesis.status]),
        );
        this.applyEvidence(investigation, evidence);
        this.promoteCandidateHypothesis(investigation, ids);
        for (const hypothesis of investigation.hypotheses) {
          const previous = previousStatuses.get(hypothesis.id);
          if (!previous || previous === hypothesis.status) continue;
          await bus.publish(
            "hypothesis.updated",
            `${hypothesis.id}: ${previous} → ${hypothesis.status}`,
            {
              hypothesisId: hypothesis.id,
              previous,
              current: hypothesis.status,
              supportingEvidenceIds: hypothesis.supportingEvidenceIds,
              contradictingEvidenceIds: hypothesis.contradictingEvidenceIds,
            },
          );
        }
        taskRecord.status = "completed";
        taskRecord.completedAt = now();
        await this.repository.save(investigation);
        await bus.publish(
          "expert.completed",
          `${this.expertLabel(next)} completed: ${finding.summary}`,
          {
            expertTask: taskRecord,
            candidate,
          },
        );
        await bus.publish("round.completed", `Round ${investigation.rounds} completed.`, {
          round: investigation.rounds,
          hypotheses: investigation.hypotheses,
          evidenceIds: evidence.map((item) => item.id),
        });
      }
      checkCancelled(options.signal);
      for (const hypothesis of investigation.hypotheses) {
        if (hypothesis.status !== "investigating") continue;
        hypothesis.status = "possible";
        await bus.publish(
          "hypothesis.updated",
          `${hypothesis.id}: investigating → possible (insufficient evidence)`,
          {
            hypothesisId: hypothesis.id,
            previous: "investigating",
            current: "possible",
            reason: "The completed checks neither supported nor rejected this hypothesis.",
          },
        );
      }
      investigation.rootCause = this.conclude(investigation, ids, candidate);
      investigation.status =
        investigation.rootCause.status === "inconclusive" ? "inconclusive" : "completed";
      investigation.completedAt = now();
      const report = this.report(investigation);
      await this.repository.save(investigation);
      await this.repository.saveReport(investigation.id, investigation.rootCause, report);
      await bus.publish(
        "investigation.completed",
        `RCA ${investigation.rootCause.status}: ${investigation.rootCause.summary}`,
        { result: investigation.rootCause },
      );
      return { investigation, report };
    } catch (error) {
      if (!investigation) throw error;
      const cancelled = error instanceof DOMException && error.name === "AbortError";
      investigation.status = cancelled ? "cancelled" : "failed";
      investigation.completedAt = now();
      investigation.error = error instanceof Error ? error.message : String(error);
      await this.repository.save(investigation);
      await bus.publish(
        cancelled ? "investigation.cancelled" : "investigation.failed",
        investigation.error,
        {},
      );
      throw error;
    }
  }

  private createInvestigation(
    id: string,
    task: RcaTask,
    initialToolCall: ToolCallRecord,
  ): Investigation {
    const service = task.alert.service ?? task.alert.entity.name;
    const operation = task.alert.operation ?? task.alert.entity.name;
    return {
      id,
      caseId: task.caseId,
      status: "running",
      symptom: `${task.alert.title}: ${task.alert.entity.name}`,
      alertContext: task.alert,
      scope: {
        alertService: task.alert.service,
        alertOperation: task.alert.operation,
        timeRange: task.alert.window,
        candidateEntities: [task.alert.entity.name],
      },
      hypotheses: [
        {
          id: "H01",
          statement: `${service}/${operation} is slow because the alerted service itself is unhealthy.`,
          status: "possible",
          confidence: 0.25,
          supportingEvidenceIds: [],
          contradictingEvidenceIds: [],
          nextChecks: ["Compare service-local latency and resource metrics."],
          entity: service,
        },
        {
          id: "H02",
          statement: `A downstream dependency is delaying ${service}/${operation} and propagating latency upstream.`,
          status: "possible",
          confidence: 0.35,
          supportingEvidenceIds: [],
          contradictingEvidenceIds: [],
          nextChecks: ["Find the critical trace path and first downstream latency concentration."],
        },
        {
          id: "H03",
          statement: "Infrastructure, network, or an environment event is causing request waits.",
          status: "possible",
          confidence: 0.25,
          supportingEvidenceIds: [],
          contradictingEvidenceIds: [],
          nextChecks: ["Inspect resource metrics, topology, and Kubernetes events."],
        },
      ],
      evidence: [],
      expertTasks: [],
      toolCalls: [initialToolCall],
      rounds: 0,
      startedAt: now(),
    };
  }

  private createExpertTask(
    investigation: Investigation,
    kind: ExpertKind,
    ids: HypothesisIds,
  ): ExpertTask {
    const task: ExpertTask = {
      id: `T${String(investigation.expertTasks.length + 1).padStart(2, "0")}`,
      expert: kind,
      objective: this.objective(kind),
      status: "running",
      hypothesisIds: Object.values(ids),
      toolCallIds: [],
      evidenceIds: [],
      createdAt: now(),
    };
    investigation.expertTasks.push(task);
    return task;
  }

  private async invokeTool(
    investigation: Investigation,
    expertTask: ExpertTask,
    bus: InvestigationEventBus,
    tool: ObservabilityToolName,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<RecordedToolExecution> {
    checkCancelled(signal);
    const call: ToolCallRecord = {
      id: `C${String(investigation.toolCalls.length + 1).padStart(2, "0")}`,
      expertTaskId: expertTask.id,
      tool,
      query: arguments_,
      status: "running",
      startedAt: now(),
    };
    investigation.toolCalls.push(call);
    expertTask.toolCallIds.push(call.id);
    await this.repository.save(investigation);
    await bus.publish("tool.started", `${expertTask.expert} called ${tool}.`, {
      toolCall: call,
    });
    try {
      const execution = await this.tools.execute(tool, arguments_);
      checkCancelled(signal);
      call.status = "completed";
      call.resultSummary = execution.summary;
      call.rawRef = execution.rawRef;
      call.completedAt = now();
      await this.repository.appendToolCall(investigation.id, call);
      await bus.publish("tool.completed", `${tool} completed: ${execution.summary}.`, {
        toolCall: call,
      });
      return { callId: call.id, execution };
    } catch (error) {
      call.status = signal?.aborted ? "cancelled" : "failed";
      call.error = error instanceof Error ? error.message : String(error);
      call.completedAt = now();
      await this.repository.appendToolCall(investigation.id, call);
      throw error;
    }
  }

  private async acceptFinding(
    investigation: Investigation,
    expertTask: ExpertTask,
    finding: ExpertFinding,
    bus: InvestigationEventBus,
  ): Promise<Evidence[]> {
    const accepted: Evidence[] = [];
    for (const item of finding.evidence) {
      const evidence: Evidence = {
        ...item,
        id: `E${String(investigation.evidence.length + 1).padStart(2, "0")}`,
        toolCallId: item.toolCallId ?? expertTask.toolCallIds.at(-1) ?? "",
        createdAt: now(),
      };
      investigation.evidence.push(evidence);
      expertTask.evidenceIds.push(evidence.id);
      accepted.push(evidence);
      await bus.publish("evidence.created", `${evidence.id}: ${evidence.summary}`, {
        evidence,
      });
    }
    for (const entity of finding.candidateEntities) {
      if (!investigation.scope.candidateEntities.includes(entity)) {
        investigation.scope.candidateEntities.push(entity);
      }
    }
    return accepted;
  }

  private applyEvidence(investigation: Investigation, evidence: Evidence[]): void {
    for (const item of evidence) {
      for (const id of item.supports) {
        const hypothesis = investigation.hypotheses.find((entry) => entry.id === id);
        if (!hypothesis) continue;
        if (!hypothesis.supportingEvidenceIds.includes(item.id)) {
          hypothesis.supportingEvidenceIds.push(item.id);
        }
        hypothesis.confidence = Math.min(0.95, hypothesis.confidence + 0.2);
        if (statusRank(hypothesis.status) < statusRank("supported"))
          hypothesis.status = "supported";
      }
      for (const id of item.contradicts) {
        const hypothesis = investigation.hypotheses.find((entry) => entry.id === id);
        if (!hypothesis) continue;
        if (!hypothesis.contradictingEvidenceIds.includes(item.id)) {
          hypothesis.contradictingEvidenceIds.push(item.id);
        }
        hypothesis.confidence = Math.max(0.05, hypothesis.confidence - 0.25);
        if (hypothesis.supportingEvidenceIds.length === 0) hypothesis.status = "rejected";
      }
    }
  }

  private updateCandidate(
    candidate: Candidate | undefined,
    finding: ExpertFinding,
    expert: ExpertKind,
  ): Candidate | undefined {
    if (candidate || expert !== "trace") return candidate;
    const host = finding.candidateEntities.find((item) =>
      /-[a-f0-9]{5,10}-[a-z0-9]{5}$/.test(item),
    );
    const operationEntity = finding.candidateEntities.find((item) => item.includes("::"));
    const service = operationEntity?.split("::")[0] ?? finding.candidateEntities[0];
    if (!service) return undefined;
    return {
      service,
      ...(operationEntity ? { operation: operationEntity.split("::").slice(1).join("::") } : {}),
      ...(host ? { host } : {}),
    };
  }

  private createCandidateHypothesis(
    investigation: Investigation,
    candidate: Candidate,
  ): Hypothesis {
    const hypothesis: Hypothesis = {
      id: `H${String(investigation.hypotheses.length + 1).padStart(2, "0")}`,
      statement: `${candidate.service}${candidate.operation ? `/${candidate.operation}` : ""}${candidate.host ? ` on ${candidate.host}` : ""} is the downstream latency source.`,
      status: "possible",
      confidence: 0.45,
      supportingEvidenceIds: investigation.evidence
        .filter((item) => item.modality === "trace" && item.supports.includes("H02"))
        .map((item) => item.id),
      contradictingEvidenceIds: [],
      nextChecks: ["Verify peer metrics, logs, and environmental counter-evidence."],
      entity: candidate.host ?? candidate.service,
      mechanism: "downstream latency propagation",
    };
    if (hypothesis.supportingEvidenceIds.length > 0) {
      hypothesis.status = "investigating";
      hypothesis.confidence = 0.6;
    }
    investigation.hypotheses.push(hypothesis);
    return hypothesis;
  }

  private promoteCandidateHypothesis(investigation: Investigation, ids: HypothesisIds): void {
    if (!ids.candidate) return;
    const hypothesis = investigation.hypotheses.find((item) => item.id === ids.candidate);
    if (!hypothesis || hypothesis.status === "rejected") return;
    const modalities = new Set(
      investigation.evidence
        .filter((item) => item.supports.includes(ids.candidate!))
        .map((item) => item.modality),
    );
    if (modalities.size >= 3) {
      hypothesis.status = "confirmed";
      hypothesis.confidence = Math.max(hypothesis.confidence, 0.88);
    } else if (modalities.size >= 1) {
      hypothesis.status = "supported";
      hypothesis.confidence = Math.max(hypothesis.confidence, modalities.size === 2 ? 0.8 : 0.72);
    }
  }

  private async markRelevantInvestigating(
    investigation: Investigation,
    expert: ExpertKind,
    ids: HypothesisIds,
    bus: InvestigationEventBus,
  ): Promise<void> {
    const relevant =
      expert === "trace"
        ? [ids.downstream]
        : expert === "metrics"
          ? [ids.local, ids.infrastructure, ...(ids.candidate ? [ids.candidate] : [])]
          : expert === "event-topology"
            ? [ids.infrastructure, ...(ids.candidate ? [ids.candidate] : [])]
            : ids.candidate
              ? [ids.candidate]
              : [ids.local];
    for (const id of relevant) {
      const hypothesis = investigation.hypotheses.find((item) => item.id === id);
      if (!hypothesis || hypothesis.status !== "possible") continue;
      const previous = hypothesis.status;
      hypothesis.status = "investigating";
      await bus.publish("hypothesis.updated", `${hypothesis.id}: ${previous} → investigating`, {
        hypothesisId: id,
        previous,
        current: hypothesis.status,
      });
    }
  }

  private conclude(
    investigation: Investigation,
    ids: HypothesisIds,
    candidate?: Candidate,
  ): RCAResult {
    const candidateHypothesis = ids.candidate
      ? investigation.hypotheses.find((item) => item.id === ids.candidate)
      : undefined;
    const supporting = candidateHypothesis
      ? investigation.evidence.filter(
          (item) =>
            item.supports.includes(candidateHypothesis.id) ||
            (item.modality === "trace" && item.supports.includes(ids.downstream)),
        )
      : [];
    const modalities = new Set(supporting.map((item) => item.modality));
    const localHypothesis = investigation.hypotheses.find((item) => item.id === ids.local);
    const localSupporting = investigation.evidence.filter((item) => item.supports.includes(ids.local));
    const localModalities = new Set(localSupporting.map((item) => item.modality));
    if (!candidate && localHypothesis && localModalities.size >= 2) {
      localHypothesis.status = localModalities.size >= 3 ? "confirmed" : "supported";
      localHypothesis.confidence = localModalities.size >= 3 ? 0.9 : 0.8;
      const logEvidence = localSupporting.find((item) => item.modality === "log");
      const applicationErrorCount = Number(logEvidence?.facts.applicationErrorCount ?? 0);
      const slowAccessLog = logEvidence?.facts.slowestAccessLog;
      const mechanism = slowAccessLog
        ? "Slow successful processing in the alerted service is supported by local metrics and logs."
        : applicationErrorCount > 0
          ? "Application errors in the alerted service coincide with its local latency anomaly."
          : "Multiple local telemetry modalities support degradation inside the alerted service, but the low-level mechanism remains uncertain.";
      return {
        investigationId: investigation.id,
        status: localModalities.size >= 3 ? "confirmed" : "probable",
        rootCauseEntities: [
          investigation.alertContext.service ?? investigation.alertContext.entity.name,
        ],
        mechanism,
        summary: `${investigation.alertContext.service ?? investigation.alertContext.entity.name} has independent local evidence across ${localModalities.size} modalities; no downstream candidate was required for this conclusion.`,
        evidenceIds: localSupporting.map((item) => item.id),
        rejectedHypotheses: investigation.hypotheses
          .filter((item) => item.status === "rejected")
          .map((item) => item.id),
        confidence: localHypothesis.confidence,
        missingEvidence: [
          "A direct low-level runtime or packet measurement would be needed to prove the exact mechanism.",
        ],
      };
    }
    if (!candidate || !candidateHypothesis || modalities.size < 2) {
      return {
        investigationId: investigation.id,
        status: "inconclusive",
        rootCauseEntities: candidate
          ? [candidate.service, ...(candidate.host ? [candidate.host] : [])]
          : [],
        summary:
          "Evidence localized part of the failure path but did not independently support a root cause with at least two modalities.",
        evidenceIds: supporting.map((item) => item.id),
        rejectedHypotheses: investigation.hypotheses
          .filter((item) => item.status === "rejected")
          .map((item) => item.id),
        confidence: candidateHypothesis?.confidence ?? 0.35,
        missingEvidence: [
          "A second independent modality supporting the same entity",
          "A direct measurement identifying the exact injected fault mechanism",
        ],
      };
    }
    candidateHypothesis.status = modalities.size >= 3 ? "confirmed" : "supported";
    candidateHypothesis.confidence = modalities.size >= 3 ? 0.9 : 0.8;
    const entities = [
      candidate.service,
      ...(candidate.operation ? [`${candidate.service}::${candidate.operation}`] : []),
      ...(candidate.host ? [candidate.host] : []),
    ];
    const metricEvidence = supporting.find((item) => item.modality === "metric");
    const traceEvidence = supporting.find((item) => item.modality === "trace");
    const candidateHosts = Array.isArray(traceEvidence?.facts.dependencyAnomalies)
      ? new Set(
          (traceEvidence.facts.dependencyAnomalies as Array<{ host?: string }>)
            .map((item) => item.host)
            .filter(Boolean),
        )
      : new Set<string>();
    const throughputChanges = Array.isArray(metricEvidence?.facts.throughputChanges)
      ? (metricEvidence.facts.throughputChanges as Array<Record<string, unknown>>)
      : [];
    const resourceEvidence = investigation.evidence.find(
      (item) => item.modality === "metric" && "resourceIncreases" in item.facts,
    );
    const resourceIncreases = Array.isArray(resourceEvidence?.facts.resourceIncreases)
      ? resourceEvidence.facts.resourceIncreases
      : [];
    const logEvidence = investigation.evidence.find(
      (item) => item.modality === "log" && item.entity?.includes(candidate.service),
    );
    const applicationErrorCount = Number(logEvidence?.facts.applicationErrorCount ?? 0);
    const slowAccessLog = logEvidence?.facts.slowestAccessLog;
    const distributedOnset = candidateHosts.size > 1;
    const networkPattern =
      distributedOnset &&
      throughputChanges.length > 0 &&
      resourceIncreases.length === 0 &&
      applicationErrorCount === 0 &&
      !slowAccessLog;
    const mechanism = networkPattern
      ? `Probable network path or policy isolation affecting ${investigation.alertContext.service ?? "the alerted service"} → ${candidate.service}; the exact policy object is not observable in the available event data.`
      : slowAccessLog
        ? "Slow successful processing in the downstream service propagated through the alert operation."
        : applicationErrorCount > 0
          ? "Downstream application errors coincided with the propagated latency."
          : "Downstream service latency propagated through the alert operation; available telemetry does not uniquely identify the low-level mechanism.";
    return {
      investigationId: investigation.id,
      status: modalities.size >= 3 ? "confirmed" : "probable",
      rootCauseEntities: entities,
      mechanism,
      summary:
        `${candidate.service}${candidate.host ? ` instance ${candidate.host}` : ""} is the evidence-supported source of the latency propagated to ${investigation.alertContext.entity.name}. ${metricEvidence?.summary ?? ""}`.trim(),
      evidenceIds: supporting.map((item) => item.id),
      rejectedHypotheses: investigation.hypotheses
        .filter((item) => item.status === "rejected")
        .map((item) => item.id),
      confidence: candidateHypothesis.confidence,
      missingEvidence: [
        networkPattern
          ? "NetworkPolicy audit/change records and packet-flow telemetry were not present, so policy isolation remains a probable mechanism rather than directly observed fact."
          : "Pod-level CPU throttling and network packet telemetry were not present, so the low-level mechanism cannot be directly proven.",
      ],
    };
  }

  private report(investigation: Investigation): string {
    const result = investigation.rootCause;
    if (!result) throw new Error("Cannot report an investigation without a result");
    const evidence = investigation.evidence
      .filter((item) => result.evidenceIds.includes(item.id))
      .map((item) => `- ${item.id} [${item.modality}] ${item.summary} (${item.rawRef})`)
      .join("\n");
    const rejected = investigation.hypotheses
      .filter((item) => result.rejectedHypotheses.includes(item.id))
      .map((item) => `- ${item.id}: ${item.statement}`)
      .join("\n");
    return `# RCA Report: ${investigation.id}\n\n## Symptom\n\n${investigation.symptom}\n\n## Root Cause\n\nStatus: ${result.status}\n\nEntities: ${result.rootCauseEntities.join(", ") || "Not localized"}\n\n${result.summary}\n\nMechanism: ${result.mechanism ?? "Not established"}\n\nConfidence: ${result.confidence.toFixed(2)}\n\n## Supporting Evidence\n\n${evidence || "No sufficient evidence."}\n\n## Rejected Hypotheses\n\n${rejected || "None."}\n\n## Missing Evidence\n\n${(result.missingEvidence ?? []).map((item) => `- ${item}`).join("\n") || "None."}\n`;
  }

  private objective(kind: ExpertKind): string {
    return {
      trace: "Locate the critical path and first downstream latency propagation point.",
      metrics: "Compare candidate latency, peer instances, and available resource metrics.",
      log: "Find explicit failures or slow successful requests without manufacturing log evidence.",
      "event-topology": "Map the candidate to infrastructure and check nearby events.",
    }[kind];
  }

  private expertLabel(kind: ExpertKind): string {
    return {
      trace: "Trace Expert",
      metrics: "Metrics Expert",
      log: "Log Expert",
      "event-topology": "Event / Topology Expert",
    }[kind];
  }
}
