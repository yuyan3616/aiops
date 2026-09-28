import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { RcaChatEventMapper, type ChatStreamProjection } from "./chat-events";
import {
  decideStartRcaInvestigation,
  idleConversationRcaContext,
  type ConversationRcaContext,
} from "./conversation-context";
import {
  createInvestigationId,
  type AgenticConclusionInput,
  type HypothesisMutation,
  type RcaOverviewKind,
  type RcaService,
} from "./service";
import type {
  Investigation,
  InvestigationBrief,
  TimeRange,
} from "./types";

export interface RcaMainAgentToolsOptions {
  rcaService: RcaService;
  conversationId: string;
  getModelRef: () => { provider: string; id: string };
  onProjection: (projection: ChatStreamProjection) => void | Promise<void>;
  onLinkInvestigation: (investigationId: string) => void | Promise<void>;
  getRcaContext?: () => ConversationRcaContext | Promise<ConversationRcaContext>;
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
    label: "开始 RCA 调查",
    description:
      "为具体 case 启动一次可审计的 RCA 调查。若当前 RCA context 已关联调查，不要隐式替换。只有用户明确要求重跑、从头开始或调查不同 case 时才设置 forceNew=true。",
    parameters: Type.Object({
      caseId: Type.String({ description: "RCA case id，例如 t039" }),
      forceNew: Type.Optional(
        Type.Boolean({
          description:
            "显式替换已关联调查。仅当用户明确要求新建/重跑调查或调查另一个 case 时使用。",
        }),
      ),
    }),
    execute: async (_toolCallId, parameters) =>
      serializeMutation(async () => {
        const caseId = parameters.caseId.trim().toLowerCase();
        if (!/^t\d+$/i.test(caseId)) throw new Error("caseId must look like t039");

        const rcaContext =
          (await options.getRcaContext?.()) ?? idleConversationRcaContext();
        const decision = decideStartRcaInvestigation(
          rcaContext,
          caseId,
          parameters.forceNew === true,
        );
        if (!decision.allowed) {
          return toolResult({
            started: false,
            caseId,
            activeRcaContext: rcaContext,
            ...decision,
          });
        }

        const investigationId = createInvestigationId();
        mappers.set(investigationId, new RcaChatEventMapper(investigationId));
        const investigation = await rcaService.beginAgentic(caseId, {
          investigationId,
          conversationId,
          onEvent: project,
        });
        await options.onLinkInvestigation(investigationId);
        return toolResult({
          started: true,
          ...compactInvestigation(investigation),
        });
      }),
  });

  const resumeTool = defineTool({
    name: "resume_rca_investigation",
    label: "恢复 RCA 调查",
    description:
      "恢复因进程重启而 interrupted 的调查，并保留已有 hypotheses、observations、evidence 和已完成任务历史。",
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
    label: "查询 RCA 概览",
    description:
      "在活动 RCA 调查中执行一次有边界的 overview/统计检查。overview 用于发现候选和减少不确定性，Top anomaly 只是线索而不是 root cause 排名。进入单一候选深挖前，可用 dependencies + 针对候选 service 的 incident-window metrics 做低成本 candidate coverage，避免真正候选在早期被漏掉；不要机械扫描全部模态。raw log 阅读交给专家子 Agent。",
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

  const hypothesisStatusSchema = Type.Optional(
    Type.Union([
      Type.Literal("possible"),
      Type.Literal("investigating"),
      Type.Literal("supported"),
      Type.Literal("rejected"),
      Type.Literal("confirmed"),
    ]),
  );
  const hypothesisEvidenceSchema = Type.Optional(Type.Array(Type.String(), { maxItems: 30 }));
  const hypothesisChecksSchema = Type.Optional(Type.Array(Type.String(), { maxItems: 10 }));

  const updateHypothesesTool = defineTool({
    name: "update_hypotheses",
    label: "更新 RCA 假设",
    description:
      "创建或更新相互竞争的 RCA hypotheses，并支持 mutation 部分接受。op=create 只定义新的不可变 statement；op=update 只修改已有 id 的 status/confidence/evidence/checks。语义实质变化必须新建 hypothesis，可选用 supersedes 关联。结果会分别报告 accepted 和 rejected mutation。",
    parameters: Type.Object({
      investigationId: Type.String(),
      mutations: Type.Array(
        Type.Union([
          Type.Object({
            op: Type.Literal("create"),
            requestId: Type.Optional(Type.String()),
            id: Type.Optional(Type.String()),
            statement: Type.String({ minLength: 1 }),
            supersedes: Type.Optional(Type.String()),
            status: hypothesisStatusSchema,
            confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
            supportingEvidenceIds: hypothesisEvidenceSchema,
            contradictingEvidenceIds: hypothesisEvidenceSchema,
            nextChecks: hypothesisChecksSchema,
            entity: Type.Optional(Type.String()),
            mechanism: Type.Optional(Type.String()),
          }),
          Type.Object({
            op: Type.Literal("update"),
            requestId: Type.Optional(Type.String()),
            id: Type.String({ minLength: 1 }),
            status: hypothesisStatusSchema,
            confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
            supportingEvidenceIds: hypothesisEvidenceSchema,
            contradictingEvidenceIds: hypothesisEvidenceSchema,
            nextChecks: hypothesisChecksSchema,
            entity: Type.Optional(Type.String()),
            mechanism: Type.Optional(Type.String()),
          }),
        ]),
        { minItems: 1, maxItems: 8 },
      ),
    }),
    execute: async (_toolCallId, parameters) => {
      const mutations = parameters.mutations as HypothesisMutation[];
      return serializeMutation(async () => {
        const result = await rcaService.updateHypotheses(parameters.investigationId, mutations);
        return toolResult(result);
      });
    },
  });

  const rangeSchema = Type.Object({
    from: Type.String(),
    to: Type.String(),
  });

  const dispatchTool = defineTool({
    name: "dispatch_investigations",
    label: "调度 RCA 子 Agent",
    description:
      "向真实 Pi 专家 Session 下发 1-3 个彼此独立、可证伪的 brief。同一调用中的独立 brief 会并发执行。只有结果可能改变指定 hypothesis 时才 dispatch。",
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
    label: "读取 RCA 调查状态",
    description:
      "读取活动或已完成调查中的当前 hypotheses、evidence summary、specialist findings 和 task status。",
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
    label: "收敛 RCA 调查",
    description:
      "持久化 Main Agent 最终、基于 evidence 的 RCA 结论。每个 hypothesis 必须且只能归入 selected、rejected 或 unresolved 一类。causalAssessment 必须引用真实 evidence：非 uncertain 的 temporalFit 要有 temporalEvidenceIds；pre_existing_explained 还必须有独立的 transitionEvidenceIds，不能只靠同一批长期异常讲故事；propagationFit=supported 要有 propagationEvidenceIds。若关键因果区间存在 materialUnobservedGap，仍声称 supported 时必须提供 gapBridgeEvidenceIds，否则应降为 uncertain。probable 不接受 temporalFit=uncertain；confirmed 还要求 propagationFit=supported 且没有未解决矛盾。",
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
      selectedHypothesisIds: Type.Array(Type.String(), { maxItems: 10 }),
      rejectedHypotheses: Type.Array(Type.String(), { maxItems: 20 }),
      unresolvedHypotheses: Type.Array(
        Type.Object({
          id: Type.String(),
          reason: Type.String({ minLength: 1 }),
          missingEvidence: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
        }),
        { maxItems: 20 },
      ),
      confidence: Type.Number({ minimum: 0, maximum: 1 }),
      missingEvidence: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
      causalAssessment: Type.Object({
        temporalFit: Type.Union([
          Type.Literal("aligned"),
          Type.Literal("pre_existing_explained"),
          Type.Literal("uncertain"),
        ]),
        temporalEvidenceIds: Type.Array(Type.String(), { maxItems: 20 }),
        transitionEvidenceIds: Type.Array(Type.String(), { maxItems: 20 }),
        propagationFit: Type.Union([
          Type.Literal("supported"),
          Type.Literal("uncertain"),
          Type.Literal("not_available"),
        ]),
        propagationEvidenceIds: Type.Array(Type.String(), { maxItems: 20 }),
        materialUnobservedGap: Type.Boolean(),
        gapBridgeEvidenceIds: Type.Array(Type.String(), { maxItems: 20 }),
        unresolvedContradictions: Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 }),
      }),
    }),
    execute: async (_toolCallId, parameters) => {
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
