import { randomUUID } from "node:crypto";

import type {
  InvestigationSummary,
  RcaEventType,
} from "../../shared/rca-types";
import { getRcaHistoryConfig, type RcaHistoryConfig } from "./history/config";
import { InvestigationRepository } from "./history/investigation-repository";
import { PersistentAgentSessionRegistry } from "./history/session-registry";
import type { InvestigationRecord } from "./history/types";
import { RcaRuntime } from "./runtime";

interface ManagedInvestigation {
  runtime: RcaRuntime;
  registry: PersistentAgentSessionRegistry;
  createdAt: string;
  updatedAt: string;
  unsubscribe?: () => void;
  saveTimer?: ReturnType<typeof setTimeout>;
  saveChain: Promise<void>;
}

const TERMINAL_EVENTS = new Set<RcaEventType>([
  "rca.completed",
  "runtime.error",
]);

function investigationId() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `INV-${stamp}-${randomUUID().slice(0, 6)}`;
}

export class RcaService {
  private readonly runtimes = new Map<string, ManagedInvestigation>();
  private readonly repository: InvestigationRepository;
  private readonly historyConfig: RcaHistoryConfig;
  private demoRuntime?: RcaRuntime;

  constructor(config = getRcaHistoryConfig()) {
    this.historyConfig = config;
    this.repository = new InvestigationRepository(config);
  }

  async create(taskId = "t039") {
    const id = investigationId();
    const now = new Date().toISOString();
    const registry = new PersistentAgentSessionRegistry(this.historyConfig, id);
    const runtime = new RcaRuntime(id, taskId, { sessionRegistry: registry });
    const managed = this.manage(runtime, registry, now, now);
    await this.persist(managed, false);
    return runtime;
  }

  async get(id: string) {
    if (id === "demo") return this.getDemoRuntime();

    const managed = this.runtimes.get(id);
    if (managed) return managed.runtime;

    const record = await this.repository.get(id);
    if (!record) throw new Error(`Investigation ${id} not found.`);

    const registry = new PersistentAgentSessionRegistry(
      this.historyConfig,
      record.id,
      record.sessions,
    );
    const runtime = new RcaRuntime(record.id, record.datasetTaskId, {
      sessionRegistry: registry,
      restoredSnapshot: record.snapshot,
    });
    const next = this.manage(runtime, registry, record.createdAt, record.updatedAt);

    if (record.status === "running" || record.status === "stopping") {
      await this.persist(next, true);
    }
    return runtime;
  }

  async list(): Promise<InvestigationSummary[]> {
    const records = await this.repository.list();
    return records.map((record) => ({
      id: record.id,
      title: record.title,
      datasetTaskId: record.datasetTaskId,
      status: record.status === "running" || record.status === "stopping"
        ? "interrupted"
        : record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }));
  }

  private getDemoRuntime() {
    if (this.demoRuntime) return this.demoRuntime;
    const registry = new PersistentAgentSessionRegistry(this.historyConfig, "demo-preview");
    this.demoRuntime = new RcaRuntime("demo", "t039", { sessionRegistry: registry });
    return this.demoRuntime;
  }

  private manage(
    runtime: RcaRuntime,
    registry: PersistentAgentSessionRegistry,
    createdAt: string,
    updatedAt: string,
  ) {
    const managed: ManagedInvestigation = {
      runtime,
      registry,
      createdAt,
      updatedAt,
      saveChain: Promise.resolve(),
    };
    managed.unsubscribe = runtime.channel.subscribe((event) => {
      const immediate = TERMINAL_EVENTS.has(event.type) ||
        (event.type === "investigation.status" &&
          ["completed", "cancelled", "error"].includes(
            (event.payload as { status?: string }).status ?? "",
          ));
      this.schedulePersist(managed, immediate);
    });
    this.runtimes.set(runtime.incidentId, managed);
    return managed;
  }

  private schedulePersist(managed: ManagedInvestigation, immediate: boolean) {
    if (managed.saveTimer) clearTimeout(managed.saveTimer);
    managed.saveTimer = undefined;
    if (immediate) {
      void this.persist(managed, true).catch((error) => {
        console.error("Failed to persist RCA investigation", managed.runtime.incidentId, error);
      });
      return;
    }
    managed.saveTimer = setTimeout(() => {
      managed.saveTimer = undefined;
      void this.persist(managed, true).catch((error) => {
        console.error("Failed to persist RCA investigation", managed.runtime.incidentId, error);
      });
    }, 60);
  }

  async flushAll() {
    const pending = [...this.runtimes.values()].map(async (managed) => {
      if (managed.saveTimer) {
        clearTimeout(managed.saveTimer);
        managed.saveTimer = undefined;
        await this.persist(managed, true);
      } else {
        await managed.saveChain;
      }
    });
    await Promise.all(pending);
  }

  private persist(managed: ManagedInvestigation, touchUpdatedAt: boolean) {
    if (touchUpdatedAt) managed.updatedAt = new Date().toISOString();
    const snapshot = managed.runtime.snapshot();
    const record: InvestigationRecord = {
      version: 1,
      id: snapshot.incidentId,
      datasetTaskId: snapshot.dataset.taskId,
      title: snapshot.title,
      prompt: snapshot.prompt,
      status: snapshot.status,
      createdAt: managed.createdAt,
      updatedAt: managed.updatedAt,
      snapshot,
      sessions: managed.registry.references(),
    };
    managed.saveChain = managed.saveChain.then(
      () => this.repository.save(record),
      () => this.repository.save(record),
    );
    return managed.saveChain;
  }
}
