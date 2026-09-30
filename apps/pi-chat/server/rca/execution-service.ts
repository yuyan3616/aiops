import { randomUUID } from "node:crypto";

import type { ConversationService } from "@server/conversation/service";

import type { RcaService } from "./service";
import {
  RuntimeExecutionRepository,
  type RuntimeExecutionRecord,
  type RuntimeExecutionReservation,
} from "./execution-repository";

export interface CreateRuntimeExecutionInput {
  caseId: string;
  idempotencyKey: string;
}

export interface RuntimeExecutionView {
  runtimeExecutionId: string;
  conversationId: string;
  investigationId?: string;
  caseId: string;
  status: RuntimeExecutionRecord["status"];
  replayed?: boolean;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

/**
 * 外部 RCA Runtime Execution 的编排层。
 *
 * 这里只管理“如何可靠地启动一次 Main Agent 执行”，不参与 RCA 假设、证据和结论编排。
 * 真正的调查流程仍由 Conversation 中的 Pi Main Agent + RCA tools 驱动。
 */
export class RuntimeExecutionService {
  private readonly repository: RuntimeExecutionRepository;
  private readonly conversationService: ConversationService;
  private readonly rcaService: RcaService;
  private readonly executionLocks = new Map<string, Promise<void>>();
  private readonly runtimeInstanceId = randomUUID();

  constructor(
    repository: RuntimeExecutionRepository,
    conversationService: ConversationService,
    rcaService: RcaService,
  ) {
    this.repository = repository;
    this.conversationService = conversationService;
    this.rcaService = rcaService;
  }

  async create(input: CreateRuntimeExecutionInput): Promise<RuntimeExecutionView> {
    const caseId = this.normalizeCaseId(input.caseId);
    const idempotencyKey = this.validateIdempotencyKey(input.idempotencyKey);
    const reservation = await this.repository.reserve(idempotencyKey, caseId);

    return this.withExecutionLock(reservation.record.runtimeExecutionId, async () =>
      this.dispatchReservation(reservation),
    );
  }

  async get(runtimeExecutionId: string): Promise<RuntimeExecutionView> {
    this.assertExecutionId(runtimeExecutionId);
    return this.withExecutionLock(runtimeExecutionId, async () => {
      const record = await this.requireRecord(runtimeExecutionId);
      const refreshed = await this.refreshFromInvestigation(record);
      return this.view(refreshed);
    });
  }

  async cancel(runtimeExecutionId: string): Promise<RuntimeExecutionView> {
    this.assertExecutionId(runtimeExecutionId);
    return this.withExecutionLock(runtimeExecutionId, async () => {
      let record = await this.requireRecord(runtimeExecutionId);
      record = await this.refreshFromInvestigation(record);

      if (record.status === "settled" || record.status === "failed" || record.status === "cancelled") {
        return this.view(record);
      }

      if (record.investigationId) {
        await this.rcaService.cancel(record.investigationId);
      }
      await this.conversationService.abort(record.conversationId);

      record = {
        ...record,
        status: "cancelled",
        lastError: undefined,
      };
      await this.repository.save(record);
      return this.view(record);
    });
  }

  private async dispatchReservation(
    reservation: RuntimeExecutionReservation,
  ): Promise<RuntimeExecutionView> {
    let record =
      (await this.repository.getByExecutionId(reservation.record.runtimeExecutionId)) ??
      reservation.record;

    if (this.isTerminal(record.status)) {
      return this.view(record, reservation.replayed);
    }

    // 同一进程里已经 handoff 的重复请求不再依赖 marker 可见性，避免极短窗口内重复 prompt。
    if (
      reservation.replayed &&
      record.dispatchOwnerId === this.runtimeInstanceId &&
      (record.status === "dispatching" || record.status === "running")
    ) {
      return this.view(record, true);
    }

    await this.conversationService.ensureConversation(record.conversationId);

    const marker = this.executionMarker(record.runtimeExecutionId);
    const alreadySubmitted = await this.conversationService.hasExecutionMarker(
      record.conversationId,
      marker,
    );

    if (alreadySubmitted) {
      record = await this.refreshFromInvestigation({
        ...record,
        status: record.status === "reserved" || record.status === "dispatching"
          ? "running"
          : record.status,
      });
      record = await this.repository.save({
        ...record,
        dispatchOwnerId: this.runtimeInstanceId,
      });
      return this.view(record, true);
    }

    record = await this.repository.save({
      ...record,
      status: "dispatching",
      lastError: undefined,
      dispatchOwnerId: this.runtimeInstanceId,
    });

    try {
      await this.conversationService.send(
        record.conversationId,
        this.executionPrompt(marker, record.caseId),
      );

      record = await this.refreshFromInvestigation({
        ...record,
        status: "running",
        dispatchOwnerId: this.runtimeInstanceId,
        promptSubmittedAt: new Date().toISOString(),
      });
      record = await this.repository.save(record);
      return this.view(record, reservation.replayed);
    } catch (error) {
      // send() 在真正 handoff 前抛出的错误属于明确失败；异步 Agent 错误会由后续状态查询观察。
      record = {
        ...record,
        status: "failed",
        lastError: error instanceof Error ? error.message : String(error),
      };
      record = await this.repository.save(record);
      throw error;
    }
  }

  private async refreshFromInvestigation(
    record: RuntimeExecutionRecord,
  ): Promise<RuntimeExecutionRecord> {
    const investigationId =
      record.investigationId ??
      (await this.conversationService.resolveInvestigation(record.conversationId));

    if (!investigationId) return record;

    let investigation;
    try {
      investigation = await this.rcaService.get(investigationId);
    } catch {
      return {
        ...record,
        investigationId,
        status: "unknown",
        lastError: "Linked investigation is temporarily unavailable",
      };
    }

    const status = (() => {
      switch (investigation.status) {
        case "running":
          return "running" as const;
        case "completed":
        case "inconclusive":
          return "settled" as const;
        case "cancelled":
          return "cancelled" as const;
        case "failed":
        case "interrupted":
          return "failed" as const;
      }
    })();

    const refreshed: RuntimeExecutionRecord = {
      ...record,
      investigationId,
      status,
      ...(status === "failed" && investigation.error
        ? { lastError: investigation.error }
        : { lastError: undefined }),
    };
    return this.repository.save(refreshed);
  }

  private executionMarker(runtimeExecutionId: string): string {
    return `[RUNTIME_EXECUTION ${runtimeExecutionId}]`;
  }

  private executionPrompt(marker: string, caseId: string): string {
    return [
      marker,
      `请对 RCA case ${caseId} 发起并完成一次完整根因调查。`,
      "必须复用当前 Main Agent 的 RCA tools 驱动 Investigation；基于证据维护假设、调度专家，并在证据允许时调用 conclude_investigation 收敛。",
      "这是平台发起的独立执行任务，不要只返回调查计划。",
    ].join("\n");
  }

  private normalizeCaseId(caseId: string): string {
    const normalized = caseId.trim().toLowerCase();
    if (!/^t\d{1,6}$/.test(normalized)) {
      throw new Error("caseId must match t<number>");
    }
    return normalized;
  }

  private validateIdempotencyKey(value: string): string {
    const normalized = value.trim();
    if (normalized.length < 8 || normalized.length > 256) {
      throw new Error("Idempotency-Key length must be between 8 and 256 characters");
    }
    if (!/^[A-Za-z0-9._:@/+\-=]+$/.test(normalized)) {
      throw new Error("Idempotency-Key contains unsupported characters");
    }
    return normalized;
  }

  private assertExecutionId(value: string): void {
    if (!/^EXEC-[0-9a-f-]{36}$/i.test(value)) {
      throw new Error("Invalid runtime execution id");
    }
  }

  private async requireRecord(runtimeExecutionId: string): Promise<RuntimeExecutionRecord> {
    const record = await this.repository.getByExecutionId(runtimeExecutionId);
    if (!record) throw new Error(`Runtime execution ${runtimeExecutionId} not found`);
    return record;
  }

  private isTerminal(status: RuntimeExecutionRecord["status"]): boolean {
    return status === "settled" || status === "failed" || status === "cancelled";
  }

  private view(record: RuntimeExecutionRecord, replayed?: boolean): RuntimeExecutionView {
    return {
      runtimeExecutionId: record.runtimeExecutionId,
      conversationId: record.conversationId,
      caseId: record.caseId,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.investigationId ? { investigationId: record.investigationId } : {}),
      ...(record.lastError ? { lastError: record.lastError } : {}),
      ...(replayed !== undefined ? { replayed } : {}),
    };
  }

  private async withExecutionLock<T>(executionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.executionLocks.get(executionId);
    let unlock!: () => void;
    const current = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    this.executionLocks.set(executionId, current);

    if (previous) await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      if (this.executionLocks.get(executionId) === current) {
        this.executionLocks.delete(executionId);
      }
      unlock();
    }
  }
}
