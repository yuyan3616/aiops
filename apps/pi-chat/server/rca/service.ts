import type { InvestigationEventListener } from "./events";
import {
  createInvestigationId,
  RcaOrchestrator,
  type InvestigationRunResult,
} from "./orchestrator";
import { InvestigationRepository } from "./repository";
import type { Investigation } from "./types";

export interface StartInvestigationOptions {
  conversationId?: string;
  onEvent?: InvestigationEventListener;
  onCompleted?: (investigation: Investigation, report: string) => void | Promise<void>;
  onFailed?: (error: Error) => void | Promise<void>;
}

export interface InvestigationRunHandle {
  investigationId: string;
  promise: Promise<InvestigationRunResult>;
}

interface RunningInvestigation {
  conversationId?: string;
  controller: AbortController;
  promise: Promise<InvestigationRunResult>;
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
    const handle = this.run(caseId, options);
    void handle.promise.catch(() => undefined);
    return handle.investigationId;
  }

  run(caseId: string, options: StartInvestigationOptions = {}): InvestigationRunHandle {
    const id = createInvestigationId();
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() =>
        this.orchestrator.investigate({
          caseId,
          investigationId: id,
          signal: controller.signal,
          onEvent: options.onEvent,
        }),
      )
      .then(async (result) => {
        await options.onCompleted?.(result.investigation, result.report);
        return result;
      })
      .catch(async (cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        await options.onFailed?.(error);
        throw error;
      })
      .finally(() => {
        this.running.delete(id);
      });

    this.running.set(id, {
      conversationId: options.conversationId,
      controller,
      promise,
    });
    return { investigationId: id, promise };
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
