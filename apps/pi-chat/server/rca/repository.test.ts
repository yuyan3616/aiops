import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InvestigationRepository } from "./repository";
import type { Investigation, RCAResult } from "./types";

test("restart recovery closes running RCA work and is idempotent", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-chat-rca-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = new InvestigationRepository(directory);
  const investigation: Investigation = {
    id: "INV-test",
    caseId: "t039",
    status: "running",
    symptom: "checkout latency",
    alertContext: {
      eventId: "a1",
      title: "checkout latency",
      triggerTime: "2026-09-28T00:00:00.000Z",
      window: {
        from: "2026-09-28T00:00:00.000Z",
        to: "2026-09-28T00:05:00.000Z",
      },
      entity: { id: "checkout", name: "checkout", type: "service", domain: "app" },
    },
    scope: {
      timeRange: {
        from: "2026-09-28T00:00:00.000Z",
        to: "2026-09-28T00:05:00.000Z",
      },
      candidateEntities: ["checkout"],
    },
    hypotheses: [],
    observations: [],
    evidence: [],
    expertTasks: [{
      id: "T01",
      expert: "trace",
      objective: "locate latency",
      status: "running",
      hypothesisIds: [],
      toolCallIds: ["C01"],
      evidenceIds: [],
      implementation: "pi-session",
      createdAt: "2026-09-28T00:00:00.000Z",
    }],
    toolCalls: [{
      id: "C01",
      expertTaskId: "T01",
      tool: "query_traces",
      query: { service: "checkout" },
      status: "running",
      startedAt: "2026-09-28T00:00:00.000Z",
    }],
    rounds: 1,
    startedAt: "2026-09-28T00:00:00.000Z",
  };

  await repository.save(investigation);
  await repository.appendEvent({
    id: 1,
    investigationId: investigation.id,
    type: "expert.started",
    at: investigation.startedAt,
    summary: "trace started",
    payload: { expertTask: investigation.expertTasks[0] },
  });
  await repository.appendEvent({
    id: 2,
    investigationId: investigation.id,
    type: "tool.started",
    at: investigation.startedAt,
    summary: "trace tool started",
    payload: { toolCall: investigation.toolCalls[0] },
  });

  assert.deepEqual(await repository.recoverInterrupted(), ["INV-test"]);

  const recovered = await repository.get("INV-test");
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.expertTasks[0]?.status, "failed");
  assert.equal(recovered.expertTasks[0]?.interruptedByRestart, true);
  assert.equal(recovered.toolCalls[0]?.status, "failed");
  assert.equal(recovered.toolCalls[0]?.interruptedByRestart, true);

  const events = await repository.listEvents("INV-test");
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "expert.started",
      "tool.started",
      "tool.completed",
      "expert.completed",
      "investigation.interrupted",
    ],
  );
  assert.deepEqual(events.map((event) => event.id), [1, 2, 3, 4, 5]);

  assert.deepEqual(await repository.recoverInterrupted(), []);
  assert.equal((await repository.listEvents("INV-test")).length, 5);
});


test("terminal RCA state cannot be regressed by a stale whole-document save", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-chat-rca-terminal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = new InvestigationRepository(directory);
  const investigation: Investigation = {
    id: "INV-terminal",
    caseId: "t039",
    status: "running",
    symptom: "checkout latency",
    alertContext: {
      eventId: "a1",
      title: "checkout latency",
      triggerTime: "2026-09-28T00:00:00.000Z",
      window: {
        from: "2026-09-28T00:00:00.000Z",
        to: "2026-09-28T00:05:00.000Z",
      },
      entity: { id: "checkout", name: "checkout", type: "service", domain: "app" },
    },
    scope: {
      timeRange: {
        from: "2026-09-28T00:00:00.000Z",
        to: "2026-09-28T00:05:00.000Z",
      },
      candidateEntities: ["checkout"],
    },
    hypotheses: [],
    observations: [],
    evidence: [],
    expertTasks: [{
      id: "T01",
      expert: "trace",
      objective: "locate latency",
      status: "running",
      hypothesisIds: [],
      toolCallIds: ["C01"],
      evidenceIds: [],
      implementation: "pi-session",
      createdAt: "2026-09-28T00:00:00.000Z",
    }],
    toolCalls: [{
      id: "C01",
      expertTaskId: "T01",
      tool: "query_traces",
      query: { service: "checkout" },
      status: "running",
      startedAt: "2026-09-28T00:00:00.000Z",
    }],
    rounds: 1,
    startedAt: "2026-09-28T00:00:00.000Z",
  };

  await repository.save(investigation);
  const stale = structuredClone(investigation);

  investigation.status = "cancelled";
  investigation.completedAt = "2026-09-28T00:01:00.000Z";
  investigation.error = "Investigation cancelled";
  investigation.expertTasks[0]!.status = "cancelled";
  investigation.expertTasks[0]!.completedAt = investigation.completedAt;
  investigation.toolCalls[0]!.status = "cancelled";
  investigation.toolCalls[0]!.completedAt = investigation.completedAt;
  investigation.toolCalls[0]!.error = investigation.error;
  await repository.save(investigation);

  stale.status = "running";
  stale.expertTasks[0]!.status = "completed";
  stale.toolCalls[0]!.status = "completed";
  stale.toolCalls[0]!.resultSummary = "late success";
  await repository.save(stale);

  const persisted = await repository.get(investigation.id);
  assert.equal(persisted.status, "cancelled");
  assert.equal(persisted.expertTasks[0]?.status, "cancelled");
  assert.equal(persisted.toolCalls[0]?.status, "cancelled");
  assert.equal(persisted.toolCalls[0]?.resultSummary, undefined);
});

test("persists Markdown report artifacts and reads legacy JSON reports", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-chat-rca-report-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = new InvestigationRepository(directory);
  const result: RCAResult = {
    investigationId: "INV-report",
    status: "confirmed",
    rootCauseEntities: ["checkout"],
    summary: "checkout dependency timeout",
    evidenceIds: ["E01", "E02"],
    rejectedHypotheses: [],
    confidence: 0.91,
  };
  const report = "# RCA Report\n\ncheckout dependency timeout";

  await repository.saveReport(result.investigationId, result, report);

  const markdownPath = join(repository.directory(result.investigationId), "final-report.md");
  assert.equal(await readFile(markdownPath, "utf8"), report + "\n");
  assert.equal(await repository.getReport(result.investigationId), report + "\n");

  const legacyId = "INV-legacy-report";
  const legacyDirectory = repository.directory(legacyId);
  await mkdir(legacyDirectory, { recursive: true });
  await writeFile(
    join(legacyDirectory, "final-report.json"),
    JSON.stringify({ result: { ...result, investigationId: legacyId }, report }),
    "utf8",
  );
  assert.equal(await repository.getReport(legacyId), report + "\n");
});

