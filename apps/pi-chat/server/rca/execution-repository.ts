import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
  constructor(private readonly executionsDir: string) {}

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

    // 先完整写临时文件，再使用 hard link 竞争最终文件名。
    // link 在目标已存在时会原子失败，因此不会把并发请求互相覆盖。
    const temporary = join(
      this.executionsDir,
      `.${idempotencyKeyHash}-${randomUUID()}.tmp`,
    );

    await writeFile(temporary, JSON.stringify(record, null, 2), "utf8");
    try {
      await link(temporary, target);
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
    const files = await this.listRecords();
    return files.find((item) => item.runtimeExecutionId === runtimeExecutionId);
  }

  async save(record: RuntimeExecutionRecord): Promise<void> {
    const target = this.pathForHash(record.idempotencyKeyHash);
    const temporary = join(
      this.executionsDir,
      `.${record.idempotencyKeyHash}-${randomUUID()}.tmp`,
    );
    const snapshot: RuntimeExecutionRecord = {
      ...record,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(temporary, JSON.stringify(snapshot, null, 2), "utf8");
    await rename(temporary, target);
  }

  private async getByHash(idempotencyKeyHash: string): Promise<RuntimeExecutionRecord> {
    const raw = await readFile(this.pathForHash(idempotencyKeyHash), "utf8");
    return JSON.parse(raw) as RuntimeExecutionRecord;
  }

  private async listRecords(): Promise<RuntimeExecutionRecord[]> {
    const { readdir } = await import("node:fs/promises");
    let entries: string[];
    try {
      entries = await readdir(this.executionsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const records = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map(async (entry) => {
          try {
            const raw = await readFile(join(this.executionsDir, entry), "utf8");
            return JSON.parse(raw) as RuntimeExecutionRecord;
          } catch {
            return undefined;
          }
        }),
    );
    return records.filter((record): record is RuntimeExecutionRecord => record !== undefined);
  }

  private pathForHash(idempotencyKeyHash: string): string {
    return join(this.executionsDir, `${idempotencyKeyHash}.json`);
  }

  private hashIdempotencyKey(idempotencyKey: string): string {
    return createHash("sha256").update(idempotencyKey, "utf8").digest("hex");
  }
}
