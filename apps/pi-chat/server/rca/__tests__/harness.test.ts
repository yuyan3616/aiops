import assert from "node:assert/strict";
import test from "node:test";

import type { AgentKind, EvidenceView, HypothesisView } from "../../../shared/rca-types.ts";
import { BudgetGuard } from "../harness/budget-guard.ts";
import { ContextBuilder } from "../harness/context-builder.ts";
import { InvestigationHarness } from "../harness/investigation-harness.ts";
import { TaskExecutionError } from "../harness/errors.ts";
import { TaskScheduler } from "../harness/task-scheduler.ts";
import { createAgentTask, transitionTask, type CaseContext } from "../harness/task-types.ts";
import { DEFAULT_TASK_POLICY } from "../harness/task-policy.ts";
import { ToolGuard } from "../harness/tool-guard.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function evidence(id: string, entityRefs: string[], createdAt = "2026-04-28T09:20:00.000Z"): EvidenceView {
  return {
    id,
    taskId: "T000",
    datasetTaskId: "t039",
    type: "metric",
    modality: "metric",
    label: `Evidence ${id}`,
    source: "RCA100-v1.1",
    summary: `summary ${id}`,
    observation: {},
    rawRef: `rca100://t039/metrics/${id}`,
    queryKey: `t039:metric:${id}`,
    entityRefs,
    timeRange: { start: "2026-04-28T09:20:00.000Z", end: "2026-04-28T09:21:00.000Z" },
    createdBy: "metric",
    createdAt,
  };
}

const caseContext: CaseContext = {
  datasetTaskId: "t039",
  alertTitle: "checkout响应时间突增告警",
  alertEntity: "checkout::PlaceOrder",
  startTime: "2026-04-28T09:20:00.000Z",
  endTime: "2026-04-28T09:30:00.000Z",
  defaultService: "checkout",
  operation: "PlaceOrder",
};

function baseTask(agent: AgentKind = "log") {
  return createAgentTask({
    id: "T001",
    investigationId: "demo",
    runId: "run-1",
    agent,
    instruction: "investigate",
    service: "checkout",
    evidenceIds: [],
    hypothesisIds: [],
    policy: { ...DEFAULT_TASK_POLICY },
  });
}

test("H81-013 task state machine accepts legal transitions and rejects terminal transitions", () => {
  const queued = baseTask();
  const running = transitionTask(queued, "running", { now: "2026-01-01T00:00:00.000Z" });
  const done = transitionTask(running, "succeeded", {
    now: "2026-01-01T00:00:01.000Z",
    result: { summary: "ok", evidenceIds: [], toolCallCount: 1, turnCount: 1, durationMs: 1000 },
  });
  assert.equal(done.status, "succeeded");
  assert.throws(() => transitionTask(done, "running"), /Illegal task transition/);
});

test("H81-024 scheduler serializes same Agent kind", async () => {
  const scheduler = new TaskScheduler(3);
  const controller = new AbortController();
  let active = 0;
  let peak = 0;
  const run = (id: string) => scheduler.schedule({
    key: "log",
    taskId: id,
    signal: controller.signal,
    execute: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(25);
      active -= 1;
      return id;
    },
  });
  const values = await Promise.all([run("T1"), run("T2")]);
  assert.deepEqual(values, ["T1", "T2"]);
  assert.equal(peak, 1);
});

test("H81-024 scheduler allows different Agent kinds to overlap", async () => {
  const scheduler = new TaskScheduler(3);
  const controller = new AbortController();
  let active = 0;
  let peak = 0;
  const run = (key: AgentKind, id: string) => scheduler.schedule({
    key,
    taskId: id,
    signal: controller.signal,
    execute: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(30);
      active -= 1;
      return id;
    },
  });
  await Promise.all([run("log", "T1"), run("metric", "T2")]);
  assert.equal(peak, 2);
});

test("H81-034 ContextBuilder bounds Evidence and never includes transcript fields", () => {
  const task = {
    ...baseTask("trace"),
    evidenceIds: ["EV01"],
    hypothesisIds: ["H1"],
    policy: { ...DEFAULT_TASK_POLICY, maxEvidence: 2 },
  };
  const hypotheses: HypothesisView[] = [{
    id: "H1",
    title: "downstream latency",
    state: "validating",
    supportingEvidenceIds: ["EV02"],
    contradictingEvidenceIds: [],
  }];
  const context = new ContextBuilder().buildSpecialistContext({
    task,
    caseContext,
    hypotheses,
    evidence: [evidence("EV01", ["checkout"]), evidence("EV02", ["payment"]), evidence("EV03", ["checkout"])],
  });
  assert.deepEqual(context.evidence.map((item) => item.id), ["EV01", "EV02"]);
  assert.equal(JSON.stringify(context).includes("transcript"), false);
  assert.equal(context.assignment.taskId, "T001");
  assert.equal(context.case.taskId, "t039");
});

test("H81-045 BudgetGuard enforces tool, turn and Evidence budgets", () => {
  const tool = new BudgetGuard({ ...DEFAULT_TASK_POLICY, maxToolCalls: 1 });
  tool.beforeToolCall();
  assert.throws(() => tool.beforeToolCall(), (error) => error instanceof TaskExecutionError && error.code === "TASK_TOOL_BUDGET_EXCEEDED");

  let aborted = false;
  const turns = new BudgetGuard({ ...DEFAULT_TASK_POLICY, maxTurns: 1 });
  turns.onTurnStart(() => { aborted = true; });
  turns.onTurnStart(() => { aborted = true; });
  assert.equal(aborted, true);
  assert.throws(() => turns.throwIfViolated(), (error) => error instanceof TaskExecutionError && error.code === "TASK_TURN_BUDGET_EXCEEDED");

  const evidenceBudget = new BudgetGuard({ ...DEFAULT_TASK_POLICY, maxEvidence: 1 });
  evidenceBudget.beforeNewEvidence();
  assert.throws(() => evidenceBudget.beforeNewEvidence(), (error) => error instanceof TaskExecutionError && error.code === "TASK_EVIDENCE_BUDGET_EXCEEDED");
});

test("H81-065 ToolGuard rejects unauthorized tool and invalid time window, caps limit", () => {
  const guard = new ToolGuard();
  assert.throws(() => guard.guardInput({ id: "1", agent: "log", name: "query_metrics", args: {} }, caseContext));
  assert.throws(() => guard.guardInput({
    id: "2", agent: "log", name: "query_logs", args: { startTime: "2026-04-28T09:00:00Z" },
  }, caseContext), /incident window/);
  const plan = guard.guardInput({ id: "3", agent: "log", name: "query_logs", args: { limit: 999 } }, caseContext);
  assert.equal(plan.args.limit, 100);
});

test("H81-065 ToolGuard rejects filesystem rawRef leakage and bounds output arrays", () => {
  const guard = new ToolGuard();
  assert.throws(() => guard.guardOutput({
    display: "x",
    evidence: [{
      taskId: "T1",
      datasetTaskId: "t039",
      type: "log",
      modality: "log",
      label: "x",
      source: "/mnt/data/answer_key/t039.gt.json",
      summary: "x",
      observation: {},
      rawRef: "/mnt/data/answer_key/t039.gt.json",
      query: {},
      entityRefs: [],
      timeRange: { start: caseContext.startTime, end: caseContext.endTime },
      createdBy: "log",
    }],
  }), /invalid rawRef|filesystem path/);
});


test("H81-065 ToolGuard rejects oversized input, bounds rows, and rejects oversized serialized output", () => {
  const guard = new ToolGuard();
  assert.throws(() => guard.guardInput({
    id: "oversized-string",
    agent: "log",
    name: "query_logs",
    args: { keyword: "x".repeat(1_025) },
  }, caseContext), /exceeds 1024 characters/);
  assert.throws(() => guard.guardInput({
    id: "oversized-array",
    agent: "metric",
    name: "query_metrics",
    args: { metrics: Array.from({ length: 17 }, (_, index) => `metric-${index}`) },
  }, caseContext), /exceeds 16 items/);

  const makeEvidence = (index: number, summary = "x") => ({
    taskId: "T1",
    datasetTaskId: "t039",
    type: "log" as const,
    modality: "log" as const,
    label: `E${index}`,
    source: "RCA100-v1.1",
    summary,
    observation: { rows: Array.from({ length: 105 }, (_, row) => row) },
    rawRef: `rca100://t039/logs/${index}`,
    query: {},
    entityRefs: ["checkout"],
    timeRange: { start: caseContext.startTime, end: caseContext.endTime },
    createdBy: "log" as const,
  });

  const bounded = guard.guardOutput({
    display: "x".repeat(4_100),
    evidence: Array.from({ length: 105 }, (_, index) => makeEvidence(index)),
  });
  assert.equal(bounded.display.length, 4_000);
  assert.equal(bounded.evidence.length, 100);
  assert.equal((bounded.evidence[0].observation.rows as unknown[]).length, 100);

  assert.throws(() => guard.guardOutput({
    display: "x",
    evidence: Array.from({ length: 100 }, (_, index) => makeEvidence(index, "x".repeat(1_000))),
  }), /serialized|server limit|Narrow the query/);
});

test("H81-064 ToolGuard validates Evidence shape", () => {
  const guard = new ToolGuard();
  assert.throws(() => guard.guardOutput({
    display: "x",
    evidence: [{
      taskId: "",
      datasetTaskId: "t039",
      type: "log",
      modality: "log",
      label: "x",
      source: "RCA100-v1.1",
      summary: "x",
      observation: {},
      rawRef: "rca100://t039/logs/x",
      query: {},
      entityRefs: [],
      timeRange: { start: caseContext.startTime, end: caseContext.endTime },
      createdBy: "log",
    }],
  }), /invalid Evidence record/);
});

test("H81-D04 InvestigationHarness times out a running task and emits correlated event", async () => {
  const previous = process.env.RCA_TASK_TIMEOUT_MS;
  process.env.RCA_TASK_TIMEOUT_MS = "30";
  const controller = new AbortController();
  const events: Array<{ type: string; payload: any }> = [];
  const fakeChannel = { publish(type: string, payload: unknown) { events.push({ type, payload }); } };
  const fakeManager = {
    run({ signal }: { signal: AbortSignal }) {
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
    dispose() {},
  };
  const harness = new InvestigationHarness({
    investigationId: "demo",
    runId: "run-timeout",
    signal: controller.signal,
    channel: fakeChannel as any,
    agentManager: fakeManager as any,
    getCaseContext: () => caseContext,
    getHypotheses: () => [],
    getEvidence: () => [],
  });
  await assert.rejects(
    harness.delegate([{ agent: "log", goal: "timeout" }]),
    (error) => error instanceof TaskExecutionError && error.code === "TASK_TIMEOUT",
  );
  const task = harness.taskViews()[0];
  assert.equal(task.status, "timed_out");
  assert.equal(events.some((event) => event.type === "task.timed_out" && event.payload.runId === "run-timeout"), true);
  if (previous === undefined) delete process.env.RCA_TASK_TIMEOUT_MS;
  else process.env.RCA_TASK_TIMEOUT_MS = previous;
});

test("H81-D05 investigation cancellation aborts running work and cancels queued same-Agent work", async () => {
  const controller = new AbortController();
  let started = 0;
  const fakeChannel = { publish() {} };
  const fakeManager = {
    run({ signal, task }: { signal: AbortSignal; task: { id: string; agent: AgentKind } }) {
      started += 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({
          agent: task.agent,
          taskId: task.id,
          summary: "ok",
          evidence: [],
          toolCallCount: 0,
          turnCount: 1,
          durationMs: 100,
        }), 100);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
    },
    dispose() {},
  };
  const harness = new InvestigationHarness({
    investigationId: "demo",
    runId: "run-cancel",
    signal: controller.signal,
    channel: fakeChannel as any,
    agentManager: fakeManager as any,
    getCaseContext: () => caseContext,
    getHypotheses: () => [],
    getEvidence: () => [],
  });
  const promise = harness.delegate([
    { agent: "log", goal: "A" },
    { agent: "log", goal: "B" },
  ]);
  await sleep(10);
  controller.abort(new TaskExecutionError("TASK_CANCELLED", "stop"));
  await assert.rejects(promise);
  await sleep(5);
  assert.equal(started, 1);
  assert.deepEqual(harness.taskViews().map((task) => task.status), ["cancelled", "cancelled"]);
});

test("H81-021 scheduler respects global specialist concurrency", async () => {
  const scheduler = new TaskScheduler(3);
  const controller = new AbortController();
  let active = 0;
  let peak = 0;
  const kinds: AgentKind[] = ["log", "metric", "trace", "context"];
  await Promise.all(kinds.map((key, index) => scheduler.schedule({
    key,
    taskId: `TG${index}`,
    signal: controller.signal,
    execute: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(25);
      active -= 1;
    },
  })));
  assert.equal(peak, 3);
});

test("H81-D08 task event carries investigation/run/task/agent correlation", async () => {
  const controller = new AbortController();
  const events: Array<{ type: string; correlation?: Record<string, string> }> = [];
  const fakeChannel = {
    publish(type: string, _payload: unknown, correlation?: Record<string, string>) {
      events.push({ type, correlation });
    },
  };
  const fakeManager = {
    async run({ task }: { task: { id: string; agent: AgentKind } }) {
      return {
        agent: task.agent,
        taskId: task.id,
        summary: "ok",
        evidence: [],
        toolCallCount: 1,
        turnCount: 1,
        durationMs: 1,
      };
    },
    dispose() {},
  };
  const harness = new InvestigationHarness({
    investigationId: "demo",
    runId: "run-correlation",
    signal: controller.signal,
    channel: fakeChannel as any,
    agentManager: fakeManager as any,
    getCaseContext: () => caseContext,
    getHypotheses: () => [],
    getEvidence: () => [],
  });
  await harness.delegate([{ agent: "metric", goal: "correlate" }]);
  const completed = events.find((event) => event.type === "task.completed");
  assert.deepEqual(completed?.correlation, {
    investigationId: "demo",
    runId: "run-correlation",
    taskId: "T001",
    agent: "metric",
  });
});
