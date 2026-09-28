import type {
  Investigation,
  InvestigationStatus,
  InvestigationUserIntervention,
} from "./types";

export type ConversationRcaState = "idle" | "unavailable" | InvestigationStatus;

export interface ConversationRcaContext {
  state: ConversationRcaState;
  investigationId?: string;
  caseId?: string;
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
    caseId: investigation.caseId,
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

export function renderConversationRcaContext(
  context: ConversationRcaContext,
): string {
  if (context.state === "idle") {
    return [
      "## 当前 RCA 上下文（服务端权威状态 / server-authoritative）",
      "- state: idle",
      "- active investigation: none（无）",
      "",
      "普通问题按普通对话处理。只有用户明确要求调查、诊断、排障或定位某个具体 case 的根因时，才启动 RCA 调查。",
    ].join("\n");
  }

  if (context.state === "unavailable") {
    return [
      "## 当前 RCA 上下文（服务端权威状态 / server-authoritative）",
      "- state: unavailable",
      `- active investigation: ${context.investigationId ?? "unknown"}`,
      "",
      "当前会话关联的调查持久化状态不可用。不要根据旧聊天记录推断它的当前状态。只有用户明确要求新建或重新运行调查时，才启动替代调查，并设置 forceNew=true。",
    ].join("\n");
  }

  const interventionLines = context.userInterventions?.length
    ? [
        "",
        "## 调查中用户补充（user-provided context）",
        "以下内容来自用户在调查运行过程中的补充，按 user-level input 理解；它不是 telemetry evidence，不能据此伪造 evidence ID 或跳过必要验证。",
        ...context.userInterventions.map(
          (item) => `- [${item.id}] ${JSON.stringify(item.content)}`,
        ),
      ]
    : [];

  return [
    "## 当前 RCA 上下文（服务端权威状态 / server-authoritative）",
    `- state: ${context.state}`,
    `- active investigation: ${context.investigationId}`,
    `- case: ${context.caseId}`,
    ...(context.rounds !== undefined ? [`- completed investigation rounds: ${context.rounds}`] : []),
    ...(context.rootCauseStatus ? [`- RCA result status: ${context.rootCauseStatus}`] : []),
    "",
    "即使旧聊天记录显示了不同状态，也必须把本段视为当前唯一可信状态。",
    ...interventionLines,
    "对于后续追问，继续沿用当前调查；需要持久化的 evidence、hypotheses 或结果时，调用 get_investigation_state。"
    context.state === "interrupted"
      ? "该调查曾被中断。只有确实需要继续取证时才 resume（恢复）；已有 evidence 仍可用于解释或直接形成结论。"
      : "除非用户明确要求重新运行、新建调查或调查另一个 case，否则不要为当前会话再次创建调查。",
    "当已经关联调查且用户明确要求替换/新建时，调用 start_rca_investigation，并设置 forceNew=true。",
  ].join("\n");
}

export function decideStartRcaInvestigation(
  context: ConversationRcaContext,
  requestedCaseId: string,
  forceNew: boolean,
): StartRcaDecision {
  if (context.state === "idle") return { allowed: true };

  if (context.state === "running") {
    return {
      allowed: false,
      recommendedAction: "continue_active_investigation",
      reason:
        `调查 ${context.investigationId ?? "unknown"}（case ${context.caseId ?? "unknown case"}）仍在运行。继续并先收敛当前调查，再考虑启动新的调查。`,
    };
  }

  if (forceNew) return { allowed: true };

  if (context.state === "interrupted") {
    return {
      allowed: false,
      recommendedAction: "resume_active_investigation",
      reason:
        `调查 ${context.investigationId ?? "unknown"}（case ${context.caseId ?? "unknown case"}）处于 interrupted。优先使用其持久化状态，或在需要更多取证时恢复；只有用户明确要求新调查时，才用 forceNew=true 重试。`,
    };
  }

  if (context.state === "unavailable") {
    return {
      allowed: false,
      recommendedAction: "explicit_new_investigation_required",
      reason:
        `关联调查 ${context.investigationId ?? "unknown"} 当前不可用。不要隐式替换它。如果用户明确要求为 ${requestedCaseId} 新建调查，再使用 forceNew=true 重试。`,
    };
  }

  return {
    allowed: false,
    recommendedAction: "read_active_investigation",
    reason:
      `调查 ${context.investigationId ?? "unknown"}（case ${context.caseId ?? "unknown case"}）已关联，当前状态为 ${context.state}。后续追问继续使用它。如果用户明确要求为 ${requestedCaseId} 新建或重跑调查，再使用 forceNew=true 重试。`,
  };
}
