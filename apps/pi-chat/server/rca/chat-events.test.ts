import assert from "node:assert/strict";
import test from "node:test";

import { RcaChatEventMapper, resolveRcaCaseId } from "./chat-events";
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

test("routes explicit commands and natural incident requests without hijacking ordinary chat", () => {
  assert.equal(resolveRcaCaseId("/rca t039", "t001"), "t039");
  assert.equal(resolveRcaCaseId("帮我排查 checkout 响应时间突然升高的问题", "t039"), "t039");
  assert.equal(resolveRcaCaseId("帮我分析一下这段 React 代码", "t039"), undefined);
  assert.equal(resolveRcaCaseId("什么是 RCA？", "t039"), undefined);
});

test("projects RCA events onto native Pi Chat thinking and tool events", () => {
  const mapper = new RcaChatEventMapper("INV-test");
  const projected = [
    ...mapper.begin(),
    ...mapper.map(
      event(1, "investigation.started", {
        alert: {
          service: "checkout",
          operation: "PlaceOrder",
          window: { from: "09:18", to: "09:27" },
        },
      }),
    ),
    ...mapper.map(
      event(2, "hypothesis.created", {
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
      event(3, "expert.started", {
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
      event(4, "tool.started", {
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
      event(5, "tool.completed", {
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
      event(6, "evidence.created", {
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
      event(7, "hypothesis.updated", {
        hypothesisId: "H01",
        previous: "investigating",
        current: "rejected",
        contradictingEvidenceIds: ["E01"],
      }),
    ),
    ...mapper.map(
      event(8, "investigation.completed", {
        result: {
          investigationId: "INV-test",
          status: "probable",
          rootCauseEntities: ["shipping"],
          summary: "shipping is the likely source",
          evidenceIds: ["E01"],
          rejectedHypotheses: ["H01"],
          confidence: 0.8,
        },
      }),
    ),
  ];

  const types = projected.map((item) => item.type);
  assert.deepEqual(types.slice(0, 2), ["thinking.started", "thinking.delta"]);
  assert.ok(types.includes("thinking.completed"));
  assert.ok(types.includes("tool.started"));
  assert.ok(types.includes("tool.completed"));
  assert.equal(
    types.some((type) => String(type) === "investigation.event"),
    false,
  );

  const toolStart = projected.find((item) => item.type === "tool.started");
  assert.deepEqual(toolStart?.payload, {
    id: "INV-test:C01",
    name: "query_traces",
    args: { caseId: "t039", service: "checkout" },
    details: { expertTaskId: "T01" },
  });
  const toolComplete = projected.find((item) => item.type === "tool.completed");
  assert.equal(toolComplete?.payload.result, "326 matched, 20 returned");
  assert.equal(JSON.stringify(toolComplete).includes("Latency is concentrated"), false);

  const reasoning = projected
    .filter((item) => item.type === "thinking.delta")
    .map((item) => String(item.payload.delta))
    .join("\n");
  assert.match(reasoning, /Trace Expert/);
  assert.match(reasoning, /E01/);
  assert.match(reasoning, /H01.*已排除/);
});
