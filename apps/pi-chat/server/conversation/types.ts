import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { MessageListItem, PendingHumanRequest, RuntimeStatus } from "@shared/types";

import type { EventChannel } from "./channel";

export interface ConversationTitleMeta {
  source: "default" | "fallback" | "llm" | "user";
  locked: boolean;
  generation: number;
  generatedAt?: string;
}

export interface ConversationRecord {
  id: string;
  title: string;
  titleMeta?: ConversationTitleMeta;
  workspaceDir: string;
  sessionId: string;
  sessionFile: string;
  createdAt: Date;
  updatedAt: Date;
  selectedSkills: string[];
  activeInvestigationId?: string;
  investigationIds?: string[];
  externalMessageList?: MessageListItem[];
  externalSequence?: number;
  pendingHumanRequest?: PendingHumanRequest;
}

export interface ManagedSession {
  id: string;
  runtime: AgentSessionRuntime;
  channel: EventChannel;
  unsubscribe?: () => void;
  status: RuntimeStatus;
  error?: string;
  diagnostics: string[];
  streamMessageId?: string;
  streamThinkingId?: string;
  activeSkillNames: string[];
  pendingHumanRequest?: PendingHumanRequest;
}
