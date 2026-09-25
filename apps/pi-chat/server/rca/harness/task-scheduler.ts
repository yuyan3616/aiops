import type { AgentKind } from "../../../shared/rca-types.ts";
import { taskError } from "./errors.ts";

interface QueueEntry<T> {
  key: AgentKind;
  taskId: string;
  signal: AbortSignal;
  execute: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  removeAbortListener?: () => void;
}

export class TaskScheduler {
  readonly globalConcurrency: number;
  private readonly queue: QueueEntry<unknown>[] = [];
  private readonly runningKeys = new Set<AgentKind>();
  private runningCount = 0;

  constructor(globalConcurrency = 3) {
    this.globalConcurrency = globalConcurrency;
    if (!Number.isInteger(globalConcurrency) || globalConcurrency < 1) {
      throw new Error("TaskScheduler globalConcurrency must be >= 1.");
    }
  }

  schedule<T>(input: {
    key: AgentKind;
    taskId: string;
    signal: AbortSignal;
    execute: () => Promise<T>;
  }): Promise<T> {
    if (input.signal.aborted) {
      return Promise.reject(taskError("TASK_CANCELLED", `Task ${input.taskId} was cancelled before scheduling.`));
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        ...input,
        resolve,
        reject,
      };
      const onAbort = () => {
        const index = this.queue.indexOf(entry as QueueEntry<unknown>);
        if (index < 0) return;
        this.queue.splice(index, 1);
        reject(taskError("TASK_CANCELLED", `Task ${input.taskId} was cancelled while queued.`));
        this.pump();
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
      entry.removeAbortListener = () => input.signal.removeEventListener("abort", onAbort);
      this.queue.push(entry as QueueEntry<unknown>);
      this.pump();
    });
  }

  queuedCount() {
    return this.queue.length;
  }

  activeCount() {
    return this.runningCount;
  }

  private pump() {
    while (this.runningCount < this.globalConcurrency) {
      const index = this.queue.findIndex(
        (entry) => !entry.signal.aborted && !this.runningKeys.has(entry.key),
      );
      if (index < 0) return;
      const [entry] = this.queue.splice(index, 1);
      entry.removeAbortListener?.();
      this.runningCount += 1;
      this.runningKeys.add(entry.key);

      void entry.execute().then(entry.resolve, entry.reject).finally(() => {
        this.runningCount -= 1;
        this.runningKeys.delete(entry.key);
        this.pump();
      });
    }
  }
}
