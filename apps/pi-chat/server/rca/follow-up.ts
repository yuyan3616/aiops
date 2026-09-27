import { InvestigationRepository } from "./repository";
import type { Evidence, ExpertKind, Hypothesis, Investigation, InvestigationEvent } from "./types";

export type FollowUpIntent =
  | "root-cause"
  | "alternative"
  | "key-evidence"
  | "evidence-detail"
  | "hypothesis-lifecycle"
  | "rejected-hypotheses"
  | "uncertainty"
  | "confidence"
  | "expert-history"
  | "tool-history"
  | "counterfactual"
  | "indirect-evidence"
  | "summary";

export interface FollowUpAnswer {
  investigationId: string;
  intent: FollowUpIntent;
  thinking: string;
  answer: string;
  evidenceIds: string[];
  toolCallIds: string[];
  usedNewTools: false;
}

interface InvestigationContext {
  investigation: Investigation;
  events: InvestigationEvent[];
}

const expertLabels: Record<ExpertKind, string> = {
  trace: "Trace Expert",
  metrics: "Metrics Expert",
  log: "Log Expert",
  "event-topology": "Event / Topology Expert",
};

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function evidenceLine(evidence: Evidence): string {
  return `**${evidence.id} — ${evidence.modality.toUpperCase()}**\n\n${evidence.summary}`;
}

function hypothesisLine(hypothesis: Hypothesis): string {
  return `**${hypothesis.id} — ${hypothesis.status}**\n\n${hypothesis.statement}`;
}

function explicitId(question: string, prefix: "E" | "H"): string | undefined {
  return question.toUpperCase().match(new RegExp(`\\b${prefix}\\d{1,3}\\b`))?.[0];
}

export function extractInvestigationId(question: string): string | undefined {
  return question.match(/\bINV-[A-Za-z0-9-]+\b/)?.[0];
}

export function requestsFreshInvestigation(question: string): boolean {
  return /(?:重新查|重新查询|再查一遍|再帮我确认|寻找新证据|再找.*证据|有没有.*(?:其他|新).*证据)|(?:re-?run|recheck|query again)/i.test(
    question,
  );
}

export function isInvestigationFollowUp(question: string): boolean {
  if (requestsFreshInvestigation(question)) return true;
  return /(?:为什么|依据|证据|evidence|\bE\d+\b|\bH\d+\b|假设|置信度|confidence|不确定|没有完全确认|查询过|调用过|Trace Expert|Metrics Expert|Log Expert|Event\s*\/\s*Topology Expert|根因|结论|排除|反事实|如果没有|如果.*不成立|间接证据|扩大时间窗口|换个时间窗口|expand.*window)/i.test(
    question,
  );
}

export class InvestigationFollowUpService {
  private readonly repository: InvestigationRepository;

  constructor(repository: InvestigationRepository) {
    this.repository = repository;
  }

  async answer(investigationId: string, question: string): Promise<FollowUpAnswer> {
    const context: InvestigationContext = {
      investigation: await this.repository.get(investigationId),
      events: await this.repository.listEvents(investigationId),
    };
    if (!context.investigation.rootCause) {
      return this.result(
        context,
        "summary",
        "正在读取尚未完成的 Investigation 状态。",
        "这次调查还没有形成 Root Cause，当前只能解释已经收集到的 Evidence 和 Hypothesis 状态。",
      );
    }

    if (/(?:扩大时间窗口|换个时间窗口|expand.*window)/i.test(question)) {
      return this.result(
        context,
        "summary",
        "当前问题需要新的遥测查询，已有 Investigation 无法回答扩窗后的结果。",
        `原调查窗口是 **${context.investigation.scope.timeRange.from} 至 ${context.investigation.scope.timeRange.to}**。扩大窗口属于新的 reassessment，不能通过重新解释现有 Evidence 得出。当前没有静默重查或修改原调查；需要创建带明确新时间范围的 Investigation revision。`,
      );
    }

    const evidenceId = explicitId(question, "E");
    if (
      evidenceId &&
      /(?:什么|详情|具体|来源|query|查询|rawRef|不成立|没有|去掉|排除)/i.test(question)
    ) {
      if (/(?:不成立|没有|去掉|排除)/i.test(question)) {
        return this.counterfactual(context, evidenceId);
      }
      return this.evidenceDetail(context, evidenceId);
    }

    const hypothesisId = explicitId(question, "H");
    if (hypothesisId) return this.hypothesisLifecycle(context, hypothesisId);
    if (/(?:Trace|Metrics|Log|Event|Topology)\s*Expert/i.test(question)) {
      return this.expertHistory(context, question);
    }
    if (/(?:置信度|confidence)/i.test(question)) return this.confidence(context);
    if (/(?:查询过|调用过|哪些数据|哪些工具|tool call)/i.test(question)) {
      return this.toolHistory(context);
    }
    if (/(?:最关键|关键的.*证据|哪个.*Evidence)/i.test(question)) {
      return this.keyEvidence(context);
    }
    if (/(?:哪些假设.*排除|排除了.*假设)/i.test(question)) {
      return this.rejectedHypotheses(context);
    }
    if (/(?:间接证据)/i.test(question)) return this.indirectEvidence(context);
    if (/(?:不确定|没有完全确认|还缺|尚未确认|没确认)/i.test(question)) {
      return this.uncertainty(context);
    }
    if (/(?:为什么不是|为何不是|排除.*问题|自己的问题|网络.*问题|网络异常)/i.test(question)) {
      return this.alternative(context, question);
    }
    if (/(?:为什么.*根因|为何.*根因|为什么.*导致|依据.*根因|为什么是)/i.test(question)) {
      return this.rootCause(context);
    }
    return this.summary(context);
  }

  private rootCause(context: InvestigationContext): FollowUpAnswer {
    const { investigation } = context;
    const result = investigation.rootCause!;
    const evidence = this.rootEvidence(investigation);
    const rejected = investigation.hypotheses.filter((item) =>
      result.rejectedHypotheses.includes(item.id),
    );
    const answer = [
      `当前把 **${result.rootCauseEntities.join("、") || "该异常路径"}** 作为根因位置，来自多条已有 Evidence 的相互印证，而不是根据告警名称直接猜测。`,
      ...evidence.map(evidenceLine),
      rejected.length > 0
        ? `同时，竞争方向 ${rejected.map((item) => item.id).join("、")} 已被反证削弱或排除。`
        : "目前没有竞争假设被完全排除。",
      result.mechanism ? `**机制判断：** ${result.mechanism}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return this.result(
      context,
      "root-cause",
      `正在回看 ${investigation.id} 的 Root Cause、支持 Evidence 和竞争假设。此次回答不会重新查询数据。`,
      answer,
      evidence.map((item) => item.id),
    );
  }

  private evidenceDetail(context: InvestigationContext, evidenceId: string): FollowUpAnswer {
    const evidence = context.investigation.evidence.find((item) => item.id === evidenceId);
    if (!evidence) {
      return this.result(
        context,
        "evidence-detail",
        `正在查找 ${evidenceId}。`,
        `当前 Investigation 中不存在 ${evidenceId}。已有 Evidence：${context.investigation.evidence.map((item) => item.id).join("、") || "无"}。`,
      );
    }
    const call = context.investigation.toolCalls.find((item) => item.id === evidence.toolCallId);
    const answer = `## ${evidence.id} Evidence Summary

**Source：** ${evidence.modality}

**Entity：** ${evidence.entity ?? "未指定"}

**Time Range：** ${evidence.timeRange ? `${evidence.timeRange.from} 至 ${evidence.timeRange.to}` : "未指定"}

**Finding：** ${evidence.summary}

**Supports：** ${evidence.supports.join("、") || "无"}

**Contradicts：** ${evidence.contradicts.join("、") || "无"}

**Tool Call：** ${call ? `${call.id} / ${call.tool}` : evidence.toolCallId || "未记录"}

**Query：**

\`\`\`json
${JSON.stringify(evidence.sourceQuery, null, 2)}
\`\`\`

**rawRef：** \`${evidence.rawRef}\`

这里默认只展示查询和结论摘要，没有展开原始遥测数据。`;
    return this.result(
      context,
      "evidence-detail",
      `正在从 Investigation Artifact 中读取 ${evidence.id} 及其来源 Tool Call。`,
      answer,
      [evidence.id],
      call ? [call.id] : [],
    );
  }

  private hypothesisLifecycle(context: InvestigationContext, hypothesisId: string): FollowUpAnswer {
    const hypothesis = context.investigation.hypotheses.find((item) => item.id === hypothesisId);
    if (!hypothesis) {
      return this.result(
        context,
        "hypothesis-lifecycle",
        `正在查找 ${hypothesisId}。`,
        `当前 Investigation 中不存在 ${hypothesisId}。`,
      );
    }
    const history = context.events
      .filter(
        (event) =>
          (event.type === "hypothesis.created" &&
            (event.payload.hypothesis as Hypothesis | undefined)?.id === hypothesisId) ||
          (event.type === "hypothesis.updated" && event.payload.hypothesisId === hypothesisId),
      )
      .map((event) => {
        if (event.type === "hypothesis.created") {
          const created = event.payload.hypothesis as Hypothesis;
          return `${event.at}：创建为 ${created.status}`;
        }
        return `${event.at}：${String(event.payload.previous)} → ${String(event.payload.current)}`;
      });
    const supporting = this.evidenceByIds(context.investigation, hypothesis.supportingEvidenceIds);
    const contradicting = this.evidenceByIds(
      context.investigation,
      hypothesis.contradictingEvidenceIds,
    );
    const answer = [
      hypothesisLine(hypothesis),
      `**状态历史**\n\n${history.map((item) => `- ${item}`).join("\n") || "未记录状态变化。"}`,
      supporting.length > 0
        ? `**支持证据**\n\n${supporting.map(evidenceLine).join("\n\n")}`
        : "**支持证据：** 无",
      contradicting.length > 0
        ? `**反对证据**\n\n${contradicting.map(evidenceLine).join("\n\n")}`
        : "**反对证据：** 无",
      `当前状态仍以原 Investigation 中的 **${hypothesis.status}** 为准，本次解释没有修改它。`,
    ].join("\n\n");
    return this.result(
      context,
      "hypothesis-lifecycle",
      `正在回放 ${hypothesisId} 的创建、状态变化和 Evidence 关联。`,
      answer,
      [...hypothesis.supportingEvidenceIds, ...hypothesis.contradictingEvidenceIds],
    );
  }

  private alternative(context: InvestigationContext, question: string): FollowUpAnswer {
    const { investigation } = context;
    const lower = question.toLowerCase();
    const alertService = investigation.alertContext.service?.toLowerCase();
    const hypothesis = investigation.hypotheses.find((item) => {
      if (/(?:网络|network)/i.test(question)) {
        return /network|infrastructure/i.test(item.statement);
      }
      if (alertService && lower.includes(alertService)) {
        return (
          item.entity?.toLowerCase() === alertService ||
          item.statement.toLowerCase().includes(alertService)
        );
      }
      return item.status === "rejected";
    });
    if (!hypothesis) return this.summary(context);
    const supporting = this.evidenceByIds(investigation, hypothesis.supportingEvidenceIds);
    const contradicting = this.evidenceByIds(investigation, hypothesis.contradictingEvidenceIds);
    const statusExplanation =
      hypothesis.status === "rejected"
        ? "该方向已被原调查标记为 rejected。"
        : hypothesis.status === "possible" || hypothesis.status === "investigating"
          ? "该方向没有得到足够的正向证据，但也没有被完全排除。"
          : `该方向当前状态是 ${hypothesis.status}，不能表述为已经排除。`;
    const answer = [
      hypothesisLine(hypothesis),
      statusExplanation,
      supporting.length > 0
        ? `**支持这一方向的证据**\n\n${supporting.map(evidenceLine).join("\n\n")}`
        : "**支持这一方向的证据：** 当前没有。",
      contradicting.length > 0
        ? `**削弱这一方向的证据**\n\n${contradicting.map(evidenceLine).join("\n\n")}`
        : "**明确反对这一方向的证据：** 当前没有。",
    ].join("\n\n");
    return this.result(
      context,
      "alternative",
      `正在对照相关 Hypothesis 的支持证据、反证和最终状态，避免把“缺少支持”误说成“已经排除”。`,
      answer,
      [...hypothesis.supportingEvidenceIds, ...hypothesis.contradictingEvidenceIds],
    );
  }

  private keyEvidence(context: InvestigationContext): FollowUpAnswer {
    const evidence = this.rootEvidence(context.investigation).sort(
      (left, right) => this.evidenceScore(right) - this.evidenceScore(left),
    );
    const key = evidence[0];
    if (!key) return this.summary(context);
    const corroborating = evidence.slice(1);
    const answer = [
      `最关键的是 **${key.id}（${key.modality}）**。它得分最高是因为它直接参与 Root Cause 的 Evidence Chain，并优先定位异常传播位置。`,
      evidenceLine(key),
      corroborating.length > 0
        ? `它不是单独完成归因；${corroborating.map((item) => `${item.id}（${item.modality}）`).join("、")} 提供了独立模态的交叉验证。`
        : "当前没有第二种独立模态与它交叉验证，因此结论强度有限。",
    ].join("\n\n");
    return this.result(
      context,
      "key-evidence",
      "正在按照原 Root Cause 引用关系和证据模态选择关键 Evidence，不重新计算原调查结果。",
      answer,
      evidence.map((item) => item.id),
    );
  }

  private rejectedHypotheses(context: InvestigationContext): FollowUpAnswer {
    const rejected = context.investigation.hypotheses.filter((item) => item.status === "rejected");
    const evidenceIds = unique(rejected.flatMap((item) => item.contradictingEvidenceIds));
    const answer =
      rejected.length > 0
        ? rejected
            .map((item) => {
              const evidence = this.evidenceByIds(
                context.investigation,
                item.contradictingEvidenceIds,
              );
              return `${hypothesisLine(item)}\n\n${evidence.length > 0 ? `排除依据：\n\n${evidence.map(evidenceLine).join("\n\n")}` : "没有记录明确反证。"}`;
            })
            .join("\n\n")
        : "本次调查没有 Hypothesis 被标记为 rejected。";
    return this.result(
      context,
      "rejected-hypotheses",
      "正在读取最终 Hypothesis 状态及其 contradictingEvidenceIds。",
      answer,
      evidenceIds,
    );
  }

  private uncertainty(context: InvestigationContext): FollowUpAnswer {
    const { investigation } = context;
    const unresolved = investigation.hypotheses.filter((item) =>
      ["possible", "investigating"].includes(item.status),
    );
    const missing = investigation.rootCause?.missingEvidence ?? [];
    const answer = [
      missing.length > 0
        ? `**缺少的直接证据**\n\n${missing.map((item) => `- ${item}`).join("\n")}`
        : "没有登记额外的 Missing Evidence。",
      unresolved.length > 0
        ? `**仍未完全关闭的方向**\n\n${unresolved.map(hypothesisLine).join("\n\n")}`
        : "所有候选方向都已经得到明确状态。",
      "因此，当前结论应按原状态理解为 evidence-supported 判断，而不是对所有底层机制的绝对证明。",
    ].join("\n\n");
    return this.result(
      context,
      "uncertainty",
      "正在检查 Root Cause 的 missingEvidence 和仍处于 possible/investigating 的 Hypothesis。",
      answer,
    );
  }

  private confidence(context: InvestigationContext): FollowUpAnswer {
    const result = context.investigation.rootCause!;
    const evidence = this.rootEvidence(context.investigation);
    const modalities = unique(evidence.map((item) => item.modality));
    const answer = `**Confidence：${result.confidence.toFixed(2)}**

这个数值是当前 RCA 规则对证据强度的表达，不是严格统计概率。

它主要来自：

- Root Cause 由 ${evidence.map((item) => item.id).join("、") || "无 Evidence"} 支持；
- 覆盖 ${modalities.join("、") || "零"} 等 ${modalities.length} 类独立观测模态；
- 已排除的竞争假设：${result.rejectedHypotheses.join("、") || "无"}。

没有达到 1.0，是因为：

${(result.missingEvidence ?? []).map((item) => `- ${item}`).join("\n") || "- 仍缺少能够直接证明底层机制的独立证据。"}`;
    return this.result(
      context,
      "confidence",
      "正在解释原调查的 Confidence 构成；不会把规则分数描述成统计概率。",
      answer,
      evidence.map((item) => item.id),
    );
  }

  private expertHistory(context: InvestigationContext, question: string): FollowUpAnswer {
    const kind: ExpertKind = /Metrics/i.test(question)
      ? "metrics"
      : /Log/i.test(question)
        ? "log"
        : /Event|Topology/i.test(question)
          ? "event-topology"
          : "trace";
    const tasks = context.investigation.expertTasks.filter((item) => item.expert === kind);
    if (tasks.length === 0) {
      return this.result(
        context,
        "expert-history",
        `正在查找 ${expertLabels[kind]} 的任务记录。`,
        `${expertLabels[kind]} 在本次 Investigation 中没有执行任务。`,
      );
    }
    const toolIds = unique(tasks.flatMap((task) => task.toolCallIds));
    const evidenceIds = unique(tasks.flatMap((task) => task.evidenceIds));
    const calls = context.investigation.toolCalls.filter((call) => toolIds.includes(call.id));
    const evidence = this.evidenceByIds(context.investigation, evidenceIds);
    const answer = tasks
      .map(
        (task) => `## ${expertLabels[kind]} / ${task.id}

**任务：** ${task.objective}

**状态：** ${task.status}

**调用的工具：**

${calls.map((call) => `- ${call.id} — ${call.tool}：${call.resultSummary ?? call.status}`).join("\n") || "- 无"}

**产生的 Evidence：**

${evidence.map(evidenceLine).join("\n\n") || "没有产生 Evidence。"}`,
      )
      .join("\n\n");
    return this.result(
      context,
      "expert-history",
      `正在回放 ${expertLabels[kind]} 的 ExpertTask、ToolCall 和 Evidence，不重新执行工具。`,
      answer,
      evidenceIds,
      toolIds,
    );
  }

  private toolHistory(context: InvestigationContext): FollowUpAnswer {
    const taskById = new Map(context.investigation.expertTasks.map((task) => [task.id, task]));
    const answer = context.investigation.toolCalls
      .map((call) => {
        const task = call.expertTaskId ? taskById.get(call.expertTaskId) : undefined;
        const owner = task ? expertLabels[task.expert] : "RCA Orchestrator";
        return `- **${call.id} / ${call.tool}**（${owner}）— ${call.resultSummary ?? call.status}\n  Query: \`${JSON.stringify(call.query)}\``;
      })
      .join("\n");
    return this.result(
      context,
      "tool-history",
      "正在读取原 Investigation 的 ToolCall 记录；不会再次调用这些工具。",
      `本次调查共记录 ${context.investigation.toolCalls.length} 次 Tool Call：\n\n${answer}`,
      [],
      context.investigation.toolCalls.map((item) => item.id),
    );
  }

  private counterfactual(context: InvestigationContext, removedId: string): FollowUpAnswer {
    const original = this.rootEvidence(context.investigation);
    const remaining = original.filter((item) => item.id !== removedId);
    const modalities = unique(remaining.map((item) => item.modality));
    const removed = context.investigation.evidence.find((item) => item.id === removedId);
    if (!removed) return this.evidenceDetail(context, removedId);
    const stillMeetsRule = modalities.length >= 2;
    const answer = `这是一次临时反事实评估，不会修改原 Investigation。

去除 **${removedId}** 后，Root Cause 还剩：${remaining.map((item) => `${item.id}（${item.modality}）`).join("、") || "没有支持证据"}。

剩余证据覆盖 ${modalities.length} 类模态。按照当前调查要求的“至少两种独立模态支持同一根因”规则：

${stillMeetsRule ? "原结论仍能维持，但证据链变弱，Confidence 应低于原值。" : "原来的 probable/confirmed 强度无法维持，应降为 inconclusive，直到补充新的独立证据。"}

原始 Root Cause、Hypothesis 状态和 Confidence 均保持不变。`;
    return this.result(
      context,
      "counterfactual",
      `正在对 ${removedId} 做只读反事实重评估，不写回 Investigation。`,
      answer,
      remaining.map((item) => item.id),
    );
  }

  private indirectEvidence(context: InvestigationContext): FollowUpAnswer {
    const rootIds = new Set(context.investigation.rootCause!.evidenceIds);
    const indirect = context.investigation.evidence.filter(
      (item) =>
        !rootIds.has(item.id) ||
        item.modality === "topology" ||
        item.supports.length === 0 ||
        item.summary.toLowerCase().startsWith("no "),
    );
    const answer = `Investigation 没有单独存储“direct/indirect”字段，下面是按用途作出的解释性分类，并未修改原 Evidence：

${indirect.map(evidenceLine).join("\n\n") || "没有识别出明显的间接或背景证据。"}

这些 Evidence 主要用于排除资源饱和、补充拓扑位置或说明缺失观测，不能单独证明 Root Cause。`;
    return this.result(
      context,
      "indirect-evidence",
      "正在区分直接参与 Root Cause 的 Evidence 与背景、负向或拓扑证据。",
      answer,
      indirect.map((item) => item.id),
    );
  }

  private summary(context: InvestigationContext): FollowUpAnswer {
    const result = context.investigation.rootCause!;
    const evidence = this.rootEvidence(context.investigation);
    return this.result(
      context,
      "summary",
      `正在回看 ${context.investigation.id} 的完整调查记录。`,
      `当前结论是 **${result.rootCauseEntities.join("、") || "未定位"}**，状态为 **${result.status}**，Confidence 为 **${result.confidence.toFixed(2)}**。\n\n${result.summary}\n\n主要 Evidence：${evidence.map((item) => item.id).join("、") || "无"}。`,
      evidence.map((item) => item.id),
    );
  }

  private rootEvidence(investigation: Investigation): Evidence[] {
    return this.evidenceByIds(investigation, investigation.rootCause?.evidenceIds ?? []);
  }

  private evidenceByIds(investigation: Investigation, ids: string[]): Evidence[] {
    const wanted = new Set(ids);
    return investigation.evidence.filter((item) => wanted.has(item.id));
  }

  private evidenceScore(evidence: Evidence): number {
    return { trace: 60, metric: 50, log: 40, event: 30, topology: 20, alert: 10 }[
      evidence.modality
    ];
  }

  private result(
    context: InvestigationContext,
    intent: FollowUpIntent,
    thinking: string,
    answer: string,
    evidenceIds: string[] = [],
    toolCallIds: string[] = [],
  ): FollowUpAnswer {
    return {
      investigationId: context.investigation.id,
      intent,
      thinking,
      answer,
      evidenceIds: unique(evidenceIds),
      toolCallIds: unique(toolCallIds),
      usedNewTools: false,
    };
  }
}
