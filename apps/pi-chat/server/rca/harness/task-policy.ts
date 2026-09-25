import type { TaskPolicy } from "./task-types.ts";

export const DEFAULT_TASK_POLICY: Readonly<TaskPolicy> = Object.freeze({
  timeoutMs: 60_000,
  maxTurns: 6,
  maxToolCalls: 10,
  maxEvidence: 12,
  maxAttempts: 1,
});

function positiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function taskPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): TaskPolicy {
  return {
    timeoutMs: positiveInteger(env.RCA_TASK_TIMEOUT_MS, DEFAULT_TASK_POLICY.timeoutMs),
    maxTurns: positiveInteger(env.RCA_TASK_MAX_TURNS, DEFAULT_TASK_POLICY.maxTurns),
    maxToolCalls: positiveInteger(env.RCA_TASK_MAX_TOOL_CALLS, DEFAULT_TASK_POLICY.maxToolCalls),
    maxEvidence: positiveInteger(env.RCA_TASK_MAX_EVIDENCE, DEFAULT_TASK_POLICY.maxEvidence),
    maxAttempts: 1,
  };
}
