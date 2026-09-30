import { createHash } from "node:crypto";

import { foldBudget } from "../budget";
import { InvestigationRepository } from "../repository";
import type { Investigation } from "../types";

import { buildInvestigationFlow } from "./builder";
import { compileMermaidFlow } from "./mermaid";
import type {
  InvestigationVisualizationArtifact,
  InvestigationVisualizationEvent,
  InvestigationVisualizationSummary,
} from "./types";

type VisualizationListener = (
  event: InvestigationVisualizationEvent,
) => void | Promise<void>;

const VISUALIZATION_RENDER_VERSION = 2;

const terminalStatuses = new Set<Investigation["status"]>([
  "completed",
  "inconclusive",
  "failed",
  "cancelled",
]);

function now(): string {
  return new Date().toISOString();
}

function sourceHash(investigation: Investigation): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        renderVersion: VISUALIZATION_RENDER_VERSION,
        id: investigation.id,
        status: investigation.status,
        alertContext: investigation.alertContext,
        hypotheses: investigation.hypotheses,
        evidence: investigation.evidence.map((item) => ({
          id: item.id,
          modality: item.modality,
          summary: item.summary,
          supports: item.supports,
          contradicts: item.contradicts,
          expertTaskId: item.expertTaskId,
        })),
        expertTasks: investigation.expertTasks.map((task) => ({
          id: task.id,
          expert: task.expert,
          objective: task.objective,
          status: task.status,
          hypothesisIds: task.hypothesisIds,
          finding: task.finding,
          budgetClass: task.budgetClass,
          recoveryOfTaskId: task.recoveryOfTaskId,
          dispatchOperationId: task.dispatchOperationId,
          createdAt: task.createdAt,
          completedAt: task.completedAt,
        })),
        userInterventions: investigation.userInterventions,
        interruptions: investigation.interruptions,
        rootCause: investigation.rootCause,
        startedAt: investigation.startedAt,
        completedAt: investigation.completedAt,
      }),
    )
    .digest("hex");
}

function summaryFor(investigation: Investigation): InvestigationVisualizationSummary {
  const startedAt = Date.parse(investigation.startedAt);
  const completedAt = investigation.completedAt ? Date.parse(investigation.completedAt) : NaN;
  const durationMs =
    Number.isFinite(startedAt) && Number.isFinite(completedAt)
      ? Math.max(0, completedAt - startedAt)
      : undefined;

  let expertTokens = 0;
  let expertCost = 0;
  let hasCost = false;
  for (const task of investigation.expertTasks) {
    expertTokens += task.usage?.totalTokens ?? 0;
    if (typeof task.usage?.cost === "number" && Number.isFinite(task.usage.cost)) {
      expertCost += task.usage.cost;
      hasCost = true;
    }
  }

  const projection = investigation.schemaVersion === 2 ? foldBudget(investigation).projection : undefined;
  const primaryUsed = projection?.primary.used ?? 0;
  const primaryLimit = projection?.primary.limit ?? 0;
  const recoveryUsed = projection?.recovery.used ?? 0;
  const recoveryLimit = projection?.recovery.limit ?? 0;

  return {
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(hasCost ? { expertCost } : {}),
    expertTokens,
    budget: {
      used: primaryUsed + recoveryUsed,
      total: primaryLimit + recoveryLimit,
      primaryUsed,
      primaryLimit,
      recoveryUsed,
      recoveryLimit,
    },
  };
}

export class InvestigationVisualizationService {
  private readonly repository: InvestigationRepository;
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly listeners = new Set<VisualizationListener>();

  constructor(repository: InvestigationRepository) {
    this.repository = repository;
  }

  subscribe(listener: VisualizationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getOrCreate(investigationId: string): Promise<InvestigationVisualizationArtifact> {
    const investigation = await this.repository.get(investigationId);
    if (!terminalStatuses.has(investigation.status)) {
      throw new Error(
        "Investigation " +
          investigationId +
          " is " +
          investigation.status +
          "; visualization requires a terminal investigation",
      );
    }

    const hash = sourceHash(investigation);
    const existing = await this.repository.getVisualization(investigationId);
    if (existing?.sourceHash === hash) {
      if (existing.status === "pending" || existing.status === "generating") {
        this.schedule(investigationId);
      }
      return existing;
    }

    return this.enqueue(investigationId);
  }

  async enqueue(
    investigationId: string,
    conversationId?: string,
    force = false,
  ): Promise<InvestigationVisualizationArtifact> {
    const investigation = await this.repository.get(investigationId);
    if (!terminalStatuses.has(investigation.status)) {
      throw new Error(
        "Investigation " +
          investigationId +
          " is " +
          investigation.status +
          "; visualization requires a terminal investigation",
      );
    }

    const hash = sourceHash(investigation);
    const existing = await this.repository.getVisualization(investigationId);
    if (
      !force &&
      existing &&
      existing.sourceHash === hash &&
      (existing.status === "ready" ||
        existing.status === "pending" ||
        existing.status === "generating")
    ) {
      if (existing.status !== "ready") this.schedule(investigationId, conversationId);
      return existing;
    }

    const artifact: InvestigationVisualizationArtifact = {
      schemaVersion: 1,
      investigationId,
      status: "pending",
      sourceHash: hash,
      updatedAt: now(),
      summary: summaryFor(investigation),
    };
    await this.repository.saveVisualization(investigationId, artifact);
    await this.emit({
      investigationId,
      ...(conversationId ? { conversationId } : {}),
      status: artifact.status,
      updatedAt: artifact.updatedAt,
    });
    this.schedule(investigationId, conversationId);
    return artifact;
  }

  async regenerate(
    investigationId: string,
    conversationId?: string,
  ): Promise<InvestigationVisualizationArtifact> {
    return this.enqueue(investigationId, conversationId, true);
  }

  async waitForIdle(investigationId?: string): Promise<void> {
    if (investigationId) {
      const job = this.jobs.get(investigationId);
      if (job) await job;
      return;
    }

    // Snapshot + loop instead of a single Promise.all so callers also cover
    // jobs that were queued by a task settling during the first await.
    while (this.jobs.size > 0) {
      await Promise.allSettled([...this.jobs.values()]);
    }
  }

  async recoverPending(): Promise<string[]> {
    const recovered: string[] = [];
    for (const investigationId of await this.repository.listInvestigationIds()) {
      const artifact = await this.repository.getVisualization(investigationId);
      if (!artifact || (artifact.status !== "pending" && artifact.status !== "generating")) {
        continue;
      }
      recovered.push(investigationId);
      this.schedule(investigationId);
    }
    return recovered;
  }

  private schedule(investigationId: string, conversationId?: string): void {
    if (this.jobs.has(investigationId)) return;
    const job = Promise.resolve()
      .then(() => this.generate(investigationId, conversationId))
      .catch((error) => {
        process.stderr.write(
          "Visualization job failed for " +
            investigationId +
            ": " +
            (error instanceof Error ? error.message : String(error)) +
            "\n",
        );
      })
      .finally(() => {
        if (this.jobs.get(investigationId) === job) this.jobs.delete(investigationId);
      });
    this.jobs.set(investigationId, job);
  }

  private async generate(investigationId: string, conversationId?: string): Promise<void> {
    const investigation = await this.repository.get(investigationId);
    const hash = sourceHash(investigation);
    const generating: InvestigationVisualizationArtifact = {
      schemaVersion: 1,
      investigationId,
      status: "generating",
      sourceHash: hash,
      updatedAt: now(),
      summary: summaryFor(investigation),
    };
    await this.repository.saveVisualization(investigationId, generating);
    await this.emit({
      investigationId,
      ...(conversationId ? { conversationId } : {}),
      status: "generating",
      updatedAt: generating.updatedAt,
    });

    try {
      const events = await this.repository.listEvents(investigationId);
      const flow = buildInvestigationFlow(investigation, events);
      const mermaid = compileMermaidFlow(flow);
      const ready: InvestigationVisualizationArtifact = {
        ...generating,
        status: "ready",
        mermaid,
        generatedAt: now(),
        updatedAt: now(),
      };
      await this.repository.saveVisualization(investigationId, ready);
      await this.emit({
        investigationId,
        ...(conversationId ? { conversationId } : {}),
        status: "ready",
        updatedAt: ready.updatedAt,
      });
    } catch (error) {
      const failed: InvestigationVisualizationArtifact = {
        ...generating,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: now(),
      };
      await this.repository.saveVisualization(investigationId, failed);
      await this.emit({
        investigationId,
        ...(conversationId ? { conversationId } : {}),
        status: "failed",
        updatedAt: failed.updatedAt,
      });
      throw error;
    }
  }

  private async emit(event: InvestigationVisualizationEvent): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (error) {
        process.stderr.write("Visualization listener failed: " + String(error) + "\n");
      }
    }
  }
}
