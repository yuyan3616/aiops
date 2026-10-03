export interface DeadlineResult<T> {
  timedOut: boolean;
  value?: T;
}

export async function settleBeforeDeadline<T>(
  task: Promise<T>,
  timeoutMs: number,
): Promise<DeadlineResult<T>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<DeadlineResult<T>>((resolve) => {
    timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });

  const taskPromise = task.then((value) => ({
    timedOut: false,
    value,
  }));
  try {
    return await Promise.race([taskPromise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// One wall-clock deadline covers both stages. Reserve a small part for the final export.
export async function drainAndFlush(options: {
  timeoutMs: number;
  drain: () => Promise<unknown>;
  forceClose: (drainTimedOut: boolean) => void;
  flush: () => Promise<void>;
}): Promise<{ drainTimedOut: boolean; flushTimedOut: boolean }> {
  const deadline = Date.now() + options.timeoutMs;
  const flushReserveMs = Math.min(2_000, options.timeoutMs / 5);
  let drainTimedOut = false;
  let flushTimedOut = false;
  try {
    drainTimedOut = (
      await settleBeforeDeadline(options.drain(), Math.max(0, options.timeoutMs - flushReserveMs))
    ).timedOut;
  } finally {
    try {
      options.forceClose(drainTimedOut);
    } finally {
      flushTimedOut = (
        await settleBeforeDeadline(options.flush(), Math.max(0, deadline - Date.now()))
      ).timedOut;
    }
  }
  return { drainTimedOut, flushTimedOut };
}
