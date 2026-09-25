export type AgentKind = "log" | "metric" | "trace" | "context";
export type RcaAgentRole = "coordinator" | AgentKind;

export interface PiSessionRef {
  sessionId: string;
  sessionFile: string;
}
export type EvidenceModality = "log" | "metric" | "trace" | "event" | "alert" | "topology";
export type AgentState = "waiting" | "running" | "done" | "error" | "cancelled";
export type HypothesisState = "possible" | "validating" | "supported" | "rejected";
export type InvestigationPhase = 1 | 2 | 3 | 4;
export type InvestigationStatus =
  | "idle"
  | "running"
  | "stopping"
  | "completed"
  | "cancelled"
  | "interrupted"
  | "error";

export type AgentTaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export type TaskErrorCode =
  | "TASK_TIMEOUT"
  | "TASK_CANCELLED"
  | "TASK_TOOL_BUDGET_EXCEEDED"
  | "TASK_TURN_BUDGET_EXCEEDED"
  | "TASK_EVIDENCE_BUDGET_EXCEEDED"
  | "TASK_AGENT_ERROR"
  | "TASK_TOOL_ERROR"
  | "TASK_INVALID_CONTEXT";

export interface TaskPolicyView {
  timeoutMs: number;
  maxTurns: number;
  maxToolCalls: number;
  maxEvidence: number;
  maxAttempts: number;
}

export interface TaskErrorView {
  code: TaskErrorCode;
  message: string;
}

export interface AgentTaskResultView {
  summary: string;
  evidenceIds: string[];
  toolCallCount: number;
  turnCount: number;
  durationMs: number;
}

export interface AgentTaskView {
  id: string;
  investigationId: string;
  runId: string;
  agent: AgentKind;
  instruction: string;
  service?: string;
  operation?: string;
  evidenceIds: string[];
  hypothesisIds: string[];
  policy: TaskPolicyView;
  status: AgentTaskStatus;
  attempt: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: AgentTaskResultView;
  error?: TaskErrorView;
}

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
  /** Harness task that produced this Evidence. */
  taskId: string;
  /** Dataset case id, e.g. RCA100 t039. */
  datasetTaskId: string;
  type: AgentKind;
  modality: EvidenceModality;
  label: string;
  source: string;
  summary: string;
  observation: Record<string, unknown>;
  rawRef: string;
  queryKey: string;
  entityRefs: string[];
  timeRange: { start: string; end: string };
  createdBy: AgentKind;
  createdAt: string;
}

export interface ToolRunView {
  id: string;
  investigationId: string;
  runId: string;
  taskId: string;
  datasetTaskId: string;
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
  prompt: string;
  title: string;
  severity: "P1" | "P2" | "P3";
  window: string;
  dataset: {
    name: "RCA100";
    version: string;
    taskId: string;
    telemetryReady: boolean;
  };
  status: InvestigationStatus;
  error?: string;
  phase: InvestigationPhase;
  agents: AgentView[];
  tasks: AgentTaskView[];
  hypotheses: HypothesisView[];
  evidence: EvidenceView[];
  messages: CoordinatorMessage[];
  thinking: ThinkingView[];
  toolRuns: ToolRunView[];
  conclusion?: {
    rootCause: string;
    rootCauseEntity?: string;
    faultType?: string;
    causalChain: string[];
    evidenceIds: string[];
  };
  runId: string;
  stream: { id: string; lastEventId: number };
}


export interface InvestigationSummary {
  id: string;
  title: string;
  datasetTaskId: string;
  status: InvestigationStatus;
  createdAt: string;
  updatedAt: string;
}

export type RcaEventType =
  | "investigation.reset"
  | "investigation.status"
  | "investigation.phase"
  | "dataset.ready"
  | "agent.updated"
  | "task.created"
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "task.timed_out"
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

export interface RcaEventCorrelation {
  investigationId?: string;
  runId?: string;
  taskId?: string;
  agent?: AgentKind;
  toolCallId?: string;
  evidenceId?: string;
}

export interface RcaStreamEvent<T = unknown> {
  id: number;
  streamId: string;
  type: RcaEventType;
  payload: T;
  correlation?: RcaEventCorrelation;
}
