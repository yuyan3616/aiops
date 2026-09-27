import type { Investigation, InvestigationStatus } from "./types";

export type ConversationRcaState = "idle" | "unavailable" | InvestigationStatus;

export interface ConversationRcaContext {
  state: ConversationRcaState;
  investigationId?: string;
  caseId?: string;
  symptom?: string;
  rounds?: number;
  rootCauseStatus?: "confirmed" | "probable" | "inconclusive";
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
  };
}

export function renderConversationRcaContext(
  context: ConversationRcaContext,
): string {
  if (context.state === "idle") {
    return [
      "## Current RCA context (server-authoritative)",
      "- state: idle",
      "- active investigation: none",
      "",
      "Use ordinary chat for ordinary questions. Start an RCA investigation only when the user is asking to investigate, diagnose, troubleshoot, or find the root cause of a concrete case.",
    ].join("\n");
  }

  if (context.state === "unavailable") {
    return [
      "## Current RCA context (server-authoritative)",
      "- state: unavailable",
      `- active investigation: ${context.investigationId ?? "unknown"}`,
      "",
      "The conversation points to an investigation whose persisted state is unavailable. Do not infer its state from old chat messages. Start a replacement investigation only when the user explicitly asks for a new or re-run investigation; set forceNew=true.",
    ].join("\n");
  }

  return [
    "## Current RCA context (server-authoritative)",
    `- state: ${context.state}`,
    `- active investigation: ${context.investigationId}`,
    `- case: ${context.caseId}`,
    ...(context.rounds !== undefined ? [`- completed investigation rounds: ${context.rounds}`] : []),
    ...(context.rootCauseStatus ? [`- RCA result status: ${context.rootCauseStatus}`] : []),
    "",
    "Treat this section as the current source of truth even if older transcript messages show a different state.",
    "For follow-up questions, continue from this investigation and use get_investigation_state when the persisted evidence or hypotheses are needed.",
    context.state === "interrupted"
      ? "This investigation was interrupted. Resume it only when additional investigation is needed; existing evidence may still be used for explanation or conclusion."
      : "Do not start another investigation for this conversation unless the user explicitly asks to re-run, start a new investigation, or investigate a different case.",
    "When an explicit replacement/new investigation is requested while an active investigation is linked, call start_rca_investigation with forceNew=true.",
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
        `Investigation ${context.investigationId ?? "unknown"} for ${context.caseId ?? "unknown case"} is still running. Continue and conclude the active investigation before starting another one.`,
    };
  }

  if (forceNew) return { allowed: true };

  if (context.state === "interrupted") {
    return {
      allowed: false,
      recommendedAction: "resume_active_investigation",
      reason:
        `Investigation ${context.investigationId ?? "unknown"} for ${context.caseId ?? "unknown case"} is interrupted. Use its persisted state or resume it unless the user explicitly requested a new investigation; then retry with forceNew=true.`,
    };
  }

  if (context.state === "unavailable") {
    return {
      allowed: false,
      recommendedAction: "explicit_new_investigation_required",
      reason:
        `The linked investigation ${context.investigationId ?? "unknown"} is unavailable. Do not replace it implicitly. If the user explicitly requested a new investigation for ${requestedCaseId}, retry with forceNew=true.`,
    };
  }

  return {
    allowed: false,
    recommendedAction: "read_active_investigation",
    reason:
      `Investigation ${context.investigationId ?? "unknown"} for ${context.caseId ?? "unknown case"} is already linked with state ${context.state}. Use it for follow-up questions. If the user explicitly requested a new or re-run investigation for ${requestedCaseId}, retry with forceNew=true.`,
  };
}
