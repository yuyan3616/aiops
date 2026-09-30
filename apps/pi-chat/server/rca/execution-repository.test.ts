import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RuntimeExecutionRepository } from "./execution-repository";

test("same idempotency key replays the original runtime execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rca-execution-"));
  try {
    const repository = new RuntimeExecutionRepository(dir);

    const first = await repository.reserve("alert-123", "t039");
    const second = await repository.reserve("alert-123", "t039");

    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(
      second.record.runtimeExecutionId,
      first.record.runtimeExecutionId,
    );
    assert.equal(second.record.conversationId, first.record.conversationId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent reservations converge on one runtime execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rca-execution-"));
  try {
    const repository = new RuntimeExecutionRepository(dir);

    const reservations = await Promise.all(
      Array.from({ length: 8 }, () => repository.reserve("same-key", "t039")),
    );

    assert.equal(
      new Set(reservations.map((item) => item.record.runtimeExecutionId)).size,
      1,
    );
    assert.equal(reservations.filter((item) => !item.replayed).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("same idempotency key cannot be reused for another case", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rca-execution-"));
  try {
    const repository = new RuntimeExecutionRepository(dir);
    await repository.reserve("alert-123", "t039");

    await assert.rejects(
      () => repository.reserve("alert-123", "t040"),
      /Idempotency key conflict/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("corrupt execution records fail loudly instead of looking missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rca-execution-"));
  try {
    const repository = new RuntimeExecutionRepository(dir);
    await writeFile(join(dir, "corrupt.json"), "{not-json", "utf8");

    await assert.rejects(
      () => repository.getByExecutionId("EXEC-00000000-0000-0000-0000-000000000000"),
      /Corrupt runtime execution record/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
