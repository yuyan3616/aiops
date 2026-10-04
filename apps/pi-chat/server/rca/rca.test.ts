import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LIVE_LIMITS } from "./live/types";
import { compactToolResultForAgent, OBSERVABILITY_TOOL_NAMES } from "./tools";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
test("production observability tool surface contains only bounded Live tools", () => {
  assert.deepEqual(OBSERVABILITY_TOOL_NAMES, [
    "search_traces",
    "get_trace",
    "search_logs",
    "discover_metrics",
    "query_metrics",
  ]);
  assert.equal(
    OBSERVABILITY_TOOL_NAMES.some((name) => name.includes("query_traces")),
    false,
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
