import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InvestigationRepository } from "../investigation-repository.ts";
import type { RcaHistoryConfig } from "../config.ts";
import type { InvestigationRecord } from "../types.ts";

function config(rootDir: string): RcaHistoryConfig {
  return {
    rootDir,
    investigationsDir: join(rootDir, "investigations"),
    sessionsDir: join(rootDir, "sessions"),
    workspacesDir: join(rootDir, "workspaces"),
  };
}

function record(id: string, updatedAt: string): InvestigationRecord {
  return {
    version: 1,
    id,
    datasetTaskId: "t039",
    title: `title-${id}`,
    prompt: "inspect checkout latency",
    status: "completed",
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt,
    sessions: {
      coordinator: { sessionId: `${id}-coordinator`, sessionFile: `/sessions/${id}.jsonl` },
    },
    snapshot: {
      incidentId: id,
      prompt: "inspect checkout latency",
      title: `title-${id}`,
      severity: "P1",
      window: "09:20 ~ 09:30",
      dataset: { name: "RCA100", version: "v1.1", taskId: "t039", telemetryReady: true },
      status: "completed",
      phase: 4,
      agents: [],
      tasks: [],
      hypotheses: [],
      evidence: [],
      messages: [],
      thinking: [],
      toolRuns: [],
      conclusion: { rootCause: "x", causalChain: ["a", "b"], evidenceIds: ["EV01", "EV02"] },
      runId: "run-1",
      stream: { id: "stream-1", lastEventId: 42 },
    },
  };
}

test("InvestigationRepository persists, overwrites, loads and sorts real history", async () => {
  const root = await mkdtemp(join(tmpdir(), "rca-history-"));
  try {
    const repository = new InvestigationRepository(config(root));
    await repository.save(record("INV-1", "2026-09-25T01:00:00.000Z"));
    await repository.save(record("INV-2", "2026-09-25T02:00:00.000Z"));

    const updated = record("INV-1", "2026-09-25T03:00:00.000Z");
    updated.title = "updated";
    await repository.save(updated);

    const loaded = await repository.get("INV-1");
    assert.equal(loaded?.title, "updated");
    assert.equal(loaded?.sessions.coordinator?.sessionId, "INV-1-coordinator");

    const history = await repository.list();
    assert.deepEqual(history.map((item) => item.id), ["INV-1", "INV-2"]);
    assert.equal(await repository.get("missing"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
