export class AbortableSemaphore {
  readonly limit: number;
  private active = 0;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort: () => void;
  }> = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  get running(): number {
    return this.active;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new DOMException("Task cancelled", "AbortError"));
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new DOMException("Task cancelled", "AbortError"));
        },
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (this.waiters.length) {
        const waiter = this.waiters.shift()!;
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
        if (waiter.signal?.aborted) {
          waiter.reject(new DOMException("Task cancelled", "AbortError"));
          continue;
        }
        waiter.resolve(this.releaseOnce());
        return;
      }
      this.active--;
    };
  }
}
