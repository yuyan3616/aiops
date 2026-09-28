export type RuntimeStatus =
  | "ready"
  | "running"
  | "waiting_for_human"
  | "stopping"
  | "compacting"
  | "error"
  | "cold";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
export type { ThinkingLevel };

export type EventType =
  | "runtime.status"
  | "runtime.error"
  | "runtime.settled"
  | "conversation.updated"
  | "message.delta"
  | "message.started"
  | "message.added"
  | "message.completed"
  | "thinking.started"
  | "thinking.delta"
  | "thinking.completed"
  | "hypothesis.updated"
  | "agent.started"
  | "agent.thinking.delta"
  | "agent.tool.started"
  | "agent.tool.completed"
  | "agent.evidence.added"
  | "agent.completed"
  | "tool.started"
  | "tool.updated"
  | "tool.completed";

export interface StreamEvent<T = unknown> {
  id: number;
  streamId: string;
  type: EventType;
  payload: T;
}

export interface ChatImage {
  type: "image";
  mimeType: string;
  data: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  images: ChatImage[];
  timestamp?: number | string;
  streaming?: boolean;
  pending?: boolean;
  error?: string;
}

export interface ToolRun {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "success" | "error" | "cancelled";
  result?: string;
  images?: ChatImage[];
  details?: unknown;
}

export interface ThinkingBlock {
  id: string;
  text: string;
  completed?: boolean;
  source?: "model" | "rca-projection";
  label?: string;
}

export interface HypothesisView {
  id: string;
  statement: string;
  status: string;
  confidence?: number;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  reason?: string;
}

export interface HypothesisBoard {
  investigationId: string;
  hypotheses: HypothesisView[];
}

export interface AgentThreadEvidence {
  id: string;
  modality: string;
  summary: string;
}

export interface AgentReasoningStep {
  id: string;
  type: "reasoning";
  text: string;
}

export interface AgentToolStep {
  id: string;
  type: "tool";
  tool: ToolRun;
}

export type AgentStep = AgentReasoningStep | AgentToolStep;

export interface AgentThreadRun {
  id: string;
  taskId: string;
  expert: "trace" | "metrics" | "log" | "event-topology";
  label: string;
  objective: string;
  status: "running" | "completed" | "failed" | "cancelled";
  tools: ToolRun[];
  evidence: AgentThreadEvidence[];
  /**
   * Ordered child-agent execution timeline. Older persisted conversations may
   * not have this field and fall back to thinking + tools.
   */
  steps?: AgentStep[];
  thinking?: string;
  summary?: string;
  interruptedByRestart?: boolean;
  implementation: "deterministic" | "pi-session";
}

export type MessageListToolItem = {
  kind: "tool";
  id: string;
  tool: ToolRun;
  seqId?: number;
};

export type MessageListItem =
  | { kind: "message"; id: string; message: ChatMessage; seqId?: number }
  | { kind: "thinking"; id: string; thinking: ThinkingBlock; seqId?: number }
  | { kind: "hypotheses"; id: string; board: HypothesisBoard; seqId?: number }
  | { kind: "agent"; id: string; agent: AgentThreadRun; seqId?: number }
  | MessageListToolItem;

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workspaceDir: string;
  status: RuntimeStatus;
}

export interface ConversationSnapshot {
  conversation: ConversationSummary;
  messageList: MessageListItem[];
  activeSkillNames: string[];
  model: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  availableThinkingLevels: ThinkingLevel[];
  status: RuntimeStatus;
  error?: string;
  stream: { id: string; lastEventId: number };
  diagnostics: string[];
}

export interface CreateConversationResponse {
  conversation: { id: string };
  model: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  stream: { id: string; lastEventId: number };
  diagnostics: string[];
}

export interface ModelOption {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  reasoning: boolean;
  imageInput: boolean;
  thinkingLevels: ThinkingLevel[];
}

export interface SkillOption {
  name: string;
  description: string;
}

export interface BootstrapData {
  models: ModelOption[];
  skills: SkillOption[];
}

export interface ConversationConfig {
  model: { provider: string; id: string };
  models: ModelOption[];
  thinkingLevel: ThinkingLevel;
  availableThinkingLevels: ThinkingLevel[];
}

export interface ConversationConfigUpdate {
  model?: {
    provider: string;
    id: string;
  };
  thinkingLevel?: ThinkingLevel;
}
