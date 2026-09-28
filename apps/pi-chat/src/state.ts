import { appendAgentReasoning, upsertAgentTool } from "../shared/agent-timeline";
import type {
  AgentThreadEvidence,
  AgentThreadRun,
  ChatImage,
  ChatMessage,
  ConversationSnapshot,
  HypothesisView,
  MessageListItem,
  RuntimeStatus,
  StreamEvent,
  ThinkingBlock,
  ToolRun,
} from "@shared/types";

export type ConversationAction =
  | { type: "event"; event: StreamEvent }
  | { type: "optimistic-user"; message: ChatMessage };

type EventPayload = Record<string, unknown>;

function eventPayload(event: StreamEvent): EventPayload {
  return event.payload && typeof event.payload === "object" ? (event.payload as EventPayload) : {};
}

export interface RuntimeState {
  conversationId?: string;
  status: RuntimeStatus;
  error?: string;
  connected: boolean;
}

export function createRuntimeState(conversationId?: string): RuntimeState {
  return {
    conversationId,
    status: "cold",
    connected: false,
  };
}

type RuntimeAction = { conversationId?: string } & (
  | { type: "select" | "disconnect" }
  | { type: "snapshot"; snapshot: ConversationSnapshot }
  | { type: "event"; event: StreamEvent }
);

export function runtimeReducer(state: RuntimeState, action: RuntimeAction): RuntimeState {
  if (action.type === "select") return createRuntimeState(action.conversationId);
  if (action.conversationId !== state.conversationId) return state;

  switch (action.type) {
    case "disconnect":
      return { ...state, connected: false };
    case "snapshot":
      return {
        ...state,
        status: action.snapshot.status,
        error: action.snapshot.error,
        connected: true,
      };
    case "event": {
      const payload = eventPayload(action.event);
      if (action.event.type === "runtime.status") {
        const status = payload.status as RuntimeStatus;
        return {
          ...state,
          status,
          error: status === "error" ? state.error : undefined,
        };
      }
      if (action.event.type === "runtime.error") {
        return {
          ...state,
          status: "error",
          error:
            typeof payload.error === "string" && payload.error.trim()
              ? payload.error
              : "运行时发生错误，请稍后重试。",
        };
      }
      return state;
    }
  }
}

function updateItem(
  items: MessageListItem[],
  id: string,
  update: (item: MessageListItem) => MessageListItem,
): MessageListItem[] {
  return items.map((item) => (item.id === id ? update(item) : item));
}

function addUserMessage(items: MessageListItem[], message: ChatMessage): MessageListItem[] {
  if (items.some((item) => item.kind === "message" && item.id === message.id)) return items;
  const pendingIndex = items.findIndex(
    (item) =>
      item.kind === "message" &&
      item.message.role === "user" &&
      item.message.pending &&
      item.message.text === message.text,
  );
  if (pendingIndex < 0) return [...items, { kind: "message", id: message.id, message }];
  return items.map((item, index) =>
    index === pendingIndex
      ? {
          kind: "message",
          id: message.id,
          message: { ...message, pending: false },
        }
      : item,
  );
}

function addOrUpdateTool(items: MessageListItem[], tool: ToolRun): MessageListItem[] {
  const exists = items.some((item) => item.kind === "tool" && item.id === tool.id);
  if (!exists) return [...items, { kind: "tool", id: tool.id, tool }];
  return updateItem(items, tool.id, (item) =>
    item.kind === "tool" ? { ...item, tool: { ...item.tool, ...tool } } : item,
  );
}

function resolveToolArgs(items: MessageListItem[], id: string, value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  const item = items.find((item) => item.kind === "tool" && item.id === id);
  return item?.kind === "tool" ? item.tool.args : {};
}

function addOrUpdateMessage(items: MessageListItem[], message: ChatMessage): MessageListItem[] {
  const index = items.findIndex((item) => item.kind === "message" && item.id === message.id);
  if (index < 0) return [...items, { kind: "message", id: message.id, message }];

  return items.map((item, itemIndex) =>
    itemIndex === index ? { kind: "message", id: message.id, message } : item,
  );
}

export function conversationReducer(
  items: MessageListItem[],
  action: ConversationAction,
): MessageListItem[] {
  if (action.type === "optimistic-user") return addUserMessage(items, action.message);
  const payload = eventPayload(action.event);
  const id = typeof payload.id === "string" ? payload.id : "";

  switch (action.event.type) {
    case "message.added":
      return addUserMessage(items, payload as unknown as ChatMessage);
    case "message.started": {
      // The start event only establishes the assistant stream. Do not render
      // an empty bubble before the thinking block arrives.
      return items;
    }
    case "message.delta": {
      if (!id) return items;
      const item = items.find((current) => current.kind === "message" && current.id === id);
      const delta = String(payload.delta ?? "");
      if (!item) {
        return addOrUpdateMessage(items, {
          id,
          role: "assistant",
          text: delta,
          images: [],
          timestamp:
            typeof payload.timestamp === "number" || typeof payload.timestamp === "string"
              ? payload.timestamp
              : undefined,
          streaming: true,
        });
      }
      return updateItem(items, id, (current) =>
        current.kind === "message"
          ? {
              ...current,
              message: {
                ...current.message,
                text: current.message.text + delta,
                streaming: true,
              },
            }
          : current,
      );
    }
    case "message.completed": {
      const message = payload.message as ChatMessage | undefined;
      if (!message) return items;
      const streamId = typeof payload.streamId === "string" ? payload.streamId : id;
      const withoutPrevious = items.filter(
        (item) => item.id !== streamId && item.id !== message.id,
      );
      const previousIndex = items.findIndex(
        (item) => item.id === streamId || item.id === message.id,
      );
      const completed = {
        kind: "message" as const,
        id: message.id,
        message: { ...message, streaming: false },
      };
      if (previousIndex < 0) return [...withoutPrevious, completed];
      const insertIndex = Math.min(previousIndex, withoutPrevious.length);
      return [
        ...withoutPrevious.slice(0, insertIndex),
        completed,
        ...withoutPrevious.slice(insertIndex),
      ];
    }
    case "thinking.started": {
      if (!id || items.some((item) => item.kind === "thinking" && item.id === id)) return items;
      const thinking: ThinkingBlock = {
        id,
        text: "",
        ...(payload.source === "rca-projection" ? { source: "rca-projection" as const } : {}),
        ...(typeof payload.label === "string" ? { label: payload.label } : {}),
      };
      return [...items, { kind: "thinking", id, thinking }];
    }
    case "thinking.delta":
      return updateItem(items, id, (item) =>
        item.kind === "thinking"
          ? {
              ...item,
              thinking: {
                ...item.thinking,
                text: item.thinking.text + String(payload.delta ?? ""),
              },
            }
          : item,
      );
    case "thinking.completed":
      return updateItem(items, id, (item) =>
        item.kind === "thinking"
          ? {
              ...item,
              thinking: { ...item.thinking, completed: true },
            }
          : item,
      );
    case "hypothesis.updated": {
      const investigationId = String(payload.investigationId ?? "");
      const incoming = payload.hypothesis as Partial<HypothesisView> | undefined;
      if (!investigationId || !incoming?.id) return items;
      const boardId = `${investigationId}:hypotheses`;
      const existing = items.find((item) => item.kind === "hypotheses" && item.id === boardId);
      if (!existing || existing.kind !== "hypotheses") {
        const hypothesis: HypothesisView = {
          id: incoming.id,
          statement: incoming.statement ?? "",
          status: incoming.status ?? "possible",
          ...(typeof incoming.confidence === "number" ? { confidence: incoming.confidence } : {}),
          supportingEvidenceIds: incoming.supportingEvidenceIds ?? [],
          contradictingEvidenceIds: incoming.contradictingEvidenceIds ?? [],
          ...(incoming.reason ? { reason: incoming.reason } : {}),
        };
        return [
          ...items,
          {
            kind: "hypotheses",
            id: boardId,
            board: { investigationId, hypotheses: [hypothesis] },
          },
        ];
      }
      return updateItem(items, boardId, (item) => {
        if (item.kind !== "hypotheses") return item;
        const current = item.board.hypotheses.find((entry) => entry.id === incoming.id);
        const hypothesis: HypothesisView = {
          id: incoming.id!,
          statement: incoming.statement ?? current?.statement ?? "",
          status: incoming.status ?? current?.status ?? "possible",
          ...(typeof incoming.confidence === "number"
            ? { confidence: incoming.confidence }
            : current?.confidence !== undefined
              ? { confidence: current.confidence }
              : {}),
          supportingEvidenceIds:
            incoming.supportingEvidenceIds ?? current?.supportingEvidenceIds ?? [],
          contradictingEvidenceIds:
            incoming.contradictingEvidenceIds ?? current?.contradictingEvidenceIds ?? [],
          ...(incoming.reason
            ? { reason: incoming.reason }
            : current?.reason
              ? { reason: current.reason }
              : {}),
        };
        const hypotheses = current
          ? item.board.hypotheses.map((entry) => (entry.id === hypothesis.id ? hypothesis : entry))
          : [...item.board.hypotheses, hypothesis];
        return { ...item, board: { ...item.board, hypotheses } };
      });
    }
    case "agent.started": {
      const agent = payload.agent as AgentThreadRun | undefined;
      if (!agent?.id) return items;
      const exists = items.some((item) => item.kind === "agent" && item.id === agent.id);
      if (!exists) return [...items, { kind: "agent", id: agent.id, agent }];
      return updateItem(items, agent.id, (item) =>
        item.kind === "agent" ? { ...item, agent: { ...item.agent, ...agent } } : item,
      );
    }
    case "agent.thinking.delta": {
      const agentId = String(payload.agentId ?? "");
      const delta = String(payload.delta ?? "");
      if (!agentId || !delta) return items;
      return updateItem(items, agentId, (item) =>
        item.kind === "agent"
          ? { ...item, agent: appendAgentReasoning(item.agent, delta) }
          : item,
      );
    }
    case "agent.tool.started":
    case "agent.tool.completed": {
      const agentId = String(payload.agentId ?? "");
      const tool = payload.tool as ToolRun | undefined;
      if (!agentId || !tool?.id) return items;
      return updateItem(items, agentId, (item) =>
        item.kind === "agent"
          ? { ...item, agent: upsertAgentTool(item.agent, tool) }
          : item,
      );
    }
    case "agent.evidence.added": {
      const agentId = String(payload.agentId ?? "");
      const evidence = payload.evidence as AgentThreadEvidence | undefined;
      if (!agentId || !evidence?.id) return items;
      return updateItem(items, agentId, (item) => {
        if (item.kind !== "agent") return item;
        if (item.agent.evidence.some((entry) => entry.id === evidence.id)) return item;
        return {
          ...item,
          agent: { ...item.agent, evidence: [...item.agent.evidence, evidence] },
        };
      });
    }
    case "agent.completed": {
      const agentId = String(payload.agentId ?? "");
      if (!agentId) return items;
      return updateItem(items, agentId, (item) =>
        item.kind === "agent"
          ? {
              ...item,
              agent: {
                ...item.agent,
                status:
                  payload.status === "failed" || payload.status === "cancelled"
                    ? payload.status
                    : "completed",
                ...(typeof payload.summary === "string" ? { summary: payload.summary } : {}),
              },
            }
          : item,
      );
    }
    case "tool.started":
      return addOrUpdateTool(items, {
        id,
        name: String(payload.name ?? "tool"),
        args: resolveToolArgs(items, id, payload.args),
        status: "running",
      });
    case "tool.updated":
    case "tool.completed":
      return addOrUpdateTool(items, {
        id,
        name: String(payload.name ?? "tool"),
        args: resolveToolArgs(items, id, payload.args),
        status:
          action.event.type === "tool.completed"
            ? payload.status === "error"
              ? "error"
              : "success"
            : "running",
        ...(typeof payload.result === "string" ? { result: payload.result } : {}),
        ...(Array.isArray(payload.images)
          ? {
              images: payload.images.filter(
                (image): image is ChatImage =>
                  image?.type === "image" &&
                  typeof image.data === "string" &&
                  typeof image.mimeType === "string",
              ),
            }
          : {}),
        ...(payload.details !== undefined ? { details: payload.details } : {}),
      });
    default:
      return items;
  }
}
