import { createHash, randomUUID } from "node:crypto";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  appendLedgerEvent,
  foldBudget,
  nextLedgerEvent,
  RCA_BUDGET_POLICY,
  type BudgetProjection,
} from "./budget";
import { InvestigationEventBus, type InvestigationEventListener } from "./events";
import { LIVE_CONTRACT_VERSION, LIVE_FORMAT_VERSION, LIVE_LIMITS, validateTimeRange } from "./live/types";
import { PiExpertRunError, PiExpertRunner, type RecordedAgentToolExecution } from "./pi-expert";
import { InvestigationRepository } from "./repository";
import { InvestigationVisualizationService } from "./visualization/service";
import type {
  InvestigationVisualizationArtifact,
  InvestigationVisualizationEvent,
} from "./visualization/types";
import { safeRuntimeDetail } from "./runtime-accounting";
import { AbortableSemaphore } from "./semaphore";
import {
  compactToolResultForAgent,
  ObservabilityToolRegistry,
  type ObservabilityToolName,
  type ToolExecution,
} from "./tools";
import type {
  AgentExpertFinding,
  AgentRunDiagnostics,
  AgentTermination,
  CausalAssessment,
  Evidence,
  EvidenceModality,
  ExpertTask,
  Hypothesis,
  HypothesisStatus,
  Investigation,
  InvestigationBrief,
  IncidentContext,
  InvestigationUserIntervention,
  Observation,
  RCAResult,
  RcaTask,
  RuntimeResourceSnapshot,
  ToolCallRecord,
  TimeRange,
} from "./types";

interface RunningAgenticInvestigation {
  conversationId?: string;
  controller: AbortController;
  unsubscribe?: () => void;
  investigation?: Investigation;
  activeOperations: number;
  activeDispatchController?: AbortController;
  activeDispatchControllers?: Set<AbortController>;
  cancellationPromise?: Promise<void>;
}

export type RcaOverviewKind = "metrics" | "traces" | "logs";

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
  operationId?: string;
  conversationId?: string;
  onEvent?: InvestigationEventListener;
}

export interface LiveIncidentInput {
  symptom: string;
  trigger?: IncidentContext["trigger"];
  target: IncidentContext["target"];
  window: TimeRange | { lookbackMinutes: number };
}

export interface AgenticResumeOptions {
  conversationId?: string;
  onEvent?: InvestigationEventListener;
}

export interface AgenticDispatchOptions {
  model?: { provider: string; id: string };
  dispatchOperationId?: string;
}

export interface AgenticConclusionInput extends Omit<
  RCAResult,
  "investigationId" | "causalAssessment"
> {
  selectedHypothesisIds: string[];
  unresolvedHypotheses: Array<{
    id: string;
    reason: string;
    missingEvidence?: string[];
  }>;
  causalAssessment: CausalAssessment & {
    temporalEvidenceIds: string[];
    transitionEvidenceIds: string[];
    propagationEvidenceIds: string[];
    materialUnobservedGap: boolean;
    gapBridgeEvidenceIds: string[];
  };
}

export interface DispatchedFinding {
  taskRef: string;
  role: InvestigationBrief["role"];
  status: ExpertTask["status"];
  finding: AgentExpertFinding;
  evidenceIds: string[];
  observationIds: string[];
  termination?: AgentTermination["reason"];
  diagnostics?: AgentRunDiagnostics;
}

export interface AgenticDispatchResult {
  findings: DispatchedFinding[];
  interrupted: boolean;
  budget?: BudgetProjection;
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
  return {
    at: now(),
    rssMb: bytesToMb(memory.rss),
    heapUsedMb: bytesToMb(memory.heapUsed),
    heapTotalMb: bytesToMb(memory.heapTotal),
    externalMb: bytesToMb(memory.external),
    arrayBuffersMb: bytesToMb(memory.arrayBuffers),
  };
}

function toolModality(tool: ObservabilityToolName): EvidenceModality {
  if (tool === "query_metrics" || tool === "discover_metrics") return "metric";
  if (tool === "search_logs") return "log";
  return "trace";
}

function observationSummary(_tool: ObservabilityToolName, execution: ToolExecution): string {
  const warnings = execution.result.warnings.slice(0, 2);
  return warnings.length
    ? `${execution.summary}; ${warnings.join("; ")}`
    : execution.summary;
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

function freezeIncidentContext(input: LiveIncidentInput): IncidentContext {
  const symptom = input.symptom.trim().slice(0, 1500);
  if (!symptom) throw new Error("Incident symptom is required");
  const target = Object.fromEntries(
    Object.entries(input.target ?? {})
      .filter(([, value]) => typeof value === "string" && value.trim())
      .map(([key, value]) => [key, String(value).trim().slice(0, 256)]),
  ) as IncidentContext["target"];
  if (!target.service && !target.entity && !target.container) {
    throw new Error("Incident target requires service, entity, or container");
  }
  let window: TimeRange;
  if ("lookbackMinutes" in input.window) {
    const lookbackMinutes = Math.floor(input.window.lookbackMinutes);
    if (!Number.isFinite(lookbackMinutes) || lookbackMinutes < 1 || lookbackMinutes > 1440) {
      throw new Error("lookbackMinutes must be between 1 and 1440");
    }
    const to = new Date();
    const from = new Date(to.getTime() - lookbackMinutes * 60_000);
    window = { from: from.toISOString(), to: to.toISOString() };
  } else {
    window = {
      from: new Date(input.window.from).toISOString(),
      to: new Date(input.window.to).toISOString(),
    };
  }
  validateTimeRange(window);
  return {
    symptom,
    trigger: structuredClone(input.trigger ?? { type: "manual" }),
    window,
    target,
  };
}

function liveRequestHash(input: LiveIncidentInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export class RcaServiceError extends Error {
  readonly code: "legacy_read_only" | "operation_conflict";

  constructor(code: RcaServiceError["code"], message = code) {
    super(message);
    this.name = "RcaServiceError";
    this.code = code;
  }
}

export class RcaService {
  private readonly repository: InvestigationRepository;
  private readonly visualizationService: InvestigationVisualizationService;
  private readonly tools?: ObservabilityToolRegistry;
  private readonly expertRunner?: PiExpertRunner;
  private readonly agenticRunning = new Map<string, RunningAgenticInvestigation>();
  private readonly eventBuses = new Map<string, InvestigationEventBus>();
  private readonly eventBusInitializations = new Map<string, Promise<InvestigationEventBus>>();
  private readonly saveQueues = new Map<string, Promise<void>>();
  private readonly investigationLocks = new Map<string, Promise<void>>();
  private readonly runtimeSlots = new Map<string, AbortableSemaphore>();
  private readonly globalRuntimeSlots = new AbortableSemaphore(
    RCA_BUDGET_POLICY.maxGlobalParallelTasks,
  );
  private readonly dispatchPromises = new Map<
    string,
    { hash: string; promise: Promise<AgenticDispatchResult> }
  >();

  constructor(
    repository: InvestigationRepository,
    modelRuntime?: ModelRuntime,
    tools?: ObservabilityToolRegistry,
  ) {
    this.repository = repository;
    this.visualizationService = new InvestigationVisualizationService(repository);
    this.tools = tools;
    this.expertRunner = modelRuntime && tools ? new PiExpertRunner(modelRuntime, tools) : undefined;
  }

  async beginAgentic(
    input: LiveIncidentInput | string,
    options: AgenticBeginOptions = {},
  ): Promise<Investigation> {
    if (typeof input === "string") {
      throw new RcaServiceError(
        "legacy_read_only",
        "legacy_read_only: RCA100 case-based investigation creation is disabled",
      );
    }
    const requestHash = liveRequestHash(input);
    const operationId = options.operationId?.trim();
    const id =
      options.investigationId ??
      (operationId
        ? `INV-op-${createHash("sha256").update(operationId).digest("hex").slice(0, 20)}`
        : createInvestigationId());

    if (operationId) {
      try {
        const existing = await this.repository.get(id);
        if (
          existing.source?.kind !== "live" ||
          existing.creation?.operationId !== operationId ||
          existing.creation.requestHash !== requestHash
        ) {
          throw new RcaServiceError(
            "operation_conflict",
            `operation_conflict: start operation ${operationId} has different input`,
          );
        }
        return existing;
      } catch (error) {
        if (
          error instanceof RcaServiceError ||
          (error as NodeJS.ErrnoException).code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }

    const context = freezeIncidentContext(input);
    const bus = await this.busFor(id);
    const controller = new AbortController();
    const unsubscribe = options.onEvent ? bus.subscribe(options.onEvent) : undefined;
    const investigation: Investigation = {
      id,
      status: "running",
      symptom: context.symptom,
      context,
      formatVersion: LIVE_FORMAT_VERSION,
      source: {
        kind: "live",
        contractVersion: LIVE_CONTRACT_VERSION,
      },
      creation: {
        ...(operationId ? { operationId } : {}),
        requestHash,
      },
      scope: {
        candidateEntities: [
          context.target.service,
          context.target.entity,
          context.target.container,
        ].filter((value): value is string => Boolean(value)),
        extensions: [],
      },
      hypotheses: [],
      observations: [],
      evidence: [],
      expertTasks: [],
      toolCalls: [],
      rounds: 0,
      startedAt: now(),
      schemaVersion: 2,
      budgetLedger: [],
    };
    this.agenticRunning.set(id, {
      conversationId: options.conversationId,
      controller,
      unsubscribe,
      investigation,
      activeOperations: 0,
    });
    try {
      await this.saveInvestigation(investigation);
      await bus.publish("investigation.started", `Investigation started: ${context.symptom}`, {
        incident: context,
        mode: "live",
        formatVersion: LIVE_FORMAT_VERSION,
        contractVersion: LIVE_CONTRACT_VERSION,
      });
      return investigation;
    } catch (error) {
      this.cleanupAgentic(id);
      throw error;
    }
  }

  async resumeAgentic(
    investigationId: string,
    options: AgenticResumeOptions = {},
    locked = false,
  ): Promise<Investigation> {
    const investigation = await this.repository.get(investigationId);
    this.assertLiveWritable(investigation);
    if (investigation.schemaVersion === 2 && !locked) {
      return this.withInvestigationLock(investigationId, () =>
        this.resumeAgentic(investigationId, options, true),
      );
    }
    if (investigation.status !== "interrupted" && investigation.status !== "running") {
      throw new Error(
        `Investigation ${investigation.id} is ${investigation.status} and cannot be resumed`,
      );
    }

    if (investigation.schemaVersion === 2 && this.agenticRunning.has(investigationId)) {
      throw new Error(`Investigation ${investigationId} is already active in this process`);
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
    snapshotRef?: string;
    result: unknown;
  }> {
    const investigation = await this.liveInvestigation(investigationId);
    this.assertLiveWritable(investigation);
    this.assertRunning(investigation);
    const bus = await this.busFor(investigationId);
    const signal = this.agenticRunning.get(investigationId)?.controller.signal;
    const releaseOperation = this.trackAgenticOperation(investigationId);
    try {
      const { tool, arguments_ } = this.overviewTool(investigation, kind, query);
      const recorded = await this.invokeRecordedToolV2(
        investigationId,
        undefined,
        bus,
        tool,
        arguments_,
        signal,
      );
      checkCancelled(signal);
      const evidence = await this.updateV2(investigationId, (draft) => {
        if (signal?.aborted || draft.status !== "running") {
          throw new DOMException("Overview superseded", "AbortError");
        }
        const item: Evidence = {
          id: this.nextEvidenceId(draft),
          investigationId: draft.id,
          modality: toolModality(tool),
          ...(typeof query.entity === "string" ? { entity: query.entity } : {}),
          timeRange: recorded.execution.actualWindow ?? draft.context!.window,
          summary: recorded.execution.summary,
          ...(recorded.execution.rawRef ? { rawRef: recorded.execution.rawRef } : {}),
          ...(recorded.execution.snapshotRef
            ? { snapshotRef: recorded.execution.snapshotRef }
            : {}),
          supports: [],
          contradicts: [],
          sourceQuery: recorded.execution.query ?? arguments_,
          toolCallId: recorded.callId,
          facts: {
            source: "main-agent-overview",
            resultStatus: recorded.execution.resultStatus,
          },
          createdAt: now(),
        };
        draft.evidence.push(item);
        return item;
      });
      await bus.publish("evidence.created", evidence.summary, { evidence });
      return {
        evidenceId: evidence.id,
        toolCallId: recorded.callId,
        summary: evidence.summary,
        ...(recorded.execution.rawRef ? { rawRef: recorded.execution.rawRef } : {}),
        ...(recorded.execution.snapshotRef ? { snapshotRef: recorded.execution.snapshotRef } : {}),
        result: compactToolResultForAgent(tool, recorded.execution.result),
      };
    } finally {
      releaseOperation();
    }
  }

  async queryCandidateCoverage(
    investigationId: string,
    _candidates: string[],
    _topNPerCandidate = 6,
  ): Promise<never> {
    const investigation = await this.liveInvestigation(investigationId);
    this.assertLiveWritable(investigation);
    throw new Error(
      "candidate_coverage_replaced: use discover_metrics/query_metrics with explicit scoped targets",
    );
  }

  async updateHypotheses(
    investigationId: string,
    mutations: HypothesisMutation[],
    locked = false,
  ): Promise<HypothesisMutationBatchResult> {
    const current = await this.liveInvestigation(investigationId);
    this.assertLiveWritable(current);
    if (!locked && current.schemaVersion === 2) {
      return this.withInvestigationLock(investigationId, () =>
        this.updateHypotheses(investigationId, mutations, true),
      );
    }
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
          reject(mutation, "DUPLICATE_ID", `Hypothesis ${requestedId} already exists`, requestedId);
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
      if (mutation.nextChecks)
        existing.nextChecks = mutation.nextChecks.filter(Boolean).slice(0, 10);
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
  ): Promise<AgenticDispatchResult> {
    const investigation = await this.liveInvestigation(investigationId);
    this.assertLiveWritable(investigation);
    this.assertRunning(investigation);
    if (briefs.some((brief) => brief.role === "event-topology")) {
      throw new Error("unsupported: Live Investigation only supports trace/log/metrics experts");
    }
    return this.dispatchAgenticV2(investigationId, briefs, options);
  }

  private async withInvestigationLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.investigationLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.investigationLocks.set(id, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.investigationLocks.get(id) === current) this.investigationLocks.delete(id);
    }
  }

  private async updateV2<T>(id: string, mutation: (draft: Investigation) => T): Promise<T> {
    return this.withInvestigationLock(id, async () => {
      const live = await this.liveInvestigation(id);
      const draft = structuredClone(live);
      const result = mutation(draft);
      foldBudget(draft);
      try {
        await this.saveInvestigation(draft);
      } catch (error) {
        // A write may fail after rename. Reloading avoids an in-memory view that
        // disagrees with the durable version; operation replay then decides.
        try {
          Object.assign(live, await this.repository.get(id));
        } catch {
          /* Preserve the original storage error. */
        }
        throw error;
      }
      Object.assign(live, draft);
      return result;
    });
  }

  private dispatchAgenticV2(
    id: string,
    briefs: InvestigationBrief[],
    options: AgenticDispatchOptions,
  ): Promise<AgenticDispatchResult> {
    const operationId = options.dispatchOperationId ?? randomUUID();
    const hash = createHash("sha256")
      .update(JSON.stringify({ briefs, model: options.model }))
      .digest("hex");
    const key = `${id}:${operationId}`;
    const active = this.dispatchPromises.get(key);
    if (active) {
      if (active.hash !== hash)
        return Promise.reject(new Error(`Conflicting dispatch operation ${operationId}`));
      return active.promise;
    }

    const promise = this.dispatchAgenticV2Prepared(id, briefs, options, operationId, hash);
    this.dispatchPromises.set(key, { hash, promise });
    void promise.then(
      () => {
        if (this.dispatchPromises.get(key)?.promise === promise) this.dispatchPromises.delete(key);
      },
      () => {
        if (this.dispatchPromises.get(key)?.promise === promise) this.dispatchPromises.delete(key);
      },
    );
    return promise;
  }

  private async dispatchAgenticV2Prepared(
    id: string,
    briefs: InvestigationBrief[],
    options: AgenticDispatchOptions,
    operationId: string,
    hash: string,
  ): Promise<AgenticDispatchResult> {
    if (!briefs.length || briefs.length > 3) throw new Error("Dispatch requires 1–3 briefs");

    const reservation = await this.updateV2(id, (draft) => {
      this.assertRunning(draft);
      const folded = foldBudget(draft);
      const existing = folded.operations.get(operationId);
      if (existing) {
        if (existing.requestHash !== hash)
          throw new Error(`Conflicting dispatch operation ${operationId}`);
        return { taskIds: existing.taskIds, created: false };
      }
      const known = new Set(draft.hypotheses.map((item) => item.id));
      for (const brief of briefs) {
        if (
          !brief.question.trim() ||
          !brief.expected.length ||
          !brief.hypothesisIds.length ||
          brief.hypothesisIds.some((hypothesisId) => !known.has(hypothesisId))
        ) {
          throw new Error("Invalid dispatch brief or hypothesis reference");
        }
        const baseline = brief.context.baselineWindow;
        const main = brief.context.mainWindow;
        if (
          baseline &&
          (!Number.isFinite(Date.parse(baseline.from)) ||
            !Number.isFinite(Date.parse(baseline.to)) ||
            !Number.isFinite(Date.parse(main.from)) ||
            !Number.isFinite(Date.parse(main.to)) ||
            Date.parse(baseline.from) > Date.parse(baseline.to) ||
            Date.parse(main.from) > Date.parse(main.to) ||
            (Date.parse(baseline.to) > Date.parse(main.from) &&
              Date.parse(baseline.from) < Date.parse(main.to)))
        ) {
          throw new Error("Brief baselineWindow overlaps or invalidates mainWindow");
        }
      }
      const primaryCount = briefs.filter((brief) => !brief.recoveryOfTaskId).length;
      const recoveryCount = briefs.length - primaryCount;
      if (primaryCount > folded.projection.primary.remaining)
        throw new Error("Primary Budget exhausted");
      if (recoveryCount > folded.projection.recovery.remaining)
        throw new Error("Recovery Budget exhausted");
      if (
        folded.projection.safety.taskIntents + briefs.length >
        RCA_BUDGET_POLICY.safety.maxTaskIntents
      ) {
        throw new Error("Investigation operational safety limit reached: task intents");
      }
      if (
        folded.projection.safety.startedTasks + briefs.length >
        RCA_BUDGET_POLICY.safety.maxStartedTasks
      ) {
        throw new Error("Investigation operational safety limit reached: started tasks");
      }
      const sources = new Set<string>();
      for (const brief of briefs) {
        const sourceId = brief.recoveryOfTaskId;
        if (!sourceId) {
          if (
            draft.expertTasks.some(
              (task) =>
                task.recoveryEligible && JSON.stringify(task.brief) === JSON.stringify(brief),
            )
          ) {
            throw new Error(
              "A failed Primary cannot be replayed as a new Primary; reference recoveryOfTaskId",
            );
          }
          continue;
        }
        const source = draft.expertTasks.find((item) => item.id === sourceId);
        if (
          !source ||
          source.status !== "failed" ||
          source.budgetClass !== "primary" ||
          !source.recoveryEligible ||
          source.expert !== brief.role ||
          sources.has(sourceId) ||
          folded.recoveredTaskIds.has(sourceId)
        ) {
          throw new Error(`Task ${sourceId} is not eligible for Recovery`);
        }
        sources.add(sourceId);
      }
      const ids: string[] = [];
      for (const brief of briefs) {
        const taskId = this.nextTaskId(draft);
        const reservationId = randomUUID();
        const budgetClass = brief.recoveryOfTaskId ? "recovery" : "primary";
        const task: ExpertTask = {
          id: taskId,
          expert: brief.role,
          objective: brief.question.trim().slice(0, 1000),
          status: "pending",
          hypothesisIds: [...new Set(brief.hypothesisIds)],
          toolCallIds: [],
          evidenceIds: [],
          brief,
          implementation: "pi-session",
          createdAt: now(),
          budgetClass,
          budgetReservationId: reservationId,
          dispatchOperationId: operationId,
          taskGeneration: 0,
          ...(brief.recoveryOfTaskId ? { recoveryOfTaskId: brief.recoveryOfTaskId } : {}),
        };
        draft.expertTasks.push(task);
        appendLedgerEvent(
          draft,
          nextLedgerEvent(draft, {
            type: "budget.reserved",
            reservationId,
            dispatchOperationId: operationId,
            requestHash: hash,
            taskId,
            budgetClass,
            ...(brief.recoveryOfTaskId ? { recoveryOfTaskId: brief.recoveryOfTaskId } : {}),
          }),
        );
        appendLedgerEvent(
          draft,
          nextLedgerEvent(draft, {
            type: "safety.consumed",
            executionId: taskId,
            resource: "task_intent",
          }),
        );
        ids.push(taskId);
      }
      draft.rounds++;
      return { taskIds: ids, created: true };
    });

    // A replay after restart reports persisted work but never starts an old session.
    const investigation = await this.liveInvestigation(id);
    const { taskIds } = reservation;
    const alreadyStarted = taskIds.some(
      (taskId) =>
        investigation.expertTasks.find((task) => task.id === taskId)?.status !== "pending",
    );
    if (!reservation.created || alreadyStarted) {
      return {
        findings: taskIds.map((taskId) => this.persistedFinding(investigation, taskId)),
        interrupted: true,
        budget: foldBudget(investigation, this.runtimeSlots.get(id)?.running ?? 0).projection,
      };
    }
    const running = this.agenticRunning.get(id);
    if (!running) throw new Error("Agentic investigation is not active");
    const controller = new AbortController();
    running.activeDispatchControllers ??= new Set();
    running.activeDispatchControllers.add(controller);
    const signal = AbortSignal.any([running.controller.signal, controller.signal]);
    const releaseOperation = this.trackAgenticOperation(id);
    const bus = await this.busFor(id);
    return (async (): Promise<AgenticDispatchResult> => {
      try {
        const results = await Promise.all(
          taskIds.map((taskId) => this.runTaskV2(id, taskId, options, bus, signal)),
        );
        const interrupted = signal.aborted;
        await bus.publish(
          "round.completed",
          interrupted ? "Agentic batch interrupted." : "Agentic batch completed.",
          {
            taskRefs: taskIds,
            evidenceIds: results.flatMap((result) => result.evidenceIds),
            interrupted,
          },
        );
        return {
          findings: results,
          interrupted,
          budget: foldBudget(
            await this.liveInvestigation(id),
            this.runtimeSlots.get(id)?.running ?? 0,
          ).projection,
        };
      } finally {
        running.activeDispatchControllers?.delete(controller);
        releaseOperation();
      }
    })();
  }

  private persistedFinding(investigation: Investigation, taskId: string): DispatchedFinding {
    const task = investigation.expertTasks.find((item) => item.id === taskId)!;
    return {
      taskRef: task.id,
      role: task.expert,
      status: task.status,
      finding: task.finding ?? {
        status: "inconclusive",
        strength: "inconclusive",
        summary: `Task ${task.id} ${task.status}`,
        conclusions: [],
        evidenceClaims: [],
        candidateEntities: [],
        suggestedFollowUps: [],
      },
      evidenceIds: [...task.evidenceIds],
      observationIds: (investigation.observations ?? [])
        .filter((item) => item.expertTaskId === task.id)
        .map((item) => item.id),
      ...(task.termination ? { termination: task.termination.reason } : {}),
      ...(task.diagnostics ? { diagnostics: task.diagnostics } : {}),
    };
  }

  private async runTaskV2(
    id: string,
    taskId: string,
    options: AgenticDispatchOptions,
    bus: InvestigationEventBus,
    signal: AbortSignal,
  ): Promise<DispatchedFinding> {
    const slots =
      this.runtimeSlots.get(id) ?? new AbortableSemaphore(RCA_BUDGET_POLICY.maxParallelTasks);
    this.runtimeSlots.set(id, slots);
    let releaseLocal: (() => void) | undefined;
    let releaseGlobal: (() => void) | undefined;
    try {
      releaseLocal = await slots.acquire(signal);
      releaseGlobal = await this.globalRuntimeSlots.acquire(signal);
      const started = await this.updateV2(id, (draft) => {
        const task = draft.expertTasks.find((item) => item.id === taskId)!;
        if (signal.aborted || draft.status !== "running" || task.status !== "pending") return false;
        const used = foldBudget(draft).projection.safety.startedTasks;
        if (used >= RCA_BUDGET_POLICY.safety.maxStartedTasks)
          throw new Error("Investigation operational safety limit reached: started tasks");
        task.status = "running";
        appendLedgerEvent(
          draft,
          nextLedgerEvent(draft, {
            type: "safety.consumed",
            executionId: task.id,
            resource: "started_task",
          }),
        );
        return true;
      });
      if (!started) return this.persistedFinding(await this.liveInvestigation(id), taskId);

      const investigation = await this.liveInvestigation(id);
      const task = investigation.expertTasks.find((item) => item.id === taskId)!;
      await bus.publish("expert.started", `${task.expert} investigating: ${task.objective}`, {
        expertTask: task,
        source: "main-agent-dispatch",
      });
      const rcaTask: RcaTask = {
        version: "live-v1",
        context: investigation.context!,
        availableModalities: ["metric", "log", "trace"],
      };
      const run = await this.requireExpertRunner().run({
        investigation,
        task: rcaTask,
        brief: task.brief!,
        model: options.model,
        signal,
        invoke: (tool, args) => this.invokeRecordedToolV2(id, taskId, bus, tool, args, signal),
        onThinking: (delta) =>
          bus
            .publish("expert.thinking.delta", "", { expertTaskId: taskId, delta })
            .then(() => undefined),
      });
      return await this.finishTaskV2(id, taskId, bus, { run }, signal);
    } catch (error) {
      return await this.finishTaskV2(id, taskId, bus, { error }, signal);
    } finally {
      // The slot remains held until the runner's Promise and its finally/dispose
      // have settled, regardless of when the semantic reservation was released.
      releaseGlobal?.();
      releaseLocal?.();
    }
  }

  private async finishTaskV2(
    id: string,
    taskId: string,
    bus: InvestigationEventBus,
    outcome: { run?: Awaited<ReturnType<PiExpertRunner["run"]>>; error?: unknown },
    signal: AbortSignal,
  ): Promise<DispatchedFinding> {
    const acceptedIds = await this.updateV2(id, (draft) => {
      const task = draft.expertTasks.find((item) => item.id === taskId)!;
      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled")
        return [];
      const createdEvidence: string[] = [];
      const cancelled =
        signal.aborted ||
        draft.status !== "running" ||
        outcome.run?.termination?.reason === "aborted" ||
        (outcome.error !== undefined && isAbortError(outcome.error));
      const run = outcome.run;
      if (run) {
        task.sessionId = run.sessionId;
        task.diagnostics = run.diagnostics;
        task.usage = run.usage;
        task.termination = cancelled ? { reason: "aborted" } : run.termination;
      }
      if (
        run &&
        !cancelled &&
        (!run.termination || run.termination.reason === "completed") &&
        run.finding
      ) {
        let finding = run.finding;
        const validHypotheses = new Set(draft.hypotheses.map((item) => item.id));
        const taskCalls = new Set(task.toolCallIds);
        for (const claim of finding.evidenceClaims) {
          if (!taskCalls.has(claim.toolCallId)) continue;
          const call = draft.toolCalls.find((item) => item.id === claim.toolCallId);
          if (!call || call.status !== "completed") continue;
          const evidence: Evidence = {
            id: this.nextEvidenceId(draft),
            investigationId: draft.id,
            modality: claim.modality,
            ...(claim.entity ? { entity: claim.entity } : {}),
            timeRange: draft.context!.window,
            summary: claim.summary,
            ...(call.rawRef ? { rawRef: call.rawRef } : {}),
            ...(call.snapshotRef ? { snapshotRef: call.snapshotRef } : {}),
            supports: claim.supports.filter((ref) => validHypotheses.has(ref)),
            contradicts: claim.contradicts.filter((ref) => validHypotheses.has(ref)),
            sourceQuery: call.query,
            toolCallId: call.id,
            expertTaskId: task.id,
            facts: { source: "pi-child-session", findingStrength: finding.strength },
            createdAt: now(),
          };
          draft.evidence.push(evidence);
          task.evidenceIds.push(evidence.id);
          createdEvidence.push(evidence.id);
        }
        if (
          !createdEvidence.length &&
          (finding.strength === "strong" || finding.strength === "moderate")
        ) {
          finding = {
            ...finding,
            status: finding.status === "blocked" ? "blocked" : "inconclusive",
            strength: "inconclusive",
            summary: `${finding.summary} No valid tool-backed evidence claim was accepted.`,
          };
        }
        for (const entity of finding.candidateEntities) {
          if (!draft.scope.candidateEntities.includes(entity))
            draft.scope.candidateEntities.push(entity);
        }
        task.finding = finding;
        // A completed execution with finding.status=failed is still an attempted Primary.
        task.status = "completed";
      } else {
        const error = outcome.error;
        if (error instanceof PiExpertRunError) {
          task.diagnostics = error.diagnostics;
          task.sessionId = error.sessionId;
          if (error.usage) task.usage = error.usage;
          task.termination = error.termination ?? {
            reason: cancelled
              ? "aborted"
              : error.providerTransient
                ? "provider_error"
                : error.diagnostics.failureReason === "json_invalid" ||
                    error.diagnostics.failureReason === "json_missing" ||
                    error.diagnostics.failureReason === "finding_invalid" ||
                    error.diagnostics.failureReason === "finding_missing"
                  ? "invalid_output"
                  : "runtime_error",
            detail: safeRuntimeDetail(error),
          };
        }
        task.termination ??= {
          reason: cancelled ? "aborted" : "runtime_error",
          detail: safeRuntimeDetail(error ?? "Expert did not start"),
        };
        task.status = cancelled ? "cancelled" : "failed";
        task.terminationReason = cancelled
          ? "user_superseded"
          : run?.termination.providerTransient ||
              (error instanceof PiExpertRunError && error.providerTransient)
            ? "provider_transient_error"
            : task.termination.reason === "invalid_output"
              ? "invalid_output"
              : "unknown";
        task.finding = {
          status: "failed",
          strength: "inconclusive",
          verdict: "inconclusive",
          summary: cancelled
            ? "Dispatch superseded or investigation cancelled."
            : (task.termination.detail ?? safeRuntimeDetail(error ?? "Expert did not start")),
          conclusions: [],
          evidenceClaims: [],
          candidateEntities: [],
          suggestedFollowUps: [],
        };
      }
      task.completedAt = now();
      const folded = foldBudget(draft);
      const reservation = folded.reservations.get(task.budgetReservationId!);
      if (!reservation || reservation.terminal)
        throw new Error(`Missing open reservation for ${taskId}`);
      const started = (draft.budgetLedger ?? []).some(
        (event) =>
          event.type === "safety.consumed" &&
          event.resource === "started_task" &&
          event.executionId === task.id,
      );
      const hadWork =
        draft.toolCalls.some(
          (call) => call.expertTaskId === task.id && call.status === "completed",
        ) || (draft.observations ?? []).some((item) => item.expertTaskId === task.id);
      task.recoveryEligible =
        task.budgetClass === "primary" &&
        started &&
        !hadWork &&
        task.terminationReason === "provider_transient_error";
      const disposition =
        cancelled || !started || task.recoveryEligible ? "budget.released" : "budget.committed";
      appendLedgerEvent(
        draft,
        nextLedgerEvent(draft, {
          type: disposition,
          reservationId: task.budgetReservationId!,
          taskId: task.id,
          budgetClass: task.budgetClass!,
          reason: task.terminationReason ?? task.finding?.status ?? "completed",
        }),
      );
      return createdEvidence;
    });
    const persisted = await this.liveInvestigation(id);
    const result = this.persistedFinding(persisted, taskId);
    for (const evidenceId of acceptedIds) {
      const evidence = persisted.evidence.find((item) => item.id === evidenceId)!;
      await bus.publish("evidence.created", evidence.summary, { evidence, expertTaskId: taskId });
    }
    await bus.publish(
      "expert.completed",
      `${result.role} ${result.status}: ${result.finding.summary}`,
      {
        expertTask: persisted.expertTasks.find((item) => item.id === taskId),
        finding: result.finding,
      },
    );
    return result;
  }

  async concludeAgentic(
    investigationId: string,
    result: AgenticConclusionInput,
    locked = false,
  ): Promise<{ investigation: Investigation; report: string }> {
    if (!locked && (await this.liveInvestigation(investigationId)).schemaVersion === 2) {
      return this.withInvestigationLock(investigationId, () =>
        this.concludeAgentic(investigationId, result, true),
      );
    }
    const investigation = await this.liveInvestigation(investigationId);
    if (investigation.schemaVersion === 2) {
      this.assertRunning(investigation);
      if (
        investigation.expertTasks.some(
          (task) => task.status === "pending" || task.status === "running",
        ) ||
        [...foldBudget(investigation).reservations.values()].some(
          (reservation) => !reservation.terminal,
        ) ||
        this.runtimeSlots.get(investigationId)?.running
      ) {
        throw new Error("Cannot conclude while Specialist work or reservations remain active");
      }
    }
    this.assertConcludable(investigation);
    const bus = await this.busFor(investigationId);
    const evidenceIds = new Set(investigation.evidence.map((item) => item.id));
    const hypothesisIds = new Set(investigation.hypotheses.map((item) => item.id));

    for (const evidenceId of result.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        throw new Error(`Conclusion references unknown evidence ${evidenceId}`);
      }
    }

    const conclusionEvidenceIds = new Set(result.evidenceIds);
    const causalEvidenceGroups = [
      ["temporalEvidenceIds", result.causalAssessment.temporalEvidenceIds],
      ["transitionEvidenceIds", result.causalAssessment.transitionEvidenceIds],
      ["propagationEvidenceIds", result.causalAssessment.propagationEvidenceIds],
      ["gapBridgeEvidenceIds", result.causalAssessment.gapBridgeEvidenceIds],
    ] as const;
    for (const [field, ids] of causalEvidenceGroups) {
      for (const evidenceId of ids) {
        if (!evidenceIds.has(evidenceId)) {
          throw new Error(`causalAssessment.${field} references unknown evidence ${evidenceId}`);
        }
        if (!conclusionEvidenceIds.has(evidenceId)) {
          throw new Error(
            `causalAssessment.${field} evidence ${evidenceId} must also appear in evidenceIds`,
          );
        }
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
      (id) => Number(selected.has(id)) + Number(rejected.has(id)) + Number(unresolved.has(id)) > 1,
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
      throw new Error(`Conclusion leaves hypotheses unaccounted for: ${unaccounted.join(", ")}`);
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
        throw new Error(`Rejected hypothesis ${id} must be marked rejected before conclusion`);
      }
    }
    for (const item of result.unresolvedHypotheses) {
      const hypothesis = investigation.hypotheses.find((candidate) => candidate.id === item.id)!;
      if (hypothesis.status === "rejected" || hypothesis.status === "confirmed") {
        throw new Error(`Unresolved hypothesis ${item.id} cannot already be ${hypothesis.status}`);
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
    const temporalEvidence = [...new Set(result.causalAssessment.temporalEvidenceIds)];
    const transitionEvidence = [...new Set(result.causalAssessment.transitionEvidenceIds)];
    const propagationEvidence = [...new Set(result.causalAssessment.propagationEvidenceIds)];
    const gapBridgeEvidence = [...new Set(result.causalAssessment.gapBridgeEvidenceIds)];

    if (result.causalAssessment.temporalFit !== "uncertain" && temporalEvidence.length === 0) {
      throw new Error("A non-uncertain temporal fit must cite temporal evidence");
    }
    if (
      result.causalAssessment.temporalFit === "pre_existing_explained" &&
      transitionEvidence.length === 0
    ) {
      throw new Error("pre_existing_explained requires independent transition/trigger evidence");
    }
    if (
      result.causalAssessment.propagationFit === "supported" &&
      propagationEvidence.length === 0
    ) {
      throw new Error("Supported propagation must cite propagation evidence");
    }
    if (
      result.causalAssessment.materialUnobservedGap &&
      result.causalAssessment.propagationFit === "supported" &&
      gapBridgeEvidence.length === 0
    ) {
      throw new Error(
        "Supported propagation across a material unobserved gap requires gap-bridge evidence",
      );
    }
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
        temporalEvidenceIds: temporalEvidence,
        transitionEvidenceIds: transitionEvidence,
        propagationEvidenceIds: propagationEvidence,
        gapBridgeEvidenceIds: gapBridgeEvidence,
      },
    };
    investigation.status =
      investigation.rootCause.status === "inconclusive" ? "inconclusive" : "completed";
    investigation.completedAt = now();
    const report = this.renderReport(investigation);
    await this.saveInvestigation(investigation);
    await this.repository.saveReport(investigationId, investigation.rootCause, report);
    const visualizationConversationId = this.agenticRunning.get(investigationId)?.conversationId;
    await bus.publish(
      "investigation.completed",
      `RCA ${investigation.rootCause.status}: ${investigation.rootCause.summary}`,
      { result: investigation.rootCause, source: "main-agent" },
    );
    try {
      await this.visualizationService.enqueue(
        investigationId,
        visualizationConversationId,
      );
    } catch (error) {
      process.stderr.write(
        `Failed to enqueue RCA visualization for ${investigationId}: ${String(error)}\n`,
      );
    }
    this.cleanupAgentic(investigationId);
    return { investigation, report };
  }

  async recordUserIntervention(
    investigationId: string,
    content: string,
  ): Promise<InvestigationUserIntervention | undefined> {
    const investigation = await this.liveInvestigation(investigationId);
    if (investigation.schemaVersion === 2) {
      const cleaned = content.trim().slice(0, 4000);
      if (!cleaned) return undefined;
      const intervention = await this.updateV2(investigationId, (draft) => {
        if (draft.status !== "running") return undefined;
        const item: InvestigationUserIntervention = {
          id: this.nextUserInterventionId(draft),
          content: cleaned,
          createdAt: now(),
        };
        draft.userInterventions ??= [];
        draft.userInterventions.push(item);
        for (const task of draft.expertTasks) {
          if (task.status !== "running" && task.status !== "pending") continue;
          task.status = "cancelled";
          task.completedAt = now();
          task.taskGeneration = (task.taskGeneration ?? 0) + 1;
          task.terminationReason = "user_superseded";
          task.termination = { reason: "aborted" };
          const reservation = foldBudget(draft).reservations.get(task.budgetReservationId ?? "");
          if (reservation && !reservation.terminal) {
            appendLedgerEvent(
              draft,
              nextLedgerEvent(draft, {
                type: "budget.released",
                reservationId: task.budgetReservationId!,
                taskId: task.id,
                budgetClass: task.budgetClass!,
                reason: "user_superseded",
              }),
            );
          }
        }
        return item;
      });
      if (!intervention) return undefined;
      this.interruptActiveDispatch(investigationId);
      const bus = await this.busFor(investigationId);
      await bus.publish("user.intervention", "User supplied additional investigation context.", {
        intervention,
        source: "user",
      });
      return intervention;
    }
    if (investigation.status !== "running") return undefined;

    const cleanedContent = content.trim().slice(0, 4000);
    if (!cleanedContent) return undefined;

    const intervention: InvestigationUserIntervention = {
      id: this.nextUserInterventionId(investigation),
      content: cleanedContent,
      createdAt: now(),
    };
    investigation.userInterventions ??= [];
    investigation.userInterventions.push(intervention);
    await this.saveInvestigation(investigation);

    const bus = await this.busFor(investigationId);
    await bus.publish("user.intervention", "User supplied additional investigation context.", {
      intervention,
      source: "user",
    });
    return intervention;
  }

  interruptActiveDispatch(investigationId: string): boolean {
    const running = this.agenticRunning.get(investigationId);
    if (running?.activeDispatchControllers?.size) {
      let interrupted = false;
      for (const controller of running.activeDispatchControllers) {
        if (!controller.signal.aborted) {
          controller.abort();
          interrupted = true;
        }
      }
      return interrupted;
    }
    const controller = running?.activeDispatchController;
    if (!controller || controller.signal.aborted) return false;
    controller.abort();
    return true;
  }

  get(investigationId: string): Promise<Investigation> {
    return this.repository.get(investigationId);
  }

  getBudgetProjection(investigation: Investigation): BudgetProjection {
    return foldBudget(investigation, this.runtimeSlots.get(investigation.id)?.running ?? 0)
      .projection;
  }

  getReport(investigationId: string): Promise<string> {
    return this.repository.getReport(investigationId);
  }

  getVisualization(investigationId: string): Promise<InvestigationVisualizationArtifact> {
    return this.visualizationService.getOrCreate(investigationId);
  }

  regenerateVisualization(
    investigationId: string,
  ): Promise<InvestigationVisualizationArtifact> {
    return this.visualizationService.regenerate(investigationId);
  }

  subscribeVisualization(
    listener: (event: InvestigationVisualizationEvent) => void | Promise<void>,
  ): () => void {
    return this.visualizationService.subscribe(listener);
  }

  recoverVisualizations(): Promise<string[]> {
    return this.visualizationService.recoverPending();
  }

  waitForVisualizationIdle(investigationId?: string): Promise<void> {
    return this.visualizationService.waitForIdle(investigationId);
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
    await Promise.all(matches.map(([id, running]) => this.requestAgenticCancellation(id, running)));
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
      if (running.investigation?.schemaVersion !== 2) running.controller.abort();
    }
    await running.cancellationPromise;
    if (running.activeOperations === 0) {
      this.cleanupAgentic(investigationId);
    }
  }

  private assertRunning(investigation: Investigation): void {
    if (investigation.status !== "running") {
      throw new Error(`Investigation ${investigation.id} is ${investigation.status}, not running`);
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
    const initializing = this.eventBusInitializations.get(investigationId);
    if (initializing) return initializing;
    const promise = (async () => {
      const events = await this.repository.listEvents(investigationId);
      const bus = new InvestigationEventBus(
        investigationId,
        this.repository,
        (events.at(-1)?.id ?? 0) + 1,
      );
      this.eventBuses.set(investigationId, bus);
      return bus;
    })();
    this.eventBusInitializations.set(investigationId, promise);
    try {
      return await promise;
    } finally {
      this.eventBusInitializations.delete(investigationId);
    }
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
    _investigation: Investigation,
    kind: RcaOverviewKind,
    query: Record<string, unknown>,
  ): { tool: ObservabilityToolName; arguments_: Record<string, unknown> } {
    switch (kind) {
      case "metrics":
        return {
          tool: typeof query.metric === "string" ? "query_metrics" : "discover_metrics",
          arguments_: { ...query },
        };
      case "traces":
        return {
          tool: "search_traces",
          arguments_: {
            ...query,
            limit: Math.min(Number(query.limit ?? 20), 50),
          },
        };
      case "logs":
        return {
          tool: "search_logs",
          arguments_: {
            ...query,
            limit: Math.min(Number(query.limit ?? 100), 200),
          },
        };
    }
  }

  private async invokeRecordedToolV2(
    id: string,
    taskId: string | undefined,
    bus: InvestigationEventBus,
    tool: ObservabilityToolName,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<RecordedAgentToolExecution> {
    const investigation = await this.liveInvestigation(id);
    this.assertLiveWritable(investigation);
    const prepared = this.requireAgenticTools().prepare(tool, arguments_, investigation);
    const callId = await this.updateV2(id, (draft) => {
      const task = taskId ? draft.expertTasks.find((item) => item.id === taskId) : undefined;
      if (signal?.aborted || draft.status !== "running" || (taskId && task?.status !== "running")) {
        throw new DOMException("Task superseded", "AbortError");
      }
      if (
        foldBudget(draft).projection.safety.toolExecutions >=
        RCA_BUDGET_POLICY.safety.maxUnderlyingToolCalls
      ) {
        throw new Error("Investigation operational safety limit reached: tool executions");
      }
      if (prepared.scopeExtension) {
        draft.scope.extensions ??= [];
        const extension = {
          ...(prepared.scopeExtension.target
            ? { target: structuredClone(prepared.scopeExtension.target) }
            : {}),
          ...(prepared.scopeExtension.window
            ? { window: structuredClone(prepared.scopeExtension.window) }
            : {}),
          reason: prepared.scopeExtension.reason,
          createdAt: now(),
        };
        const duplicate = draft.scope.extensions.some(
          (item) =>
            item.reason === extension.reason &&
            JSON.stringify(item.target ?? {}) === JSON.stringify(extension.target ?? {}) &&
            JSON.stringify(item.window ?? {}) === JSON.stringify(extension.window ?? {}),
        );
        if (!duplicate) draft.scope.extensions.push(extension);
      }
      const call: ToolCallRecord = {
        id: this.nextToolId(draft),
        ...(taskId ? { expertTaskId: taskId } : {}),
        tool,
        query: prepared.arguments,
        status: "running",
        startedAt: now(),
        runtime: { before: runtimeResourceSnapshot() },
      };
      draft.toolCalls.push(call);
      task?.toolCallIds.push(call.id);
      appendLedgerEvent(
        draft,
        nextLedgerEvent(draft, {
          type: "safety.consumed",
          executionId: call.id,
          resource: "tool_execution",
        }),
      );
      return call.id;
    });

    const persistedStart = await this.liveInvestigation(id);
    await bus.publish("tool.started", `${tool} started.`, {
      toolCall: persistedStart.toolCalls.find((item) => item.id === callId),
    });

    try {
      const execution = await this.requireAgenticTools().executePrepared(id, prepared, signal);
      checkCancelled(signal);
      const agentContextResult = compactToolResultForAgent(tool, execution.result);
      const snapshotRef = await this.repository.saveEvidenceSnapshot(id, callId, {
        formatVersion: 1,
        investigationId: id,
        toolCallId: callId,
        tool,
        query: execution.arguments,
        timeRange: execution.actualWindow,
        retrievedAt: execution.result.retrievedAt,
        backendAlias: execution.backendAlias,
        contractVersion: execution.result.contractVersion,
        resultStatus: execution.resultStatus,
        result: execution.result,
        agentResult: agentContextResult,
      });
      checkCancelled(signal);

      const observationId = await this.updateV2(id, (draft) => {
        const task = taskId ? draft.expertTasks.find((item) => item.id === taskId) : undefined;
        const call = draft.toolCalls.find((item) => item.id === callId)!;
        if (
          signal?.aborted ||
          draft.status !== "running" ||
          (taskId && task?.status !== "running") ||
          call.status !== "running"
        ) {
          throw new DOMException("Late tool result discarded", "AbortError");
        }
        call.status = "completed";
        call.resultSummary = execution.summary;
        call.rawRef = execution.rawRef;
        call.snapshotRef = snapshotRef;
        call.resultStatus = execution.resultStatus;
        call.completedAt = now();
        if (call.runtime) call.runtime.after = runtimeResourceSnapshot();
        const observation: Observation = {
          id: this.nextObservationId(draft),
          investigationId: draft.id,
          modality: toolModality(tool),
          toolCallId: callId,
          ...(taskId ? { expertTaskId: taskId } : {}),
          summary: observationSummary(tool, execution),
          ...(execution.rawRef ? { rawRef: execution.rawRef } : {}),
          snapshotRef,
          facts: {
            source: taskId ? "pi-child-session" : "main-agent-overview",
            resultStatus: execution.resultStatus,
            backendAlias: execution.backendAlias,
            warnings: execution.result.warnings.slice(0, 10),
            truncationReasons: execution.result.truncationReasons.slice(0, 10),
          },
          createdAt: now(),
        };
        draft.observations ??= [];
        draft.observations.push(observation);
        return observation.id;
      });
      const persisted = await this.liveInvestigation(id);
      const completedCall = persisted.toolCalls.find((item) => item.id === callId)!;
      await this.repository.appendToolCall(id, completedCall).catch((error) => {
        process.stderr.write(
          `RCA tool-call projection append failed for ${id}/${callId}: ${String(error)}\n`,
        );
      });
      await bus.publish("tool.completed", `${tool} completed: ${execution.summary}.`, {
        toolCall: completedCall,
        agentContextResult,
      });
      await bus.publish("observation.created", execution.summary, {
        observation: (persisted.observations ?? []).find((item) => item.id === observationId),
      });
      return {
        callId,
        observationId,
        execution: {
          result: execution.result,
          summary: execution.summary,
          rawRef: execution.rawRef,
          snapshotRef,
          resultStatus: execution.resultStatus,
          actualWindow: execution.actualWindow,
          query: execution.arguments,
        },
      };
    } catch (error) {
      await this.updateV2(id, (draft) => {
        const call = draft.toolCalls.find((item) => item.id === callId)!;
        if (call.status !== "running") return;
        call.status =
          signal?.aborted || isAbortError(error) || draft.status !== "running"
            ? "cancelled"
            : "failed";
        call.completedAt = now();
        call.error = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
        if (call.runtime) call.runtime.after = runtimeResourceSnapshot();
      });
      const failed = await this.liveInvestigation(id);
      const failedCall = failed.toolCalls.find((item) => item.id === callId);
      if (failedCall) {
        await this.repository.appendToolCall(id, failedCall).catch(() => undefined);
      }
      throw error;
    }
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

  private nextUserInterventionId(investigation: Investigation): string {
    return `UI${String((investigation.userInterventions?.length ?? 0) + 1).padStart(2, "0")}`;
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
            `- Temporal evidence: ${result.causalAssessment.temporalEvidenceIds?.join(", ") || "none"}`,
            `- Transition evidence: ${result.causalAssessment.transitionEvidenceIds?.join(", ") || "none"}`,
            `- Propagation fit: ${result.causalAssessment.propagationFit}`,
            `- Propagation evidence: ${result.causalAssessment.propagationEvidenceIds?.join(", ") || "none"}`,
            `- Material unobserved gap: ${result.causalAssessment.materialUnobservedGap ?? false}`,
            `- Gap-bridge evidence: ${result.causalAssessment.gapBridgeEvidenceIds?.join(", ") || "none"}`,
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
                item.missingEvidence?.length ? ` (missing: ${item.missingEvidence.join("; ")})` : ""
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
    if (investigation.schemaVersion === 2) {
      const cancelled = await this.updateV2(investigationId, (draft) => {
        if (draft.status !== "running") return false;
        draft.status = "cancelled";
        draft.completedAt = now();
        draft.error = "Investigation cancelled";
        for (const task of draft.expertTasks) {
          if (task.status !== "running" && task.status !== "pending") continue;
          task.status = "cancelled";
          task.completedAt = now();
          task.taskGeneration = (task.taskGeneration ?? 0) + 1;
          task.terminationReason = "investigation_cancelled";
          task.termination = { reason: "aborted" };
          const reservation = foldBudget(draft).reservations.get(task.budgetReservationId ?? "");
          if (reservation && !reservation.terminal)
            appendLedgerEvent(
              draft,
              nextLedgerEvent(draft, {
                type: "budget.released",
                reservationId: task.budgetReservationId!,
                taskId: task.id,
                budgetClass: task.budgetClass!,
                reason: "investigation_cancelled",
              }),
            );
        }
        for (const call of draft.toolCalls) {
          if (call.status !== "running") continue;
          call.status = "cancelled";
          call.completedAt = now();
          call.error = "Investigation cancelled";
        }
        return true;
      });
      running.controller.abort();
      this.interruptActiveDispatch(investigationId);
      if (cancelled)
        await (
          await this.busFor(investigationId)
        ).publish("investigation.cancelled", "Investigation cancelled.", { source: "user" });
      return;
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
      task.termination = { reason: "aborted" };
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
    if (this.runtimeSlots.get(investigationId)?.running === 0) {
      this.runtimeSlots.delete(investigationId);
    }
  }
}
