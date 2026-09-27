import assert from "node:assert/strict";
import test from "node:test";

import type { Investigation } from "@server/rca/types";
import type { MessageListItem } from "@shared/types";

import {
  reconcileRcaExecutionItems,
  settleInterruptedRcaSessionTools,
} from "./recovery";

function interruptedInvestigation(): Investigation {
  return {
    id: "INV-test",
    caseId: "t039",
    status: "interrupted",
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
    evidence: [{
      id: "E01",
      caseId: "t039",
      modality: "trace",
      summary: "latency observed",
      rawRef: "trace://1",
      supports: [],
      contradicts: [],
      sourceQuery: {},
      toolCallId: "C01",
      expertTaskId: "T01",
      facts: {},
      createdAt: "2026-09-28T00:00:01.000Z",
    }],
    expertTasks: [{
      id: "T01",
      expert: "trace",
      objective: "locate latency",
      status: "failed",
      hypothesisIds: [],
      toolCallIds: ["C01"],
      evidenceIds: ["E01"],
      implementation: "pi-session",
      createdAt: "2026-09-28T00:00:00.000Z",
      completedAt: "2026-09-28T00:00:02.000Z",
    }],
    toolCalls: [{
      id: "C01",
      expertTaskId: "T01",
      tool: "query_traces",
      query: { service: "checkout" },
      status: "failed",
      startedAt: "2026-09-28T00:00:00.000Z",
      completedAt: "2026-09-28T00:00:02.000Z",
      error: "Investigation interrupted by process restart before completion.",
    }],
    rounds: 1,
    startedAt: "2026-09-28T00:00:00.000Z",
    interruptions: [{
      at: "2026-09-28T00:00:02.000Z",
      reason: "Investigation interrupted by process restart before completion.",
    }],
    error: "Investigation interrupted by process restart before completion.",
  };
}

test("reconciles stale running RCA agent and nested tools from persisted investigation state", () => {
  const investigation = interruptedInvestigation();
  const items: MessageListItem[] = [{
    kind: "agent",
    id: "INV-test:agent:T01",
    agent: {
      id: "INV-test:agent:T01",
      taskId: "T01",
      expert: "trace",
      label: "Trace 调查员",
      objective: "locate latency",
      status: "running",
      tools: [{
        id: "INV-test:C01",
        name: "query_traces",
        args: { service: "checkout" },
        status: "running",
      }],
      evidence: [],
      implementation: "pi-session",
    },
  }];

  const reconciled = reconcileRcaExecutionItems(
    items,
    new Map([[investigation.id, investigation]]),
  );

  assert.equal(reconciled[0]?.kind, "agent");
  if (reconciled[0]?.kind !== "agent") return;
  assert.equal(reconciled[0].agent.status, "failed");
  assert.equal(reconciled[0].agent.interruptedByRestart, true);
  assert.equal(reconciled[0].agent.tools[0]?.status, "error");
  assert.equal(
    (reconciled[0].agent.tools[0]?.details as { interruptedByRestart?: boolean })
      ?.interruptedByRestart,
    true,
  );
  assert.equal(reconciled[0].agent.evidence[0]?.id, "E01");
});

test("settles an orphaned RCA main-agent tool after a process restart", () => {
  const investigation = interruptedInvestigation();
  const items: MessageListItem[] = [{
    kind: "tool",
    id: "dispatch-1",
    tool: {
      id: "dispatch-1",
      name: "dispatch_investigations",
      args: { investigationId: investigation.id },
      status: "running",
    },
  }];

  const settled = settleInterruptedRcaSessionTools(
    items,
    new Map([[investigation.id, investigation]]),
    false,
  );

  assert.equal(settled[0]?.kind, "tool");
  if (settled[0]?.kind !== "tool") return;
  assert.equal(settled[0].tool.status, "error");
  assert.equal(
    (settled[0].tool.details as { interruptedByRestart?: boolean }).interruptedByRestart,
    true,
  );

  const stillLive = settleInterruptedRcaSessionTools(
    items,
    new Map([[investigation.id, investigation]]),
    true,
  );
  assert.equal(stillLive[0]?.kind === "tool" ? stillLive[0].tool.status : "", "running");
});
