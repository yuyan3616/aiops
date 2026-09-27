import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { RCA100Adapter } from "./adapter";
import { OBSERVABILITY_TOOL_NAMES, ObservabilityToolRegistry } from "./tools";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const benchmarkRoot = resolve(
  process.env.RCA100_ROOT ?? join(appDir, "../../../agenticopseval/RCA100"),
);
const casesDir = resolve(process.env.RCA100_CASES_DIR ?? join(benchmarkRoot, "cases"));
const adapter = new RCA100Adapter(casesDir);
const tools = new ObservabilityToolRegistry(adapter);

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

const hasT039 = await exists(join(casesDir, "t039", "task.json"));
const rca100Test = hasT039 ? test : test.skip;

rca100Test("loads every required t039 modality using its actual schema", async () => {
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

rca100Test("tools query t039 by time, service, operation, and keyword with bounded output", async () => {
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

test("agent runtime sources cannot expose an answer key", async () => {
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
    "main-agent-tools.ts",
    "parquet.ts",
    "pi-expert.ts",
    "repository.ts",
    "service.ts",
    "statistics.ts",
    "tools.ts",
    "types.ts",
  ];
  for (const source of runtimeSources) {
    const text = await readFile(join(dirname(fileURLToPath(import.meta.url)), source), "utf8");
    assert.doesNotMatch(text, /from\s+["'].*evaluation|RCA100_ANSWER_KEY_DIR|\.gt\.json/);
  }
});


test("production wiring has a single agentic RCA execution path", async () => {
  const indexSource = await readFile(join(appDir, "server/index.ts"), "utf8");
  const serviceSource = await readFile(join(appDir, "server/rca/service.ts"), "utf8");
  const routeSource = await readFile(join(appDir, "server/routes/rca.ts"), "utf8");
  const packageJson = JSON.parse(await readFile(join(appDir, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };

  assert.doesNotMatch(indexSource, /RcaOrchestrator|PiRcaPlanner|RCA_AGENTIC_PLANNER/);
  assert.doesNotMatch(serviceSource, /Legacy deterministic|private readonly orchestrator|RunningInvestigation/);
  assert.doesNotMatch(routeSource, /app\.post\("\/investigations"/);
  assert.equal(packageJson.scripts?.["rca:run"], undefined);
});
