import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
}
