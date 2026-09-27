import { InvestigationRepository } from "./repository";
import type { InvestigationEvent, InvestigationEventType } from "./types";

export type InvestigationEventListener = (event: InvestigationEvent) => void | Promise<void>;

export class InvestigationEventBus {
  private sequence: number;
  private publishQueue: Promise<void> = Promise.resolve();
  private readonly investigationId: string;
  private readonly repository: InvestigationRepository;
  private readonly listeners = new Set<InvestigationEventListener>();

  constructor(
    investigationId: string,
    repository: InvestigationRepository,
    startSequence = 1,
  ) {
    this.investigationId = investigationId;
    this.repository = repository;
    this.sequence = startSequence;
  }

  subscribe(listener: InvestigationEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(
    type: InvestigationEventType,
    summary: string,
    payload: Record<string, unknown> = {},
  ): Promise<InvestigationEvent> {
    const event: InvestigationEvent = {
      id: this.sequence++,
      investigationId: this.investigationId,
      type,
      at: new Date().toISOString(),
      summary,
      payload,
    };
    const run = async () => {
      await this.repository.appendEvent(event);
      for (const listener of this.listeners) await listener(event);
    };
    const completion = this.publishQueue.then(run);
    this.publishQueue = completion.catch(() => undefined);
    return completion.then(() => event);
  }
}
