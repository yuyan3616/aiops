export type AgentKind = "log" | "metric" | "trace" | "change";
export type AgentState = "waiting" | "running" | "done" | "error";
export type HypothesisState = "possible" | "validating" | "supported" | "rejected";
export type InvestigationPhase = 1 | 2 | 3 | 4;
export type InvestigationStatus = "idle" | "running" | "completed" | "error";

export interface AgentView {
  id: AgentKind;
  name: string;
  description: string;
  result: string;
  state: AgentState;
  progress: number;
}

export interface HypothesisView {
  id: string;
  title: string;
  state: HypothesisState;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}

export interface EvidenceView {
  id: string;
  type: AgentKind;
  label: string;
  source: string;
  summary: string;
  rawRef: string;
  queryKey: string;
  createdAt: string;
}

export interface ToolRunView {
  id: string;
  agent: AgentKind;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "success" | "error";
  result?: string;
  startedAt: string;
  completedAt?: string;
}

export type ThinkingStage = "plan" | "evidence" | "synthesis";

export interface ThinkingView {
  id: string;
  stage: ThinkingStage;
  title: string;
  text: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CoordinatorMessage {
  id: string;
  kind: "plan" | "finding" | "decision" | "conclusion";
  text: string;
  createdAt: string;
}

export interface InvestigationSnapshot {
  incidentId: string;
  title: string;
  severity: "P1" | "P2" | "P3";
  window: string;
  status: InvestigationStatus;
  error?: string;
  phase: InvestigationPhase;
  agents: AgentView[];
  hypotheses: HypothesisView[];
  evidence: EvidenceView[];
  messages: CoordinatorMessage[];
  thinking: ThinkingView[];
  toolRuns: ToolRunView[];
  conclusion?: {
    rootCause: string;
    causalChain: string[];
    evidenceIds: string[];
  };
  runId: string;
  stream: { id: string; lastEventId: number };
}

export type RcaEventType =
  | "investigation.reset"
  | "investigation.status"
  | "investigation.phase"
  | "agent.updated"
  | "hypothesis.updated"
  | "evidence.created"
  | "coordinator.message"
  | "thinking.started"
  | "thinking.delta"
  | "thinking.completed"
  | "tool.started"
  | "tool.completed"
  | "rca.completed"
  | "runtime.error";

export interface RcaStreamEvent<T = unknown> {
  id: number;
  streamId: string;
  type: RcaEventType;
  payload: T;
}
