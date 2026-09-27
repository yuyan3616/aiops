import type {
  ChatMessage,
  EventType,
  MessageListItem,
  ThinkingBlock,
  ToolRun,
} from "@shared/types";

function nextSequence(current: number, at: number): number {
  return Math.max(current + 1, Math.trunc(at) * 100);
}

function updateItem(
  items: MessageListItem[],
  id: string,
  update: (item: MessageListItem) => MessageListItem,
): MessageListItem[] {
  return items.map((item) => (item.id === id ? update(item) : item));
}

export function applyExternalStreamEvent(
  currentItems: MessageListItem[],
  currentSequence: number,
  type: EventType,
  payload: unknown,
  at = Date.now(),
): { items: MessageListItem[]; sequence: number } {
  const data = (payload ?? {}) as Record<string, unknown>;
  let items = structuredClone(currentItems);
  let sequence = currentSequence;
  const allocate = () => {
    sequence = nextSequence(sequence, at);
    return sequence;
  };

  if (type === "message.added") {
    const message = data as unknown as ChatMessage;
    if (!message.id || items.some((item) => item.kind === "message" && item.id === message.id)) {
      return { items, sequence };
    }
    items.push({ kind: "message", id: message.id, message, seqId: allocate() });
    return { items, sequence };
  }

  if (type === "message.completed") {
    const message = data.message as ChatMessage | undefined;
    if (!message?.id) return { items, sequence };
    const existing = items.find((item) => item.kind === "message" && item.id === message.id);
    if (existing) {
      items = updateItem(items, message.id, (item) =>
        item.kind === "message"
          ? { ...item, message: { ...message, streaming: false } }
          : item,
      );
    } else {
      items.push({
        kind: "message",
        id: message.id,
        message: { ...message, streaming: false },
        seqId: allocate(),
      });
    }
    return { items, sequence };
  }

  if (type === "thinking.started") {
    const id = String(data.id ?? "");
    if (!id || items.some((item) => item.kind === "thinking" && item.id === id)) {
      return { items, sequence };
    }
    const thinking: ThinkingBlock = { id, text: "" };
    items.push({ kind: "thinking", id, thinking, seqId: allocate() });
    return { items, sequence };
  }

  if (type === "thinking.delta") {
    const id = String(data.id ?? "");
    if (!id) return { items, sequence };
    items = updateItem(items, id, (item) =>
      item.kind === "thinking"
        ? {
            ...item,
            thinking: {
              ...item.thinking,
              text: item.thinking.text + String(data.delta ?? ""),
            },
          }
        : item,
    );
    return { items, sequence };
  }

  if (type === "thinking.completed") {
    const id = String(data.id ?? "");
    if (!id) return { items, sequence };
    items = updateItem(items, id, (item) =>
      item.kind === "thinking"
        ? { ...item, thinking: { ...item.thinking, completed: true } }
        : item,
    );
    return { items, sequence };
  }

  if (type === "tool.started") {
    const id = String(data.id ?? "");
    if (!id) return { items, sequence };
    const tool: ToolRun = {
      id,
      name: String(data.name ?? "tool"),
      args: (data.args ?? {}) as Record<string, unknown>,
      status: "running",
      ...(data.details !== undefined ? { details: data.details } : {}),
    };
    const existing = items.find((item) => item.kind === "tool" && item.id === id);
    if (existing) {
      items = updateItem(items, id, (item) =>
        item.kind === "tool" ? { ...item, tool: { ...item.tool, ...tool } } : item,
      );
    } else {
      items.push({ kind: "tool", id, tool, seqId: allocate() });
    }
    return { items, sequence };
  }

  if (type === "tool.updated" || type === "tool.completed") {
    const id = String(data.id ?? "");
    if (!id) return { items, sequence };
    const status: ToolRun["status"] =
      type === "tool.completed"
        ? data.status === "error"
          ? "error"
          : "success"
        : "running";
    const existing = items.find((item) => item.kind === "tool" && item.id === id);
    const tool: ToolRun = {
      id,
      name: String(data.name ?? (existing?.kind === "tool" ? existing.tool.name : "tool")),
      args:
        (data.args as Record<string, unknown> | undefined) ??
        (existing?.kind === "tool" ? existing.tool.args : {}),
      status,
      ...(typeof data.result === "string" ? { result: data.result } : {}),
      ...(data.details !== undefined ? { details: data.details } : {}),
    };
    if (existing) {
      items = updateItem(items, id, (item) =>
        item.kind === "tool" ? { ...item, tool: { ...item.tool, ...tool } } : item,
      );
    } else {
      items.push({ kind: "tool", id, tool, seqId: allocate() });
    }
    return { items, sequence };
  }

  return { items, sequence };
}

export function mergeMessageLists(
  sessionItems: MessageListItem[],
  externalItems: MessageListItem[],
): MessageListItem[] {
  return [...sessionItems, ...externalItems]
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftSeq = left.item.seqId ?? Number.MAX_SAFE_INTEGER;
      const rightSeq = right.item.seqId ?? Number.MAX_SAFE_INTEGER;
      return leftSeq === rightSeq ? left.index - right.index : leftSeq - rightSeq;
    })
    .map(({ item }) => item);
}
