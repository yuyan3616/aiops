import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { Investigation, InvestigationEvent, RCAResult, ToolCallRecord } from "./types";

export class InvestigationRepository {
  readonly investigationsDir: string;

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
    const directory = this.directory(investigation.id);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "investigation.json"),
      JSON.stringify(investigation, null, 2),
      "utf8",
    );
  }

  async get(investigationId: string): Promise<Investigation> {
    const raw = await readFile(join(this.directory(investigationId), "investigation.json"), "utf8");
    return JSON.parse(raw) as Investigation;
  }

  async listEvents(investigationId: string): Promise<InvestigationEvent[]> {
    try {
      const raw = await readFile(join(this.directory(investigationId), "events.jsonl"), "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as InvestigationEvent);
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

  async saveReport(investigationId: string, result: RCAResult, report: string): Promise<void> {
    const directory = this.directory(investigationId);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "final-report.json"),
      JSON.stringify({ result, report }, null, 2),
      "utf8",
    );
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

      const completedAt = new Date().toISOString();
      const errorMessage = "Investigation interrupted by process restart before completion.";
      investigation.status = "failed";
      investigation.completedAt = completedAt;
      investigation.error = errorMessage;

      for (const toolCall of investigation.toolCalls) {
        if (toolCall.status !== "running") continue;
        toolCall.status = "failed";
        toolCall.completedAt = completedAt;
        toolCall.error = errorMessage;
        await this.appendToolCall(investigation.id, toolCall);
      }
      for (const task of investigation.expertTasks) {
        if (task.status !== "running" && task.status !== "pending") continue;
        task.status = "failed";
        task.completedAt = completedAt;
      }

      await this.save(investigation);
      const events = await this.listEvents(investigation.id);
      await this.appendEvent({
        id: (events.at(-1)?.id ?? 0) + 1,
        investigationId: investigation.id,
        type: "investigation.failed",
        at: completedAt,
        summary: errorMessage,
        payload: { recoveredAfterRestart: true },
      });
      recovered.push(investigation.id);
    }
    return recovered;
  }
}
