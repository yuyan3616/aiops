import assert from "node:assert/strict";
import test from "node:test";

import { RcaChatEventMapper } from "./chat-events";
import type { InvestigationEvent } from "./types";

function event(
  id: number,
  type: InvestigationEvent["type"],
  payload: Record<string, unknown>,
): InvestigationEvent {
  return {
    id,
    investigationId: "INV-test",
    type,
    at: "2026-09-27T00:00:00.000Z",
    summary: type,
    payload,
  };
}

test("projects RCA events as structured UI events without synthetic thinking", () => {
  const mapper = new RcaChatEventMapper("INV-test");
  const projected = [
    ...mapper.map(
      event(1, "hypothesis.created", {
        hypothesis: {
          id: "H01",
          statement: "checkout is unhealthy",
          status: "possible",
          confidence: 0.25,
          supportingEvidenceIds: [],
          contradictingEvidenceIds: [],
          nextChecks: [],
        },
      }),
    ),
    ...mapper.map(
      event(2, "expert.started", {
        expertTask: {
          id: "T01",
          expert: "trace",
          objective: "Locate latency propagation.",
          status: "running",
          hypothesisIds: ["H01"],
          toolCallIds: [],
          evidenceIds: [],
          createdAt: "2026-09-27T00:00:00.000Z",
        },
      }),
    ),
    ...mapper.map(
      event(3, "tool.started", {
        toolCall: {
          id: "C01",
          expertTaskId: "T01",
          tool: "query_traces",
          query: { caseId: "t039", service: "checkout" },
          status: "running",
          startedAt: "2026-09-27T00:00:00.000Z",
        },
      }),
    ),
    ...mapper.map(
      event(4, "tool.completed", {
        toolCall: {
          id: "C01",
          expertTaskId: "T01",
          tool: "query_traces",
          query: { caseId: "t039", service: "checkout" },
          status: "completed",
          resultSummary: "326 matched, 20 returned",
          rawRef: "rca100://t039/traces.parquet?q=bounded",
          startedAt: "2026-09-27T00:00:00.000Z",
          completedAt: "2026-09-27T00:00:01.000Z",
        },
      }),
    ),
    ...mapper.map(
      event(5, "evidence.created", {
        evidence: {
          id: "E01",
          caseId: "t039",
          modality: "trace",
          entity: "shipping",
          summary: "Latency is concentrated in checkout to shipping.",
          rawRef: "rca100://t039/traces.parquet?q=bounded",
          supports: ["H02"],
          contradicts: [],
          sourceQuery: { service: "checkout" },
          toolCallId: "C01",
          facts: {},
          createdAt: "2026-09-27T00:00:01.000Z",
        },
      }),
    ),
    ...mapper.map(
      event(6, "hypothesis.updated", {
        hypothesisId: "H01",
        previous: "investigating",
        current: "rejected",
        contradictingEvidenceIds: ["E01"],
      }),
    ),
    ...mapper.map(
      event(7, "investigation.completed", {
        result: {
          investigationId: "INV-test",
          status: "confirmed",
          rootCauseEntities: ["shipping"],
          summary: "shipping timeout is the root cause",
          evidenceIds: ["E01"],
          rejectedHypotheses: ["H01"],
          confidence: 0.92,
        },
      }),
    ),
  ];

  const types = projected.map((item) => item.type);
  assert.equal(types.some((type) => type.startsWith("thinking.")), false);
  assert.ok(types.includes("hypothesis.updated"));
  assert.ok(types.includes("agent.started"));
  assert.ok(types.includes("agent.tool.started"));
  assert.ok(types.includes("agent.tool.completed"));
  assert.ok(types.includes("agent.evidence.added"));
  assert.ok(types.includes("report.ready"));

  const hypothesis = projected.find((item) => item.type === "hypothesis.updated");
  assert.equal(
    (hypothesis?.payload.hypothesis as { id?: string } | undefined)?.id,
    "H01",
  );

  const agentStart = projected.find((item) => item.type === "agent.started");
  assert.equal(
    (agentStart?.payload.agent as { id?: string } | undefined)?.id,
    "INV-test:agent:T01",
  );
  const toolComplete = projected.find((item) => item.type === "agent.tool.completed");
  assert.equal(
    (toolComplete?.payload.tool as { result?: string } | undefined)?.result,
    "326 matched, 20 returned",
  );
  const evidenceEvent = projected.find((item) => item.type === "agent.evidence.added");
  assert.equal(
    (evidenceEvent?.payload.evidence as { id?: string } | undefined)?.id,
    "E01",
  );

  const reportEvent = projected.find((item) => item.type === "report.ready");
  assert.equal(reportEvent?.payload.investigationId, "INV-test");
  assert.equal(reportEvent?.payload.filename, "RCA-INV-test.md");
  assert.equal(reportEvent?.payload.confidence, 0.92);
});

test("projects terminal runtime fields and preserves legacy termination fallback", () => {
  const mapper = new RcaChatEventMapper("INV-test");
  const completed = mapper.map(event(1, "expert.completed", {
    expertTask: {
      id: "T01", expert: "trace", status: "failed",
      usage: { turns: 2, inputTokens: 10, outputTokens: 2, cacheReadTokens: 3,
        cacheWriteTokens: 0, totalTokens: 15, contextTokens: 12 },
      diagnostics: { toolCallCount: 1, repairAttempted: true, repairSucceeded: false },
      termination: { reason: "invalid_output" },
    },
  }));
  assert.equal(completed[0]?.type, "agent.completed");
  assert.equal((completed[0]?.payload.usage as { turns?: number } | undefined)?.turns, 2);
  assert.deepEqual(completed[0]?.payload.termination, { reason: "invalid_output" });
  const legacy = mapper.map(event(2, "expert.completed", {
    expertTask: { id: "T02", expert: "trace", status: "failed", terminationReason: "service_restart" },
  }));
  assert.equal(legacy[0]?.payload.terminationReason, "service_restart");
  assert.equal(legacy[0]?.payload.usage, undefined);
});
