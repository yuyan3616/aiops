import { foldBudget } from "./budget";
import { RcaChatEventMapper, type ChatStreamProjection } from "./chat-events";
import {
  decideStartRcaInvestigation,
  idleConversationRcaContext,
  type ConversationRcaContext,
} from "./conversation-context";
import {
  type AgenticConclusionInput,
  type HypothesisMutation,
  type LiveIncidentInput,
  type RcaOverviewKind,
  type RcaService,
} from "./service";
import { compactToolResultForAgent } from "./tools";
import type { Investigation, InvestigationBrief, TimeRange } from "./types";

export interface RcaMainHostOptions {
  rcaService: RcaService;
  conversationId: string;
  getModelRef: () => { provider: string; id: string };
  onProjection: (projection: ChatStreamProjection) => void | Promise<void>;
  onLinkInvestigation: (investigationId: string) => void | Promise<void>;
  getAgentConfigVersion?: () => string;
  getRcaContext?: () => ConversationRcaContext | Promise<ConversationRcaContext>;
  onConcluded?: (investigation: Investigation, report: string) => void | Promise<void>;
}

function toolResult(result: unknown) {
  const bounded = compactToolResultForAgent("search_logs", result);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(bounded) }],
    details: result,
  };
}

function tail<T>(
  items: T[],
  limit: number,
  offset = 0,
): { items: T[]; total: number; truncated: boolean; nextOffset?: number } {
  const bounded = Math.max(1, Math.min(Math.floor(limit), 50));
  const end = Math.max(0, items.length - Math.max(0, Math.floor(offset)));
  const start = Math.max(0, end - bounded);
  return {
    items: items.slice(start, end),
    total: items.length,
    truncated: start > 0,
    ...(start > 0 ? { nextOffset: offset + end - start } : {}),
  };
}

function compactInvestigation(
  investigation: Investigation,
  budget?: ReturnType<RcaService["getBudgetProjection"]>,
  limit = 20,
  offset = 0,
) {
  const observations = tail(investigation.observations ?? [], limit, offset);
  const evidence = tail(investigation.evidence, limit, offset);
  const tasks = tail(investigation.expertTasks, limit, offset);
  const hypotheses = tail(investigation.hypotheses, limit, offset);
  return {
    investigationId: investigation.id,
    agentConfigVersion: investigation.agentConfigVersion,
    ...(investigation.caseId ? { caseId: investigation.caseId } : {}),
    status: investigation.status,
    symptom: investigation.symptom,
    ...(investigation.context ? { incident: investigation.context } : {}),
    ...(investigation.alertContext ? { alert: investigation.alertContext } : {}),
    ...(investigation.source ? { source: investigation.source } : {}),
    ...(investigation.formatVersion ? { formatVersion: investigation.formatVersion } : {}),
    scope: {
      ...investigation.scope,
      candidateEntities: investigation.scope.candidateEntities.slice(-50),
      extensions: investigation.scope.extensions?.slice(-20),
    },
    rounds: investigation.rounds,
    hypotheses: hypotheses.items,
    observations: observations.items.map((item) => ({
      id: item.id,
      modality: item.modality,
      toolCallId: item.toolCallId,
      expertTaskId: item.expertTaskId,
      summary: item.summary,
      rawRef: item.rawRef,
      snapshotRef: item.snapshotRef,
      sourceItems: item.sourceItems,
      timeRange: item.timeRange,
    })),
    evidence: evidence.items.map((item) => ({
      id: item.id,
      modality: item.modality,
      entity: item.entity,
      sourceItems: item.sourceItems,
      timeRange: item.timeRange,
      summary: item.summary,
      supports: item.supports,
      contradicts: item.contradicts,
      rawRef: item.rawRef,
      snapshotRef: item.snapshotRef,
      toolCallId: item.toolCallId,
      expertTaskId: item.expertTaskId,
    })),
    expertTasks: tasks.items.map((item) => ({
      id: item.id,
      expert: item.expert,
      objective: item.objective,
      status: item.status,
      hypothesisIds: item.hypothesisIds,
      evidenceIds: item.evidenceIds,
      finding: item.finding,
      termination: item.termination?.reason ?? item.terminationReason,
      budgetClass: item.budgetClass,
      recoveryOfTaskId: item.recoveryOfTaskId,
      recoveryEligible: item.recoveryEligible,
      taskGeneration: item.taskGeneration,
    })),
    page: {
      offset,
      observations: {
        total: observations.total,
        truncated: observations.truncated,
        nextOffset: observations.nextOffset,
      },
      evidence: {
        total: evidence.total,
        truncated: evidence.truncated,
        nextOffset: evidence.nextOffset,
      },
      expertTasks: { total: tasks.total, truncated: tasks.truncated, nextOffset: tasks.nextOffset },
      hypotheses: {
        total: hypotheses.total,
        truncated: hypotheses.truncated,
        nextOffset: hypotheses.nextOffset,
      },
    },
    ...(investigation.schemaVersion === 2
      ? { budget: budget ?? foldBudget(investigation).projection }
      : {}),
    rootCause: investigation.rootCause,
  };
}

function parseRange(value: { from: string; to: string }): TimeRange {
  return { from: value.from, to: value.to };
}

function cleanRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, entry]) => entry !== undefined && entry !== null && entry !== "",
    ),
  );
}

import type { MainToolInputs } from "./main-host-inputs";
export function createRcaMainHost(options: RcaMainHostOptions) {
  const { rcaService, conversationId } = options;
  const mappers = new Map<string, RcaChatEventMapper>();
  let mutationQueue: Promise<void> = Promise.resolve();

  const serializeMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = mutationQueue;
    let release!: () => void;
    mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const project = async (event: {
    investigationId: string;
    type: Parameters<RcaChatEventMapper["map"]>[0]["type"];
    id: number;
    at: string;
    summary: string;
    payload: Record<string, unknown>;
  }) => {
    let mapper = mappers.get(event.investigationId);
    if (!mapper) {
      mapper = new RcaChatEventMapper(event.investigationId);
      mappers.set(event.investigationId, mapper);
    }
    for (const projection of mapper.map(event)) await options.onProjection(projection);
  };

  const capabilities = {
    utc_time: async () => ({
      content: [{ type: "text" as const, text: new Date().toISOString() }],
      details: {},
    }),
    start_rca_investigation: async (
      _toolCallId: string,
      parameters: MainToolInputs["start_rca_investigation"],
      _signal?: AbortSignal,
    ) =>
      serializeMutation(async () => {
        _signal?.throwIfAborted();
        const rcaContext = (await options.getRcaContext?.()) ?? idleConversationRcaContext();
        const decision = decideStartRcaInvestigation(
          rcaContext,
          parameters.symptom,
          parameters.forceNew === true,
        );
        if (!decision.allowed) {
          return toolResult({
            started: false,
            activeRcaContext: rcaContext,
            ...decision,
          });
        }
        const input: LiveIncidentInput = {
          symptom: parameters.symptom,
          target: cleanRecord(parameters.target) as LiveIncidentInput["target"],
          window:
            "lookbackMinutes" in parameters.window
              ? { lookbackMinutes: parameters.window.lookbackMinutes }
              : { from: parameters.window.from, to: parameters.window.to },
          trigger: { type: "manual" },
        };
        const investigation = await rcaService.beginAgentic(input, {
          agentConfigVersion: options.getAgentConfigVersion?.(),
          operationId: `${conversationId}:${_toolCallId}`,
          conversationId,
          onEvent: project,
        });
        await options.onLinkInvestigation(investigation.id);
        return toolResult({
          started: true,
          ...compactInvestigation(investigation),
        });
      }),
    resume_rca_investigation: async (
      _toolCallId: string,
      parameters: MainToolInputs["resume_rca_investigation"],
      _signal?: AbortSignal,
    ) =>
      serializeMutation(async () => {
        _signal?.throwIfAborted();
        const investigation = await rcaService.resumeAgentic(parameters.investigationId, {
          conversationId,
          onEvent: project,
        });
        return toolResult(compactInvestigation(investigation));
      }),
    query_rca_overview: async (
      _toolCallId: string,
      parameters: MainToolInputs["query_rca_overview"],
      _signal?: AbortSignal,
    ) => {
      const { investigationId, kind, metricOperation, logTraceId, ...query } = parameters;
      const normalized = cleanRecord({
        ...query,
        ...(metricOperation ? { operation: metricOperation } : {}),
        ...(kind === "logs" && logTraceId ? { traceId: logTraceId } : {}),
      });
      return serializeMutation(async () =>
        toolResult(
          await rcaService.queryOverview(
            investigationId,
            kind as RcaOverviewKind,
            normalized,
            _signal,
          ),
        ),
      );
    },
    read_rca_trace: async (
      _toolCallId: string,
      parameters: MainToolInputs["read_rca_trace"],
      _signal?: AbortSignal,
    ) => {
      const { investigationId, ...query } = parameters;
      return serializeMutation(async () =>
        toolResult(
          await rcaService.queryOverview(investigationId, "traces", cleanRecord(query), _signal),
        ),
      );
    },
    update_hypotheses: async (
      _toolCallId: string,
      parameters: MainToolInputs["update_hypotheses"],
      _signal?: AbortSignal,
    ) =>
      serializeMutation(async () =>
        toolResult(
          await rcaService.updateHypotheses(
            parameters.investigationId,
            parameters.mutations as HypothesisMutation[],
          ),
        ),
      ),
    dispatch_investigations: async (
      _toolCallId: string,
      parameters: MainToolInputs["dispatch_investigations"],
      _signal?: AbortSignal,
    ) => {
      const briefs: InvestigationBrief[] = parameters.briefs.map((brief) => ({
        role: brief.role,
        ...(brief.recoveryOfTaskId ? { recoveryOfTaskId: brief.recoveryOfTaskId } : {}),
        question: brief.question,
        hypothesisIds: [...brief.hypothesisIds],
        context: {
          alertSummary: brief.context.alertSummary,
          ...(brief.context.service ? { service: brief.context.service } : {}),
          mainWindow: parseRange(brief.context.mainWindow),
          ...(brief.context.baselineWindow
            ? { baselineWindow: parseRange(brief.context.baselineWindow) }
            : {}),
          knownFacts: [...brief.context.knownFacts],
          ...(brief.context.refs?.length
            ? {
                refs: Object.fromEntries(
                  brief.context.refs.map((item) => [item.key, [...item.values]]),
                ),
              }
            : {}),
        },
        expected: [...brief.expected],
        ...(brief.notInScope ? { notInScope: brief.notInScope } : {}),
      }));
      return serializeMutation(async () => {
        _signal?.throwIfAborted();
        const dispatch = await rcaService.dispatchAgentic(parameters.investigationId, briefs, {
          model: options.getModelRef(),
          dispatchOperationId: `${conversationId}:${_toolCallId}`,
        });
        return toolResult({
          ...dispatch,
          findings: dispatch.findings.map(({ diagnostics: _diagnostics, ...finding }) => finding),
        });
      });
    },
    get_investigation_state: async (
      _toolCallId: string,
      parameters: MainToolInputs["get_investigation_state"],
      _signal?: AbortSignal,
    ) => {
      const investigation = await rcaService.get(parameters.investigationId);
      return toolResult(
        compactInvestigation(
          investigation,
          investigation.schemaVersion === 2
            ? rcaService.getBudgetProjection(investigation)
            : undefined,
          parameters.limit ?? 20,
          parameters.offset ?? 0,
        ),
      );
    },
    conclude_investigation: async (
      _toolCallId: string,
      parameters: MainToolInputs["conclude_investigation"],
      _signal?: AbortSignal,
    ) => {
      const { investigationId, ...input } = parameters;
      const result: AgenticConclusionInput = {
        status: input.status,
        rootCauseEntities: [...input.rootCauseEntities],
        ...(input.mechanism ? { mechanism: input.mechanism } : {}),
        summary: input.summary,
        evidenceIds: [...input.evidenceIds],
        selectedHypothesisIds: [...input.selectedHypothesisIds],
        rejectedHypotheses: [...input.rejectedHypotheses],
        unresolvedHypotheses: input.unresolvedHypotheses.map((item) => ({
          id: item.id,
          reason: item.reason,
          ...(item.missingEvidence ? { missingEvidence: [...item.missingEvidence] } : {}),
        })),
        confidence: input.confidence,
        ...(input.missingEvidence ? { missingEvidence: [...input.missingEvidence] } : {}),
        causalAssessment: {
          temporalFit: input.causalAssessment.temporalFit,
          temporalEvidenceIds: [...input.causalAssessment.temporalEvidenceIds],
          transitionEvidenceIds: [...input.causalAssessment.transitionEvidenceIds],
          propagationFit: input.causalAssessment.propagationFit,
          propagationEvidenceIds: [...input.causalAssessment.propagationEvidenceIds],
          materialUnobservedGap: input.causalAssessment.materialUnobservedGap,
          gapBridgeEvidenceIds: [...input.causalAssessment.gapBridgeEvidenceIds],
          unresolvedContradictions: [...input.causalAssessment.unresolvedContradictions],
        },
      };
      return serializeMutation(async () => {
        _signal?.throwIfAborted();
        const concluded = await rcaService.concludeAgentic(investigationId, result);
        await options.onConcluded?.(concluded.investigation, concluded.report);
        return toolResult({ result: concluded.investigation.rootCause, report: concluded.report });
      });
    },
  };
  return Object.fromEntries(
    Object.entries(capabilities).map(([name, operation]) => [
      name,
      async (...args: unknown[]) => {
        const signal = args[2] as AbortSignal | undefined;
        signal?.throwIfAborted();
        const input = args[1] as { investigationId?: string } | undefined;
        const boundVersion = options.getAgentConfigVersion?.();
        if (boundVersion && input?.investigationId && name !== "get_investigation_state") {
          const investigation = await rcaService.get(input.investigationId);
          if (investigation.status === "running" || investigation.status === "interrupted") {
            const investigationVersion = await rcaService.resolveAgentConfigVersion(
              input.investigationId,
            );
            if (investigationVersion !== boundVersion)
              throw new Error("agent_config_version_mismatch");
          }
        }
        signal?.throwIfAborted();
        return (operation as (...args: unknown[]) => Promise<unknown>)(...args);
      },
    ]),
  ) as typeof capabilities;
}
