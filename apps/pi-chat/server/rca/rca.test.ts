import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RCA100Adapter,
  resolveLogQueryFilter,
  traceQueryWindowRelation,
} from "./adapter";
import {
  compactToolResultForAgent,
  OBSERVABILITY_TOOL_NAMES,
} from "./tools";
import { LIVE_LIMITS } from "./live/types";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const benchmarkRoot = resolve(
  process.env.RCA100_ROOT ?? join(appDir, "../../../agenticopseval/RCA100"),
);
const casesDir = resolve(process.env.RCA100_CASES_DIR ?? join(benchmarkRoot, "cases"));
const adapter = new RCA100Adapter(casesDir);

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

const hasT039 = await exists(join(casesDir, "t039", "task.json"));
const rca100Test = hasT039 ? test : test.skip;

rca100Test("offline RCA100 adapter still reads benchmark fixtures without entering production registry", async () => {
  const counts = await adapter.validateCase("t039");
  assert.equal(counts["task.json"], 1);
  assert.ok((counts["metrics.parquet"] ?? 0) > 0);
  assert.ok((counts["logs.parquet"] ?? 0) > 0);
  assert.ok((counts["traces.parquet"] ?? 0) > 0);
  const task = await adapter.loadTask("t039");
  assert.equal(task.alert?.service, "checkout");
  assert.match(task.alert?.operation ?? "", /PlaceOrder/);
});

test("production observability tool surface contains only bounded Live tools", () => {
  assert.deepEqual(OBSERVABILITY_TOOL_NAMES, [
    "search_traces",
    "get_trace",
    "search_logs",
    "discover_metrics",
    "query_metrics",
  ]);
  assert.equal(OBSERVABILITY_TOOL_NAMES.some((name) => name.includes("query_traces")), false);
});

test("legacy log filter helper remains available only for offline benchmark evaluation", () => {
  const anomaly = resolveLogQueryFilter({});
  assert.equal(anomaly.mode, "anomaly");
  assert.ok(anomaly.effectiveKeywords.includes("error"));
  assert.deepEqual(resolveLogQueryFilter({ mode: "all" }), {
    mode: "all",
    effectiveKeywords: [],
  });
  assert.throws(() => resolveLogQueryFilter({ mode: "custom" }), /requires at least one keyword/);
});

test("legacy trace window helper still distinguishes pre-existing spans for historical evidence", () => {
  assert.deepEqual(
    traceQueryWindowRelation(
      Date.parse("2026-04-28T00:11:16.000Z"),
      Date.parse("2026-04-28T01:26:31.000Z"),
      {
        from: Date.parse("2026-04-28T01:18:30.000Z"),
        to: Date.parse("2026-04-28T01:27:55.000Z"),
      },
    ),
    {
      startedBeforeWindow: true,
      startedInWindow: false,
      endedInWindow: true,
      spansEntireWindow: false,
    },
  );
});

test("Agent tool text is bounded to 32 KiB and marks truncation explicitly", () => {
  const huge = {
    status: "success",
    query: { operation: "search_logs" },
    data: {
      logs: Array.from({ length: 200 }, (_, index) => ({
        timestamp: "2026-01-01T00:00:00.000Z",
        message: `log-${index}-${"x".repeat(2048)}`,
      })),
    },
    warnings: [],
    truncationReasons: [],
  };
  const compact = compactToolResultForAgent("search_logs", huge);
  const bytes = Buffer.byteLength(JSON.stringify(compact), "utf8");
  assert.ok(bytes <= LIVE_LIMITS.maxAgentToolBytes);
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

test("runtime source graph does not embed RCA100 ground truth", async () => {
  const sourceFiles = [
    join(appDir, "server/rca/service.ts"),
    join(appDir, "server/rca/tools.ts"),
    join(appDir, "server/rca/live/providers.ts"),
  ];
  for (const path of sourceFiles) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, /expected_fault_id|raw_ground_truth|ground_truth/);
  }
});


test("production startup graph no longer depends on RCA100 data or dataset download", async () => {
  const repoRoot = resolve(appDir, "../..");
  const checks = [
    {
      path: join(appDir, "server/index.ts"),
      forbidden: /RCA100Adapter|RCA100_CASES_DIR|rca:fetch:t039/,
    },
    {
      path: join(appDir, "server/config.ts"),
      forbidden: /RCA100_CASES_DIR|rcaCasesDir/,
    },
    {
      path: join(appDir, "server/rca/tools.ts"),
      forbidden: /RCA100Adapter|metrics\.parquet|logs\.parquet|traces\.parquet/,
    },
    {
      path: join(repoRoot, "Dockerfile"),
      forbidden: /rca:fetch:t039|RCA100_CASES_DIR/,
    },
    {
      path: join(appDir, "scripts/start-railway.sh"),
      forbidden: /RCA100_CASES_DIR/,
    },
  ];
  for (const check of checks) {
    assert.doesNotMatch(await readFile(check.path, "utf8"), check.forbidden);
  }
});
