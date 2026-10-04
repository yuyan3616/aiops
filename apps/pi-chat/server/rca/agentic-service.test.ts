import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRcaMainAgentTools } from "./main-agent-tools";
import { InvestigationRepository } from "./repository";
import { RcaService } from "./service";
import type { Investigation } from "./types";

function investigation(id: string): Investigation {
  return {
    id,
    status: "running",
    symptom: "checkout latency",
    context: {
      symptom: "checkout latency",
      trigger: { type: "manual" },
      window: {
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-01T00:10:00.000Z",
      },
      target: {
        service: "checkout",
        operation: "PlaceOrder",
      },
    },
    formatVersion: 3,
    source: { kind: "live", contractVersion: "1" },
    creation: { requestHash: "fixture" },
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
        investigationId: id,
        modality: "trace",
        entity: "shipping",
        timeRange: {
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-01-01T00:10:00.000Z",
        },
        summary: "shipping latency rises in the incident window",
        rawRef: "tempo://query/search_traces",
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
    schemaVersion: 2,
    budgetLedger: [],
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
    "resume_rca_investigation",
    "query_rca_overview",
    "update_hypotheses",
    "dispatch_investigations",
    "get_investigation_state",
    "conclude_investigation",
  ]);
  assert.equal(names.includes("investigate_rca_case"), false);
});

test("Main Agent compact state excludes runtime accounting and diagnostics", async () => {
  const current = investigation("INV-compact-runtime");
  current.expertTasks.push({
    id: "T01", expert: "trace", objective: "trace latency", status: "failed",
    hypothesisIds: [], toolCallIds: [], evidenceIds: [], createdAt: current.startedAt,
    usage: { turns: 2, inputTokens: 100, outputTokens: 20, cacheReadTokens: 10,
      cacheWriteTokens: 0, totalTokens: 130, contextTokens: 80 },
    diagnostics: { toolCallCount: 0, thinkingChars: 0, outputChars: 0,
      repairAttempted: false, repairSucceeded: false },
    termination: { reason: "provider_error", detail: "unavailable" },
  });
  const definitions = createRcaMainAgentTools({
    rcaService: {
      get: async () => current,
      getBudgetProjection: () => ({
        primary: { limit: 4, used: 0, reserved: 0, remaining: 4 },
        recovery: { limit: 2, used: 0, reserved: 0, remaining: 2 },
        safety: { taskIntents: 0, startedTasks: 0, toolExecutions: 0 },
        runtime: { running: 0, maxPerInvestigation: 3, maxGlobal: 4 },
        reservations: [],
      }),
    } as unknown as RcaService,
    conversationId: "conversation-compact",
    getModelRef: () => ({ provider: "test", id: "test" }),
    onProjection: () => {},
    onLinkInvestigation: () => {},
  });
  const tool = definitions.find((item) => item.name === "get_investigation_state")!;
  const execute = tool.execute as unknown as (
    callId: string, parameters: { investigationId: string },
  ) => Promise<{ content: Array<{ text: string }> }>;
  const response = await execute("call-compact", { investigationId: current.id });
  const task = (JSON.parse(response.content[0]!.text) as { expertTasks: Array<Record<string, unknown>> })
    .expertTasks[0]!;
  assert.equal(task.termination, "provider_error");
  assert.equal(task.usage, undefined);
  assert.equal(task.diagnostics, undefined);
});

test("start_rca_investigation does not implicitly replace a linked investigation", async () => {
  let beginCalls = 0;
  const fakeService = {
    async beginAgentic() {
      beginCalls++;
      throw new Error("beginAgentic should not be called");
    },
  } as unknown as RcaService;

  const definitions = createRcaMainAgentTools({
    rcaService: fakeService,
    conversationId: "conversation-existing-rca",
    getModelRef: () => ({ provider: "packy", id: "deepseek-flash" }),
    onProjection: () => {},
    onLinkInvestigation: () => {},
    getRcaContext: () => ({
      state: "completed",
      investigationId: "INV-existing",
      caseId: "t039",
      rounds: 2,
      rootCauseStatus: "probable",
    }),
  });
  const start = definitions.find((tool) => tool.name === "start_rca_investigation");
  assert.ok(start);
  const executeStart = start.execute as unknown as (
    toolCallId: string,
    parameters: {
      symptom: string;
      target: { service: string; operation?: string };
      window: { from: string; to: string };
      forceNew?: boolean;
    },
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;

  const result = await executeStart("call-start", {
    symptom: "checkout latency",
    target: { service: "checkout", operation: "PlaceOrder" },
    window: {
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T00:10:00.000Z",
    },
  });
  const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
    started?: boolean;
    recommendedAction?: string;
    activeRcaContext?: { investigationId?: string };
  };

  assert.equal(beginCalls, 0);
  assert.equal(payload.started, false);
  assert.equal(payload.recommendedAction, "read_active_investigation");
  assert.equal(payload.activeRcaContext?.investigationId, "INV-existing");
});


test("cancelling an active RCA terminalizes expert tasks and tools before cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-chat-agentic-cancel-"));
  try {
    const repository = new InvestigationRepository(directory);
    const service = new RcaService(repository);
    const current = investigation("INV-agentic-cancel");
    current.schemaVersion = undefined;
    current.budgetLedger = undefined;
    current.expertTasks.push({
      id: "T01",
      expert: "trace",
      objective: "locate unexplained latency",
      status: "running",
      hypothesisIds: [],
      toolCallIds: ["C02"],
      evidenceIds: [],
      implementation: "pi-session",
      createdAt: "2026-01-01T00:10:00.000Z",
    });
    current.toolCalls.push({
      id: "C02",
      expertTaskId: "T01",
      tool: "search_traces",
      query: { target: { service: "checkout" } },
      status: "running",
      startedAt: "2026-01-01T00:10:00.000Z",
    });
    await repository.save(current);

    const eventTypes: string[] = [];
    await service.resumeAgentic(current.id, {
      conversationId: "conversation-cancel",
      onEvent: (event) => {
        eventTypes.push(event.type);
      },
    });

    assert.equal(await service.cancelConversation("conversation-cancel"), 1);

    const cancelled = await repository.get(current.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.expertTasks[0]?.status, "cancelled");
    assert.equal(cancelled.toolCalls[0]?.status, "cancelled");
    assert.match(cancelled.toolCalls[0]?.error ?? "", /cancelled/i);
    assert.deepEqual(eventTypes, [
      "tool.completed",
      "expert.completed",
      "investigation.cancelled",
    ]);
    assert.equal(await service.cancelConversation("conversation-cancel"), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("user steering interrupts only the active dispatch and keeps the investigation running", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-chat-agentic-steer-"));
  try {
    const repository = new InvestigationRepository(directory);
    const service = new RcaService(repository);
    const current = investigation("INV-agentic-steer");
    current.hypotheses.push({
      id: "H01",
      statement: "checkout latency was caused by a dependency regression",
      status: "possible",
      confidence: 0.4,
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      nextChecks: [],
    });
    await repository.save(current);

    let markDispatchStarted!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      markDispatchStarted = resolve;
    });
    Object.assign(service, {
      expertRunner: {
        run: ({ signal }: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            markDispatchStarted();
            const rejectAbort = () =>
              reject(new DOMException("Dispatch superseded by user intervention", "AbortError"));
            if (signal?.aborted) {
              rejectAbort();
              return;
            }
            signal?.addEventListener("abort", rejectAbort, { once: true });
          }),
      },
    });

    await service.resumeAgentic(current.id, {
      conversationId: "conversation-steer",
    });

    const dispatchPromise = service.dispatchAgentic(current.id, [
      {
        role: "trace",
        question: "Check whether the dependency path explains checkout latency.",
        hypothesisIds: ["H01"],
        context: {
          alertSummary: "checkout latency",
          mainWindow: current.context!.window,
          knownFacts: [],
        },
        expected: ["Return a tool-backed finding."],
      },
    ]);

    await dispatchStarted;

    const intervention = await service.recordUserIntervention(
      current.id,
      "14:02 checkout 做过一次手工发布",
    );
    assert.equal(intervention?.id, "UI01");
    assert.equal(service.interruptActiveDispatch(current.id), false);

    const outcome = await dispatchPromise;
    assert.equal(outcome.interrupted, true);
    assert.equal(outcome.findings.length, 1);
    assert.equal(outcome.findings[0]?.status, "cancelled");
    assert.equal(outcome.findings[0]?.termination, "aborted");
    assert.deepEqual(outcome.findings[0]?.evidenceIds, []);

    const persisted = await repository.get(current.id);
    assert.equal(persisted.status, "running");
    assert.equal(persisted.expertTasks[0]?.status, "cancelled");
    assert.equal(
      persisted.userInterventions?.[0]?.content,
      "14:02 checkout 做过一次手工发布",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("hypothesis mutations partially accept valid items and publish only persisted changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-chat-agentic-"));
  try {
    const repository = new InvestigationRepository(directory);
    const service = new RcaService(repository);
    const current = investigation("INV-agentic-hypotheses");
    await repository.save(current);

    const result = await service.updateHypotheses(current.id, [
      {
        op: "create",
        requestId: "create-valid",
        id: "H01",
        statement: "shipping is propagating latency to checkout",
        status: "supported",
        confidence: 0.78,
        supportingEvidenceIds: ["E01"],
        nextChecks: ["cross-check with an independent modality"],
      },
      {
        op: "create",
        requestId: "create-invalid",
        id: "H02",
        statement: "an ungrounded alternative",
        status: "supported",
        supportingEvidenceIds: ["E99"],
      },
    ]);

    assert.deepEqual(result.accepted.map((item) => item.requestId), ["create-valid"]);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0]?.requestId, "create-invalid");
    assert.equal(result.rejected[0]?.code, "UNKNOWN_EVIDENCE");
    assert.equal(result.hypotheses.length, 1);
    assert.equal(result.hypotheses[0]?.status, "supported");
    assert.deepEqual(result.hypotheses[0]?.supportingEvidenceIds, ["E01"]);

    const saved = await repository.get(current.id);
    assert.equal(saved.hypotheses.length, 1);
    const events = await repository.listEvents(current.id);
    assert.equal(events.filter((event) => event.type === "hypothesis.created").length, 1);

    const rejectedUpdate = await service.updateHypotheses(current.id, [
      {
        op: "update",
        requestId: "bad-update",
        id: "H01",
        status: "confirmed",
        supportingEvidenceIds: ["E99"],
      },
    ]);
    assert.equal(rejectedUpdate.accepted.length, 0);
    assert.equal(rejectedUpdate.rejected[0]?.code, "UNKNOWN_EVIDENCE");
    assert.equal((await repository.get(current.id)).hypotheses[0]?.status, "supported");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("agentic conclusion requires real evidence and complete hypothesis accounting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-chat-agentic-"));
  try {
    const repository = new InvestigationRepository(directory);
    const service = new RcaService(repository);
    const current = investigation("INV-agentic-conclusion");
    current.hypotheses.push({
      id: "H01",
      statement: "shipping is propagating latency",
      status: "confirmed",
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
        selectedHypothesisIds: ["H01"],
        rejectedHypotheses: [],
        unresolvedHypotheses: [],
        confidence: 0.9,
        causalAssessment: {
          temporalFit: "aligned",
          temporalEvidenceIds: ["E01"],
          transitionEvidenceIds: [],
          propagationFit: "supported",
          propagationEvidenceIds: ["E01"],
          materialUnobservedGap: false,
          gapBridgeEvidenceIds: [],
          unresolvedContradictions: [],
        },
      }),
      /at least two evidence items/,
    );

    const concluded = await service.concludeAgentic(current.id, {
      status: "probable",
      rootCauseEntities: ["shipping"],
      summary: "shipping is the most evidence-supported latency source",
      evidenceIds: ["E01"],
      selectedHypothesisIds: ["H01"],
      rejectedHypotheses: [],
      unresolvedHypotheses: [],
      confidence: 0.8,
      missingEvidence: ["independent log or metric confirmation"],
      causalAssessment: {
        temporalFit: "aligned",
        temporalEvidenceIds: ["E01"],
        transitionEvidenceIds: [],
        propagationFit: "supported",
        propagationEvidenceIds: ["E01"],
        materialUnobservedGap: false,
        gapBridgeEvidenceIds: [],
        unresolvedContradictions: [],
      },
    });
    await service.waitForVisualizationIdle(current.id);
    assert.equal(concluded.investigation.status, "completed");
    assert.equal(concluded.investigation.rootCause?.status, "probable");
    assert.match(concluded.report, /E01/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("causal assessment blocks confident conclusions with unresolved temporal or propagation gaps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-chat-agentic-causal-"));
  try {
    const repository = new InvestigationRepository(directory);
    const service = new RcaService(repository);

    const probable = investigation("INV-agentic-causal-probable");
    probable.hypotheses.push({
      id: "H01",
      statement: "a dependency anomaly caused checkout latency",
      status: "supported",
      confidence: 0.7,
      supportingEvidenceIds: ["E01"],
      contradictingEvidenceIds: [],
      nextChecks: [],
    });
    await repository.save(probable);

    await assert.rejects(
      service.concludeAgentic(probable.id, {
        status: "probable",
        rootCauseEntities: ["dependency"],
        summary: "candidate remains temporally unresolved",
        evidenceIds: ["E01"],
        selectedHypothesisIds: ["H01"],
        rejectedHypotheses: [],
        unresolvedHypotheses: [],
        confidence: 0.7,
        causalAssessment: {
          temporalFit: "uncertain",
          temporalEvidenceIds: [],
          transitionEvidenceIds: [],
          propagationFit: "supported",
          propagationEvidenceIds: ["E01"],
          materialUnobservedGap: false,
          gapBridgeEvidenceIds: [],
          unresolvedContradictions: [],
        },
      }),
      /non-uncertain temporal fit/,
    );

    const confirmed = investigation("INV-agentic-causal-confirmed");
    confirmed.evidence.push({
      ...confirmed.evidence[0]!,
      id: "E02",
      modality: "metric",
      summary: "independent metric evidence",
      toolCallId: "C02",
    });
    confirmed.hypotheses.push({
      id: "H01",
      statement: "a dependency failure propagated to checkout",
      status: "confirmed",
      confidence: 0.95,
      supportingEvidenceIds: ["E01", "E02"],
      contradictingEvidenceIds: [],
      nextChecks: [],
    });
    await repository.save(confirmed);

    await assert.rejects(
      service.concludeAgentic(confirmed.id, {
        status: "confirmed",
        rootCauseEntities: ["dependency"],
        summary: "propagation is still uncertain",
        evidenceIds: ["E01", "E02"],
        selectedHypothesisIds: ["H01"],
        rejectedHypotheses: [],
        unresolvedHypotheses: [],
        confidence: 0.95,
        causalAssessment: {
          temporalFit: "aligned",
          temporalEvidenceIds: ["E01"],
          transitionEvidenceIds: [],
          propagationFit: "uncertain",
          propagationEvidenceIds: [],
          materialUnobservedGap: false,
          gapBridgeEvidenceIds: [],
          unresolvedContradictions: [],
        },
      }),
      /requires supported propagation/,
    );

    await assert.rejects(
      service.concludeAgentic(confirmed.id, {
        status: "confirmed",
        rootCauseEntities: ["dependency"],
        summary: "a key contradiction remains",
        evidenceIds: ["E01", "E02"],
        selectedHypothesisIds: ["H01"],
        rejectedHypotheses: [],
        unresolvedHypotheses: [],
        confidence: 0.95,
        causalAssessment: {
          temporalFit: "aligned",
          temporalEvidenceIds: ["E01"],
          transitionEvidenceIds: [],
          propagationFit: "supported",
          propagationEvidenceIds: ["E01"],
          materialUnobservedGap: false,
          gapBridgeEvidenceIds: [],
          unresolvedContradictions: ["candidate was already degraded before the alert window"],
        },
      }),
      /cannot retain unresolved contradictions/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pre-existing explanations require transition evidence and supported propagation cannot cross an unbridged gap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-chat-agentic-causal-evidence-"));
  try {
    const repository = new InvestigationRepository(directory);
    const service = new RcaService(repository);
    const current = investigation("INV-agentic-causal-evidence");
    current.evidence.push({
      ...current.evidence[0]!,
      id: "E02",
      modality: "metric",
      summary: "an incident-aligned transition signal",
      toolCallId: "C02",
    });
    current.hypotheses.push({
      id: "H01",
      statement: "a pre-existing dependency anomaly became causal during the alert window",
      status: "supported",
      confidence: 0.7,
      supportingEvidenceIds: ["E01", "E02"],
      contradictingEvidenceIds: [],
      nextChecks: [],
    });
    await repository.save(current);

    await assert.rejects(
      service.concludeAgentic(current.id, {
        status: "probable",
        rootCauseEntities: ["dependency"],
        summary: "pre-existing anomaly without transition proof",
        evidenceIds: ["E01", "E02"],
        selectedHypothesisIds: ["H01"],
        rejectedHypotheses: [],
        unresolvedHypotheses: [],
        confidence: 0.7,
        causalAssessment: {
          temporalFit: "pre_existing_explained",
          temporalEvidenceIds: ["E01"],
          transitionEvidenceIds: [],
          propagationFit: "uncertain",
          propagationEvidenceIds: [],
          materialUnobservedGap: false,
          gapBridgeEvidenceIds: [],
          unresolvedContradictions: [],
        },
      }),
      /requires independent transition\/trigger evidence/,
    );

    await assert.rejects(
      service.concludeAgentic(current.id, {
        status: "probable",
        rootCauseEntities: ["dependency"],
        summary: "propagation crosses an unobserved gap",
        evidenceIds: ["E01", "E02"],
        selectedHypothesisIds: ["H01"],
        rejectedHypotheses: [],
        unresolvedHypotheses: [],
        confidence: 0.7,
        causalAssessment: {
          temporalFit: "pre_existing_explained",
          temporalEvidenceIds: ["E01"],
          transitionEvidenceIds: ["E02"],
          propagationFit: "supported",
          propagationEvidenceIds: ["E01"],
          materialUnobservedGap: true,
          gapBridgeEvidenceIds: [],
          unresolvedContradictions: [],
        },
      }),
      /requires gap-bridge evidence/,
    );

    const concluded = await service.concludeAgentic(current.id, {
      status: "probable",
      rootCauseEntities: ["dependency"],
      summary: "pre-existing anomaly has an independent transition signal",
      evidenceIds: ["E01", "E02"],
      selectedHypothesisIds: ["H01"],
      rejectedHypotheses: [],
      unresolvedHypotheses: [],
      confidence: 0.7,
      causalAssessment: {
        temporalFit: "pre_existing_explained",
        temporalEvidenceIds: ["E01"],
        transitionEvidenceIds: ["E02"],
        propagationFit: "uncertain",
        propagationEvidenceIds: [],
        materialUnobservedGap: true,
        gapBridgeEvidenceIds: [],
        unresolvedContradictions: ["the exact transport mechanism remains unresolved"],
      },
    });
    await service.waitForVisualizationIdle(current.id);
    assert.equal(concluded.investigation.rootCause?.status, "probable");
    assert.deepEqual(
      concluded.investigation.rootCause?.causalAssessment?.transitionEvidenceIds,
      ["E02"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("inconclusive RCA accepts uncertain causal assessment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-chat-agentic-causal-inconclusive-"));
  try {
    const repository = new InvestigationRepository(directory);
    const service = new RcaService(repository);
    const current = investigation("INV-agentic-causal-inconclusive");
    current.hypotheses.push({
      id: "H01",
      statement: "the available telemetry cannot distinguish two mechanisms",
      status: "investigating",
      confidence: 0.4,
      supportingEvidenceIds: ["E01"],
      contradictingEvidenceIds: [],
      nextChecks: [],
    });
    await repository.save(current);

    const concluded = await service.concludeAgentic(current.id, {
      status: "inconclusive",
      rootCauseEntities: [],
      summary: "available evidence cannot establish incident-specific causality",
      evidenceIds: ["E01"],
      selectedHypothesisIds: [],
      rejectedHypotheses: [],
      unresolvedHypotheses: [
        {
          id: "H01",
          reason: "temporal and propagation evidence remain incomplete",
          missingEvidence: ["change history or an independent propagation signal"],
        },
      ],
      confidence: 0.35,
      causalAssessment: {
        temporalFit: "uncertain",
        temporalEvidenceIds: [],
        transitionEvidenceIds: [],
        propagationFit: "uncertain",
        propagationEvidenceIds: [],
        materialUnobservedGap: true,
        gapBridgeEvidenceIds: [],
        unresolvedContradictions: ["the candidate anomaly may predate the alert window"],
      },
    });

    await service.waitForVisualizationIdle(current.id);
    assert.equal(concluded.investigation.status, "inconclusive");
    assert.equal(concluded.investigation.rootCause?.causalAssessment?.temporalFit, "uncertain");
    assert.match(concluded.report, /Causal Assessment/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("hypothesis updates cannot rewrite statements; revisions create a linked new id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-chat-agentic-"));
  try {
    const repository = new InvestigationRepository(directory);
    const service = new RcaService(repository);
    const current = investigation("INV-agentic-hypothesis-identity");
    current.hypotheses.push({
      id: "H01",
      statement: "email service is the incident-specific latency source",
      status: "possible",
      confidence: 0.4,
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      nextChecks: [],
    });
    await repository.save(current);

    const updated = await service.updateHypotheses(current.id, [
      {
        op: "update",
        id: "H01",
        status: "rejected",
        confidence: 0.15,
      },
      {
        op: "create",
        id: "H02",
        statement: "email is slow in absolute terms but not incident-specific",
        status: "supported",
        confidence: 0.65,
        supersedes: "H01",
      },
    ]);

    assert.equal(updated.rejected.length, 0);
    assert.equal(updated.hypotheses.length, 2);
    assert.equal(
      updated.hypotheses[0]?.statement,
      "email service is the incident-specific latency source",
    );
    assert.equal(updated.hypotheses[0]?.status, "rejected");
    assert.equal(
      updated.hypotheses[1]?.statement,
      "email is slow in absolute terms but not incident-specific",
    );
    assert.equal(updated.hypotheses[1]?.supersedes, "H01");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Main Agent overview mutations are serialized so parallel calls cannot allocate stale ids", async () => {
  let active = 0;
  let maxActive = 0;
  let sequence = 0;
  const fakeService = {
    async queryOverview() {
      active++;
      maxActive = Math.max(maxActive, active);
      const id = ++sequence;
      await new Promise((resolve) => setTimeout(resolve, 15));
      active--;
      return {
        evidenceId: `E0${id}`,
        toolCallId: `C0${id + 1}`,
        summary: `overview-${id}`,
        result: {},
      };
    },
  } as unknown as RcaService;

  const definitions = createRcaMainAgentTools({
    rcaService: fakeService,
    conversationId: "conversation-serialize",
    getModelRef: () => ({ provider: "packy", id: "deepseek-flash" }),
    onProjection: () => {},
    onLinkInvestigation: () => {},
  });
  const overview = definitions.find((tool) => tool.name === "query_rca_overview");
  assert.ok(overview);

  const executeOverview = overview.execute as unknown as (
    toolCallId: string,
    parameters: Record<string, unknown>,
  ) => Promise<unknown>;

  await Promise.all([
    executeOverview("call-1", {
      investigationId: "INV-serialize",
      kind: "dependencies",
      service: "checkout",
    }),
    executeOverview("call-2", {
      investigationId: "INV-serialize",
      kind: "traces",
      service: "checkout",
    }),
  ]);

  assert.equal(maxActive, 1);
  assert.equal(sequence, 2);
});


test("compact metric result enforces the Live Agent 32 KiB text budget", async () => {
  const { compactToolResultForAgent } = await import("./tools");
  const compact = compactToolResultForAgent("query_metrics", {
    status: "success",
    query: { operation: "query_metrics", metric: "cpu_usage_total" },
    timeRange: { from: "2026-01-01T00:00:00Z", to: "2026-01-01T00:10:00Z" },
    retrievedAt: "2026-01-01T00:10:01Z",
    backendAlias: "prometheus",
    contractVersion: "1",
    warnings: [],
    truncationReasons: [],
    data: {
      series: Array.from({ length: 20 }, (_, index) => ({
        labels: { service: `svc-${index}` },
        points: Array.from({ length: 100 }, (_, point) => ({
          timestamp: `2026-01-01T00:${String(Math.floor(point / 6)).padStart(2, "0")}:00Z`,
          value: point,
        })),
      })),
    },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(compact), "utf8") <= 32 * 1024);
  assert.equal(
    Boolean(
      compact &&
        typeof compact === "object" &&
        !Array.isArray(compact) &&
        (compact as { agentTextTruncated?: boolean }).agentTextTruncated,
    ),
    true,
  );
});

test("recoverInterrupted marks active investigations interrupted and resumable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-chat-recover-"));
  try {
    const repository = new InvestigationRepository(directory);
    const current = investigation("INV-recoverable-restart");
    current.schemaVersion = undefined;
    current.budgetLedger = undefined;
    current.status = "running";
    current.expertTasks.push({
      id: "T01",
      expert: "metrics",
      objective: "check saturation",
      status: "running",
      hypothesisIds: ["H01"],
      toolCallIds: [],
      evidenceIds: [],
      implementation: "pi-session",
      createdAt: "2026-01-01T00:10:00.000Z",
    });
    await repository.save(current);

    const recovered = await repository.recoverInterrupted();
    assert.deepEqual(recovered, [current.id]);

    const interrupted = await repository.get(current.id);
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.completedAt, undefined);
    assert.equal(interrupted.interruptions?.length, 1);
    assert.equal(interrupted.expertTasks[0]?.status, "failed");

    const service = new RcaService(repository);
    const resumed = await service.resumeAgentic(current.id);
    assert.equal(resumed.status, "running");
    assert.equal(resumed.interruptions?.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("interrupted investigation may still conclude from persisted evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-chat-interrupted-conclude-"));
  try {
    const repository = new InvestigationRepository(directory);
    const current = investigation("INV-interrupted-conclude");
    current.status = "interrupted";
    current.hypotheses.push({
      id: "H01",
      statement: "shipping is the most likely latency source",
      status: "supported",
      confidence: 0.7,
      supportingEvidenceIds: ["E01"],
      contradictingEvidenceIds: [],
      nextChecks: [],
    });
    await repository.save(current);

    const service = new RcaService(repository);
    const concluded = await service.concludeAgentic(current.id, {
      status: "probable",
      rootCauseEntities: ["shipping"],
      summary: "shipping remains the best-supported cause from persisted evidence",
      evidenceIds: ["E01"],
      selectedHypothesisIds: ["H01"],
      rejectedHypotheses: [],
      unresolvedHypotheses: [],
      confidence: 0.65,
      missingEvidence: ["additional metric confirmation after restart"],
      causalAssessment: {
        temporalFit: "aligned",
        temporalEvidenceIds: ["E01"],
        transitionEvidenceIds: [],
        propagationFit: "uncertain",
        propagationEvidenceIds: [],
        materialUnobservedGap: false,
        gapBridgeEvidenceIds: [],
        unresolvedContradictions: [],
      },
    });
    await service.waitForVisualizationIdle(current.id);
    assert.equal(concluded.investigation.status, "completed");
    assert.equal(concluded.investigation.rootCause?.status, "probable");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dispatch rejects a baseline window that overlaps the main incident window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-chat-baseline-"));
  try {
    const repository = new InvestigationRepository(directory);
    const current = investigation("INV-baseline-overlap");
    current.hypotheses.push({
      id: "H01",
      statement: "checkout is resource saturated",
      status: "possible",
      confidence: 0.4,
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      nextChecks: [],
    });
    await repository.save(current);

    const service = new RcaService(repository);
    await assert.rejects(
      service.dispatchAgentic(current.id, [
        {
          role: "metrics",
          question: "Is checkout resource saturated?",
          hypothesisIds: ["H01"],
          context: {
            alertSummary: "checkout latency",
            mainWindow: {
              from: "2026-01-01T00:00:00.000Z",
              to: "2026-01-01T00:10:00.000Z",
            },
            baselineWindow: {
              from: "2025-12-31T23:55:00.000Z",
              to: "2026-01-01T00:05:00.000Z",
            },
            knownFacts: [],
          },
          expected: ["state whether saturation is present"],
        },
      ]),
      /baselineWindow overlaps|overlaps or invalidates mainWindow/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("compact trace result enforces the Live Agent 32 KiB text budget", async () => {
  const { compactToolResultForAgent } = await import("./tools");
  const compact = compactToolResultForAgent("search_traces", {
    status: "success",
    query: { operation: "search_traces", target: { service: "checkout" } },
    timeRange: { from: "2026-01-01T00:00:00Z", to: "2026-01-01T00:10:00Z" },
    retrievedAt: "2026-01-01T00:10:01Z",
    backendAlias: "tempo",
    contractVersion: "1",
    warnings: [],
    truncationReasons: [],
    data: {
      traces: Array.from({ length: 50 }, (_, index) => ({
        traceId: String(index + 1).padStart(32, "0"),
        rootService: "checkout",
        rootOperation: "PlaceOrder",
        detail: "x".repeat(2048),
      })),
    },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(compact), "utf8") <= 32 * 1024);
  assert.equal(
    Boolean(
      compact &&
        typeof compact === "object" &&
        !Array.isArray(compact) &&
        (compact as { agentTextTruncated?: boolean }).agentTextTruncated,
    ),
    true,
  );
});

test("conclusion rejects any hypothesis left outside selected rejected or unresolved buckets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-chat-hypothesis-closure-"));
  try {
    const repository = new InvestigationRepository(directory);
    const service = new RcaService(repository);
    const current = investigation("INV-hypothesis-closure");
    current.hypotheses.push(
      {
        id: "H01",
        statement: "shipping is the likely root cause",
        status: "supported",
        confidence: 0.75,
        supportingEvidenceIds: ["E01"],
        contradictingEvidenceIds: [],
        nextChecks: [],
      },
      {
        id: "H02",
        statement: "another downstream may explain the latency",
        status: "investigating",
        confidence: 0.1,
        supportingEvidenceIds: [],
        contradictingEvidenceIds: ["E01"],
        nextChecks: [],
      },
    );
    await repository.save(current);

    await assert.rejects(
      service.concludeAgentic(current.id, {
        status: "probable",
        rootCauseEntities: ["shipping"],
        summary: "shipping is the best-supported explanation",
        evidenceIds: ["E01"],
        selectedHypothesisIds: ["H01"],
        rejectedHypotheses: [],
        unresolvedHypotheses: [],
        confidence: 0.75,
        causalAssessment: {
          temporalFit: "aligned",
          temporalEvidenceIds: ["E01"],
          transitionEvidenceIds: [],
          propagationFit: "uncertain",
          propagationEvidenceIds: [],
          materialUnobservedGap: false,
          gapBridgeEvidenceIds: [],
          unresolvedContradictions: [],
        },
      }),
      /leaves hypotheses unaccounted for: H02/,
    );

    const concluded = await service.concludeAgentic(current.id, {
      status: "probable",
      rootCauseEntities: ["shipping"],
      summary: "shipping is the best-supported explanation",
      evidenceIds: ["E01"],
      selectedHypothesisIds: ["H01"],
      rejectedHypotheses: [],
      unresolvedHypotheses: [
        {
          id: "H02",
          reason: "The trace contradicts this branch but no dedicated downstream check was run.",
          missingEvidence: ["direct verification of the alternate downstream"],
        },
      ],
      confidence: 0.75,
      causalAssessment: {
        temporalFit: "aligned",
        temporalEvidenceIds: ["E01"],
        transitionEvidenceIds: [],
        propagationFit: "uncertain",
        propagationEvidenceIds: [],
        materialUnobservedGap: false,
        gapBridgeEvidenceIds: [],
        unresolvedContradictions: [],
      },
    });
    await service.waitForVisualizationIdle(current.id);
    assert.equal(concluded.investigation.rootCause?.unresolvedHypotheses?.[0]?.id, "H02");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
