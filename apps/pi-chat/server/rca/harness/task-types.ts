import type {
  AgentKind,
  AgentTaskResultView,
  AgentTaskStatus,
  AgentTaskView,
  TaskErrorView,
  TaskPolicyView,
} from "../../../shared/rca-types.ts";
import { taskError } from "./errors.ts";

export type TaskPolicy = TaskPolicyView;
export type AgentTaskResult = AgentTaskResultView;

export interface AgentTask extends AgentTaskView {}

const ALLOWED_TRANSITIONS: Record<AgentTaskStatus, ReadonlySet<AgentTaskStatus>> = {
  queued: new Set(["running", "cancelled"]),
  running: new Set(["succeeded", "failed", "cancelled", "timed_out"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  timed_out: new Set(),
};

export function isTerminalTaskStatus(status: AgentTaskStatus) {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "timed_out";
}

export function canTransitionTask(from: AgentTaskStatus, to: AgentTaskStatus) {
  return ALLOWED_TRANSITIONS[from].has(to);
}

export function transitionTask(
  task: AgentTask,
  status: AgentTaskStatus,
  options: { result?: AgentTaskResult; error?: TaskErrorView; now?: string } = {},
): AgentTask {
  if (!canTransitionTask(task.status, status)) {
    throw taskError(
      "TASK_AGENT_ERROR",
      `Illegal task transition ${task.id}: ${task.status} -> ${status}.`,
    );
  }
  const now = options.now ?? new Date().toISOString();
  return {
    ...task,
    status,
    ...(status === "running" ? { startedAt: now } : {}),
    ...(isTerminalTaskStatus(status) ? { completedAt: now } : {}),
    ...(options.result ? { result: options.result } : {}),
    ...(options.error ? { error: options.error } : {}),
  };
}

export interface CaseContext {
  datasetTaskId: string;
  alertTitle: string;
  alertEntity?: string;
  startTime: string;
  endTime: string;
  defaultService: string;
  operation?: string;
}

export interface EvidenceContextItem {
  id: string;
  modality: string;
  label: string;
  summary: string;
  entityRefs: string[];
  timeRange: { start: string; end: string };
}

export interface SpecialistExecutionContext {
  case: {
    taskId: string;
    alertTitle: string;
    alertEntity?: string;
    startTime: string;
    endTime: string;
  };
  assignment: {
    taskId: string;
    instruction: string;
    service?: string;
    operation?: string;
  };
  hypotheses: Array<{
    id: string;
    title: string;
    state: string;
  }>;
  evidence: EvidenceContextItem[];
  constraints: {
    timeoutMs: number;
    maxTurns: number;
    maxToolCalls: number;
    maxEvidence: number;
  };
}

export interface CreateAgentTaskInput {
  id: string;
  investigationId: string;
  runId: string;
  agent: AgentKind;
  instruction: string;
  service?: string;
  operation?: string;
  evidenceIds?: string[];
  hypothesisIds?: string[];
  policy: TaskPolicy;
}

export function createAgentTask(input: CreateAgentTaskInput): AgentTask {
  return {
    id: input.id,
    investigationId: input.investigationId,
    runId: input.runId,
    agent: input.agent,
    instruction: input.instruction,
    ...(input.service ? { service: input.service } : {}),
    ...(input.operation ? { operation: input.operation } : {}),
    evidenceIds: [...new Set(input.evidenceIds ?? [])],
    hypothesisIds: [...new Set(input.hypothesisIds ?? [])],
    policy: { ...input.policy },
    status: "queued",
    attempt: 1,
    createdAt: new Date().toISOString(),
  };
}
