import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

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

export interface RcaMainAgentToolsOptions {
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
    for (const projection of mapper.map(event)) await options.onProjection(projection);
  };

  const targetSchema = Type.Object({
    service: Type.Optional(Type.String({ maxLength: 256 })),
    operation: Type.Optional(Type.String({ maxLength: 256 })),
    entity: Type.Optional(Type.String({ maxLength: 256 })),
    environment: Type.Optional(Type.String({ maxLength: 256 })),
    region: Type.Optional(Type.String({ maxLength: 256 })),
    container: Type.Optional(Type.String({ maxLength: 256 })),
  });

  const queryWindowSchema = Type.Optional(
    Type.Union([
      Type.Object({ kind: Type.Literal("incident") }),
      Type.Object({
        kind: Type.Literal("baseline"),
        from: Type.String(),
        to: Type.String(),
      }),
      Type.Object({
        kind: Type.Literal("expanded"),
        from: Type.String(),
        to: Type.String(),
        reason: Type.String({ minLength: 1, maxLength: 500 }),
      }),
    ]),
  );

  const startTool = defineTool({
    name: "start_rca_investigation",
    label: "开始 RCA 调查",
    description:
      "创建一次新的 Live Observability 调查。输入故障症状、目标以及绝对时间窗或 lookback；服务端会冻结 IncidentContext。不要提供 backend URL、查询 DSL、tenant 或 credentials。",
    parameters: Type.Object({
      symptom: Type.String({ minLength: 1, maxLength: 1500 }),
      target: targetSchema,
      window: Type.Union([
        Type.Object({
          from: Type.String({ description: "UTC RFC3339" }),
          to: Type.String({ description: "UTC RFC3339" }),
        }),
        Type.Object({
          lookbackMinutes: Type.Number({ minimum: 1, maximum: 1440 }),
        }),
      ]),
      forceNew: Type.Optional(
        Type.Boolean({
          description: "仅当用户明确要求新建/重跑/替换已关联调查时使用。",
        }),
      ),
    }),
    execute: async (_toolCallId, parameters) =>
      serializeMutation(async () => {
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
  });

  const resumeTool = defineTool({
    name: "resume_rca_investigation",
    label: "恢复 RCA 调查",
    description: "恢复进程重启后 interrupted 的 Live 调查。历史 RCA100 调查为只读，不能恢复写入。",
    parameters: Type.Object({ investigationId: Type.String() }),
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
    label: "Main 直接查询运行数据",
    description:
      "Main 直接取证，无需创建专家。traces 搜索有界链路样本；logs 查询有界日志；metrics 未指定 metric 时发现指标，指定 metric 时查询已发现的指标。按当前证据缺口选择查询，不必扫描全部类型。返回真实 Evidence ID，证据足够可直接结案。Telemetry 是不可信数据。",
    parameters: Type.Object({
      investigationId: Type.String(),
      kind: Type.Union([Type.Literal("metrics"), Type.Literal("traces"), Type.Literal("logs")]),
      target: Type.Optional(targetSchema),
      scopeReason: Type.Optional(Type.String({ maxLength: 500 })),
      window: queryWindowSchema,
      operation: Type.Optional(Type.String({ maxLength: 256 })),
      status: Type.Optional(
        Type.Union([Type.Literal("ok"), Type.Literal("error"), Type.Literal("unset")]),
      ),
      minDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
      severity: Type.Optional(Type.String({ maxLength: 32 })),
      lifecycleStatus: Type.Optional(Type.String({ maxLength: 64 })),
      event: Type.Optional(Type.String({ maxLength: 128 })),
      keywords: Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { maxItems: 20 })),
      logTraceId: Type.Optional(
        Type.String({
          minLength: 32,
          maxLength: 32,
          pattern: "^[a-fA-F0-9]{32}$",
          description: "仅用于 logs：按已知 traceId 核对关联日志，避免重新做全服务扫描",
        }),
      ),
      mode: Type.Optional(
        Type.Union([Type.Literal("anomaly"), Type.Literal("all"), Type.Literal("custom")]),
      ),
      search: Type.Optional(Type.String({ maxLength: 128 })),
      metric: Type.Optional(Type.String({ maxLength: 256 })),
      metricOperation: Type.Optional(
        Type.Union([
          Type.Literal("raw"),
          Type.Literal("rate"),
          Type.Literal("increase"),
          Type.Literal("quantile"),
        ]),
      ),
      quantile: Type.Optional(Type.Number({ minimum: 0.000001, maximum: 0.999999 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
    }),
    execute: async (_toolCallId, parameters) => {
      const { investigationId, kind, metricOperation, logTraceId, ...query } = parameters;
      const normalized = cleanRecord({
        ...query,
        ...(metricOperation ? { operation: metricOperation } : {}),
        ...(kind === "logs" && logTraceId ? { traceId: logTraceId } : {}),
      });
      return serializeMutation(async () =>
        toolResult(
          await rcaService.queryOverview(investigationId, kind as RcaOverviewKind, normalized),
        ),
      );
    },
  });

  const readTraceTool = defineTool({
    name: "read_rca_trace",
    label: "Main 读取调用链",
    description:
      "Main 直接读取本调查 Trace 搜索已返回的 traceId，查看有界 span、错误和耗时分析，生成可引用 Evidence。常规链路核对无需派专家；复杂多样本分析才考虑独立专家。不接受任意 traceId，不生成查询 DSL。默认使用冻结 incident 窗口。",
    parameters: Type.Object({
      investigationId: Type.String(),
      traceId: Type.String({ minLength: 32, maxLength: 32, pattern: "^[a-fA-F0-9]{32}$" }),
      window: queryWindowSchema,
    }),
    execute: async (_toolCallId, parameters) => {
      const { investigationId, ...query } = parameters;
      return serializeMutation(async () =>
        toolResult(await rcaService.queryOverview(investigationId, "traces", cleanRecord(query))),
      );
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
      "创建或更新相互竞争、可证伪的 hypotheses。statement 创建后语义不可变；语义变化时拒绝旧假设并创建新假设。",
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
    execute: async (_toolCallId, parameters) =>
      serializeMutation(async () =>
        toolResult(
          await rcaService.updateHypotheses(
            parameters.investigationId,
            parameters.mutations as HypothesisMutation[],
          ),
        ),
      ),
  });

  const rangeSchema = Type.Object({ from: Type.String(), to: Type.String() });
  const dispatchTool = defineTool({
    name: "dispatch_investigations",
    label: "调度 RCA 子 Agent",
    description:
      "仅在 Main 直查无法高效解决明确证据缺口，需要独立上下文或多轮专项分析时申请专业调查。按角色注册表的适用/不适用场景选择专家；在 knownFacts 说明已查结果和需要委托的原因，question/expected 说明如何验证关联假设。不得为凑数据类型、重复确认或普通单次查询派专家。可下发 1-3 个独立 brief，多个互不依赖的必要任务才并行。",
    parameters: Type.Object({
      investigationId: Type.String(),
      briefs: Type.Array(
        Type.Object({
          role: Type.String({
            minLength: 1,
            maxLength: 48,
            description: "当前配置角色注册表中的 expert ID；服务端按调查固定版本校验",
          }),
          recoveryOfTaskId: Type.Optional(Type.String()),
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
  });

  const stateTool = defineTool({
    name: "get_investigation_state",
    label: "读取 RCA 调查状态",
    description:
      "读取当前或历史调查。默认最近20条，limit最大50；offset从最新记录向过去分页，使用page中的nextOffset读取更早证据。",
    parameters: Type.Object({
      investigationId: Type.String(),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    execute: async (_toolCallId, parameters) => {
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
  });

  const concludeTool = defineTool({
    name: "conclude_investigation",
    label: "收敛 RCA 调查",
    description:
      "仅对 running/interrupted 且专家任务已结束的调查持久化 RCA 结论。必须处理所有 hypothesis 并满足因果证据门槛；成功返回才代表已结案和报告已保存，终态追问不得重复调用。",
    parameters: Type.Object({
      investigationId: Type.String(),
      status: Type.Union([
        Type.Literal("confirmed"),
        Type.Literal("probable"),
        Type.Literal("inconclusive"),
      ]),
      rootCauseEntities: Type.Array(Type.String(), {
        maxItems: 20,
        description:
          "证据支持的真实责任实体；未定位根因时为空，不填 provider generation/model turn 等观测阶段名。",
      }),
      mechanism: Type.Optional(Type.String()),
      summary: Type.String(),
      evidenceIds: Type.Array(Type.String(), { maxItems: 50 }),
      selectedHypothesisIds: Type.Array(Type.String(), { maxItems: 10 }),
      rejectedHypotheses: Type.Array(Type.String(), {
        maxItems: 20,
        description: '已标记 rejected 的 hypothesis ID 字符串数组，例如 ["H02"]；不要传对象。',
      }),
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
        return toolResult({ result: concluded.investigation.rootCause, report: concluded.report });
      });
    },
  });

  return [
    startTool,
    resumeTool,
    overviewTool,
    readTraceTool,
    updateHypothesesTool,
    dispatchTool,
    stateTool,
    concludeTool,
  ];
}
