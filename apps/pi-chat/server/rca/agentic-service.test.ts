import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRcaMainAgentTools } from "./main-agent-tools";
import type { RcaOrchestrator } from "./orchestrator";
import { InvestigationRepository } from "./repository";
import { RcaService } from "./service";
import type { Investigation } from "./types";

function investigation(id: string): Investigation {
  return {
    id,
    caseId: "t999",
    status: "running",
    symptom: "checkout latency",
    alertContext: {
      eventId: "evt",
      title: "checkout latency",
      triggerTime: "2026-01-01T00:10:00.000Z",
      service: "checkout",
      operation: "PlaceOrder",
      window: {
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-01T00:10:00.000Z",
      },
      entity: {
        id: "checkout::PlaceOrder",
        name: "checkout::PlaceOrder",
        type: "operation",
        domain: "apm",
      },
    },
    scope: {
      alertService: "checkout",
      alertOperation: "PlaceOrder",
      timeRange: {
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-01T00:10:00.000Z",
      },
      candidateEntities: ["checkout"],
    },
    hypotheses: [],
    evidence: [
      {
        id: "E01",
        caseId: "t999",
        modality: "trace",
        entity: "shipping",
        timeRange: {
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-01-01T00:10:00.000Z",
        },
        summary: "shipping latency rises in the incident window",
        rawRef: "rca100://t999/traces",
        supports: [],
        contradicts: [],
        sourceQuery: { service: "shipping" },
        toolCallId: "C01",
        facts: {},
        createdAt: "2026-01-01T00:11:00.000Z",
      },
    ],
    expertTasks: [],
    toolCalls: [],
    rounds: 0,
    startedAt: "2026-01-01T00:10:00.000Z",
  };
}

test("Main Agent RCA tools expose explicit investigation controls instead of a black-box RCA tool", () => {
  const tools = createRcaMainAgentTools({
    rcaService: {} as RcaService,
    conversationId: "conversation-test",
    getModelRef: () => ({ provider: "packy", id: "deepseek-flash" }),
    onProjection: () => {},
    onLinkInvestigation: () => {},
  });
  const names = tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "start_rca_investigation",
    "query_rca_overview",
    "update_hypotheses",
    "dispatch_investigations",
    "get_investigation_state",
    "conclude_investigation",
  ]);
  assert.equal(names.includes("investigate_rca_case"), false);
});

test("agentic hypothesis updates reject unknown evidence and preserve model-owned status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-chat-agentic-"));
  try {
    const repository = new InvestigationRepository(directory);
    const service = new RcaService({} as RcaOrchestrator, repository);
    const current = investigation("INV-agentic-hypotheses");
    await repository.save(current);

    const hypotheses = await service.updateHypotheses(current.id, [
      {
        id: "H01",
        statement: "shipping is propagating latency to checkout",
        status: "supported",
        confidence: 0.78,
        supportingEvidenceIds: ["E01"],
        nextChecks: ["cross-check with an independent modality"],
      },
    ]);

    assert.equal(hypotheses[0]?.status, "supported");
    assert.deepEqual(hypotheses[0]?.supportingEvidenceIds, ["E01"]);

    await assert.rejects(
      service.updateHypotheses(current.id, [
        {
          id: "H01",
          status: "confirmed",
          supportingEvidenceIds: ["E99"],
        },
      ]),
      /unknown evidence E99/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("agentic conclusion requires real evidence and stronger evidence for confirmed status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-chat-agentic-"));
  try {
    const repository = new InvestigationRepository(directory);
    const service = new RcaService({} as RcaOrchestrator, repository);
    const current = investigation("INV-agentic-conclusion");
    current.hypotheses.push({
      id: "H01",
      statement: "shipping is propagating latency",
      status: "supported",
      confidence: 0.8,
      supportingEvidenceIds: ["E01"],
      contradictingEvidenceIds: [],
      nextChecks: [],
    });
    await repository.save(current);

    await assert.rejects(
      service.concludeAgentic(current.id, {
        status: "confirmed",
        rootCauseEntities: ["shipping"],
        summary: "shipping is the root cause",
        evidenceIds: ["E01"],
        rejectedHypotheses: [],
        confidence: 0.9,
      }),
      /at least two evidence items/,
    );

    const concluded = await service.concludeAgentic(current.id, {
      status: "probable",
      rootCauseEntities: ["shipping"],
      summary: "shipping is the most evidence-supported latency source",
      evidenceIds: ["E01"],
      rejectedHypotheses: [],
      confidence: 0.8,
      missingEvidence: ["independent log or metric confirmation"],
    });
    assert.equal(concluded.investigation.status, "completed");
    assert.equal(concluded.investigation.rootCause?.status, "probable");
    assert.match(concluded.report, /E01/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
