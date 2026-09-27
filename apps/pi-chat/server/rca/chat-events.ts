import type { EventType } from "@shared/types";

import type {
  Evidence,
  ExpertKind,
  ExpertTask,
  Hypothesis,
  Investigation,
  InvestigationEvent,
  RCAResult,
  ToolCallRecord,
} from "./types";

export interface ChatStreamProjection {
  type: EventType;
  payload: Record<string, unknown>;
}

const expertLabels: Record<ExpertKind, string> = {
  trace: "Trace Expert",
  metrics: "Metrics Expert",
  log: "Log Expert",
  "event-topology": "Event / Topology Expert",
};

function expertLabel(task?: ExpertTask): string {
  return task ? expertLabels[task.expert] : "Expert";
}

function hypothesisStatus(status: string): string {
  return (
    {
      possible: "待验证",
      investigating: "调查中",
      supported: "获得支持",
      rejected: "已排除",
      confirmed: "已确认",
    }[status] ?? status
  );
}

function evidenceSummary(evidence: Evidence): string {
  const effects = [
    evidence.supports.length > 0 ? `支持 ${evidence.supports.join("、")}` : "",
    evidence.contradicts.length > 0 ? `削弱 ${evidence.contradicts.join("、")}` : "",
  ].filter(Boolean);
  return `**${evidence.id} · ${evidence.modality.toUpperCase()}**\n\n${evidence.summary}${effects.length > 0 ? `\n\n这条证据${effects.join("，")}。` : ""}`;
}

/**
 * Projects RCA business events onto Pi Chat's existing thinking/tool/message
 * protocol. It intentionally contains no investigation logic.
 */
export class RcaChatEventMapper {
  private readonly investigationId: string;
  private activeThinkingId?: string;
  private thinkingSequence = 0;
  private readonly toolToAgent = new Map<string, string>();

  constructor(investigationId: string) {
    this.investigationId = investigationId;
  }

  begin(): ChatStreamProjection[] {
    return this.reason(
      "我先读取告警上下文和故障时间范围，再从调用链开始判断延迟是服务自身产生，还是由下游依赖传播。",
    );
  }

  map(event: InvestigationEvent): ChatStreamProjection[] {
    switch (event.type) {
      case "investigation.started": {
        const alert = event.payload.alert as
          | {
              service?: string;
              operation?: string;
              window?: { from?: string; to?: string };
            }
          | undefined;
        return this.reason(
          [
            `已建立调查 **${event.investigationId}**。`,
            alert?.service ? `告警服务：${alert.service}` : "",
            alert?.operation ? `操作：${alert.operation}` : "",
            alert?.window?.from && alert.window.to
              ? `时间窗口：${alert.window.from} 至 ${alert.window.to}`
              : "",
            "接下来建立候选假设并逐项验证。",
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
      }
      case "hypothesis.created": {
        const hypothesis = event.payload.hypothesis as Hypothesis | undefined;
        if (!hypothesis) return [];
        return this.reason(
          `**${hypothesis.id} · ${hypothesisStatus(hypothesis.status)}**\n\n${hypothesis.statement}`,
        );
      }
      case "hypothesis.updated": {
        const id = String(event.payload.hypothesisId ?? "Hypothesis");
        const previous = String(event.payload.previous ?? "unknown");
        const current = String(event.payload.current ?? "unknown");
        const supporting = Array.isArray(event.payload.supportingEvidenceIds)
          ? event.payload.supportingEvidenceIds.join("、")
          : "";
        const contradicting = Array.isArray(event.payload.contradictingEvidenceIds)
          ? event.payload.contradictingEvidenceIds.join("、")
          : "";
        const references = [
          supporting ? `支持证据：${supporting}` : "",
          contradicting ? `反证：${contradicting}` : "",
          typeof event.payload.reason === "string" ? event.payload.reason : "",
        ].filter(Boolean);
        return this.reason(
          `**${id}：${hypothesisStatus(previous)} → ${hypothesisStatus(current)}**${references.length > 0 ? `\n\n${references.join("\n\n")}` : ""}`,
        );
      }
      case "expert.started": {
        const task = event.payload.expertTask as ExpertTask | undefined;
        if (!task) return [];
        const agentId = this.agentId(task.id);
        return [
          ...this.reason(
            `根据当前证据缺口，将下一步交给 **${expertLabel(task)}**：${task.objective}`,
          ),
          ...this.completeThinking(),
          {
            type: "agent.started",
            payload: {
              agent: {
                id: agentId,
                taskId: task.id,
                expert: task.expert,
                label: expertLabel(task),
                objective: task.objective,
                status: "running",
                tools: [],
                evidence: [],
                implementation: "deterministic",
              },
            },
          },
        ];
      }
      case "tool.started": {
        const call = event.payload.toolCall as ToolCallRecord | undefined;
        if (!call) return [];
        if (call.expertTaskId) {
          const agentId = this.agentId(call.expertTaskId);
          this.toolToAgent.set(call.id, agentId);
          return [
            {
              type: "agent.tool.started",
              payload: {
                agentId,
                tool: {
                  id: this.toolId(call.id),
                  name: call.tool,
                  args: call.query,
                  status: "running",
                  details: { expertTaskId: call.expertTaskId },
                },
              },
            },
          ];
        }
        return [
          ...this.completeThinking(),
          {
            type: "tool.started",
            payload: {
              id: this.toolId(call.id),
              name: call.tool,
              args: call.query,
              details: {},
            },
          },
        ];
      }
      case "tool.completed": {
        const call = event.payload.toolCall as ToolCallRecord | undefined;
        if (!call) return [];
        if (call.expertTaskId) {
          const agentId = this.agentId(call.expertTaskId);
          this.toolToAgent.set(call.id, agentId);
          return [
            {
              type: "agent.tool.completed",
              payload: {
                agentId,
                tool: {
                  id: this.toolId(call.id),
                  name: call.tool,
                  args: call.query,
                  status: call.status === "completed" ? "success" : "error",
                  result: call.resultSummary ?? call.error ?? event.summary,
                  details: {
                    expertTaskId: call.expertTaskId,
                    rawRef: call.rawRef,
                  },
                },
              },
            },
          ];
        }
        return [
          {
            type: "tool.completed",
            payload: {
              id: this.toolId(call.id),
              name: call.tool,
              args: call.query,
              status: call.status === "completed" ? "success" : "error",
              result: call.resultSummary ?? call.error ?? event.summary,
              details: { rawRef: call.rawRef },
            },
          },
        ];
      }
      case "evidence.created": {
        const evidence = event.payload.evidence as Evidence | undefined;
        if (!evidence) return [];
        const agentId = this.toolToAgent.get(evidence.toolCallId);
        if (agentId) {
          return [
            {
              type: "agent.evidence.added",
              payload: {
                agentId,
                evidence: {
                  id: evidence.id,
                  modality: evidence.modality,
                  summary: evidence.summary,
                },
              },
            },
          ];
        }
        return this.reason(evidenceSummary(evidence));
      }
      case "expert.completed": {
        const task = event.payload.expertTask as ExpertTask | undefined;
        if (!task) return [];
        return [
          {
            type: "agent.completed",
            payload: {
              agentId: this.agentId(task.id),
              status: task.status,
              summary: event.summary,
            },
          },
          ...this.reason(`**${expertLabel(task)} findings 已回传。**\n\n${event.summary}`),
        ];
      }
      case "round.completed":
        // Round bookkeeping remains in the investigation artifact. The chat
        // already contains the expert, tools, evidence, and hypothesis update.
        return [];
      case "investigation.completed": {
        const result = event.payload.result as RCAResult | undefined;
        const projections = this.reason(
          result
            ? `证据收集完成。当前结论为 **${result.status}**，置信度 **${result.confidence.toFixed(2)}**。即将整理最终 RCA 报告。`
            : "证据收集完成，正在整理最终 RCA 报告。",
        );
        return [...projections, ...this.completeThinking()];
      }
      case "investigation.failed":
      case "investigation.cancelled": {
        const projections = this.reason(
          event.type === "investigation.cancelled" ? "调查已取消。" : `调查失败：${event.summary}`,
        );
        return [...projections, ...this.completeThinking()];
      }
    }
  }

  private reason(text: string): ChatStreamProjection[] {
    const projections: ChatStreamProjection[] = [];
    const continuing = Boolean(this.activeThinkingId);
    if (!this.activeThinkingId) {
      this.activeThinkingId = `${this.investigationId}:thinking:${++this.thinkingSequence}`;
      projections.push({
        type: "thinking.started",
        payload: {
          id: this.activeThinkingId,
          source: "rca-projection",
          label: "调查过程",
        },
      });
    }
    projections.push({
      type: "thinking.delta",
      payload: {
        id: this.activeThinkingId,
        delta: `${continuing ? "\n\n" : ""}${text}`,
      },
    });
    return projections;
  }

  private completeThinking(): ChatStreamProjection[] {
    if (!this.activeThinkingId) return [];
    const id = this.activeThinkingId;
    this.activeThinkingId = undefined;
    return [{ type: "thinking.completed", payload: { id } }];
  }

  private toolId(callId: string): string {
    return `${this.investigationId}:${callId}`;
  }

  private agentId(taskId: string): string {
    return `${this.investigationId}:agent:${taskId}`;
  }
}

export function formatRcaFinalAnswer(investigation: Investigation): string {
  const result = investigation.rootCause;
  if (!result) return "RCA 调查结束，但没有形成可用结论。";
  const evidence = investigation.evidence
    .filter((item) => result.evidenceIds.includes(item.id))
    .map((item) => `${item.id} — ${item.modality.toUpperCase()}\n${item.summary}`)
    .join("\n\n");
  const rejected = investigation.hypotheses
    .filter((item) => result.rejectedHypotheses.includes(item.id))
    .map((item) => `${item.id} — ${item.statement}`)
    .join("\n\n");
  const missing = (result.missingEvidence ?? []).map((item) => `- ${item}`).join("\n");

  return `# RCA 调查结论

**状态：** ${result.status}

**根因实体：** ${result.rootCauseEntities.join("、") || "尚未定位"}

**置信度：** ${result.confidence.toFixed(2)}

${result.summary}

${result.mechanism ? `**故障机制：** ${result.mechanism}\n` : ""}
## 主要证据

${evidence || "现有证据不足以支持明确结论。"}

## 已排除方向

${rejected || "暂无。"}

## 仍缺少的证据

${missing || "无。"}

调查编号：\`${investigation.id}\``;
}

export function resolveRcaCaseId(input: string, defaultCaseId?: string): string | undefined {
  const command = /^\/rca\s+(t\d+)$/i.exec(input.trim());
  if (command) return command[1].toLowerCase();
  if (!defaultCaseId) return undefined;

  const asksToInvestigate =
    /(?:排查|定位|诊断|根因|故障分析)|(?:investigate|diagnose|root\s*cause)/i.test(input);
  const describesIncident =
    /(?:故障|问题|异常|响应时间|延迟|变慢|很慢|突增|报错|错误)|(?:incident|latency|slow|failure|outage|error)/i.test(
      input,
    );
  return asksToInvestigate && describesIncident ? defaultCaseId : undefined;
}
