import type {
  AgentView,
  CoordinatorMessage,
  EvidenceView,
  HypothesisView,
  InvestigationSnapshot,
  RcaStreamEvent,
  ToolRunView,
} from "@shared/rca-types";

function replaceById<T extends { id: string }>(items: T[], next: T) {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) return [...items, next];
  return items.map((item) => (item.id === next.id ? next : item));
}

export function applyRcaEvent(
  snapshot: InvestigationSnapshot,
  event: RcaStreamEvent,
): InvestigationSnapshot {
  const stream = { id: event.streamId, lastEventId: Math.max(snapshot.stream.lastEventId, event.id) };

  switch (event.type) {
    case "investigation.reset":
      return { ...(event.payload as InvestigationSnapshot), stream };
    case "investigation.status":
      return {
        ...snapshot,
        status: (event.payload as { status: InvestigationSnapshot["status"] }).status,
        stream,
      };
    case "investigation.phase":
      return {
        ...snapshot,
        phase: (event.payload as { phase: InvestigationSnapshot["phase"] }).phase,
        stream,
      };
    case "agent.updated":
      return {
        ...snapshot,
        agents: replaceById(snapshot.agents, event.payload as AgentView),
        stream,
      };
    case "hypothesis.updated":
      return {
        ...snapshot,
        hypotheses: replaceById(snapshot.hypotheses, event.payload as HypothesisView),
        stream,
      };
    case "evidence.created":
      return {
        ...snapshot,
        evidence: replaceById(snapshot.evidence, event.payload as EvidenceView),
        stream,
      };
    case "tool.started":
    case "tool.completed":
      return {
        ...snapshot,
        toolRuns: replaceById(snapshot.toolRuns, event.payload as ToolRunView),
        stream,
      };
    case "coordinator.message":
      return {
        ...snapshot,
        messages: replaceById(snapshot.messages, event.payload as CoordinatorMessage),
        stream,
      };
    case "rca.completed":
      return {
        ...snapshot,
        conclusion: event.payload as InvestigationSnapshot["conclusion"],
        stream,
      };
    case "runtime.error":
      return { ...snapshot, status: "error", stream };
    default:
      return { ...snapshot, stream };
  }
}
