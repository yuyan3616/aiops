import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RcaHistoryConfig } from "./config.ts";
import type { InvestigationRecord } from "./types.ts";

export class InvestigationRepository {
  private readonly config: RcaHistoryConfig;

  constructor(config: RcaHistoryConfig) {
    this.config = config;
  }

  recordPath(id: string) {
    return join(this.config.investigationsDir, `${id}.json`);
  }

  async save(record: InvestigationRecord) {
    await mkdir(this.config.investigationsDir, { recursive: true });
    const target = this.recordPath(record.id);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(record, null, 2), "utf8");
    await rename(temporary, target);
  }

  async get(id: string): Promise<InvestigationRecord | null> {
    try {
      const raw = await readFile(this.recordPath(id), "utf8");
      const parsed = JSON.parse(raw) as InvestigationRecord;
      return parsed?.version === 1 && parsed.id === id ? parsed : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(): Promise<InvestigationRecord[]> {
    await mkdir(this.config.investigationsDir, { recursive: true });
    const files = await readdir(this.config.investigationsDir);
    const records = await Promise.all(
      files.filter((file) => file.endsWith(".json")).map(async (file) => {
        try {
          const raw = await readFile(join(this.config.investigationsDir, file), "utf8");
          const parsed = JSON.parse(raw) as InvestigationRecord;
          return parsed?.version === 1 ? parsed : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    return records
      .filter((record): record is InvestigationRecord => Boolean(record))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async delete(id: string) {
    await rm(this.recordPath(id), { force: true });
  }
}
