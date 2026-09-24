import { randomUUID } from "node:crypto";

import type { RcaEventType, RcaStreamEvent } from "../../shared/rca-types";

export class EventChannel {
  readonly streamId = randomUUID();
  private nextId = 1;
  private readonly history: RcaStreamEvent[] = [];
  get lastId() {
    return this.nextId - 1;
  }

  private readonly subscribers = new Set<(event: RcaStreamEvent) => void>();

  publish<T>(type: RcaEventType, payload: T) {
    const event: RcaStreamEvent<T> = {
      id: this.nextId++,
      streamId: this.streamId,
      type,
      payload,
    };
    this.history.push(event);
    if (this.history.length > 500) this.history.shift();
    for (const subscriber of this.subscribers) subscriber(event);
    return event;
  }

  after(id: number) {
    return this.history.filter((event) => event.id > id);
  }

  subscribe(listener: (event: RcaStreamEvent) => void) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }
}
