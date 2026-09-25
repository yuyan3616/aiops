import type {
  AgentView,
  CoordinatorMessage,
  EvidenceView,
  HypothesisView,
  InvestigationSnapshot,
  ThinkingView,
  RcaStreamEvent,
  ToolRunView,
  AgentTaskView,
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
    case "dataset.ready": {
      const payload = event.payload as Pick<InvestigationSnapshot, "dataset" | "title" | "window">;
      return {
        ...snapshot,
        dataset: payload.dataset,
        title: payload.title,
        window: payload.window,
        stream,
      };
    }
    case "agent.updated":
      return {
        ...snapshot,
        agents: replaceById(snapshot.agents, event.payload as AgentView),
        stream,
      };
    case "task.created":
    case "task.started":
    case "task.completed":
    case "task.failed":
    case "task.cancelled":
    case "task.timed_out":
      return {
        ...snapshot,
        tasks: replaceById(snapshot.tasks, event.payload as AgentTaskView),
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
    case "thinking.started":
      return {
        ...snapshot,
        thinking: replaceById(snapshot.thinking, event.payload as ThinkingView),
        stream,
      };
    case "thinking.delta": {
      const payload = event.payload as { id: string; delta: string; updatedAt: string };
      const current = snapshot.thinking.find((item) => item.id === payload.id);
      if (!current) return { ...snapshot, stream };
      return {
        ...snapshot,
        thinking: replaceById(snapshot.thinking, {
          ...current,
          text: current.text + payload.delta,
          updatedAt: payload.updatedAt,
        }),
        stream,
      };
    }
    case "thinking.completed": {
      const payload = event.payload as { id: string; completed: true; updatedAt: string };
      const current = snapshot.thinking.find((item) => item.id === payload.id);
      if (!current) return { ...snapshot, stream };
      return {
        ...snapshot,
        thinking: replaceById(snapshot.thinking, {
          ...current,
          completed: true,
          updatedAt: payload.updatedAt,
        }),
        stream,
      };
    }
    case "rca.completed":
      return {
        ...snapshot,
        conclusion: event.payload as InvestigationSnapshot["conclusion"],
        stream,
      };
    case "runtime.error":
      return {
        ...snapshot,
        status: "error",
        error: (event.payload as { message?: string }).message ?? "RCA Runtime error",
        stream,
      };
    default:
      return { ...snapshot, stream };
  }
}
