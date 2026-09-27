import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { RcaChatEventMapper, type ChatStreamProjection } from "./chat-events";
import { createInvestigationId } from "./orchestrator";
import type {
  HypothesisMutation,
  RcaOverviewKind,
  RcaService,
} from "./service";
import type {
  Investigation,
  InvestigationBrief,
  RCAResult,
  TimeRange,
} from "./types";

export interface RcaMainAgentToolsOptions {
  rcaService: RcaService;
  conversationId: string;
  getModelRef: () => { provider: string; id: string };
  onProjection: (projection: ChatStreamProjection) => void | Promise<void>;
  onLinkInvestigation: (investigationId: string) => void | Promise<void>;
  onConcluded?: (investigation: Investigation, report: string) => void | Promise<void>;
}

function toolResult(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    details: result,
  };
}

function compactInvestigation(investigation: Investigation) {
  return {
    investigationId: investigation.id,
    caseId: investigation.caseId,
    status: investigation.status,
    symptom: investigation.symptom,
    alert: investigation.alertContext,
    scope: investigation.scope,
    rounds: investigation.rounds,
    hypotheses: investigation.hypotheses,
    observations: (investigation.observations ?? []).map((item) => ({
      id: item.id,
      modality: item.modality,
      toolCallId: item.toolCallId,
      expertTaskId: item.expertTaskId,
      summary: item.summary,
      rawRef: item.rawRef,
    })),
    evidence: investigation.evidence.map((item) => ({
      id: item.id,
      modality: item.modality,
      entity: item.entity,
      summary: item.summary,
      supports: item.supports,
      contradicts: item.contradicts,
      rawRef: item.rawRef,
      toolCallId: item.toolCallId,
      expertTaskId: item.expertTaskId,
    })),
    expertTasks: investigation.expertTasks.map((item) => ({
      id: item.id,
      expert: item.expert,
      objective: item.objective,
      status: item.status,
      hypothesisIds: item.hypothesisIds,
      evidenceIds: item.evidenceIds,
      finding: item.finding,
      diagnostics: item.diagnostics,
    })),
    rootCause: investigation.rootCause,
  };
}

function parseRange(value: { from: string; to: string }): TimeRange {
  return { from: value.from, to: value.to };
}

function cleanRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""),
  );
}

export function createRcaMainAgentTools(options: RcaMainAgentToolsOptions): ToolDefinition[] {
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
    for (const projection of mapper.map(event)) {
      await options.onProjection(projection);
    }
  };

  const startTool = defineTool({
    name: "start_rca_investigation",
    label: "Start RCA investigation",
    description:
      "Start an auditable RCA investigation for a concrete case. Returns alert context and an empty hypothesis set. Use this before RCA overview, hypothesis, dispatch, or conclusion tools.",
    parameters: Type.Object({
      caseId: Type.String({ description: "RCA case id, for example t039" }),
    }),
    execute: async (_toolCallId, parameters) => {
      const caseId = parameters.caseId.trim().toLowerCase();
      if (!/^t\d+$/i.test(caseId)) throw new Error("caseId must look like t039");
      const investigationId = createInvestigationId();
      mappers.set(investigationId, new RcaChatEventMapper(investigationId));
      const investigation = await rcaService.beginAgentic(caseId, {
        investigationId,
        conversationId,
        onEvent: project,
      });
      await options.onLinkInvestigation(investigationId);
      return toolResult(compactInvestigation(investigation));
    },
  });

  const resumeTool = defineTool({
    name: "resume_rca_investigation",
    label: "Resume RCA investigation",
    description:
      "Resume an investigation that was interrupted by a process restart. Preserves prior hypotheses, observations, evidence, and completed task history.",
    parameters: Type.Object({
      investigationId: Type.String(),
    }),
    execute: async (_toolCallId, parameters) =>
      serializeMutation(async () => {
        const investigation = await rcaService.resumeAgentic(parameters.investigationId, {
          conversationId,
          onEvent: project,
        });
        return toolResult(compactInvestigation(investigation));
      }),
  });

  const overviewTool = defineTool({
    name: "query_rca_overview",
    label: "Query RCA overview",
    description:
      "Run one bounded overview/statistical check in an active RCA investigation. Choose only the overview that reduces a current uncertainty. Raw log reading belongs to a specialist sub-agent.",
    parameters: Type.Object({
      investigationId: Type.String(),
      kind: Type.Union([
        Type.Literal("alerts"),
        Type.Literal("dependencies"),
        Type.Literal("metrics"),
        Type.Literal("traces"),
        Type.Literal("topology"),
      ]),
      service: Type.Optional(Type.String()),
      operation: Type.Optional(Type.String()),
      entity: Type.Optional(Type.String()),
      metric: Type.Optional(Type.String()),
      subject: Type.Optional(Type.String()),
      host: Type.Optional(Type.String()),
      timeBasis: Type.Optional(
        Type.Union([Type.Literal("start"), Type.Literal("end"), Type.Literal("overlap")]),
      ),
      topN: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
      depth: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    }),
    execute: async (_toolCallId, parameters) => {
      const { investigationId, kind, ...query } = parameters;
      return serializeMutation(async () => {
        const result = await rcaService.queryOverview(
          investigationId,
          kind as RcaOverviewKind,
          cleanRecord(query),
        );
        return toolResult(result);
      });
    },
  });

  const updateHypothesesTool = defineTool({
    name: "update_hypotheses",
    label: "Update RCA hypotheses",
    description:
      "Create or update competing RCA hypotheses based on evidence. Hypothesis statements are immutable once created; if the meaning changes, create a new hypothesis id instead of rewriting an old one. The model owns hypothesis decisions; the server validates evidence references and persists the state.",
    parameters: Type.Object({
      investigationId: Type.String(),
      hypotheses: Type.Array(
        Type.Object({
          id: Type.Optional(Type.String()),
          statement: Type.Optional(Type.String()),
          status: Type.Optional(
            Type.Union([
              Type.Literal("possible"),
              Type.Literal("investigating"),
              Type.Literal("supported"),
              Type.Literal("rejected"),
              Type.Literal("confirmed"),
            ]),
          ),
          confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
          supportingEvidenceIds: Type.Optional(Type.Array(Type.String(), { maxItems: 30 })),
          contradictingEvidenceIds: Type.Optional(Type.Array(Type.String(), { maxItems: 30 })),
          nextChecks: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
          entity: Type.Optional(Type.String()),
          mechanism: Type.Optional(Type.String()),
        }),
        { minItems: 1, maxItems: 8 },
      ),
    }),
    execute: async (_toolCallId, parameters) => {
      const hypotheses = parameters.hypotheses.map((item) => cleanRecord(item)) as HypothesisMutation[];
      return serializeMutation(async () => {
        const result = await rcaService.updateHypotheses(parameters.investigationId, hypotheses);
        return toolResult({ hypotheses: result });
      });
    },
  });

  const rangeSchema = Type.Object({
    from: Type.String(),
    to: Type.String(),
  });

  const dispatchTool = defineTool({
    name: "dispatch_investigations",
    label: "Dispatch RCA sub-agents",
    description:
      "Dispatch one to three independent falsifiable briefs to real Pi specialist sessions. Independent briefs in the same call run concurrently. Dispatch only when the result can change a named hypothesis.",
    parameters: Type.Object({
      investigationId: Type.String(),
      briefs: Type.Array(
        Type.Object({
          role: Type.Union([
            Type.Literal("trace"),
            Type.Literal("metrics"),
            Type.Literal("log"),
            Type.Literal("event-topology"),
          ]),
          question: Type.String({ minLength: 1 }),
          hypothesisIds: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }),
          context: Type.Object({
            alertSummary: Type.String(),
            service: Type.Optional(Type.String()),
            mainWindow: rangeSchema,
            baselineWindow: Type.Optional(rangeSchema),
            knownFacts: Type.Array(Type.String(), { maxItems: 30 }),
            refs: Type.Optional(
              Type.Array(
                Type.Object({
                  key: Type.String(),
                  values: Type.Array(Type.String(), { maxItems: 30 }),
                }),
                { maxItems: 20 },
              ),
            ),
          }),
          expected: Type.Array(Type.String(), { minItems: 1, maxItems: 10 }),
          notInScope: Type.Optional(Type.String()),
        }),
        { minItems: 1, maxItems: 3 },
      ),
    }),
    execute: async (_toolCallId, parameters) => {
      const briefs: InvestigationBrief[] = parameters.briefs.map((brief) => ({
        role: brief.role,
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
        const findings = await rcaService.dispatchAgentic(parameters.investigationId, briefs, {
          model: options.getModelRef(),
        });
        return toolResult({ findings });
      });
    },
  });

  const stateTool = defineTool({
    name: "get_investigation_state",
    label: "Get RCA investigation state",
    description:
      "Read the current hypotheses, evidence summaries, specialist findings, and task status for an active or completed investigation.",
    parameters: Type.Object({
      investigationId: Type.String(),
    }),
    execute: async (_toolCallId, parameters) => {
      const investigation = await rcaService.get(parameters.investigationId);
      return toolResult(compactInvestigation(investigation));
    },
  });

  const concludeTool = defineTool({
    name: "conclude_investigation",
    label: "Conclude RCA investigation",
    description:
      "Persist the Main Agent's final evidence-grounded RCA conclusion. Call only after competing hypotheses have been evaluated or the remaining uncertainty is explicitly declared.",
    parameters: Type.Object({
      investigationId: Type.String(),
      status: Type.Union([
        Type.Literal("confirmed"),
        Type.Literal("probable"),
        Type.Literal("inconclusive"),
      ]),
      rootCauseEntities: Type.Array(Type.String(), { maxItems: 20 }),
      mechanism: Type.Optional(Type.String()),
      summary: Type.String(),
      evidenceIds: Type.Array(Type.String(), { maxItems: 50 }),
      rejectedHypotheses: Type.Array(Type.String(), { maxItems: 20 }),
      confidence: Type.Number({ minimum: 0, maximum: 1 }),
      missingEvidence: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
    }),
    execute: async (_toolCallId, parameters) => {
      const { investigationId, ...input } = parameters;
      const result: Omit<RCAResult, "investigationId"> = {
        status: input.status,
        rootCauseEntities: [...input.rootCauseEntities],
        ...(input.mechanism ? { mechanism: input.mechanism } : {}),
        summary: input.summary,
        evidenceIds: [...input.evidenceIds],
        rejectedHypotheses: [...input.rejectedHypotheses],
        confidence: input.confidence,
        ...(input.missingEvidence ? { missingEvidence: [...input.missingEvidence] } : {}),
      };
      return serializeMutation(async () => {
        const concluded = await rcaService.concludeAgentic(investigationId, result);
        await options.onConcluded?.(concluded.investigation, concluded.report);
        return toolResult({
          result: concluded.investigation.rootCause,
          report: concluded.report,
        });
      });
    },
  });

  return [
    startTool,
    resumeTool,
    overviewTool,
    updateHypothesesTool,
    dispatchTool,
    stateTool,
    concludeTool,
  ];
}
