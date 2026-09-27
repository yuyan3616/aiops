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
  ];

  const types = projected.map((item) => item.type);
  assert.equal(types.some((type) => type.startsWith("thinking.")), false);
  assert.ok(types.includes("hypothesis.updated"));
  assert.ok(types.includes("agent.started"));
  assert.ok(types.includes("agent.tool.started"));
  assert.ok(types.includes("agent.tool.completed"));
  assert.ok(types.includes("agent.evidence.added"));

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
});
