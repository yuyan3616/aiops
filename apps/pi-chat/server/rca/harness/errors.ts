import type { TaskErrorCode, TaskErrorView } from "../../../shared/rca-types.ts";

export class TaskExecutionError extends Error {
  readonly code: TaskErrorCode;

  constructor(code: TaskErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskExecutionError";
    this.code = code;
  }
}

export function taskError(code: TaskErrorCode, message: string, cause?: unknown) {
  return new TaskExecutionError(code, message, cause === undefined ? undefined : { cause });
}

export function toTaskErrorView(error: unknown, fallback: TaskErrorCode = "TASK_AGENT_ERROR"): TaskErrorView {
  if (error instanceof TaskExecutionError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: fallback,
    message: error instanceof Error ? error.message : String(error),
  };
}

export function isCancellationError(error: unknown) {
  return error instanceof TaskExecutionError && error.code === "TASK_CANCELLED";
}

export function isTimeoutError(error: unknown) {
  return error instanceof TaskExecutionError && error.code === "TASK_TIMEOUT";
}
