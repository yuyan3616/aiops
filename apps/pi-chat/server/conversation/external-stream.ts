import { appendAgentReasoning, upsertAgentTool } from "../../shared/agent-timeline";
import type {
  AgentThreadEvidence,
  AgentThreadRun,
  ChatMessage,
  EventType,
  HypothesisView,
  InvestigationReportArtifact,
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
    const thinking: ThinkingBlock = {
      id,
      text: "",
      ...(data.source === "rca-projection" ? { source: "rca-projection" as const } : {}),
      ...(typeof data.label === "string" ? { label: data.label } : {}),
    };
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

  if (type === "hypothesis.updated") {
    const investigationId = String(data.investigationId ?? "");
    const incoming = data.hypothesis as Partial<HypothesisView> | undefined;
    if (!investigationId || !incoming?.id) return { items, sequence };
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
      items.push({
        kind: "hypotheses",
        id: boardId,
        board: { investigationId, hypotheses: [hypothesis] },
        seqId: allocate(),
      });
      return { items, sequence };
    }
    items = updateItem(items, boardId, (item) => {
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
    return { items, sequence };
  }

  if (type === "report.ready") {
    const report = data as unknown as InvestigationReportArtifact;
    if (!report.investigationId || !report.filename) return { items, sequence };
    const id = `${report.investigationId}:report`;
    const existing = items.find((item) => item.kind === "report" && item.id === id);
    if (existing) {
      items = updateItem(items, id, (item) =>
        item.kind === "report" ? { ...item, report } : item,
      );
    } else {
      items.push({ kind: "report", id, report, seqId: allocate() });
    }
    return { items, sequence };
  }

  if (type === "agent.started") {
    const agent = data.agent as AgentThreadRun | undefined;
    if (!agent?.id) return { items, sequence };
    const existing = items.find((item) => item.kind === "agent" && item.id === agent.id);
    if (existing) {
      items = updateItem(items, agent.id, (item) =>
        item.kind === "agent" ? { ...item, agent: { ...item.agent, ...agent } } : item,
      );
    } else {
      items.push({ kind: "agent", id: agent.id, agent, seqId: allocate() });
    }
    return { items, sequence };
  }

  if (type === "agent.thinking.delta") {
    const agentId = String(data.agentId ?? "");
    const delta = String(data.delta ?? "");
    if (!agentId || !delta) return { items, sequence };
    items = updateItem(items, agentId, (item) =>
      item.kind === "agent"
        ? { ...item, agent: appendAgentReasoning(item.agent, delta) }
        : item,
    );
    return { items, sequence };
  }

  if (type === "agent.tool.started" || type === "agent.tool.completed") {
    const agentId = String(data.agentId ?? "");
    const tool = data.tool as ToolRun | undefined;
    if (!agentId || !tool?.id) return { items, sequence };
    items = updateItem(items, agentId, (item) =>
      item.kind === "agent"
        ? { ...item, agent: upsertAgentTool(item.agent, tool) }
        : item,
    );
    return { items, sequence };
  }

  if (type === "agent.evidence.added") {
    const agentId = String(data.agentId ?? "");
    const evidence = data.evidence as AgentThreadEvidence | undefined;
    if (!agentId || !evidence?.id) return { items, sequence };
    items = updateItem(items, agentId, (item) => {
      if (item.kind !== "agent") return item;
      if (item.agent.evidence.some((entry) => entry.id === evidence.id)) return item;
      return {
        ...item,
        agent: { ...item.agent, evidence: [...item.agent.evidence, evidence] },
      };
    });
    return { items, sequence };
  }

  if (type === "agent.completed") {
    const agentId = String(data.agentId ?? "");
    if (!agentId) return { items, sequence };
    items = updateItem(items, agentId, (item) =>
      item.kind === "agent"
        ? {
            ...item,
            agent: {
              ...item.agent,
              status:
                data.status === "failed" || data.status === "cancelled"
                  ? data.status
                  : "completed",
              ...(typeof data.summary === "string" ? { summary: data.summary } : {}),
            },
          }
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
