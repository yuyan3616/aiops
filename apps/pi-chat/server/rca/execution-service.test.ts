import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RuntimeExecutionRepository } from "./execution-repository";
import { RuntimeExecutionService } from "./execution-service";

function createHarness(repository: RuntimeExecutionRepository) {
  const conversations = new Map<string, string[]>();
  let sends = 0;

  const conversationService = {
    async ensureConversation(id: string) {
      if (!conversations.has(id)) conversations.set(id, []);
    },
    async hasExecutionMarker(id: string, marker: string) {
      return (conversations.get(id) ?? []).some((message) => message.includes(marker));
    },
    async send(id: string, prompt: string) {
      sends++;
      conversations.get(id)?.push(prompt);
    },
    async resolveInvestigation() {
      return undefined;
    },
    async abort() {},
  };

  const rcaService = {
    async get() {
      throw new Error("not linked");
    },
    async cancel() {
      return false;
    },
  };

  const service = new RuntimeExecutionService(
    repository,
    conversationService as never,
    rcaService as never,
  );

  return {
    service,
    getSendCount: () => sends,
    addMessage: (conversationId: string, message: string) => {
      const messages = conversations.get(conversationId) ?? [];
      messages.push(message);
      conversations.set(conversationId, messages);
    },
  };
}

test("idempotent create submits main-agent prompt only once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rca-execution-service-"));
  try {
    const repository = new RuntimeExecutionRepository(dir);
    const harness = createHarness(repository);

    const first = await harness.service.create({
      caseId: "t039",
      idempotencyKey: "alert-t039-001",
    });
    const second = await harness.service.create({
      caseId: "t039",
      idempotencyKey: "alert-t039-001",
    });

    assert.equal(first.runtimeExecutionId, second.runtimeExecutionId);
    assert.equal(harness.getSendCount(), 1);
    assert.equal(second.replayed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent idempotent create submits main-agent prompt only once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rca-execution-service-"));
  try {
    const repository = new RuntimeExecutionRepository(dir);
    const harness = createHarness(repository);

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        harness.service.create({
          caseId: "t039",
          idempotencyKey: "alert-t039-concurrent",
        }),
      ),
    );

    assert.equal(new Set(results.map((item) => item.runtimeExecutionId)).size, 1);
    assert.equal(harness.getSendCount(), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid idempotency keys are rejected before reservation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rca-execution-service-"));
  try {
    const repository = new RuntimeExecutionRepository(dir);
    const harness = createHarness(repository);

    await assert.rejects(
      () =>
        harness.service.create({
          caseId: "t039",
          idempotencyKey: "bad key",
        }),
      /Idempotency-Key/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("restart recovery resubmits when old dispatch has no session marker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rca-execution-service-"));
  try {
    const repository = new RuntimeExecutionRepository(dir);
    const reservation = await repository.reserve("restart-no-marker", "t039");
    await repository.save({
      ...reservation.record,
      status: "dispatching",
      dispatchOwnerId: "old-runtime-instance",
    });

    const harness = createHarness(repository);
    const replay = await harness.service.create({
      caseId: "t039",
      idempotencyKey: "restart-no-marker",
    });

    assert.equal(replay.runtimeExecutionId, reservation.record.runtimeExecutionId);
    assert.equal(harness.getSendCount(), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restart recovery does not resubmit when session marker already exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rca-execution-service-"));
  try {
    const repository = new RuntimeExecutionRepository(dir);
    const reservation = await repository.reserve("restart-with-marker", "t039");
    await repository.save({
      ...reservation.record,
      status: "dispatching",
      dispatchOwnerId: "old-runtime-instance",
    });

    const harness = createHarness(repository);
    harness.addMessage(
      reservation.record.conversationId,
      `[RUNTIME_EXECUTION ${reservation.record.runtimeExecutionId}]\n已提交`,
    );

    const replay = await harness.service.create({
      caseId: "t039",
      idempotencyKey: "restart-with-marker",
    });

    assert.equal(replay.runtimeExecutionId, reservation.record.runtimeExecutionId);
    assert.equal(harness.getSendCount(), 0);
    assert.equal(replay.replayed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
