import type {
  IncidentContext,
  Investigation,
  InvestigationStatus,
  InvestigationUserIntervention,
} from "./types";

export type ConversationRcaState = "idle" | "unavailable" | InvestigationStatus;

export interface ConversationRcaContext {
  state: ConversationRcaState;
  investigationId?: string;
  caseId?: string;
  sourceKind?: "live" | "legacy";
  incident?: IncidentContext;
  symptom?: string;
  rounds?: number;
  rootCauseStatus?: "confirmed" | "probable" | "inconclusive";
  userInterventions?: InvestigationUserIntervention[];
}

export interface StartRcaDecision {
  allowed: boolean;
  recommendedAction?:
    | "continue_active_investigation"
    | "resume_active_investigation"
    | "read_active_investigation"
    | "explicit_new_investigation_required";
  reason?: string;
}

export function idleConversationRcaContext(): ConversationRcaContext {
  return { state: "idle" };
}

export function unavailableConversationRcaContext(
  investigationId: string,
): ConversationRcaContext {
  return { state: "unavailable", investigationId };
}

export function conversationRcaContextFromInvestigation(
  investigation: Investigation,
): ConversationRcaContext {
  return {
    state: investigation.status,
    investigationId: investigation.id,
    ...(investigation.caseId ? { caseId: investigation.caseId } : {}),
    sourceKind: investigation.source?.kind === "live" ? "live" : "legacy",
    ...(investigation.context ? { incident: investigation.context } : {}),
    symptom: investigation.symptom,
    rounds: investigation.rounds,
    ...(investigation.rootCause?.status
      ? { rootCauseStatus: investigation.rootCause.status }
      : {}),
    ...(investigation.userInterventions?.length
      ? { userInterventions: investigation.userInterventions.slice(-12) }
      : {}),
  };
}

function investigationLabel(context: ConversationRcaContext): string {
  if (context.caseId) return `case ${context.caseId}`;
  if (context.incident?.target.service) return `service ${context.incident.target.service}`;
  if (context.incident?.target.entity) return `entity ${context.incident.target.entity}`;
  if (context.incident?.target.container) return `container ${context.incident.target.container}`;
  return context.symptom ?? "current incident";
}

export function renderConversationRcaContext(
  context: ConversationRcaContext,
): string {
  if (context.state === "idle") {
    return [
      "## 当前 RCA 上下文（服务端权威状态 / server-authoritative）",
      "- state: idle",
      "- active investigation: none（无）",
      "",
      "普通问题按普通对话处理。只有用户明确要求调查、诊断、排障或定位故障根因时，才启动新的 Live Investigation。",
    ].join("\n");
  }

  if (context.state === "unavailable") {
    return [
      "## 当前 RCA 上下文（服务端权威状态 / server-authoritative）",
      "- state: unavailable",
      `- active investigation: ${context.investigationId ?? "unknown"}`,
      "",
      "当前会话关联的调查持久化状态不可用。不要根据旧聊天记录推断当前状态。只有用户明确要求新建调查时，才设置 forceNew=true。",
    ].join("\n");
  }

  const interventionLines = context.userInterventions?.length
    ? [
        "",
        "## 调查中用户补充（user-provided context）",
        "以下内容来自用户，不是 telemetry evidence，不能据此伪造 evidence ID 或绕过验证。",
        ...context.userInterventions.map(
          (item) => `- [${item.id}] ${JSON.stringify(item.content)}`,
        ),
      ]
    : [];

  const liveLines = context.incident
    ? [
        `- source: ${context.sourceKind}`,
        `- symptom: ${JSON.stringify(context.incident.symptom)}`,
        `- frozen window: ${context.incident.window.from} .. ${context.incident.window.to}`,
        `- target: ${JSON.stringify(context.incident.target)}`,
      ]
    : [
        `- source: ${context.sourceKind ?? "legacy"}`,
        ...(context.caseId ? [`- legacy case: ${context.caseId}`] : []),
        ...(context.symptom ? [`- symptom: ${JSON.stringify(context.symptom)}`] : []),
      ];

  return [
    "## 当前 RCA 上下文（服务端权威状态 / server-authoritative）",
    `- state: ${context.state}`,
    `- active investigation: ${context.investigationId}`,
    ...liveLines,
    ...(context.rounds !== undefined ? [`- completed investigation rounds: ${context.rounds}`] : []),
    ...(context.rootCauseStatus ? [`- RCA result status: ${context.rootCauseStatus}`] : []),
    "",
    "本段是当前调查状态的唯一可信来源。Live IncidentContext 的原始 window/target 已冻结；后续查询只能通过服务端受控 scope 扩展。",
    ...(context.sourceKind === "legacy"
      ? [
          "这是历史 RCA100 调查，只允许读取、展示和追问解释；不得 resume、修改 hypothesis、dispatch、cancel、重新结案或写入 evidence。",
        ]
      : []),
    ...interventionLines,
    context.state === "interrupted" && context.sourceKind === "live"
      ? "该 Live 调查曾被中断。只有确实需要继续取证时才 resume；已有 evidence 仍可用于解释或直接形成结论。"
      : "除非用户明确要求重新运行、新建调查或替换当前调查，否则不要创建新的 Investigation。",
  ].join("\n");
}

export function decideStartRcaInvestigation(
  context: ConversationRcaContext,
  requestedIncident: string,
  forceNew: boolean,
): StartRcaDecision {
  if (context.state === "idle") return { allowed: true };

  if (context.state === "running") {
    return {
      allowed: false,
      recommendedAction: "continue_active_investigation",
      reason:
        `调查 ${context.investigationId ?? "unknown"}（${investigationLabel(context)}）仍在运行。继续当前调查，不要隐式替换。`,
    };
  }

  if (forceNew) return { allowed: true };

  if (context.state === "interrupted" && context.sourceKind === "live") {
    return {
      allowed: false,
      recommendedAction: "resume_active_investigation",
      reason:
        `调查 ${context.investigationId ?? "unknown"} 处于 interrupted。优先恢复或读取；只有用户明确要求新调查时才设置 forceNew=true。`,
    };
  }

  if (context.state === "unavailable") {
    return {
      allowed: false,
      recommendedAction: "explicit_new_investigation_required",
      reason:
        `关联调查 ${context.investigationId ?? "unknown"} 当前不可用。若用户明确要求为 ${requestedIncident.slice(0, 120)} 新建调查，再设置 forceNew=true。`,
    };
  }

  return {
    allowed: false,
    recommendedAction: "read_active_investigation",
    reason:
      `调查 ${context.investigationId ?? "unknown"}（${investigationLabel(context)}）已关联，状态为 ${context.state}。后续追问继续读取该调查；只有用户明确要求新建/重跑时才设置 forceNew=true。`,
  };
}
