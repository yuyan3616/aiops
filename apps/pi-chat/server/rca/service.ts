import { randomUUID } from "node:crypto";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  InvestigationEventBus,
  type InvestigationEventListener,
} from "./events";
import { getParquetRuntimeDiagnostics } from "./parquet";
import {
  PiExpertRunError,
  PiExpertRunner,
  type RecordedAgentToolExecution,
} from "./pi-expert";
import { InvestigationRepository } from "./repository";
import {
  compactToolResultForAgent,
  ObservabilityToolRegistry,
  type ObservabilityToolName,
  type ToolExecution,
} from "./tools";
import type {
  AgentExpertFinding,
  AgentRunDiagnostics,
  CausalAssessment,
  Evidence,
  EvidenceModality,
  ExpertTask,
  Hypothesis,
  HypothesisStatus,
  Investigation,
  InvestigationBrief,
  Observation,
  RCAResult,
  RcaTask,
  RuntimeResourceSnapshot,
  ToolCallRecord,
} from "./types";

interface RunningAgenticInvestigation {
  conversationId?: string;
  controller: AbortController;
  unsubscribe?: () => void;
  investigation?: Investigation;
  activeOperations: number;
  cancellationPromise?: Promise<void>;
}

export type RcaOverviewKind = "alerts" | "dependencies" | "metrics" | "traces" | "topology";

interface HypothesisMutationBase {
  requestId?: string;
  status?: HypothesisStatus;
  confidence?: number;
  supportingEvidenceIds?: string[];
  contradictingEvidenceIds?: string[];
  nextChecks?: string[];
  entity?: string;
  mechanism?: string;
}

export interface CreateHypothesisMutation extends HypothesisMutationBase {
  op: "create";
  id?: string;
  statement: string;
  supersedes?: string;
}

export interface UpdateHypothesisMutation extends HypothesisMutationBase {
  op: "update";
  id: string;
}

export type HypothesisMutation = CreateHypothesisMutation | UpdateHypothesisMutation;

export type HypothesisMutationRejectionCode =
  | "MISSING_STATEMENT"
  | "INVALID_ID"
  | "DUPLICATE_ID"
  | "HYPOTHESIS_NOT_FOUND"
  | "UNKNOWN_EVIDENCE"
  | "INVALID_SUPERSEDES";

export interface HypothesisMutationAccepted {
  requestId?: string;
  op: HypothesisMutation["op"];
  hypothesisId: string;
}

export interface HypothesisMutationRejected {
  requestId?: string;
  op: HypothesisMutation["op"];
  hypothesisId?: string;
  code: HypothesisMutationRejectionCode;
  message: string;
}

export interface HypothesisMutationBatchResult {
  accepted: HypothesisMutationAccepted[];
  rejected: HypothesisMutationRejected[];
  hypotheses: Hypothesis[];
}

export interface AgenticBeginOptions {
  investigationId?: string;
  conversationId?: string;
  onEvent?: InvestigationEventListener;
}

export interface AgenticResumeOptions {
  conversationId?: string;
  onEvent?: InvestigationEventListener;
}

export interface AgenticDispatchOptions {
  model?: { provider: string; id: string };
}

export interface AgenticConclusionInput
  extends Omit<RCAResult, "investigationId" | "causalAssessment"> {
  selectedHypothesisIds: string[];
  unresolvedHypotheses: Array<{
    id: string;
    reason: string;
    missingEvidence?: string[];
  }>;
  causalAssessment: CausalAssessment;
}

export interface DispatchedFinding {
  taskRef: string;
  role: InvestigationBrief["role"];
  status: ExpertTask["status"];
  finding: AgentExpertFinding;
  evidenceIds: string[];
  observationIds: string[];
  diagnostics?: AgentRunDiagnostics;
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function clampConfidence(value: number | undefined, fallback = 0.3): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function bytesToMb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

function runtimeResourceSnapshot(): RuntimeResourceSnapshot {
  const memory = process.memoryUsage();
  const parquet = getParquetRuntimeDiagnostics();
  return {
    at: now(),
    rssMb: bytesToMb(memory.rss),
    heapUsedMb: bytesToMb(memory.heapUsed),
    heapTotalMb: bytesToMb(memory.heapTotal),
    externalMb: bytesToMb(memory.external),
    arrayBuffersMb: bytesToMb(memory.arrayBuffers),
    activeParquetScans: parquet.activeScans,
    maxConcurrentParquetScans: parquet.maxConcurrentScans,
    totalParquetScans: parquet.totalScans,
    parquetBatchesRead: parquet.batchesRead,
    parquetRowsScanned: parquet.rowsScanned,
  };
}

function toolModality(tool: ObservabilityToolName): EvidenceModality {
  if (tool === "query_metrics" || tool === "get_metric_catalog") return "metric";
  if (tool === "query_logs" || tool === "get_log_fields") return "log";
  if (tool === "query_traces" || tool === "get_trace_fields") return "trace";
  if (tool === "query_events") return "event";
  if (tool === "query_alerts" || tool === "get_alert_context") return "alert";
  return "topology";
}

function observationSummary(tool: ObservabilityToolName, execution: ToolExecution): string {
  if (tool !== "query_metrics") return execution.summary;
  const compact = compactToolResultForAgent(tool, execution.result);
  if (!compact || typeof compact !== "object" || Array.isArray(compact)) return execution.summary;
  const data = (compact as { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return execution.summary;
  const anomalies = (data as { anomalies?: unknown }).anomalies;
  if (!Array.isArray(anomalies) || anomalies.length === 0) {
    return `${execution.summary}; no metric anomaly summary was returned`;
  }
  const top = anomalies
    .slice(0, 3)
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
      const row = item as Record<string, unknown>;
      const entity = String(row.entity ?? row.service ?? "entity");
      const metric = String(row.metric ?? "metric");
      const baseline = Number(row.baselineMedian);
      const incident = Number(row.incidentMedian);
      const ratio = Number(row.ratio);
      const direction = String(row.direction ?? "unknown");
      const values = Number.isFinite(baseline) && Number.isFinite(incident)
        ? `${baseline.toPrecision(4)}→${incident.toPrecision(4)}`
        : "n/a";
      const ratioText = Number.isFinite(ratio) ? ` x${ratio.toFixed(2)}` : "";
      return `${entity} ${metric} ${values}${ratioText} (${direction})`;
    })
    .filter((item): item is string => Boolean(item));
  return top.length ? `metric observation: ${top.join("; ")}` : execution.summary;
}

function observationFacts(
  tool: ObservabilityToolName,
  execution: ToolExecution,
): Record<string, unknown> {
  return {
    tool,
    result: compactToolResultForAgent(tool, execution.result),
  };
}

export class RcaService {
  private readonly repository: InvestigationRepository;
  private readonly tools?: ObservabilityToolRegistry;
  private readonly expertRunner?: PiExpertRunner;
  private readonly agenticRunning = new Map<string, RunningAgenticInvestigation>();
  private readonly eventBuses = new Map<string, InvestigationEventBus>();
  private readonly saveQueues = new Map<string, Promise<void>>();

  constructor(
    repository: InvestigationRepository,
    modelRuntime?: ModelRuntime,
    tools?: ObservabilityToolRegistry,
  ) {
    this.repository = repository;
    this.tools = tools;
    this.expertRunner = modelRuntime && tools ? new PiExpertRunner(modelRuntime, tools) : undefined;
  }

  async beginAgentic(
    caseId: string,
    options: AgenticBeginOptions = {},
  ): Promise<Investigation> {
    const tools = this.requireAgenticTools();
    const id = options.investigationId ?? createInvestigationId();
    const bus = await this.busFor(id);
    const controller = new AbortController();
    const unsubscribe = options.onEvent ? bus.subscribe(options.onEvent) : undefined;
    this.agenticRunning.set(id, {
      conversationId: options.conversationId,
      controller,
      unsubscribe,
      activeOperations: 0,
    });
    const releaseOperation = this.trackAgenticOperation(id);

    const call: ToolCallRecord = {
      id: "C01",
      tool: "get_alert_context",
      query: { caseId },
      status: "running",
      startedAt: now(),
    };
    await bus.publish("tool.started", "Loading alert context.", { toolCall: call });

    try {
      const execution = await tools.execute("get_alert_context", { caseId }, controller.signal);
      call.status = "completed";
      call.resultSummary = execution.summary;
      call.rawRef = execution.rawRef;
      call.completedAt = now();

      const alert = execution.result as RcaTask["alert"];
      const investigation: Investigation = {
        id,
        caseId,
        status: "running",
        symptom: `${alert.title}: ${alert.entity.name}`,
        alertContext: alert,
        scope: {
          alertService: alert.service,
          alertOperation: alert.operation,
          timeRange: alert.window,
          candidateEntities: [alert.entity.name],
        },
        hypotheses: [],
        observations: [],
        evidence: [],
        expertTasks: [],
        toolCalls: [call],
        rounds: 0,
        startedAt: now(),
      };
      const active = this.agenticRunning.get(id);
      if (active) active.investigation = investigation;
      const alertObservation: Observation = {
        id: this.nextObservationId(investigation),
        caseId,
        modality: "alert",
        toolCallId: call.id,
        summary: `alert context: ${alert.title} on ${alert.entity.name}`,
        ...(execution.rawRef ? { rawRef: execution.rawRef } : {}),
        facts: { alert },
        createdAt: now(),
      };
      investigation.observations?.push(alertObservation);
      await this.repository.appendToolCall(id, call);
      await this.saveInvestigation(investigation);
      await bus.publish("observation.created", alertObservation.summary, {
        observation: alertObservation,
      });
      await bus.publish("tool.completed", "Alert context loaded.", { toolCall: call });
      await bus.publish("investigation.started", `Investigation started for ${alert.title}.`, {
        caseId,
        alert,
        mode: "agentic",
      });
      return investigation;
    } catch (error) {
      call.status = isAbortError(error) || controller.signal.aborted ? "cancelled" : "failed";
      call.error = error instanceof Error ? error.message : String(error);
      call.completedAt = now();
      await this.repository.appendToolCall(id, call);
      await bus.publish("tool.completed", "Loading alert context failed.", { toolCall: call });
      if (!controller.signal.aborted) this.cleanupAgentic(id);
      throw error;
    } finally {
      releaseOperation();
    }
  }

  async resumeAgentic(
    investigationId: string,
    options: AgenticResumeOptions = {},
  ): Promise<Investigation> {
    const investigation = await this.repository.get(investigationId);
    if (investigation.status !== "interrupted" && investigation.status !== "running") {
      throw new Error(
        `Investigation ${investigation.id} is ${investigation.status} and cannot be resumed`,
      );
    }

    const bus = await this.busFor(investigationId);
    this.agenticRunning.get(investigationId)?.unsubscribe?.();
    const controller = new AbortController();
    const unsubscribe = options.onEvent ? bus.subscribe(options.onEvent) : undefined;
    this.agenticRunning.set(investigationId, {
      conversationId: options.conversationId,
      controller,
      unsubscribe,
      investigation,
      activeOperations: 0,
    });

    if (investigation.status === "interrupted") {
      investigation.status = "running";
      investigation.error = undefined;
      await this.saveInvestigation(investigation);
      await bus.publish("investigation.resumed", "Investigation resumed after interruption.", {
        interruptionCount: investigation.interruptions?.length ?? 0,
        source: "main-agent",
      });
    }
    return investigation;
  }

  async queryOverview(
    investigationId: string,
    kind: RcaOverviewKind,
    query: Record<string, unknown> = {},
  ): Promise<{
    evidenceId: string;
    toolCallId: string;
    summary: string;
    rawRef?: string;
    result: unknown;
  }> {
    const investigation = await this.liveInvestigation(investigationId);
    this.assertRunning(investigation);
    const bus = await this.busFor(investigationId);
    const signal = this.agenticRunning.get(investigationId)?.controller.signal;
    const releaseOperation = this.trackAgenticOperation(investigationId);

    try {
      const { tool, arguments_ } = this.overviewTool(investigation, kind, query);
      const recorded = await this.invokeRecordedTool(
        investigation,
        bus,
        tool,
        arguments_,
        undefined,
        signal,
      );
      checkCancelled(signal);
      const evidence: Evidence = {
        id: this.nextEvidenceId(investigation),
        caseId: investigation.caseId,
        modality: toolModality(tool),
        ...(typeof query.entity === "string" ? { entity: query.entity } : {}),
        timeRange: investigation.alertContext.window,
        summary: recorded.execution.summary,
        rawRef:
          recorded.execution.rawRef ??
          `investigation://${investigation.id}/tool/${recorded.callId}`,
        supports: [],
        contradicts: [],
        sourceQuery: arguments_,
        toolCallId: recorded.callId,
        facts: { source: "main-agent-overview" },
        createdAt: now(),
      };
      investigation.evidence.push(evidence);
      await this.saveInvestigation(investigation);
      checkCancelled(signal);
      await bus.publish("evidence.created", evidence.summary, { evidence });

      return {
        evidenceId: evidence.id,
        toolCallId: recorded.callId,
        summary: evidence.summary,
        ...(recorded.execution.rawRef ? { rawRef: recorded.execution.rawRef } : {}),
        result: compactToolResultForAgent(tool, recorded.execution.result),
      };
    } finally {
      releaseOperation();
    }
  }

  async updateHypotheses(
    investigationId: string,
    mutations: HypothesisMutation[],
  ): Promise<HypothesisMutationBatchResult> {
    const investigation = await this.liveInvestigation(investigationId);
    this.assertConcludable(investigation);
    const bus = await this.busFor(investigationId);
    const evidenceIds = new Set(investigation.evidence.map((item) => item.id));
    const working = investigation.hypotheses.map((item) => ({
      ...item,
      supportingEvidenceIds: [...item.supportingEvidenceIds],
      contradictingEvidenceIds: [...item.contradictingEvidenceIds],
      nextChecks: [...item.nextChecks],
    }));
    const accepted: HypothesisMutationAccepted[] = [];
    const rejected: HypothesisMutationRejected[] = [];
    const pendingEvents: Array<{
      type: "hypothesis.created" | "hypothesis.updated";
      summary: string;
      payload: Record<string, unknown>;
    }> = [];

    const reject = (
      mutation: HypothesisMutation,
      code: HypothesisMutationRejectionCode,
      message: string,
      hypothesisId?: string,
    ) => {
      rejected.push({
        ...(mutation.requestId ? { requestId: mutation.requestId } : {}),
        op: mutation.op,
        ...(hypothesisId ? { hypothesisId } : {}),
        code,
        message,
      });
    };

    const validateEvidence = (
      mutation: HypothesisMutation,
      ids: string[],
      hypothesisId?: string,
    ): boolean => {
      for (const evidenceId of ids) {
        if (evidenceIds.has(evidenceId)) continue;
        reject(
          mutation,
          "UNKNOWN_EVIDENCE",
          `Hypothesis references unknown evidence ${evidenceId}`,
          hypothesisId,
        );
        return false;
      }
      return true;
    };

    const nextWorkingId = (): string => {
      let index = working.length + 1;
      while (working.some((item) => item.id === `H${String(index).padStart(2, "0")}`)) {
        index++;
      }
      return `H${String(index).padStart(2, "0")}`;
    };

    for (const mutation of mutations.slice(0, 8)) {
      if (mutation.op === "create") {
        const statement = mutation.statement?.trim();
        if (!statement) {
          reject(mutation, "MISSING_STATEMENT", "New hypotheses require a statement");
          continue;
        }

        const requestedId = mutation.id?.trim();
        if (requestedId && !/^H\d+$/.test(requestedId)) {
          reject(
            mutation,
            "INVALID_ID",
            `Hypothesis id ${requestedId} must match H<number>`,
            requestedId,
          );
          continue;
        }
        if (requestedId && working.some((item) => item.id === requestedId)) {
          reject(
            mutation,
            "DUPLICATE_ID",
            `Hypothesis ${requestedId} already exists`,
            requestedId,
          );
          continue;
        }

        const supportingEvidenceIds = [...new Set(mutation.supportingEvidenceIds ?? [])];
        const contradictingEvidenceIds = [...new Set(mutation.contradictingEvidenceIds ?? [])];
        if (
          !validateEvidence(
            mutation,
            [...supportingEvidenceIds, ...contradictingEvidenceIds],
            requestedId,
          )
        ) {
          continue;
        }

        const supersedes = mutation.supersedes?.trim();
        if (supersedes && !working.some((item) => item.id === supersedes)) {
          reject(
            mutation,
            "INVALID_SUPERSEDES",
            `Superseded hypothesis ${supersedes} does not exist`,
            requestedId,
          );
          continue;
        }

        const id = requestedId ?? nextWorkingId();
        const hypothesis: Hypothesis = {
          id,
          statement: statement.slice(0, 1000),
          status: mutation.status ?? "possible",
          confidence: clampConfidence(mutation.confidence),
          supportingEvidenceIds,
          contradictingEvidenceIds,
          nextChecks: (mutation.nextChecks ?? []).filter(Boolean).slice(0, 10),
          ...(mutation.entity?.trim() ? { entity: mutation.entity.trim().slice(0, 200) } : {}),
          ...(mutation.mechanism?.trim()
            ? { mechanism: mutation.mechanism.trim().slice(0, 1000) }
            : {}),
          ...(supersedes ? { supersedes } : {}),
        };
        working.push(hypothesis);
        accepted.push({
          ...(mutation.requestId ? { requestId: mutation.requestId } : {}),
          op: mutation.op,
          hypothesisId: id,
        });
        pendingEvents.push({
          type: "hypothesis.created",
          summary: `${hypothesis.id}: ${hypothesis.statement}`,
          payload: {
            hypothesis,
            source: "main-agent",
          },
        });
        continue;
      }

      const requestedId = mutation.id.trim();
      const existing = working.find((item) => item.id === requestedId);
      if (!existing) {
        reject(
          mutation,
          "HYPOTHESIS_NOT_FOUND",
          `Hypothesis ${requestedId} does not exist`,
          requestedId,
        );
        continue;
      }

      const supportingEvidenceIds = [
        ...new Set(mutation.supportingEvidenceIds ?? existing.supportingEvidenceIds),
      ];
      const contradictingEvidenceIds = [
        ...new Set(mutation.contradictingEvidenceIds ?? existing.contradictingEvidenceIds),
      ];
      if (
        !validateEvidence(
          mutation,
          [...supportingEvidenceIds, ...contradictingEvidenceIds],
          requestedId,
        )
      ) {
        continue;
      }

      const previous = existing.status;
      if (mutation.status) existing.status = mutation.status;
      if (typeof mutation.confidence === "number") {
        existing.confidence = clampConfidence(mutation.confidence, existing.confidence);
      }
      existing.supportingEvidenceIds = supportingEvidenceIds;
      existing.contradictingEvidenceIds = contradictingEvidenceIds;
      if (mutation.nextChecks) existing.nextChecks = mutation.nextChecks.filter(Boolean).slice(0, 10);
      if (mutation.entity?.trim()) existing.entity = mutation.entity.trim().slice(0, 200);
      if (mutation.mechanism?.trim()) existing.mechanism = mutation.mechanism.trim().slice(0, 1000);

      accepted.push({
        ...(mutation.requestId ? { requestId: mutation.requestId } : {}),
        op: mutation.op,
        hypothesisId: requestedId,
      });
      pendingEvents.push({
        type: "hypothesis.updated",
        summary: `${existing.id}: ${previous} → ${existing.status}`,
        payload: {
          hypothesisId: existing.id,
          previous,
          current: existing.status,
          hypothesis: { ...existing },
          supportingEvidenceIds: [...existing.supportingEvidenceIds],
          contradictingEvidenceIds: [...existing.contradictingEvidenceIds],
          source: "main-agent",
        },
      });
    }

    if (accepted.length > 0) {
      investigation.hypotheses = working;
      await this.saveInvestigation(investigation);
      for (const event of pendingEvents) {
        await bus.publish(event.type, event.summary, event.payload);
      }
    }

    return {
      accepted,
      rejected,
      hypotheses: investigation.hypotheses,
    };
  }

  async dispatchAgentic(
    investigationId: string,
    briefs: InvestigationBrief[],
    options: AgenticDispatchOptions = {},
  ): Promise<DispatchedFinding[]> {
    const investigation = await this.liveInvestigation(investigationId);
    this.assertRunning(investigation);

    if (briefs.length === 0) throw new Error("At least one investigation brief is required");
    if (briefs.length > 3) throw new Error("At most three independent briefs may be dispatched in one batch");
    const failedNoEvidenceRoles = new Set(
      investigation.expertTasks
        .filter((task) => task.status === "failed" && task.evidenceIds.length === 0)
        .map((task) => task.expert),
    );
    const effectiveExistingTasks = investigation.expertTasks.filter(
      (task) => !(task.status === "failed" && task.evidenceIds.length === 0),
    ).length;
    const recoveryBriefs = briefs.filter((brief) => failedNoEvidenceRoles.has(brief.role)).length;
    const effectiveNewTasks = briefs.length - recoveryBriefs;
    const totalAfterDispatch = investigation.expertTasks.length + briefs.length;
    if (effectiveExistingTasks + effectiveNewTasks > 4 || totalAfterDispatch > 6) {
      throw new Error(
        "Sub-investigation budget exceeded (4 evidence-producing tasks plus up to 2 recovery tasks for failed/no-evidence roles)",
      );
    }

    for (const brief of briefs) {
      const baseline = brief.context.baselineWindow;
      if (!baseline) continue;
      const baselineFrom = Date.parse(baseline.from);
      const baselineTo = Date.parse(baseline.to);
      const mainFrom = Date.parse(brief.context.mainWindow.from);
      const mainTo = Date.parse(brief.context.mainWindow.to);
      if (
        !Number.isFinite(baselineFrom) ||
        !Number.isFinite(baselineTo) ||
        !Number.isFinite(mainFrom) ||
        !Number.isFinite(mainTo)
      ) {
        throw new Error("Brief contains an invalid baseline or main time window");
      }
      if (baselineFrom > baselineTo || mainFrom > mainTo) {
        throw new Error("Brief time window start must not be after its end");
      }
      if (baselineTo > mainFrom && baselineFrom < mainTo) {
        throw new Error(
          "Brief baselineWindow overlaps mainWindow; choose a non-overlapping comparison window",
        );
      }
    }

    const knownHypotheses = new Set(investigation.hypotheses.map((item) => item.id));
    for (const brief of briefs) {
      if (!brief.question.trim()) throw new Error("Brief question is required");
      if (brief.expected.length === 0) throw new Error("Brief expected outputs are required");
      if (brief.hypothesisIds.length === 0) {
        throw new Error("Brief must identify at least one hypothesis it can change");
      }
      for (const id of brief.hypothesisIds) {
        if (!knownHypotheses.has(id)) throw new Error(`Brief references unknown hypothesis ${id}`);
      }
    }

    const runner = this.requireExpertRunner();
    const bus = await this.busFor(investigationId);
    const running = this.agenticRunning.get(investigationId);
    if (!running) throw new Error("Agentic investigation is not active");
    checkCancelled(running.controller.signal);
    const releaseOperation = this.trackAgenticOperation(investigationId);

    try {
    const taskPairs = briefs.map((brief) => {
      const task: ExpertTask = {
        id: this.nextTaskId(investigation),
        expert: brief.role,
        objective: brief.question.trim().slice(0, 1000),
        status: "running",
        hypothesisIds: [...new Set(brief.hypothesisIds)],
        toolCallIds: [],
        evidenceIds: [],
        brief,
        implementation: "pi-session",
        createdAt: now(),
      };
      investigation.expertTasks.push(task);
      return { task, brief };
    });

    investigation.rounds += 1;
    await this.saveInvestigation(investigation);
    for (const { task, brief } of taskPairs) {
      await bus.publish("expert.started", `${task.expert} investigating: ${brief.question}`, {
        expertTask: task,
        round: investigation.rounds,
        source: "main-agent-dispatch",
      });
    }

    const rcaTask: RcaTask = {
      caseId: investigation.caseId,
      version: "runtime",
      alert: investigation.alertContext,
      availableModalities: ["metric", "log", "trace", "event", "alert", "topology"],
    };

    const settled = await Promise.allSettled(
      taskPairs.map(async ({ task, brief }): Promise<DispatchedFinding> => {
        try {
          const run = await runner.run({
            investigation,
            task: rcaTask,
            brief,
            model: options.model,
            signal: running.controller.signal,
            invoke: (tool, arguments_) =>
              this.invokeRecordedTool(
                investigation,
                bus,
                tool,
                arguments_,
                task,
                running.controller.signal,
              ),
            onThinking: (delta) =>
              bus.publish("expert.thinking.delta", "", {
                expertTaskId: task.id,
                delta,
              }).then(() => undefined),
          });
          checkCancelled(running.controller.signal);
          task.sessionId = run.sessionId;
          task.diagnostics = run.diagnostics;

          const finding = await this.acceptAgentFinding(investigation, task, run.finding, bus);
          checkCancelled(running.controller.signal);
          task.finding = finding;
          task.status = finding.status === "failed" ? "failed" : "completed";
          task.completedAt = now();
          await this.saveInvestigation(investigation);
          await bus.publish("expert.completed", `${task.expert} completed: ${finding.summary}`, {
            expertTask: task,
            finding,
          });
          const observationIds = (investigation.observations ?? [])
            .filter((item) => item.expertTaskId === task.id)
            .map((item) => item.id);
          return {
            taskRef: task.id,
            role: task.expert,
            status: task.status,
            finding,
            evidenceIds: [...task.evidenceIds],
            observationIds,
            ...(task.diagnostics ? { diagnostics: task.diagnostics } : {}),
          };
        } catch (error) {
          const cancelled = running.controller.signal.aborted || isAbortError(error);
          if (error instanceof PiExpertRunError) {
            task.diagnostics = error.diagnostics;
            if (error.sessionId) task.sessionId = error.sessionId;
          }
          if (cancelled && task.status === "cancelled") {
            throw error;
          }
          task.status = cancelled ? "cancelled" : "failed";
          task.completedAt = now();
          const finding: AgentExpertFinding = {
            status: cancelled ? "failed" : "failed",
            strength: "inconclusive",
            summary: error instanceof Error ? error.message : String(error),
            conclusions: [],
            evidenceClaims: [],
            candidateEntities: [],
            verdict: "inconclusive",
            suggestedFollowUps: [],
          };
          task.finding = finding;
          await this.saveInvestigation(investigation);
          await bus.publish(
            "expert.completed",
            `${task.expert} ${cancelled ? "cancelled" : "failed"}: ${finding.summary}`,
            { expertTask: task, finding },
          );
          if (cancelled) throw error;
          const observationIds = (investigation.observations ?? [])
            .filter((item) => item.expertTaskId === task.id)
            .map((item) => item.id);
          if (observationIds.length > 0) {
            finding.summary = `${finding.summary} ${observationIds.length} tool-backed observations were retained for recovery.`;
            finding.suggestedFollowUps = [
              "Use get_investigation_state to inspect retained observations before deciding whether a narrower recovery brief is needed.",
            ];
          }
          return {
            taskRef: task.id,
            role: task.expert,
            status: task.status,
            finding,
            evidenceIds: [],
            observationIds,
            ...(task.diagnostics ? { diagnostics: task.diagnostics } : {}),
          };
        }
      }),
    );

    if (running.controller.signal.aborted) {
      throw new DOMException("Investigation cancelled", "AbortError");
    }
    const results: DispatchedFinding[] = [];
    for (const item of settled) {
      if (item.status === "rejected") throw item.reason;
      results.push(item.value);
    }

    await bus.publish("round.completed", `Agentic batch ${investigation.rounds} completed.`, {
      round: investigation.rounds,
      taskRefs: results.map((item) => item.taskRef),
      evidenceIds: results.flatMap((item) => item.evidenceIds),
      source: "main-agent",
    });
    return results;
    } finally {
      releaseOperation();
    }
  }

  async concludeAgentic(
    investigationId: string,
    result: AgenticConclusionInput,
  ): Promise<{ investigation: Investigation; report: string }> {
    const investigation = await this.liveInvestigation(investigationId);
    this.assertConcludable(investigation);
    const bus = await this.busFor(investigationId);
    const evidenceIds = new Set(investigation.evidence.map((item) => item.id));
    const hypothesisIds = new Set(investigation.hypotheses.map((item) => item.id));

    for (const evidenceId of result.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        throw new Error(`Conclusion references unknown evidence ${evidenceId}`);
      }
    }
    for (const hypothesisId of result.rejectedHypotheses) {
      if (!hypothesisIds.has(hypothesisId)) {
        throw new Error(`Conclusion references unknown hypothesis ${hypothesisId}`);
      }
    }
    for (const hypothesisId of result.selectedHypothesisIds) {
      if (!hypothesisIds.has(hypothesisId)) {
        throw new Error(`Conclusion selects unknown hypothesis ${hypothesisId}`);
      }
    }
    for (const unresolved of result.unresolvedHypotheses) {
      if (!hypothesisIds.has(unresolved.id)) {
        throw new Error(`Conclusion marks unknown hypothesis ${unresolved.id} unresolved`);
      }
      if (!unresolved.reason.trim()) {
        throw new Error(`Unresolved hypothesis ${unresolved.id} requires a reason`);
      }
    }

    const selected = new Set(result.selectedHypothesisIds);
    const rejected = new Set(result.rejectedHypotheses);
    const unresolved = new Set(result.unresolvedHypotheses.map((item) => item.id));
    if (selected.size !== result.selectedHypothesisIds.length) {
      throw new Error("selectedHypothesisIds contains duplicate hypothesis ids");
    }
    if (rejected.size !== result.rejectedHypotheses.length) {
      throw new Error("rejectedHypotheses contains duplicate hypothesis ids");
    }
    if (unresolved.size !== result.unresolvedHypotheses.length) {
      throw new Error("unresolvedHypotheses contains duplicate hypothesis ids");
    }
    const overlaps = [...hypothesisIds].filter(
      (id) =>
        Number(selected.has(id)) + Number(rejected.has(id)) + Number(unresolved.has(id)) > 1,
    );
    if (overlaps.length > 0) {
      throw new Error(
        `Hypotheses must appear in exactly one conclusion bucket: ${overlaps.join(", ")}`,
      );
    }
    const unaccounted = [...hypothesisIds].filter(
      (id) => !selected.has(id) && !rejected.has(id) && !unresolved.has(id),
    );
    if (unaccounted.length > 0) {
      throw new Error(
        `Conclusion leaves hypotheses unaccounted for: ${unaccounted.join(", ")}`,
      );
    }

    for (const id of selected) {
      const hypothesis = investigation.hypotheses.find((item) => item.id === id)!;
      if (hypothesis.status !== "supported" && hypothesis.status !== "confirmed") {
        throw new Error(
          `Selected hypothesis ${id} must be supported or confirmed before conclusion`,
        );
      }
    }
    for (const id of rejected) {
      const hypothesis = investigation.hypotheses.find((item) => item.id === id)!;
      if (hypothesis.status !== "rejected") {
        throw new Error(
          `Rejected hypothesis ${id} must be marked rejected before conclusion`,
        );
      }
    }
    for (const item of result.unresolvedHypotheses) {
      const hypothesis = investigation.hypotheses.find((candidate) => candidate.id === item.id)!;
      if (hypothesis.status === "rejected" || hypothesis.status === "confirmed") {
        throw new Error(
          `Unresolved hypothesis ${item.id} cannot already be ${hypothesis.status}`,
        );
      }
    }
    if (result.status !== "inconclusive" && selected.size === 0) {
      throw new Error("A non-inconclusive conclusion must select at least one hypothesis");
    }
    if (
      result.status === "confirmed" &&
      ![...selected].some(
        (id) => investigation.hypotheses.find((item) => item.id === id)?.status === "confirmed",
      )
    ) {
      throw new Error("A confirmed conclusion must select at least one confirmed hypothesis");
    }

    if (result.status !== "inconclusive" && result.evidenceIds.length === 0) {
      throw new Error("A non-inconclusive conclusion must cite evidence");
    }
    if (result.status === "confirmed" && result.evidenceIds.length < 2) {
      throw new Error("A confirmed conclusion must cite at least two evidence items");
    }
    if (result.status !== "inconclusive" && result.rootCauseEntities.length === 0) {
      throw new Error("A non-inconclusive conclusion must name at least one root-cause entity");
    }

    const contradictions = result.causalAssessment.unresolvedContradictions
      .map((item) => item.trim())
      .filter(Boolean);
    if (result.status === "probable" && result.causalAssessment.temporalFit === "uncertain") {
      throw new Error("A probable conclusion requires a non-uncertain temporal fit");
    }
    if (result.status === "confirmed") {
      if (result.causalAssessment.temporalFit === "uncertain") {
        throw new Error("A confirmed conclusion requires a non-uncertain temporal fit");
      }
      if (result.causalAssessment.propagationFit !== "supported") {
        throw new Error("A confirmed conclusion requires supported propagation");
      }
      if (contradictions.length > 0) {
        throw new Error("A confirmed conclusion cannot retain unresolved contradictions");
      }
    }

    investigation.rootCause = {
      investigationId,
      ...result,
      evidenceIds: [...new Set(result.evidenceIds)],
      rejectedHypotheses: [...new Set(result.rejectedHypotheses)],
      rootCauseEntities: [...new Set(result.rootCauseEntities)],
      confidence: clampConfidence(result.confidence, 0),
      causalAssessment: {
        ...result.causalAssessment,
        unresolvedContradictions: [...new Set(contradictions)],
      },
    };
    investigation.status =
      investigation.rootCause.status === "inconclusive" ? "inconclusive" : "completed";
    investigation.completedAt = now();
    const report = this.renderReport(investigation);
    await this.saveInvestigation(investigation);
    await this.repository.saveReport(investigationId, investigation.rootCause, report);
    await bus.publish(
      "investigation.completed",
      `RCA ${investigation.rootCause.status}: ${investigation.rootCause.summary}`,
      { result: investigation.rootCause, source: "main-agent" },
    );
    this.cleanupAgentic(investigationId);
    return { investigation, report };
  }

  get(investigationId: string): Promise<Investigation> {
    return this.repository.get(investigationId);
  }

  getReport(investigationId: string): Promise<string> {
    return this.repository.getReport(investigationId);
  }

  async cancel(investigationId: string): Promise<boolean> {
    const running = this.agenticRunning.get(investigationId);
    if (!running) return false;
    await this.requestAgenticCancellation(investigationId, running);
    return true;
  }

  async cancelConversation(conversationId: string): Promise<number> {
    const matches = [...this.agenticRunning.entries()].filter(
      ([, running]) => running.conversationId === conversationId,
    );
    await Promise.all(
      matches.map(([id, running]) => this.requestAgenticCancellation(id, running)),
    );
    return matches.length;
  }

  private requireAgenticTools(): ObservabilityToolRegistry {
    if (!this.tools) throw new Error("Agentic RCA tools are not configured");
    return this.tools;
  }

  private requireExpertRunner(): PiExpertRunner {
    if (!this.expertRunner) throw new Error("Pi RCA sub-agent runtime is not configured");
    return this.expertRunner;
  }

  private async liveInvestigation(investigationId: string): Promise<Investigation> {
    const running = this.agenticRunning.get(investigationId);
    if (running?.investigation) return running.investigation;
    const investigation = await this.repository.get(investigationId);
    if (running) running.investigation = investigation;
    return investigation;
  }

  private trackAgenticOperation(investigationId: string): () => void {
    const running = this.agenticRunning.get(investigationId);
    if (!running) return () => undefined;
    running.activeOperations++;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      running.activeOperations = Math.max(0, running.activeOperations - 1);
      if (!running.controller.signal.aborted || running.activeOperations !== 0) return;
      const cancellation = running.cancellationPromise;
      if (cancellation) {
        void cancellation.finally(() => {
          const current = this.agenticRunning.get(investigationId);
          if (current === running && current.activeOperations === 0) {
            this.cleanupAgentic(investigationId);
          }
        });
      } else {
        this.cleanupAgentic(investigationId);
      }
    };
  }

  private async requestAgenticCancellation(
    investigationId: string,
    running: RunningAgenticInvestigation,
  ): Promise<void> {
    if (!running.cancellationPromise) {
      running.cancellationPromise = this.markAgenticCancelled(investigationId, running);
      running.controller.abort();
    }
    await running.cancellationPromise;
    if (running.activeOperations === 0) {
      this.cleanupAgentic(investigationId);
    }
  }

  private assertRunning(investigation: Investigation): void {
    if (investigation.status !== "running") {
      throw new Error(
        `Investigation ${investigation.id} is ${investigation.status}, not running`,
      );
    }
  }

  private assertConcludable(investigation: Investigation): void {
    if (investigation.status !== "running" && investigation.status !== "interrupted") {
      throw new Error(
        `Investigation ${investigation.id} is ${investigation.status} and cannot be concluded`,
      );
    }
  }

  private async busFor(investigationId: string): Promise<InvestigationEventBus> {
    const existing = this.eventBuses.get(investigationId);
    if (existing) return existing;
    const events = await this.repository.listEvents(investigationId);
    const bus = new InvestigationEventBus(
      investigationId,
      this.repository,
      (events.at(-1)?.id ?? 0) + 1,
    );
    this.eventBuses.set(investigationId, bus);
    return bus;
  }

  private saveInvestigation(investigation: Investigation): Promise<void> {
    const previous = this.saveQueues.get(investigation.id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.repository.save(investigation));
    const tracked = next.finally(() => {
      if (this.saveQueues.get(investigation.id) === tracked) {
        this.saveQueues.delete(investigation.id);
      }
    });
    this.saveQueues.set(investigation.id, tracked);
    return tracked;
  }

  private overviewTool(
    investigation: Investigation,
    kind: RcaOverviewKind,
    query: Record<string, unknown>,
  ): { tool: ObservabilityToolName; arguments_: Record<string, unknown> } {
    const common = {
      caseId: investigation.caseId,
      from: investigation.alertContext.window.from,
      to: investigation.alertContext.window.to,
    };
    switch (kind) {
      case "alerts":
        return {
          tool: "query_alerts",
          arguments_: { ...common, ...query, limit: Math.min(Number(query.limit ?? 20), 20) },
        };
      case "dependencies":
        return {
          tool: "get_service_dependencies",
          arguments_: {
            caseId: investigation.caseId,
            service:
              query.service ??
              investigation.alertContext.service ??
              investigation.alertContext.entity.name,
          },
        };
      case "metrics":
        return {
          tool: "query_metrics",
          arguments_: { ...common, ...query, topN: Math.min(Number(query.topN ?? 20), 20) },
        };
      case "traces":
        return {
          tool: "query_traces",
          arguments_: { ...common, ...query, topN: Math.min(Number(query.topN ?? 10), 10) },
        };
      case "topology":
        return {
          tool: "get_topology",
          arguments_: {
            caseId: investigation.caseId,
            ...query,
            depth: Math.min(Number(query.depth ?? 1), 1),
          },
        };
    }
  }

  private async invokeRecordedTool(
    investigation: Investigation,
    bus: InvestigationEventBus,
    tool: ObservabilityToolName,
    arguments_: Record<string, unknown>,
    expertTask?: ExpertTask,
    signal?: AbortSignal,
  ): Promise<RecordedAgentToolExecution> {
    const tools = this.requireAgenticTools();
    checkCancelled(signal);
    const call: ToolCallRecord = {
      id: this.nextToolId(investigation),
      ...(expertTask ? { expertTaskId: expertTask.id } : {}),
      tool,
      query: arguments_,
      status: "running",
      startedAt: now(),
      runtime: {
        before: runtimeResourceSnapshot(),
      },
    };
    investigation.toolCalls.push(call);
    expertTask?.toolCallIds.push(call.id);
    await this.saveInvestigation(investigation);
    await bus.publish("tool.started", `${expertTask?.expert ?? "main"} called ${tool}.`, {
      toolCall: call,
    });

    try {
      const execution: ToolExecution = await tools.execute(tool, arguments_, signal);
      checkCancelled(signal);
      const agentContextResult = compactToolResultForAgent(tool, execution.result);
      call.status = "completed";
      call.resultSummary = execution.summary;
      call.rawRef = execution.rawRef;
      call.completedAt = now();
      if (call.runtime) call.runtime.after = runtimeResourceSnapshot();
      const observation: Observation = {
        id: this.nextObservationId(investigation),
        caseId: investigation.caseId,
        modality: toolModality(tool),
        toolCallId: call.id,
        ...(expertTask ? { expertTaskId: expertTask.id } : {}),
        summary: observationSummary(tool, execution),
        ...(execution.rawRef ? { rawRef: execution.rawRef } : {}),
        facts: observationFacts(tool, execution),
        createdAt: now(),
      };
      investigation.observations ??= [];
      investigation.observations.push(observation);
      await this.repository.appendToolCall(investigation.id, call);
      await this.saveInvestigation(investigation);
      checkCancelled(signal);
      await bus.publish("tool.completed", `${tool} completed: ${execution.summary}.`, {
        toolCall: call,
        agentContextResult,
      });
      await bus.publish("observation.created", observation.summary, {
        observation,
      });
      return {
        callId: call.id,
        observationId: observation.id,
        execution: {
          result: execution.result,
          summary: execution.summary,
          rawRef: execution.rawRef,
        },
      };
    } catch (error) {
      const cancelled = signal?.aborted || isAbortError(error);
      if (cancelled) {
        investigation.observations = (investigation.observations ?? []).filter(
          (observation) => observation.toolCallId !== call.id,
        );
      }
      const alreadyCancelled = cancelled && call.status === "cancelled";
      if (!alreadyCancelled) {
        call.status = cancelled ? "cancelled" : "failed";
        call.error = error instanceof Error ? error.message : String(error);
        call.completedAt = now();
        if (call.runtime) call.runtime.after = runtimeResourceSnapshot();
        await this.repository.appendToolCall(investigation.id, call);
        await this.saveInvestigation(investigation);
        await bus.publish(
          "tool.completed",
          `${tool} ${cancelled ? "cancelled" : "failed"}: ${call.error}.`,
          { toolCall: call },
        );
      }
      throw error;
    }
  }

  private async acceptAgentFinding(
    investigation: Investigation,
    task: ExpertTask,
    finding: AgentExpertFinding,
    bus: InvestigationEventBus,
  ): Promise<AgentExpertFinding> {
    const validHypotheses = new Set(investigation.hypotheses.map((item) => item.id));
    const taskCalls = new Set(task.toolCallIds);
    let accepted = 0;

    for (const claim of finding.evidenceClaims) {
      if (!taskCalls.has(claim.toolCallId)) continue;
      const call = investigation.toolCalls.find((item) => item.id === claim.toolCallId);
      if (!call || call.status !== "completed") continue;
      const evidence: Evidence = {
        id: this.nextEvidenceId(investigation),
        caseId: investigation.caseId,
        modality: claim.modality,
        ...(claim.entity ? { entity: claim.entity } : {}),
        timeRange: investigation.alertContext.window,
        summary: claim.summary,
        rawRef: call.rawRef ?? `investigation://${investigation.id}/tool/${call.id}`,
        supports: claim.supports.filter((id) => validHypotheses.has(id)),
        contradicts: claim.contradicts.filter((id) => validHypotheses.has(id)),
        sourceQuery: call.query,
        toolCallId: call.id,
        expertTaskId: task.id,
        facts: {
          source: "pi-child-session",
          findingStrength: finding.strength,
        },
        createdAt: now(),
      };
      investigation.evidence.push(evidence);
      task.evidenceIds.push(evidence.id);
      for (const entity of finding.candidateEntities) {
        if (!investigation.scope.candidateEntities.includes(entity)) {
          investigation.scope.candidateEntities.push(entity);
        }
      }
      accepted++;
      await bus.publish("evidence.created", evidence.summary, {
        evidence,
        expertTaskId: task.id,
      });
    }

    if (accepted === 0 && (finding.strength === "strong" || finding.strength === "moderate")) {
      return {
        ...finding,
        status: finding.status === "blocked" ? "blocked" : "inconclusive",
        strength: "inconclusive",
        summary: `${finding.summary} No valid tool-backed evidence claim was accepted.`,
      };
    }
    return finding;
  }

  private nextObservationId(investigation: Investigation): string {
    const count = investigation.observations?.length ?? 0;
    return `O${String(count + 1).padStart(2, "0")}`;
  }

  private nextToolId(investigation: Investigation): string {
    return `C${String(investigation.toolCalls.length + 1).padStart(2, "0")}`;
  }

  private nextEvidenceId(investigation: Investigation): string {
    return `E${String(investigation.evidence.length + 1).padStart(2, "0")}`;
  }

  private nextTaskId(investigation: Investigation): string {
    return `T${String(investigation.expertTasks.length + 1).padStart(2, "0")}`;
  }

  private renderReport(investigation: Investigation): string {
    const result = investigation.rootCause!;
    const evidence = investigation.evidence.filter((item) => result.evidenceIds.includes(item.id));
    const ruledOut = investigation.hypotheses.filter((item) =>
      result.rejectedHypotheses.includes(item.id),
    );
    return [
      "# RCA Report",
      "",
      `- Investigation: ${investigation.id}`,
      `- Status: ${result.status}`,
      `- Confidence: ${result.confidence.toFixed(2)}`,
      `- Root cause entities: ${result.rootCauseEntities.join(", ") || "unresolved"}`,
      "",
      "## Conclusion",
      result.summary,
      ...(result.mechanism ? ["", "## Mechanism", result.mechanism] : []),
      ...(result.causalAssessment
        ? [
            "",
            "## Causal Assessment",
            `- Temporal fit: ${result.causalAssessment.temporalFit}`,
            `- Propagation fit: ${result.causalAssessment.propagationFit}`,
            `- Unresolved contradictions: ${
              result.causalAssessment.unresolvedContradictions.length
                ? result.causalAssessment.unresolvedContradictions.join("; ")
                : "none"
            }`,
          ]
        : []),
      "",
      "## Key Evidence",
      ...(evidence.length
        ? evidence.map((item) => `- ${item.id} [${item.modality}] ${item.summary}`)
        : ["- No decisive evidence was established."]),
      "",
      "## Ruled Out",
      ...(ruledOut.length
        ? ruledOut.map((item) => `- ${item.id}: ${item.statement}`)
        : ["- None recorded."]),
      "",
      "## Unresolved Hypotheses",
      ...(result.unresolvedHypotheses?.length
        ? result.unresolvedHypotheses.map(
            (item) =>
              `- ${item.id}: ${item.reason}${
                item.missingEvidence?.length
                  ? ` (missing: ${item.missingEvidence.join("; ")})`
                  : ""
              }`,
          )
        : ["- None recorded."]),
      "",
      "## Missing Evidence",
      ...(result.missingEvidence?.length
        ? result.missingEvidence.map((item) => `- ${item}`)
        : ["- None recorded."]),
    ].join("\n");
  }

  private async markAgenticCancelled(
    investigationId: string,
    running: RunningAgenticInvestigation,
  ): Promise<void> {
    let investigation = running.investigation;
    if (!investigation) {
      try {
        investigation = await this.repository.get(investigationId);
        running.investigation = investigation;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
    if (investigation.status !== "running") return;

    const cancelledAt = now();
    const cancellationMessage = "Investigation cancelled";
    investigation.status = "cancelled";
    investigation.completedAt = cancelledAt;
    investigation.error = cancellationMessage;

    const cancelledCalls: ToolCallRecord[] = [];
    for (const call of investigation.toolCalls) {
      if (call.status !== "running") continue;
      call.status = "cancelled";
      call.completedAt = cancelledAt;
      call.error = cancellationMessage;
      if (call.runtime) call.runtime.after = runtimeResourceSnapshot();
      cancelledCalls.push(call);
    }

    const cancelledTasks: ExpertTask[] = [];
    for (const task of investigation.expertTasks) {
      if (task.status !== "running" && task.status !== "pending") continue;
      task.status = "cancelled";
      task.completedAt = cancelledAt;
      cancelledTasks.push(task);
    }

    await this.saveInvestigation(investigation);
    for (const call of cancelledCalls) {
      await this.repository.appendToolCall(investigationId, call);
    }

    const bus = await this.busFor(investigationId);
    for (const call of cancelledCalls) {
      await bus.publish("tool.completed", `${call.tool} cancelled: ${cancellationMessage}.`, {
        toolCall: call,
      });
    }
    for (const task of cancelledTasks) {
      await bus.publish("expert.completed", `${task.expert} cancelled: ${cancellationMessage}.`, {
        expertTask: task,
      });
    }
    await bus.publish("investigation.cancelled", "Investigation cancelled.", {
      source: "user",
    });
  }

  private cleanupAgentic(investigationId: string): void {
    const active = this.agenticRunning.get(investigationId);
    active?.unsubscribe?.();
    this.agenticRunning.delete(investigationId);
  }
}
