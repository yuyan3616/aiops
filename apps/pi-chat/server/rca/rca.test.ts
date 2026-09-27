import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { RCA100Adapter } from "./adapter";
import { RcaScorer, type RcaEvaluation } from "./evaluation/scorer";
import { InvestigationFollowUpService, requestsFreshInvestigation } from "./follow-up";
import { RcaOrchestrator } from "./orchestrator";
import { InvestigationRepository } from "./repository";
import { OBSERVABILITY_TOOL_NAMES, ObservabilityToolRegistry } from "./tools";
import type { Investigation } from "./types";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const benchmarkRoot = resolve(
  process.env.RCA100_ROOT ?? join(appDir, "../../../agenticopseval/RCA100"),
);
const casesDir = resolve(process.env.RCA100_CASES_DIR ?? join(benchmarkRoot, "cases"));
const answerKeyDir = resolve(
  process.env.RCA100_ANSWER_KEY_DIR ?? join(benchmarkRoot, "answer_key"),
);
const adapter = new RCA100Adapter(casesDir);
const tools = new ObservabilityToolRegistry(adapter);
let tempDir = "";
let repository: InvestigationRepository;
let completed: Investigation;
let evaluation: RcaEvaluation;

test.before(async () => {
  await access(join(casesDir, "t039", "task.json"));
  tempDir = await mkdtemp(join(tmpdir(), "pi-chat-rca-test-"));
  repository = new InvestigationRepository(tempDir);
});

test.after(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test("loads every required t039 modality using its actual schema", async () => {
  assert.deepEqual(await adapter.validateCase("t039"), {
    "task.json": 1,
    "metrics.parquet": 91_162,
    "logs.parquet": 616_778,
    "traces.parquet": 447_541,
    "events.parquet": 450,
    "alerts.parquet": 12,
    "topology.json": 1,
  });
  const task = await adapter.loadTask("t039");
  assert.equal(task.alert.service, "checkout");
  assert.match(task.alert.operation ?? "", /PlaceOrder/);
  const schemas = await Promise.all(
    (["metric", "log", "trace", "event", "alert", "topology"] as const).map((modality) =>
      adapter.inspectSchema("t039", modality),
    ),
  );
  assert.deepEqual(
    schemas.map(({ modality, rowCount }) => [modality, rowCount]),
    [
      ["metric", 91_162],
      ["log", 616_778],
      ["trace", 447_541],
      ["event", 450],
      ["alert", 12],
      ["topology", 686],
    ],
  );
  assert.ok(schemas.every((schema) => schema.fields.length > 0));
});

test("tools query t039 by time, service, operation, and keyword with bounded output", async () => {
  const alert = await adapter.getAlertContext("t039");
  const range = { caseId: "t039", from: alert.window.from, to: alert.window.to };
  const metrics = await tools.execute("query_metrics", {
    ...range,
    service: alert.service,
    topN: 5,
  });
  const traces = await tools.execute("query_traces", {
    ...range,
    service: alert.service,
    operation: alert.operation,
    topN: 5,
  });
  const logs = await tools.execute("query_logs", {
    ...range,
    service: alert.service,
    keywords: ["error"],
    limit: 5,
  });
  const alerts = await tools.execute("query_alerts", {
    ...range,
    subject: alert.service,
    limit: 5,
  });
  const topology = await tools.execute("get_topology", {
    caseId: "t039",
    entity: alert.service,
    depth: 2,
  });
  for (const execution of [metrics, traces, logs, alerts, topology]) {
    assert.ok(execution.result);
  }
  assert.ok((traces.result as { matchedRows: number }).matchedRows > 0);
  assert.ok((logs.result as { returnedRows: number }).returnedRows <= 5);
  assert.ok((metrics.result as { returnedRows: number }).returnedRows <= 5);
});

test("runtime path and tool registry cannot expose an answer key", async () => {
  assert.deepEqual(adapter.runtimeAccessiblePaths("t039"), [join(casesDir, "t039")]);
  assert.ok(
    OBSERVABILITY_TOOL_NAMES.every(
      (name) => !name.includes("answer") && !name.includes("ground_truth"),
    ),
  );
  const runtimeSources = [
    "adapter.ts",
    "chat-events.ts",
    "events.ts",
    "experts.ts",
    "follow-up.ts",
    "orchestrator.ts",
    "parquet.ts",
    "repository.ts",
    "service.ts",
    "statistics.ts",
    "tools.ts",
    "types.ts",
    "cli/run.ts",
  ];
  for (const source of runtimeSources) {
    const text = await readFile(join(dirname(fileURLToPath(import.meta.url)), source), "utf8");
    assert.doesNotMatch(text, /from\s+["'].*evaluation|RCA100_ANSWER_KEY_DIR|\.gt\.json/);
  }
});

test("end-to-end investigation persists traceable evidence and hypothesis transitions", async () => {
  const orchestrator = new RcaOrchestrator(tools, repository);
  completed = (await orchestrator.investigate({ caseId: "t039" })).investigation;
  assert.equal(completed.status, "completed");
  assert.ok(completed.rootCause);
  assert.equal(completed.rootCause.status, "probable");
  assert.ok(completed.rootCause.evidenceIds.length >= 2);
  const callIds = new Set(completed.toolCalls.map((call) => call.id));
  for (const evidenceId of completed.rootCause.evidenceIds) {
    const evidence = completed.evidence.find((item) => item.id === evidenceId);
    assert.ok(evidence);
    assert.equal(evidence.caseId, "t039");
    assert.ok(evidence.rawRef.startsWith("rca100://t039/"));
    assert.ok(Object.keys(evidence.sourceQuery).length > 0);
    assert.ok(callIds.has(evidence.toolCallId));
  }
  const rawEvents = await readFile(
    join(repository.directory(completed.id), "events.jsonl"),
    "utf8",
  );
  assert.match(rawEvents, /"previous":"possible","current":"investigating"/);
  assert.match(rawEvents, /"current":"(?:supported|confirmed|rejected)"/);
  for (const file of [
    "investigation.json",
    "tool-calls.jsonl",
    "events.jsonl",
    "final-report.json",
  ]) {
    await access(join(repository.directory(completed.id), file));
  }
});

test("independent scorer reads t039 ground truth only after prediction completion", async () => {
  assert.ok(completed?.completedAt);
  evaluation = await new RcaScorer(answerKeyDir, repository).evaluate(completed.id);
  assert.equal(evaluation.rootCauseEntity.matched, true);
  assert.equal(evaluation.faultMechanism.matched, true);
  assert.equal(evaluation.evidenceQuality.matched, true);
  assert.equal(evaluation.reasoningTrace.matched, true);
  assert.equal(evaluation.passed, true);
  await access(join(repository.directory(completed.id), "evaluation.json"));
});

test("follow-up QA explains the completed investigation without new tool calls or mutation", async () => {
  const service = new InvestigationFollowUpService(repository);
  const originalHypotheses = structuredClone(completed.hypotheses);
  const originalToolCalls = structuredClone(completed.toolCalls);
  const questions = [
    "为什么这是根因？",
    "为什么不是 checkout 自己的问题？",
    "最关键的 Evidence 是哪个？",
    "有哪些假设被排除了？",
    "这个结论还有什么不确定性？",
    "Trace Expert 发现了什么？",
  ];
  const answers = await Promise.all(
    questions.map((question) => service.answer(completed.id, question)),
  );

  assert.ok(answers.every((answer) => answer.investigationId === completed.id));
  assert.ok(answers.every((answer) => answer.usedNewTools === false));
  assert.match(answers[0].answer, /shipping/);
  assert.match(answers[0].answer, /E01/);
  assert.match(answers[0].answer, /E02/);
  assert.match(answers[1].answer, /H01/);
  assert.match(answers[1].answer, /rejected/);
  assert.match(answers[2].answer, /E01/);
  assert.match(answers[3].answer, /H01/);
  assert.match(answers[4].answer, /NetworkPolicy|packet-flow/);
  assert.match(answers[5].answer, /T01/);
  assert.match(answers[5].answer, /query_traces/);
  assert.match(answers[5].answer, /E01/);
  assert.deepEqual(completed.hypotheses, originalHypotheses);
  assert.deepEqual(completed.toolCalls, originalToolCalls);
});

test("follow-up QA supports evidence drill-down, lifecycle replay, and read-only counterfactuals", async () => {
  const service = new InvestigationFollowUpService(repository);
  const original = JSON.stringify(await repository.get(completed.id));
  const evidence = await service.answer(completed.id, "E01 是什么？");
  const lifecycle = await service.answer(completed.id, "H01 为什么被排除了？");
  const counterfactual = await service.answer(completed.id, "如果没有 E01，这个结论还成立吗？");
  const expandedWindow = await service.answer(completed.id, "扩大时间窗口看看");

  assert.match(evidence.answer, /query_traces/);
  assert.match(evidence.answer, /rawRef/);
  assert.match(evidence.answer, /shipping/);
  assert.match(lifecycle.answer, /possible/);
  assert.match(lifecycle.answer, /investigating/);
  assert.match(lifecycle.answer, /rejected/);
  assert.match(counterfactual.answer, /inconclusive/);
  assert.equal(counterfactual.usedNewTools, false);
  assert.match(expandedWindow.answer, /Investigation revision/);
  assert.equal(expandedWindow.usedNewTools, false);
  assert.equal(requestsFreshInvestigation("再帮我确认一下"), true);
  assert.equal(requestsFreshInvestigation("有没有其他新证据"), true);
  assert.equal(requestsFreshInvestigation("扩大时间窗口看看"), false);
  assert.equal(JSON.stringify(await repository.get(completed.id)), original);
});
