import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export type RuntimeExecutionStatus =
  | "reserved"
  | "dispatching"
  | "running"
  | "settled"
  | "failed"
  | "cancelled"
  | "unknown";

export interface RuntimeExecutionRecord {
  runtimeExecutionId: string;
  idempotencyKeyHash: string;
  caseId: string;
  conversationId: string;
  status: RuntimeExecutionStatus;
  createdAt: string;
  updatedAt: string;
  investigationId?: string;
  lastError?: string;
  dispatchOwnerId?: string;
  promptSubmittedAt?: string;
}

export interface RuntimeExecutionReservation {
  record: RuntimeExecutionRecord;
  replayed: boolean;
}

/**
 * Runtime Execution 的本地持久化仓库。
 *
 * reservation 必须先于启动 Main Agent 的副作用落盘，这样服务重启后，
 * 同一个 Idempotency-Key 仍能找到原来的 execution/conversation。
 */
export class RuntimeExecutionRepository {
  private readonly executionsDir: string;

  constructor(executionsDir: string) {
    this.executionsDir = executionsDir;
  }

  async reserve(idempotencyKey: string, caseId: string): Promise<RuntimeExecutionReservation> {
    const idempotencyKeyHash = this.hashIdempotencyKey(idempotencyKey);
    const target = this.pathForHash(idempotencyKeyHash);
    await mkdir(this.executionsDir, { recursive: true });

    const now = new Date().toISOString();
    const runtimeExecutionId = `EXEC-${randomUUID()}`;
    const record: RuntimeExecutionRecord = {
      runtimeExecutionId,
      idempotencyKeyHash,
      caseId,
      conversationId: randomUUID(),
      status: "reserved",
      createdAt: now,
      updatedAt: now,
    };

    // 先完整写入并 fsync 临时文件，再通过 hard link 原子竞争最终文件名。
    // 目标已存在时 link 会失败为 EEXIST，从而安全复用已有 reservation。
    const temporary = this.temporaryPath(idempotencyKeyHash);
    await this.writeDurableFile(temporary, JSON.stringify(record, null, 2));

    try {
      await link(temporary, target);
      await this.syncDirectory();
      return { record, replayed: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      const existing = await this.getByHash(idempotencyKeyHash);
      if (existing.caseId !== caseId) {
        throw new Error(
          `Idempotency key conflict: existing case ${existing.caseId}, requested case ${caseId}`,
        );
      }
      return { record: existing, replayed: true };
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async getByExecutionId(runtimeExecutionId: string): Promise<RuntimeExecutionRecord | undefined> {
    const records = await this.listRecords();
    return records.find((item) => item.runtimeExecutionId === runtimeExecutionId);
  }

  async save(record: RuntimeExecutionRecord): Promise<RuntimeExecutionRecord> {
    await mkdir(this.executionsDir, { recursive: true });
    const target = this.pathForHash(record.idempotencyKeyHash);
    const temporary = this.temporaryPath(record.idempotencyKeyHash);
    const snapshot: RuntimeExecutionRecord = {
      ...record,
      updatedAt: new Date().toISOString(),
    };

    await this.writeDurableFile(temporary, JSON.stringify(snapshot, null, 2));
    try {
      await rename(temporary, target);
      await this.syncDirectory();
      return snapshot;
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async getByHash(idempotencyKeyHash: string): Promise<RuntimeExecutionRecord> {
    const raw = await readFile(this.pathForHash(idempotencyKeyHash), "utf8");
    return this.parseRecord(raw, idempotencyKeyHash);
  }

  private async listRecords(): Promise<RuntimeExecutionRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.executionsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    return Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map(async (entry) => {
          const raw = await readFile(join(this.executionsDir, entry), "utf8");
          return this.parseRecord(raw, entry);
        }),
    );
  }

  private parseRecord(raw: string, source: string): RuntimeExecutionRecord {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Corrupt runtime execution record ${source}`, { cause: error });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid runtime execution record ${source}`);
    }

    const record = parsed as Partial<RuntimeExecutionRecord>;
    if (
      typeof record.runtimeExecutionId !== "string" ||
      typeof record.idempotencyKeyHash !== "string" ||
      typeof record.caseId !== "string" ||
      typeof record.conversationId !== "string" ||
      typeof record.status !== "string" ||
      typeof record.createdAt !== "string" ||
      typeof record.updatedAt !== "string"
    ) {
      throw new Error(`Invalid runtime execution record ${source}`);
    }
    return record as RuntimeExecutionRecord;
  }

  private async writeDurableFile(path: string, content: string): Promise<void> {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async syncDirectory(): Promise<void> {
    const handle = await open(this.executionsDir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private temporaryPath(idempotencyKeyHash: string): string {
    return join(
      this.executionsDir,
      `.${idempotencyKeyHash}-${randomUUID()}.tmp`,
    );
  }

  private pathForHash(idempotencyKeyHash: string): string {
    return join(this.executionsDir, `${idempotencyKeyHash}.json`);
  }

  private hashIdempotencyKey(idempotencyKey: string): string {
    return createHash("sha256").update(idempotencyKey, "utf8").digest("hex");
  }
}
