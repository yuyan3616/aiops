import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  InvestigationEventBus,
  type InvestigationEventListener,
} from "./events";
import {
  createInvestigationId,
  RcaOrchestrator,
  type InvestigationRunResult,
} from "./orchestrator";
import {
  PiExpertRunner,
  type RecordedAgentToolExecution,
} from "./pi-expert";
import { InvestigationRepository } from "./repository";
import {
  ObservabilityToolRegistry,
  type ObservabilityToolName,
  type ToolExecution,
} from "./tools";
import type {
  AgentExpertFinding,
  Evidence,
  EvidenceModality,
  ExpertTask,
  Hypothesis,
  HypothesisStatus,
  Investigation,
  InvestigationBrief,
  RCAResult,
  RcaTask,
  ToolCallRecord,
} from "./types";

export interface StartInvestigationOptions {
  conversationId?: string;
  onEvent?: InvestigationEventListener;
  onCompleted?: (investigation: Investigation, report: string) => void | Promise<void>;
  onFailed?: (error: Error) => void | Promise<void>;
}

export interface InvestigationRunHandle {
  investigationId: string;
  promise: Promise<InvestigationRunResult>;
}

interface RunningInvestigation {
  conversationId?: string;
  controller: AbortController;
  promise: Promise<InvestigationRunResult>;
}

interface RunningAgenticInvestigation {
  conversationId?: string;
  controller: AbortController;
  unsubscribe?: () => void;
}

export type RcaOverviewKind = "alerts" | "dependencies" | "metrics" | "traces" | "topology";

export interface HypothesisMutation {
  id?: string;
  statement?: string;
  status?: HypothesisStatus;
  confidence?: number;
  supportingEvidenceIds?: string[];
  contradictingEvidenceIds?: string[];
  nextChecks?: string[];
  entity?: string;
  mechanism?: string;
}

export interface AgenticBeginOptions {
  investigationId?: string;
  conversationId?: string;
  onEvent?: InvestigationEventListener;
}

export interface AgenticDispatchOptions {
  model?: { provider: string; id: string };
}

export interface DispatchedFinding {
  taskRef: string;
  role: InvestigationBrief["role"];
  status: ExpertTask["status"];
  finding: AgentExpertFinding;
  evidenceIds: string[];
}

function now(): string {
  return new Date().toISOString();
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

function toolModality(tool: ObservabilityToolName): EvidenceModality {
  if (tool === "query_metrics" || tool === "get_metric_catalog") return "metric";
  if (tool === "query_logs" || tool === "get_log_fields") return "log";
  if (tool === "query_traces" || tool === "get_trace_fields") return "trace";
  if (tool === "query_events") return "event";
  if (tool === "query_alerts" || tool === "get_alert_context") return "alert";
  return "topology";
}

export class RcaService {
  private readonly orchestrator: RcaOrchestrator;
  private readonly repository: InvestigationRepository;
  private readonly tools?: ObservabilityToolRegistry;
  private readonly expertRunner?: PiExpertRunner;
  private readonly running = new Map<string, RunningInvestigation>();
  private readonly agenticRunning = new Map<string, RunningAgenticInvestigation>();
  private readonly eventBuses = new Map<string, InvestigationEventBus>();
  private readonly saveQueues = new Map<string, Promise<void>>();

  constructor(
    orchestrator: RcaOrchestrator,
    repository: InvestigationRepository,
    modelRuntime?: ModelRuntime,
    tools?: ObservabilityToolRegistry,
  ) {
    this.orchestrator = orchestrator;
    this.repository = repository;
    this.tools = tools;
    this.expertRunner = modelRuntime && tools ? new PiExpertRunner(modelRuntime, tools) : undefined;
  }

  // Legacy deterministic/Planner-backed path kept temporarily for rollback and regression tests.
  start(caseId: string, options: StartInvestigationOptions = {}): string {
    const handle = this.run(caseId, options);
    void handle.promise.catch(() => undefined);
    return handle.investigationId;
  }

  run(caseId: string, options: StartInvestigationOptions = {}): InvestigationRunHandle {
    const id = createInvestigationId();
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() =>
        this.orchestrator.investigate({
          caseId,
          investigationId: id,
          signal: controller.signal,
          onEvent: options.onEvent,
        }),
      )
      .then(async (result) => {
        await options.onCompleted?.(result.investigation, result.report);
        return result;
      })
      .catch(async (cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        await options.onFailed?.(error);
        throw error;
      })
      .finally(() => {
        this.running.delete(id);
      });

    this.running.set(id, {
      conversationId: options.conversationId,
      controller,
      promise,
    });
    return { investigationId: id, promise };
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
    });

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
        evidence: [],
        expertTasks: [],
        toolCalls: [call],
        rounds: 0,
        startedAt: now(),
      };
      await this.repository.appendToolCall(id, call);
      await this.saveInvestigation(investigation);
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
      this.cleanupAgentic(id);
      throw error;
    }
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
    const investigation = await this.repository.get(investigationId);
    this.assertRunning(investigation);
    const bus = await this.busFor(investigationId);
    const signal = this.agenticRunning.get(investigationId)?.controller.signal;

    const { tool, arguments_ } = this.overviewTool(investigation, kind, query);
    const recorded = await this.invokeRecordedTool(
      investigation,
      bus,
      tool,
      arguments_,
      undefined,
      signal,
    );
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
    await bus.publish("evidence.created", evidence.summary, { evidence });

    return {
      evidenceId: evidence.id,
      toolCallId: recorded.callId,
      summary: evidence.summary,
      ...(recorded.execution.rawRef ? { rawRef: recorded.execution.rawRef } : {}),
      result: recorded.execution.result,
    };
  }

  async updateHypotheses(
    investigationId: string,
    mutations: HypothesisMutation[],
  ): Promise<Hypothesis[]> {
    const investigation = await this.repository.get(investigationId);
    this.assertRunning(investigation);
    const bus = await this.busFor(investigationId);
    const evidenceIds = new Set(investigation.evidence.map((item) => item.id));

    for (const mutation of mutations.slice(0, 8)) {
      const requestedId = mutation.id?.trim();
      const existing = requestedId
        ? investigation.hypotheses.find((item) => item.id === requestedId)
        : undefined;
      const supportingEvidenceIds = mutation.supportingEvidenceIds ?? existing?.supportingEvidenceIds ?? [];
      const contradictingEvidenceIds =
        mutation.contradictingEvidenceIds ?? existing?.contradictingEvidenceIds ?? [];
      for (const evidenceId of [...supportingEvidenceIds, ...contradictingEvidenceIds]) {
        if (!evidenceIds.has(evidenceId)) {
          throw new Error(`Hypothesis references unknown evidence ${evidenceId}`);
        }
      }

      if (!existing) {
        if (!mutation.statement?.trim()) {
          throw new Error("New hypotheses require a statement");
        }
        const id =
          requestedId && /^H\d+$/.test(requestedId) && !investigation.hypotheses.some((h) => h.id === requestedId)
            ? requestedId
            : this.nextHypothesisId(investigation);
        const hypothesis: Hypothesis = {
          id,
          statement: mutation.statement.trim().slice(0, 1000),
          status: mutation.status ?? "possible",
          confidence: clampConfidence(mutation.confidence),
          supportingEvidenceIds: [...new Set(supportingEvidenceIds)],
          contradictingEvidenceIds: [...new Set(contradictingEvidenceIds)],
          nextChecks: (mutation.nextChecks ?? []).filter(Boolean).slice(0, 10),
          ...(mutation.entity?.trim() ? { entity: mutation.entity.trim().slice(0, 200) } : {}),
          ...(mutation.mechanism?.trim()
            ? { mechanism: mutation.mechanism.trim().slice(0, 1000) }
            : {}),
        };
        investigation.hypotheses.push(hypothesis);
        await bus.publish("hypothesis.created", `${hypothesis.id}: ${hypothesis.statement}`, {
          hypothesis,
          source: "main-agent",
        });
        continue;
      }

      const previous = existing.status;
      if (
        mutation.statement?.trim() &&
        mutation.statement.trim().slice(0, 1000) !== existing.statement
      ) {
        throw new Error(
          `Hypothesis ${existing.id} statement is immutable; create a new hypothesis id for a revised meaning`,
        );
      }
      if (mutation.status) existing.status = mutation.status;
      if (typeof mutation.confidence === "number") {
        existing.confidence = clampConfidence(mutation.confidence, existing.confidence);
      }
      existing.supportingEvidenceIds = [...new Set(supportingEvidenceIds)];
      existing.contradictingEvidenceIds = [...new Set(contradictingEvidenceIds)];
      if (mutation.nextChecks) existing.nextChecks = mutation.nextChecks.filter(Boolean).slice(0, 10);
      if (mutation.entity?.trim()) existing.entity = mutation.entity.trim().slice(0, 200);
      if (mutation.mechanism?.trim()) existing.mechanism = mutation.mechanism.trim().slice(0, 1000);

      await bus.publish("hypothesis.updated", `${existing.id}: ${previous} → ${existing.status}`, {
        hypothesisId: existing.id,
        previous,
        current: existing.status,
        hypothesis: existing,
        supportingEvidenceIds: existing.supportingEvidenceIds,
        contradictingEvidenceIds: existing.contradictingEvidenceIds,
        source: "main-agent",
      });
    }

    await this.saveInvestigation(investigation);
    return investigation.hypotheses;
  }

  async dispatchAgentic(
    investigationId: string,
    briefs: InvestigationBrief[],
    options: AgenticDispatchOptions = {},
  ): Promise<DispatchedFinding[]> {
    const runner = this.requireExpertRunner();
    const investigation = await this.repository.get(investigationId);
    this.assertRunning(investigation);
    const bus = await this.busFor(investigationId);
    const running = this.agenticRunning.get(investigationId);
    if (!running) throw new Error("Agentic investigation is not active");
    checkCancelled(running.controller.signal);

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

    const knownHypotheses = new Set(investigation.hypotheses.map((item) => item.id));
    const taskPairs = briefs.map((brief) => {
      if (!brief.question.trim()) throw new Error("Brief question is required");
      if (brief.expected.length === 0) throw new Error("Brief expected outputs are required");
      if (brief.hypothesisIds.length === 0) {
        throw new Error("Brief must identify at least one hypothesis it can change");
      }
      for (const id of brief.hypothesisIds) {
        if (!knownHypotheses.has(id)) throw new Error(`Brief references unknown hypothesis ${id}`);
      }
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

    const results = await Promise.all(
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
          task.sessionId = run.sessionId;

          const finding = await this.acceptAgentFinding(investigation, task, run.finding, bus);
          task.finding = finding;
          task.status = finding.status === "failed" ? "failed" : "completed";
          task.completedAt = now();
          await this.saveInvestigation(investigation);
          await bus.publish("expert.completed", `${task.expert} completed: ${finding.summary}`, {
            expertTask: task,
            finding,
          });
          return {
            taskRef: task.id,
            role: task.expert,
            status: task.status,
            finding,
            evidenceIds: [...task.evidenceIds],
          };
        } catch (error) {
          const cancelled = running.controller.signal.aborted || isAbortError(error);
          task.status = cancelled ? "cancelled" : "failed";
          task.completedAt = now();
          const finding: AgentExpertFinding = {
            status: cancelled ? "failed" : "failed",
            strength: "inconclusive",
            summary: error instanceof Error ? error.message : String(error),
            conclusions: [],
            evidenceClaims: [],
            candidateEntities: [],
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
          return {
            taskRef: task.id,
            role: task.expert,
            status: task.status,
            finding,
            evidenceIds: [],
          };
        }
      }),
    );

    await bus.publish("round.completed", `Agentic batch ${investigation.rounds} completed.`, {
      round: investigation.rounds,
      taskRefs: results.map((item) => item.taskRef),
      evidenceIds: results.flatMap((item) => item.evidenceIds),
      source: "main-agent",
    });
    return results;
  }

  async concludeAgentic(
    investigationId: string,
    result: Omit<RCAResult, "investigationId">,
  ): Promise<{ investigation: Investigation; report: string }> {
    const investigation = await this.repository.get(investigationId);
    this.assertRunning(investigation);
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
    if (result.status !== "inconclusive" && result.evidenceIds.length === 0) {
      throw new Error("A non-inconclusive conclusion must cite evidence");
    }
    if (result.status === "confirmed" && result.evidenceIds.length < 2) {
      throw new Error("A confirmed conclusion must cite at least two evidence items");
    }
    if (result.status !== "inconclusive" && result.rootCauseEntities.length === 0) {
      throw new Error("A non-inconclusive conclusion must name at least one root-cause entity");
    }

    investigation.rootCause = {
      investigationId,
      ...result,
      evidenceIds: [...new Set(result.evidenceIds)],
      rejectedHypotheses: [...new Set(result.rejectedHypotheses)],
      rootCauseEntities: [...new Set(result.rootCauseEntities)],
      confidence: clampConfidence(result.confidence, 0),
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

  cancel(investigationId: string): boolean {
    let cancelled = false;
    const legacy = this.running.get(investigationId);
    if (legacy) {
      legacy.controller.abort();
      cancelled = true;
    }
    const agentic = this.agenticRunning.get(investigationId);
    if (agentic) {
      agentic.controller.abort();
      void this.markAgenticCancelled(investigationId);
      cancelled = true;
    }
    return cancelled;
  }

  cancelConversation(conversationId: string): number {
    const ids = new Set<string>();
    for (const [id, running] of this.running) {
      if (running.conversationId !== conversationId) continue;
      running.controller.abort();
      ids.add(id);
    }
    for (const [id, running] of this.agenticRunning) {
      if (running.conversationId !== conversationId) continue;
      running.controller.abort();
      void this.markAgenticCancelled(id);
      ids.add(id);
    }
    return ids.size;
  }

  private requireAgenticTools(): ObservabilityToolRegistry {
    if (!this.tools) throw new Error("Agentic RCA tools are not configured");
    return this.tools;
  }

  private requireExpertRunner(): PiExpertRunner {
    if (!this.expertRunner) throw new Error("Pi RCA sub-agent runtime is not configured");
    return this.expertRunner;
  }

  private assertRunning(investigation: Investigation): void {
    if (investigation.status !== "running") {
      throw new Error(
        `Investigation ${investigation.id} is ${investigation.status}, not running`,
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
      call.status = "completed";
      call.resultSummary = execution.summary;
      call.rawRef = execution.rawRef;
      call.completedAt = now();
      await this.repository.appendToolCall(investigation.id, call);
      await this.saveInvestigation(investigation);
      await bus.publish("tool.completed", `${tool} completed: ${execution.summary}.`, {
        toolCall: call,
      });
      return {
        callId: call.id,
        execution: {
          result: execution.result,
          summary: execution.summary,
          rawRef: execution.rawRef,
        },
      };
    } catch (error) {
      const cancelled = signal?.aborted || isAbortError(error);
      call.status = cancelled ? "cancelled" : "failed";
      call.error = error instanceof Error ? error.message : String(error);
      call.completedAt = now();
      await this.repository.appendToolCall(investigation.id, call);
      await this.saveInvestigation(investigation);
      await bus.publish(
        "tool.completed",
        `${tool} ${cancelled ? "cancelled" : "failed"}: ${call.error}.`,
        { toolCall: call },
      );
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

  private nextToolId(investigation: Investigation): string {
    return `C${String(investigation.toolCalls.length + 1).padStart(2, "0")}`;
  }

  private nextEvidenceId(investigation: Investigation): string {
    return `E${String(investigation.evidence.length + 1).padStart(2, "0")}`;
  }

  private nextTaskId(investigation: Investigation): string {
    return `T${String(investigation.expertTasks.length + 1).padStart(2, "0")}`;
  }

  private nextHypothesisId(investigation: Investigation): string {
    let index = investigation.hypotheses.length + 1;
    while (investigation.hypotheses.some((item) => item.id === `H${String(index).padStart(2, "0")}`)) {
      index++;
    }
    return `H${String(index).padStart(2, "0")}`;
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
      "## Unresolved",
      ...(result.missingEvidence?.length
        ? result.missingEvidence.map((item) => `- ${item}`)
        : ["- None recorded."]),
    ].join("\n");
  }

  private async markAgenticCancelled(investigationId: string): Promise<void> {
    try {
      const investigation = await this.repository.get(investigationId);
      if (investigation.status !== "running") return;
      investigation.status = "cancelled";
      investigation.completedAt = now();
      investigation.error = "Investigation cancelled";
      for (const task of investigation.expertTasks) {
        if (task.status !== "running" && task.status !== "pending") continue;
        task.status = "cancelled";
        task.completedAt = now();
      }
      await this.saveInvestigation(investigation);
      const bus = await this.busFor(investigationId);
      await bus.publish("investigation.cancelled", "Investigation cancelled.", {
        source: "user",
      });
    } finally {
      this.cleanupAgentic(investigationId);
    }
  }

  private cleanupAgentic(investigationId: string): void {
    const active = this.agenticRunning.get(investigationId);
    active?.unsubscribe?.();
    this.agenticRunning.delete(investigationId);
  }
}
