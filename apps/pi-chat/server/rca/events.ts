import { InvestigationRepository } from "./repository";
import type { InvestigationEvent, InvestigationEventType } from "./types";

export type InvestigationEventListener = (event: InvestigationEvent) => void | Promise<void>;

export class InvestigationEventBus {
  private sequence = 1;
  private readonly investigationId: string;
  private readonly repository: InvestigationRepository;
  private readonly listeners = new Set<InvestigationEventListener>();

  constructor(investigationId: string, repository: InvestigationRepository) {
    this.investigationId = investigationId;
    this.repository = repository;
  }

  subscribe(listener: InvestigationEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async publish(
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
    await this.repository.appendEvent(event);
    for (const listener of this.listeners) await listener(event);
    return event;
  }
}
