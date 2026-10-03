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
    timeout.unref();
  });

  const taskPromise = task.then((value) => ({
    timedOut: false,
    value,
  }));
  const result = await Promise.race([taskPromise, timeoutPromise]);
  if (timeout) clearTimeout(timeout);
  return result;
}
