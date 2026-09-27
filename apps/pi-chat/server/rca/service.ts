import type { InvestigationEventListener } from "./events";
import { createInvestigationId, RcaOrchestrator } from "./orchestrator";
import { InvestigationRepository } from "./repository";
import type { Investigation } from "./types";

export interface StartInvestigationOptions {
  conversationId?: string;
  onEvent?: InvestigationEventListener;
  onCompleted?: (investigation: Investigation, report: string) => void | Promise<void>;
  onFailed?: (error: Error) => void | Promise<void>;
}

interface RunningInvestigation {
  conversationId?: string;
  controller: AbortController;
  promise: Promise<void>;
}

export class RcaService {
  private readonly orchestrator: RcaOrchestrator;
  private readonly repository: InvestigationRepository;
  private readonly running = new Map<string, RunningInvestigation>();

  constructor(orchestrator: RcaOrchestrator, repository: InvestigationRepository) {
    this.orchestrator = orchestrator;
    this.repository = repository;
  }

  start(caseId: string, options: StartInvestigationOptions = {}): string {
    const id = createInvestigationId();
    const controller = new AbortController();
    // Defer execution by one microtask so callers can attach their UI mapper
    // and publish an immediate progress state before the first RCA event.
    const promise = Promise.resolve()
      .then(() =>
        this.orchestrator.investigate({
          caseId,
          investigationId: id,
          signal: controller.signal,
          onEvent: options.onEvent,
        }),
      )
      .then(async ({ investigation, report }) => {
        await options.onCompleted?.(investigation, report);
      })
      .catch(async (cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        await options.onFailed?.(error);
      })
      .finally(() => {
        this.running.delete(id);
      });
    this.running.set(id, { conversationId: options.conversationId, controller, promise });
    return id;
  }

  get(investigationId: string): Promise<Investigation> {
    return this.repository.get(investigationId);
  }

  cancel(investigationId: string): boolean {
    const running = this.running.get(investigationId);
    if (!running) return false;
    running.controller.abort();
    return true;
  }

  cancelConversation(conversationId: string): number {
    let cancelled = 0;
    for (const running of this.running.values()) {
      if (running.conversationId !== conversationId) continue;
      running.controller.abort();
      cancelled++;
    }
    return cancelled;
  }
}
