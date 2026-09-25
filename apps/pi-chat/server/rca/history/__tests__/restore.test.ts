import assert from "node:assert/strict";
import test from "node:test";

import type { InvestigationSnapshot } from "../../../../shared/rca-types.ts";
import { normalizeRestoredSnapshot } from "../restore.ts";

function snapshot(): InvestigationSnapshot {
  return {
    incidentId: "INV-1",
    prompt: "prompt",
    title: "incident",
    severity: "P1",
    window: "window",
    dataset: { name: "RCA100", version: "v1.1", taskId: "t039", telemetryReady: true },
    status: "running",
    phase: 2,
    agents: [{ id: "trace", name: "Trace Agent", description: "", result: "", state: "running", progress: 50 }],
    tasks: [{
      id: "T001",
      investigationId: "INV-1",
      runId: "run-1",
      agent: "trace",
      instruction: "inspect",
      evidenceIds: [],
      hypothesisIds: [],
      policy: { timeoutMs: 1, maxTurns: 1, maxToolCalls: 1, maxEvidence: 1, maxAttempts: 1 },
      status: "running",
      attempt: 1,
      createdAt: "2026-09-25T00:00:00.000Z",
    }],
    hypotheses: [],
    evidence: [],
    messages: [],
    thinking: [{ id: "TH1", stage: "plan", title: "plan", text: "partial", completed: false, createdAt: "x", updatedAt: "x" }],
    toolRuns: [{
      id: "TC1",
      investigationId: "INV-1",
      runId: "run-1",
      taskId: "T001",
      datasetTaskId: "t039",
      agent: "trace",
      name: "search_traces",
      args: {},
      status: "running",
      startedAt: "x",
    }],
    runId: "run-1",
    stream: { id: "old", lastEventId: 3 },
  };
}

test("restart normalization marks volatile running work interrupted without losing history", () => {
  const restored = normalizeRestoredSnapshot(snapshot());
  assert.equal(restored.status, "interrupted");
  assert.equal(restored.tasks[0]?.status, "interrupted");
  assert.equal(restored.agents[0]?.state, "cancelled");
  assert.equal(restored.toolRuns[0]?.status, "error");
  assert.equal(restored.thinking[0]?.completed, true);
  assert.equal(restored.prompt, "prompt");
});
