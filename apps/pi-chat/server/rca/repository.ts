import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { appendLedgerEvent, assertBudgetConsistency, foldBudget, nextLedgerEvent } from "./budget";
import type { Investigation, InvestigationEvent, RCAResult, ToolCallRecord } from "./types";
import type { InvestigationVisualizationArtifact } from "./visualization/types";

const terminalInvestigationStatuses = new Set<Investigation["status"]>([
  "completed",
  "inconclusive",
  "failed",
  "cancelled",
]);
const terminalExpertTaskStatuses = new Set<Investigation["expertTasks"][number]["status"]>([
  "completed",
  "failed",
  "cancelled",
]);
const terminalToolCallStatuses = new Set<ToolCallRecord["status"]>([
  "completed",
  "failed",
  "cancelled",
]);

function replaceObject<T extends object>(target: T, source: T): void {
  for (const key of Object.keys(target) as Array<keyof T>) {
    delete target[key];
  }
  Object.assign(target, structuredClone(source));
}

function preserveTerminalState(current: Investigation, incoming: Investigation): void {
  if (terminalInvestigationStatuses.has(current.status) && current.status !== incoming.status) {
    replaceObject(incoming, current);
    return;
  }

  for (const currentTask of current.expertTasks) {
    if (!terminalExpertTaskStatuses.has(currentTask.status)) continue;
    const incomingTask = incoming.expertTasks.find((task) => task.id === currentTask.id);
    if (!incomingTask || incomingTask.status === currentTask.status) continue;
    replaceObject(incomingTask, currentTask);
  }

  for (const currentCall of current.toolCalls) {
    if (!terminalToolCallStatuses.has(currentCall.status)) continue;
    const incomingCall = incoming.toolCalls.find((call) => call.id === currentCall.id);
    if (!incomingCall || incomingCall.status === currentCall.status) continue;
    replaceObject(incomingCall, currentCall);
  }
}

export class InvestigationRepository {
  readonly investigationsDir: string;
  private readonly saveQueues = new Map<string, Promise<void>>();
  private readonly visualizationSaveQueues = new Map<string, Promise<void>>();

  constructor(investigationsDir: string) {
    this.investigationsDir = resolve(investigationsDir);
  }

  directory(investigationId: string): string {
    if (!/^INV-[A-Za-z0-9-]+$/.test(investigationId)) {
      throw new Error(`Invalid investigation id: ${investigationId}`);
    }
    const directory = resolve(this.investigationsDir, investigationId);
    const child = relative(this.investigationsDir, directory);
    if (!child || child.startsWith("..")) {
      throw new Error(`Investigation path escaped repository: ${investigationId}`);
    }
    return directory;
  }

  async save(investigation: Investigation): Promise<void> {
    // Queue an immutable version. A running Agent may mutate its live object before
    // an earlier queued write starts; serializing that object later loses decisions.
    const snapshot = structuredClone(investigation);
    const previous = this.saveQueues.get(investigation.id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          const current = await this.get(investigation.id);
          if (snapshot.schemaVersion === 2) {
            assertBudgetConsistency(snapshot);
            if (
              current.schemaVersion === 2 &&
              terminalInvestigationStatuses.has(current.status) &&
              JSON.stringify(current) !== JSON.stringify(snapshot)
            ) {
              throw new Error(`Terminal investigation ${snapshot.id} is immutable`);
            }
          } else {
            preserveTerminalState(current, snapshot);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }

        const directory = this.directory(investigation.id);
        await mkdir(directory, { recursive: true });
        const target = join(directory, "investigation.json");
        const temporary = join(directory, `.investigation-${randomUUID()}.tmp`);
        try {
          const handle = await open(temporary, "wx");
          try {
            await handle.writeFile(JSON.stringify(snapshot, null, 2), "utf8");
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temporary, target);
        } catch (error) {
          await unlink(temporary).catch(() => undefined);
          throw error;
        }
        // On a filesystem supporting directory fsync, make the rename durable too.
        const directoryHandle = await open(directory, "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      });
    const tracked = next.finally(() => {
      if (this.saveQueues.get(investigation.id) === tracked) {
        this.saveQueues.delete(investigation.id);
      }
    });
    this.saveQueues.set(investigation.id, tracked);
    return tracked;
  }

  async get(investigationId: string): Promise<Investigation> {
    const raw = await readFile(join(this.directory(investigationId), "investigation.json"), "utf8");
    return JSON.parse(raw) as Investigation;
  }

  async listEvents(investigationId: string): Promise<InvestigationEvent[]> {
    try {
      const file = join(this.directory(investigationId), "events.jsonl");
      const raw = await readFile(file, "utf8");
      const lines = raw.split("\n");
      if (lines.at(-1) === "") lines.pop();
      const events: InvestigationEvent[] = [];
      for (const [index, line] of lines.entries()) {
        try {
          const event = JSON.parse(line) as InvestigationEvent;
          if (event.id !== events.length + 1) throw new Error("UI event sequence gap");
          events.push(event);
        } catch (error) {
          if (index !== lines.length - 1 || raw.endsWith("\n")) throw error;
          const quarantine = `${file}.corrupt-${Date.now()}-${randomUUID()}`;
          await writeFile(quarantine, line, "utf8");
          const prefix = `${lines.slice(0, -1).join("\n")}${index ? "\n" : ""}`;
          const temporary = `${file}.${randomUUID()}.tmp`;
          await writeFile(temporary, prefix, "utf8");
          await rename(temporary, file);
          process.stderr.write(`Quarantined damaged RCA event tail: ${quarantine}\n`);
          return events;
        }
      }
      if (raw && !raw.endsWith("\n")) await appendFile(file, "\n", "utf8");
      return events;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      throw error;
    }
  }

  async appendEvent(event: InvestigationEvent): Promise<void> {
    const directory = this.directory(event.investigationId);
    await mkdir(directory, { recursive: true });
    await appendFile(join(directory, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
  }

  async appendToolCall(investigationId: string, toolCall: ToolCallRecord): Promise<void> {
    const directory = this.directory(investigationId);
    await mkdir(directory, { recursive: true });
    await appendFile(join(directory, "tool-calls.jsonl"), `${JSON.stringify(toolCall)}\n`, "utf8");
  }

  async saveEvidenceSnapshot(
    investigationId: string,
    toolCallId: string,
    snapshot: unknown,
  ): Promise<string> {
    if (!/^C\d+$/.test(toolCallId)) throw new Error("Invalid tool call id for snapshot");
    const directory = join(this.directory(investigationId), "evidence-snapshots");
    await mkdir(directory, { recursive: true });
    const target = join(directory, `${toolCallId}.json`);
    const serialized = JSON.stringify(structuredClone(snapshot), null, 2);
    try {
      const handle = await open(target, "wx");
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = await readFile(target, "utf8");
      if (current !== serialized) {
        throw new Error(`Immutable evidence snapshot conflict for ${investigationId}/${toolCallId}`);
      }
    }
    return `investigation://${investigationId}/evidence-snapshots/${toolCallId}.json`;
  }

  async getEvidenceSnapshot(investigationId: string, toolCallId: string): Promise<unknown> {
    if (!/^C\d+$/.test(toolCallId)) throw new Error("Invalid tool call id for snapshot");
    const raw = await readFile(
      join(this.directory(investigationId), "evidence-snapshots", `${toolCallId}.json`),
      "utf8",
    );
    return JSON.parse(raw) as unknown;
  }

  async saveReport(investigationId: string, result: RCAResult, report: string): Promise<void> {
    const directory = this.directory(investigationId);
    await mkdir(directory, { recursive: true });
    const markdown = report.endsWith("\n") ? report : `${report}\n`;
    await Promise.all([
      writeFile(
        join(directory, "final-report.json"),
        JSON.stringify({ result, report }, null, 2),
        "utf8",
      ),
      writeFile(join(directory, "final-report.md"), markdown, "utf8"),
    ]);
  }

  async getReport(investigationId: string): Promise<string> {
    const directory = this.directory(investigationId);
    try {
      return await readFile(join(directory, "final-report.md"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    // Backward compatibility for investigations completed before Markdown
    // artifacts were introduced.
    const raw = await readFile(join(directory, "final-report.json"), "utf8");
    const persisted = JSON.parse(raw) as { report?: unknown };
    if (typeof persisted.report !== "string" || !persisted.report.trim()) {
      throw new Error(`Investigation ${investigationId} has no downloadable report`);
    }
    return persisted.report.endsWith("\n") ? persisted.report : `${persisted.report}\n`;
  }

  async saveEvaluation(investigationId: string, evaluation: unknown): Promise<void> {
    const directory = this.directory(investigationId);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "evaluation.json"),
      JSON.stringify(evaluation, null, 2),
      "utf8",
    );
  }

  async listInvestigationIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.investigationsDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && /^INV-[A-Za-z0-9-]+$/.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async getVisualization(
    investigationId: string,
  ): Promise<InvestigationVisualizationArtifact | undefined> {
    try {
      const raw = await readFile(
        join(this.directory(investigationId), "visualization.json"),
        "utf8",
      );
      return JSON.parse(raw) as InvestigationVisualizationArtifact;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async saveVisualization(
    investigationId: string,
    artifact: InvestigationVisualizationArtifact,
  ): Promise<void> {
    if (artifact.investigationId !== investigationId) {
      throw new Error("Visualization investigation id mismatch");
    }
    const snapshot = structuredClone(artifact);
    const previous = this.visualizationSaveQueues.get(investigationId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const directory = this.directory(investigationId);
        await mkdir(directory, { recursive: true });
        const target = join(directory, "visualization.json");
        const temporary = join(directory, ".visualization-" + randomUUID() + ".tmp");
        try {
          const handle = await open(temporary, "wx");
          try {
            await handle.writeFile(JSON.stringify(snapshot, null, 2), "utf8");
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temporary, target);
        } catch (error) {
          await unlink(temporary).catch(() => undefined);
          throw error;
        }
        const directoryHandle = await open(directory, "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      });
    const tracked = next.finally(() => {
      if (this.visualizationSaveQueues.get(investigationId) === tracked) {
        this.visualizationSaveQueues.delete(investigationId);
      }
    });
    this.visualizationSaveQueues.set(investigationId, tracked);
    return tracked;
  }

  async recoverInterrupted(): Promise<string[]> {
    const recovered: string[] = [];
    let entries;
    try {
      entries = await readdir(this.investigationsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return recovered;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !/^INV-[A-Za-z0-9-]+$/.test(entry.name)) continue;
      let investigation: Investigation;
      try {
        investigation = await this.get(entry.name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (investigation.status !== "running") continue;

      const interruptedAt = new Date().toISOString();
      const errorMessage = "Investigation interrupted by process restart before completion.";
      investigation.status = "interrupted";
      investigation.interruptions = [
        ...(investigation.interruptions ?? []),
        { at: interruptedAt, reason: errorMessage },
      ];
      investigation.error = errorMessage;

      const interruptedToolCalls: ToolCallRecord[] = [];
      for (const toolCall of investigation.toolCalls) {
        if (toolCall.status !== "running") continue;
        toolCall.status = "failed";
        toolCall.completedAt = interruptedAt;
        toolCall.interruptedByRestart = true;
        toolCall.error = errorMessage;
        interruptedToolCalls.push(toolCall);
        await this.appendToolCall(investigation.id, toolCall);
      }

      const interruptedExpertTasks = [];
      for (const task of investigation.expertTasks) {
        if (task.status !== "running" && task.status !== "pending") continue;
        const wasRunning = task.status === "running";
        task.status = "failed";
        task.completedAt = interruptedAt;
        task.interruptedByRestart = true;
        if (investigation.schemaVersion === 2 && task.budgetReservationId) {
          const ledger = foldBudget(investigation);
          const reservation = ledger.reservations.get(task.budgetReservationId);
          if (reservation && !reservation.terminal) {
            const hadWork =
              investigation.toolCalls.some(
                (call) => call.expertTaskId === task.id && call.status === "completed",
              ) || (investigation.observations ?? []).some((item) => item.expertTaskId === task.id);
            const started = (investigation.budgetLedger ?? []).some(
              (event) =>
                event.type === "safety.consumed" &&
                event.resource === "started_task" &&
                event.executionId === task.id,
            );
            const committed = task.budgetClass === "recovery" ? started : hadWork;
            task.terminationReason = "service_restart";
            task.recoveryEligible = task.budgetClass === "primary" && started && !hadWork;
            appendLedgerEvent(
              investigation,
              nextLedgerEvent(investigation, {
                type: committed ? "budget.committed" : "budget.released",
                reservationId: task.budgetReservationId,
                taskId: task.id,
                budgetClass: task.budgetClass ?? "primary",
                reason: "service_restart",
              }),
            );
          }
        }
        if (wasRunning) interruptedExpertTasks.push(task);
      }

      await this.save(investigation);

      const events = await this.listEvents(investigation.id);
      let nextEventId = (events.at(-1)?.id ?? 0) + 1;
      for (const toolCall of interruptedToolCalls) {
        await this.appendEvent({
          id: nextEventId++,
          investigationId: investigation.id,
          type: "tool.completed",
          at: interruptedAt,
          summary: errorMessage,
          payload: { toolCall },
        });
      }
      for (const expertTask of interruptedExpertTasks) {
        await this.appendEvent({
          id: nextEventId++,
          investigationId: investigation.id,
          type: "expert.completed",
          at: interruptedAt,
          summary: errorMessage,
          payload: { expertTask },
        });
      }
      await this.appendEvent({
        id: nextEventId,
        investigationId: investigation.id,
        type: "investigation.interrupted",
        at: interruptedAt,
        summary: errorMessage,
        payload: { recoveredAfterRestart: true, resumable: true },
      });
      recovered.push(investigation.id);
    }
    return recovered;
  }
}
