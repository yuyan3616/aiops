import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendLedgerEvent, foldBudget, nextLedgerEvent, RCA_BUDGET_POLICY } from "./budget";
import { PiExpertRunError } from "./pi-expert";
import { InvestigationRepository } from "./repository";
import { RcaService } from "./service";
import type { AgentExpertFinding, Investigation, InvestigationBrief } from "./types";

function fixture(id: string): Investigation {
  return {
    id,
    caseId: "t039",
    schemaVersion: 2,
    budgetLedger: [],
    status: "running",
    symptom: "checkout latency",
    context: {
      symptom: "checkout latency",
      trigger: { type: "manual" },
      window: { from: "2026-09-28T00:00:00Z", to: "2026-09-28T00:10:00Z" },
      target: { service: "checkout", operation: "PlaceOrder" },
    },
    formatVersion: 3,
    source: { kind: "live", contractVersion: "1" },
    creation: { requestHash: "budget-v2-fixture" },
    alertContext: {
      eventId: "evt",
      title: "checkout latency",
      triggerTime: "2026-09-28T00:10:00Z",
      window: { from: "2026-09-28T00:00:00Z", to: "2026-09-28T00:10:00Z" },
      entity: { id: "checkout", name: "checkout", type: "service", domain: "apm" },
    },
    scope: {
      timeRange: { from: "2026-09-28T00:00:00Z", to: "2026-09-28T00:10:00Z" },
      candidateEntities: ["checkout"],
    },
    hypotheses: [
      {
        id: "H01",
        statement: "dependency caused latency",
        status: "possible",
        confidence: 0.3,
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
        nextChecks: [],
      },
    ],
    observations: [],
    evidence: [],
    expertTasks: [],
    toolCalls: [],
    rounds: 0,
    startedAt: "2026-09-28T00:10:00Z",
  };
}

function brief(question: string, recoveryOfTaskId?: string): InvestigationBrief {
  return {
    role: "trace",
    question,
    hypothesisIds: ["H01"],
    context: {
      alertSummary: "checkout latency",
      mainWindow: {
        from: "2026-09-28T00:00:00Z",
        to: "2026-09-28T00:10:00Z",
      },
      knownFacts: [],
    },
    expected: ["finding"],
    ...(recoveryOfTaskId ? { recoveryOfTaskId } : {}),
  };
}

const finding: AgentExpertFinding = {
  status: "inconclusive",
  strength: "inconclusive",
  verdict: "no-signal",
  summary: "Checked without a decisive result",
  conclusions: [],
  evidenceClaims: [],
  candidateEntities: [],
  suggestedFollowUps: [],
};

async function setup(id: string, runner: (context: unknown) => Promise<unknown>) {
  const directory = await mkdtemp(join(tmpdir(), "rca-budget-v2-"));
  const repository = new InvestigationRepository(directory);
  await repository.save(fixture(id));
  const service = new RcaService(repository);
  Object.assign(service, { expertRunner: { run: runner } });
  await service.resumeAgentic(id);
  return { directory, repository, service };
}

const success = async () => ({
  sessionId: "test-session",
  usage: {
    turns: 1,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 50,
    cacheWriteTokens: 0,
    totalTokens: 170,
    contextTokens: 170,
  },
  termination: { reason: "completed" as const },
  diagnostics: {
    toolCallCount: 0,
    thinkingChars: 0,
    outputChars: 0,
    repairAttempted: false,
    repairSucceeded: false,
  },
  finding,
});

test("persists runtime accounting without changing Primary disposition", async (t) => {
  const state = await setup("INV-v2-usage", success);
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  await state.service.dispatchAgentic("INV-v2-usage", [brief("accounting")], {
    dispatchOperationId: "op-usage",
  });
  const task = (await state.repository.get("INV-v2-usage")).expertTasks[0];
  assert.equal(task?.status, "completed");
  assert.equal(task?.usage?.totalTokens, 170);
  assert.deepEqual(task?.termination, { reason: "completed" });
  assert.equal(task?.terminationReason, undefined);
  assert.equal(task?.recoveryEligible, false);
});

test("provider result retains existing transient Recovery rule", async (t) => {
  const state = await setup("INV-v2-runtime-failure", async () => ({
    sessionId: "provider-session",
    usage: {
      turns: 1,
      inputTokens: 12,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 12,
      contextTokens: 0,
    },
    diagnostics: {
      toolCallCount: 0,
      thinkingChars: 0,
      outputChars: 0,
      repairAttempted: false,
      repairSucceeded: false,
      failureReason: "model_error",
    },
    termination: { reason: "provider_error", providerTransient: true, detail: "503" },
  }));
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  await state.service.dispatchAgentic("INV-v2-runtime-failure", [brief("outage")], {
    dispatchOperationId: "op-outage",
  });
  const persisted = await state.repository.get("INV-v2-runtime-failure");
  const task = persisted.expertTasks[0];
  assert.equal(task?.status, "failed");
  assert.equal(task?.terminationReason, "provider_transient_error");
  assert.equal(task?.recoveryEligible, true);
  assert.equal(task?.usage?.inputTokens, 12);
  assert.equal(foldBudget(persisted).projection.primary.used, 0);
});

test("concurrent dispatches cannot oversubscribe and same operation cannot start twice", async (t) => {
  let starts = 0;
  const state = await setup("INV-v2-concurrent", async () => {
    starts++;
    return success();
  });
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  const first = await state.service.dispatchAgentic(
    "INV-v2-concurrent",
    [brief("one"), brief("two"), brief("three")],
    {
      dispatchOperationId: "op-one",
    },
  );
  assert.equal(first.findings.length, 3);
  const outcomes = await Promise.allSettled([
    state.service.dispatchAgentic("INV-v2-concurrent", [brief("four")], {
      dispatchOperationId: "op-two",
    }),
    state.service.dispatchAgentic("INV-v2-concurrent", [brief("five")], {
      dispatchOperationId: "op-three",
    }),
  ]);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((item) => item.status === "rejected").length, 1);
  const replay = await state.service.dispatchAgentic(
    "INV-v2-concurrent",
    [brief("one"), brief("two"), brief("three")],
    {
      dispatchOperationId: "op-one",
    },
  );
  assert.equal(replay.findings.length, 3);
  assert.equal(starts, 4);
  const persisted = await state.repository.get("INV-v2-concurrent");
  assert.equal(persisted.expertTasks.length, 4);
  assert.equal(foldBudget(persisted).projection.primary.used, 4);
  await assert.rejects(
    () =>
      state.service.dispatchAgentic("INV-v2-concurrent", [brief("different")], {
        dispatchOperationId: "op-one",
      }),
    /Conflicting dispatch operation/,
  );
});

test("an in-flight duplicate dispatch joins the same operation", async (t) => {
  let starts = 0;
  let resolveRun!: (value: unknown) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const state = await setup("INV-v2-idempotent", async () => {
    starts++;
    markStarted();
    return new Promise((resolve) => {
      resolveRun = resolve;
    });
  });
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  const request = [brief("same")];
  const one = state.service.dispatchAgentic("INV-v2-idempotent", request, {
    dispatchOperationId: "same-id",
  });
  const two = state.service.dispatchAgentic("INV-v2-idempotent", request, {
    dispatchOperationId: "same-id",
  });
  await started;
  assert.equal(starts, 1);
  assert.equal((await state.repository.get("INV-v2-idempotent")).expertTasks.length, 1);
  resolveRun(await success());
  const results = await Promise.all([one, two]);
  assert.equal(results[0]?.findings[0]?.taskRef, results[1]?.findings[0]?.taskRef);
  assert.equal(
    foldBudget(await state.repository.get("INV-v2-idempotent")).projection.primary.used,
    1,
  );
});

test("failed atomic intent save cannot start a Specialist or spend a reservation", async (t) => {
  let starts = 0;
  const state = await setup("INV-v2-save-failure", async () => {
    starts++;
    return success();
  });
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  const original = state.repository.save.bind(state.repository);
  let fail = true;
  Object.assign(state.repository, {
    save: async (investigation: Investigation) => {
      if (fail) {
        fail = false;
        throw new Error("injected save failure");
      }
      return original(investigation);
    },
  });
  await assert.rejects(
    () =>
      state.service.dispatchAgentic("INV-v2-save-failure", [brief("one")], {
        dispatchOperationId: "op-failed-save",
      }),
    /injected save failure/,
  );
  assert.equal(starts, 0);
  const persisted = await state.repository.get("INV-v2-save-failure");
  assert.equal(persisted.expertTasks.length, 0);
  assert.equal(foldBudget(persisted).projection.primary.reserved, 0);
});

test("transient provider failure permits one explicit Recovery, but findings do not", async (t) => {
  let attempts = 0;
  const state = await setup("INV-v2-recovery", async () => {
    attempts++;
    if (attempts === 1)
      throw new PiExpertRunError(
        "provider unavailable",
        {
          toolCallCount: 0,
          thinkingChars: 0,
          outputChars: 0,
          repairAttempted: false,
          repairSucceeded: false,
          failureReason: "model_error",
        },
        "session-failed",
        true,
      );
    return success();
  });
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  const failed = await state.service.dispatchAgentic("INV-v2-recovery", [brief("trace failure")], {
    dispatchOperationId: "op-failed",
  });
  assert.equal(failed.findings[0]?.status, "failed");
  assert.equal(
    foldBudget(await state.repository.get("INV-v2-recovery")).projection.primary.used,
    0,
  );
  await assert.rejects(
    () =>
      state.service.dispatchAgentic("INV-v2-recovery", [brief("trace failure")], {
        dispatchOperationId: "op-duplicate-primary",
      }),
    /recoveryOfTaskId/,
  );
  await state.service.dispatchAgentic("INV-v2-recovery", [brief("trace failure", "T01")], {
    dispatchOperationId: "op-recovery",
  });
  await assert.rejects(
    () =>
      state.service.dispatchAgentic("INV-v2-recovery", [brief("again", "T01")], {
        dispatchOperationId: "op-second-recovery",
      }),
    /not eligible for Recovery/,
  );
  const persisted = await state.repository.get("INV-v2-recovery");
  assert.equal(foldBudget(persisted).projection.recovery.used, 1);
  assert.equal(persisted.expertTasks[1]?.recoveryOfTaskId, "T01");
});

test("steering fences a late model result and preserves a physical slot until settlement", async (t) => {
  let resolveRun!: (value: unknown) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const state = await setup("INV-v2-steer", async () => {
    markStarted();
    return new Promise((resolve) => {
      resolveRun = resolve;
    });
  });
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  const dispatch = state.service.dispatchAgentic("INV-v2-steer", [brief("old")], {
    dispatchOperationId: "op-old",
  });
  await started;
  await state.service.recordUserIntervention("INV-v2-steer", "New deploy context");
  const midway = await state.repository.get("INV-v2-steer");
  assert.equal(midway.expertTasks[0]?.status, "cancelled");
  assert.equal(midway.expertTasks[0]?.termination?.reason, "aborted");
  assert.equal(midway.expertTasks[0]?.recoveryEligible, undefined);
  assert.equal(foldBudget(midway).projection.primary.reserved, 0);
  resolveRun(await success());
  await dispatch;
  const persisted = await state.repository.get("INV-v2-steer");
  assert.equal(persisted.expertTasks[0]?.status, "cancelled");
  assert.equal(persisted.evidence.length, 0);
  assert.equal(foldBudget(persisted).projection.safety.startedTasks, 1);
});

test("restart reconciles Task and reservation together without rerunning the session", async (t) => {
  const state = await setup("INV-v2-restart", async () => new Promise(() => undefined));
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  // Model a crash after the atomic pending intent but before a Specialist starts.
  const draft = await state.repository.get("INV-v2-restart");
  draft.expertTasks.push({
    id: "T01",
    expert: "trace",
    objective: "pending",
    status: "pending",
    hypothesisIds: ["H01"],
    toolCallIds: [],
    evidenceIds: [],
    brief: brief("pending"),
    implementation: "pi-session",
    createdAt: new Date().toISOString(),
    budgetClass: "primary",
    budgetReservationId: "reservation-1",
    dispatchOperationId: "op-pending",
  });
  draft.budgetLedger!.push({
    id: "B0001",
    sequence: 1,
    at: new Date().toISOString(),
    type: "budget.reserved",
    reservationId: "reservation-1",
    dispatchOperationId: "op-pending",
    requestHash: "hash",
    taskId: "T01",
    budgetClass: "primary",
  });
  draft.budgetLedger!.push({
    id: "B0002",
    sequence: 2,
    at: new Date().toISOString(),
    type: "safety.consumed",
    executionId: "T01",
    resource: "task_intent",
  });
  await state.repository.save(draft);
  assert.deepEqual(await state.repository.recoverInterrupted(), ["INV-v2-restart"]);
  const persisted = await state.repository.get("INV-v2-restart");
  assert.equal(persisted.expertTasks[0]?.status, "failed");
  assert.equal(persisted.expertTasks[0]?.recoveryEligible, false);
  assert.equal(foldBudget(persisted).projection.primary.reserved, 0);
  assert.deepEqual(await state.repository.recoverInterrupted(), []);
});

test("completed tool work commits Primary even if a transient model failure follows", async (t) => {
  const state = await setup("INV-v2-partial", async (context: unknown) => {
    const invoke = (
      context as { invoke: (tool: string, args: Record<string, unknown>) => Promise<unknown> }
    ).invoke;
    await invoke("search_traces", { target: { service: "checkout" }, window: { kind: "incident" } });
    throw new PiExpertRunError(
      "provider temporarily unavailable",
      {
        toolCallCount: 1,
        thinkingChars: 0,
        outputChars: 0,
        repairAttempted: false,
        repairSucceeded: false,
        failureReason: "model_error",
      },
      "partial-session",
      true,
    );
  });
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  Object.assign(state.service, {
    tools: {
      prepare: (
        tool: "search_traces",
        arguments_: Record<string, unknown>,
        investigation: Investigation,
      ) => ({
        tool,
        arguments: arguments_,
        target: investigation.context!.target,
        window: investigation.context!.window,
      }),
      executePrepared: async (
        _investigationId: string,
        prepared: {
          tool: "search_traces";
          arguments: Record<string, unknown>;
          window: { from: string; to: string };
        },
      ) => ({
        tool: prepared.tool,
        arguments: prepared.arguments,
        result: {
          status: "success",
          query: { operation: "search_traces" },
          timeRange: prepared.window,
          retrievedAt: "2026-09-28T00:10:01Z",
          backendAlias: "tempo",
          contractVersion: "1",
          data: { traces: [{ traceId: "00000000000000000000000000000001" }] },
          warnings: [],
          truncationReasons: [],
        },
        summary: "search_traces: success, returned 1",
        resultStatus: "success",
        actualWindow: prepared.window,
        backendAlias: "tempo",
        rawRef: "tempo://query/search_traces",
      }),
    },
  });
  await state.service.dispatchAgentic("INV-v2-partial", [brief("partial")], {
    dispatchOperationId: "op-partial",
  });
  const persisted = await state.repository.get("INV-v2-partial");
  assert.equal(persisted.expertTasks[0]?.status, "failed");
  assert.equal(persisted.expertTasks[0]?.recoveryEligible, false);
  assert.equal(persisted.observations?.length, 1);
  assert.equal(foldBudget(persisted).projection.primary.used, 1);
  assert.equal(foldBudget(persisted).projection.safety.toolExecutions, 1);
});

test("t039 failure/recovery history does not impose an expertTasks.length ceiling", async (t) => {
  let attempt = 0;
  const state = await setup("INV-v2-t039", async () => {
    attempt++;
    if (attempt === 3 || attempt === 5)
      throw new PiExpertRunError(
        "provider 503",
        {
          toolCallCount: 0,
          thinkingChars: 0,
          outputChars: 0,
          repairAttempted: false,
          repairSucceeded: false,
          failureReason: "model_error",
        },
        `session-${attempt}`,
        true,
      );
    return success();
  });
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  await state.service.dispatchAgentic("INV-v2-t039", [brief("T01"), brief("T02"), brief("T03")], {
    dispatchOperationId: "round-1",
  });
  await state.service.dispatchAgentic("INV-v2-t039", [brief("T04", "T03"), brief("T05")], {
    dispatchOperationId: "round-2",
  });
  const final = await state.service.dispatchAgentic(
    "INV-v2-t039",
    [brief("T06", "T05"), brief("T07")],
    {
      dispatchOperationId: "round-3",
    },
  );
  assert.equal(final.findings.length, 2);
  const persisted = await state.repository.get("INV-v2-t039");
  assert.equal(persisted.expertTasks.length, 7);
  assert.equal(foldBudget(persisted).projection.primary.used, 3);
  assert.equal(foldBudget(persisted).projection.recovery.used, 2);
});

test("steering releases semantic budget but old un-settled sessions hold all runtime slots", async (t) => {
  const resolvers: Array<(value: unknown) => void> = [];
  let started = 0;
  const state = await setup("INV-v2-slots", async () => {
    started++;
    return new Promise((resolve) => {
      resolvers.push(resolve);
    });
  });
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  const first = state.service.dispatchAgentic(
    "INV-v2-slots",
    [brief("old-1"), brief("old-2"), brief("old-3")],
    {
      dispatchOperationId: "op-old-slots",
    },
  );
  while (started < 3) await new Promise((resolve) => setTimeout(resolve, 1));
  await state.service.recordUserIntervention("INV-v2-slots", "steer");
  const second = state.service.dispatchAgentic("INV-v2-slots", [brief("new-1")], {
    dispatchOperationId: "op-new-slot",
  });
  while ((await state.repository.get("INV-v2-slots")).expertTasks.length < 4) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(started, 3);
  const pending = await state.repository.get("INV-v2-slots");
  assert.equal(pending.expertTasks[3]?.status, "pending");
  assert.equal(state.service.getBudgetProjection(pending).runtime.running, 3);
  for (const resolve of resolvers.splice(0)) resolve(await success());
  await first;
  while (started < 4) await new Promise((resolve) => setTimeout(resolve, 1));
  resolvers[0]!(await success());
  await second;
  assert.equal(
    foldBudget(await state.repository.get("INV-v2-slots")).projection.safety.startedTasks,
    4,
  );
});

test("only a malformed final unterminated UI event is quarantined", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rca-budget-tail-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = new InvestigationRepository(directory);
  const current = fixture("INV-v2-tail");
  await repository.save(current);
  await repository.appendEvent({
    id: 1,
    investigationId: current.id,
    type: "investigation.started",
    at: new Date().toISOString(),
    summary: "started",
    payload: {},
  });
  const file = join(repository.directory(current.id), "events.jsonl");
  await appendFile(file, '{"id":2,"type":"budget.reser', "utf8");
  assert.equal((await repository.listEvents(current.id)).length, 1);
  await repository.appendEvent({
    id: 2,
    investigationId: current.id,
    type: "investigation.resumed",
    at: new Date().toISOString(),
    summary: "resumed",
    payload: {},
  });
  assert.equal((await repository.listEvents(current.id)).length, 2);
  assert.ok((await readFile(file, "utf8")).endsWith("\n"));
});

test("cancel wins over a late completion and cannot be undone by it", async (t) => {
  let resolveRun!: (value: unknown) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const state = await setup("INV-v2-cancel-race", async () => {
    markStarted();
    return new Promise((resolve) => {
      resolveRun = resolve;
    });
  });
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  const dispatch = state.service.dispatchAgentic("INV-v2-cancel-race", [brief("old")], {
    dispatchOperationId: "op-cancel-race",
  });
  await started;
  assert.equal(await state.service.cancel("INV-v2-cancel-race"), true);
  resolveRun(await success());
  await dispatch;
  const persisted = await state.repository.get("INV-v2-cancel-race");
  assert.equal(persisted.status, "cancelled");
  assert.equal(persisted.expertTasks[0]?.status, "cancelled");
  assert.equal(foldBudget(persisted).projection.primary.reserved, 0);
  assert.equal(foldBudget(persisted).projection.primary.used, 0);
});

test("terminal replay is idempotent but conflicting disposition fails closed", () => {
  const investigation = fixture("INV-v2-fold");
  investigation.expertTasks.push({
    id: "T01",
    expert: "trace",
    objective: "checked",
    status: "completed",
    hypothesisIds: ["H01"],
    toolCallIds: [],
    evidenceIds: [],
    createdAt: new Date().toISOString(),
    budgetClass: "primary",
    budgetReservationId: "reservation-1",
    dispatchOperationId: "operation-1",
  });
  investigation.budgetLedger = [
    {
      id: "B0001",
      sequence: 1,
      at: "2026-01-01T00:00:00Z",
      type: "budget.reserved",
      reservationId: "reservation-1",
      dispatchOperationId: "operation-1",
      requestHash: "hash",
      taskId: "T01",
      budgetClass: "primary",
    },
    {
      id: "B0002",
      sequence: 2,
      at: "2026-01-01T00:00:01Z",
      type: "budget.committed",
      reservationId: "reservation-1",
      taskId: "T01",
      budgetClass: "primary",
      reason: "completed",
    },
    {
      id: "B0003",
      sequence: 3,
      at: "2026-01-01T00:00:02Z",
      type: "budget.committed",
      reservationId: "reservation-1",
      taskId: "T01",
      budgetClass: "primary",
      reason: "completed",
    },
  ];
  assert.equal(foldBudget(investigation).projection.primary.used, 1);
  investigation.budgetLedger[2] = {
    ...investigation.budgetLedger[2]!,
    type: "budget.released",
  } as (typeof investigation.budgetLedger)[number];
  assert.throws(() => foldBudget(investigation), /Conflicting budget terminal/);
});

test("pending tasks released by repeated steering still exhaust the intent Safety ceiling", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rca-budget-intents-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = new InvestigationRepository(directory);
  const current = fixture("INV-v2-intents");
  for (let i = 1; i <= RCA_BUDGET_POLICY.safety.maxTaskIntents; i++) {
    const taskId = `T${String(i).padStart(2, "0")}`;
    const reservationId = `reservation-${i}`;
    current.expertTasks.push({
      id: taskId,
      expert: "trace",
      objective: "superseded",
      status: "cancelled",
      hypothesisIds: ["H01"],
      toolCallIds: [],
      evidenceIds: [],
      createdAt: new Date().toISOString(),
      budgetClass: "primary",
      budgetReservationId: reservationId,
      dispatchOperationId: `operation-${i}`,
    });
    appendLedgerEvent(
      current,
      nextLedgerEvent(current, {
        type: "budget.reserved",
        taskId,
        reservationId,
        dispatchOperationId: `operation-${i}`,
        requestHash: `hash-${i}`,
        budgetClass: "primary",
      }),
    );
    appendLedgerEvent(
      current,
      nextLedgerEvent(current, {
        type: "safety.consumed",
        executionId: taskId,
        resource: "task_intent",
      }),
    );
    appendLedgerEvent(
      current,
      nextLedgerEvent(current, {
        type: "budget.released",
        taskId,
        reservationId,
        budgetClass: "primary",
        reason: "user_superseded",
      }),
    );
  }
  await repository.save(current);
  const service = new RcaService(repository);
  Object.assign(service, { expertRunner: { run: success } });
  await service.resumeAgentic(current.id);
  assert.equal(foldBudget(await repository.get(current.id)).projection.primary.remaining, 4);
  await assert.rejects(
    () =>
      service.dispatchAgentic(current.id, [brief("still new")], {
        dispatchOperationId: "operation-33",
      }),
    /safety limit reached: task intents/,
  );
});


test("three Specialists may settle out of order without corrupting Budget or task identity", async (t) => {
  const resolvers = new Map<string, (value: unknown) => void>();
  let started = 0;
  const allStarted = new Promise<void>((resolve) => {
    const statePromise = resolve;
    Object.assign(globalThis, { __unusedStatePromise: statePromise });
  });
  let markAllStarted!: () => void;
  const startedBarrier = new Promise<void>((resolve) => {
    markAllStarted = resolve;
  });
  const state = await setup("INV-v2-out-of-order", async (context: unknown) => {
    const question = (context as { brief: InvestigationBrief }).brief.question;
    started++;
    if (started === 3) markAllStarted();
    return new Promise((resolve) => {
      resolvers.set(question, resolve);
    });
  });
  void allStarted;
  t.after(() => {
    delete (globalThis as { __unusedStatePromise?: unknown }).__unusedStatePromise;
    return rm(state.directory, { recursive: true, force: true });
  });

  const dispatch = state.service.dispatchAgentic(
    "INV-v2-out-of-order",
    [brief("first"), brief("second"), brief("third")],
    { dispatchOperationId: "op-out-of-order" },
  );
  await startedBarrier;
  resolvers.get("third")!(await success());
  await new Promise((resolve) => setTimeout(resolve, 1));
  resolvers.get("first")!(await success());
  await new Promise((resolve) => setTimeout(resolve, 1));
  resolvers.get("second")!(await success());

  const result = await dispatch;
  assert.deepEqual(result.findings.map((item) => item.taskRef), ["T01", "T02", "T03"]);
  const persisted = await state.repository.get("INV-v2-out-of-order");
  assert.deepEqual(persisted.expertTasks.map((task) => task.status), [
    "completed",
    "completed",
    "completed",
  ]);
  assert.equal(foldBudget(persisted).projection.primary.used, 3);
  assert.equal(foldBudget(persisted).projection.primary.reserved, 0);
});

test("steering storage failure still aborts the underlying Specialist and leaves no late Evidence or slot leak", async (t) => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let sawAbort = false;
  const state = await setup("INV-v2-steer-storage-failure", async (context: unknown) => {
    const signal = (context as { signal: AbortSignal }).signal;
    markStarted();
    return new Promise((_resolve, reject) => {
      const onAbort = () => {
        sawAbort = true;
        reject(new DOMException("steered", "AbortError"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  });
  t.after(() => rm(state.directory, { recursive: true, force: true }));

  const dispatch = state.service.dispatchAgentic(
    "INV-v2-steer-storage-failure",
    [brief("old investigation")],
    { dispatchOperationId: "op-steer-storage-failure" },
  );
  await started;

  const originalSave = state.repository.save.bind(state.repository);
  Object.assign(state.repository, {
    save: async (investigation: Investigation) => {
      if (investigation.userInterventions?.some((item) => item.content === "new context")) {
        throw new Error("injected intervention storage failure");
      }
      return originalSave(investigation);
    },
  });

  await assert.rejects(
    state.service.recordUserIntervention("INV-v2-steer-storage-failure", "new context"),
    /injected intervention storage failure/,
  );
  const outcome = await dispatch;
  assert.equal(sawAbort, true);
  assert.equal(outcome.interrupted, true);

  const persisted = await state.repository.get("INV-v2-steer-storage-failure");
  assert.equal(persisted.userInterventions?.length ?? 0, 0);
  assert.equal(persisted.expertTasks[0]?.status, "cancelled");
  assert.equal(persisted.evidence.length, 0);
  assert.equal(state.service.getBudgetProjection(persisted).runtime.running, 0);
  assert.equal(foldBudget(persisted).projection.primary.reserved, 0);
});
