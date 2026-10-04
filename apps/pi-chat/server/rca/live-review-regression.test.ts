import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LiveHttpClient } from "./live/http-client";
import { LogProvider, MetricsProvider, TraceProvider } from "./live/providers";
import { LIVE_LIMITS, LiveBackendError } from "./live/types";
import { createRcaMainAgentTools } from "./main-host-test-helper";
import type { PiExpertRunContext } from "./pi-expert";
import { InvestigationRepository } from "./repository";
import { RcaService } from "./service";
import { compactToolResultForAgent, ObservabilityToolRegistry } from "./tools";

const window = { from: "2026-10-04T00:00:00.000Z", to: "2026-10-04T00:10:00.000Z" };
const target = { service: "checkout" };
const id = "00000000000000000000000000000001";
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const span = (spanId: string, start: number, end: number, parentSpanId?: string) => ({
  traceId: id,
  spanId,
  parentSpanId,
  name: "operation",
  startTimeUnixNano: String(1791072000000000000n + BigInt(start) * 1000000n),
  endTimeUnixNano: String(1791072000000000000n + BigInt(end) * 1000000n),
});
const traceResponse = (status = "COMPLETE") => ({
  trace: {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout" } }] },
        scopeSpans: [
          {
            spans: [
              span("0000000000000001", 0, 100),
              span("0000000000000002", 10, 70, "0000000000000001"),
              span("0000000000000003", 50, 90, "0000000000000001"),
            ],
          },
        ],
      },
    ],
  },
  status,
});

test("HTTP gateway path prefix and Basic auth are preserved without leaking auth into result", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/tempo/api/search?limit=1");
    assert.equal(
      request.headers.authorization,
      `Basic ${Buffer.from("reader:secret").toString("base64")}`,
    );
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ traces: [] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address() as { port: number };
    const client = new LiveHttpClient({
      baseUrl: `http://127.0.0.1:${address.port}/tempo/`,
      backendAlias: "tempo",
      headers: { Authorization: `Basic ${Buffer.from("reader:secret").toString("base64")}` },
    });
    const result = await client.requestJson({
      path: "/api/search",
      search: new URLSearchParams({ limit: "1" }),
    });
    assert.deepEqual(result, { traces: [] });
    assert.doesNotMatch(JSON.stringify(result), /reader|secret|Authorization/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("Tempo v2 wrapped response preserves backend partial and computes child interval union", async () => {
  const provider = new TraceProvider({
    baseUrl: "http://tempo.test",
    backendAlias: "tempo",
    fetchImpl: async () => json(traceResponse("PARTIAL")),
  });
  const result = await provider.getTrace({ target, window, traceId: id });
  assert.equal(result.status, "partial");
  assert.equal(result.data.trace.spans.length, 3);
  assert.equal(result.data.trace.spans[0]?.startTimeUnixNano, "1791072000000000000");
  const parent = result.data.trace.analysis?.intervals.find(
    (item) => item.spanId === "0000000000000001",
  );
  assert.equal(parent?.coveredChildDurationMs, 80);
  assert.equal(parent?.uncoveredDurationMs, 20);
  assert.deepEqual(parent?.uncoveredIntervals, [
    { fromOffsetMs: 0, toOffsetMs: 10 },
    { fromOffsetMs: 90, toOffsetMs: 100 },
  ]);
  assert.equal(result.data.trace.analysis?.completeCriticalPath, false);
});

test("Classic Histogram discovery maps suffixed series to family metadata and bucket quantile", async () => {
  const queries: string[] = [];
  const provider = new MetricsProvider({
    baseUrl: "http://prom.test",
    backendAlias: "prometheus",
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/series"))
        return json({
          status: "success",
          data: [
            { __name__: "pi_tool_call_duration_seconds_bucket", service: "checkout", le: "1" },
            { __name__: "pi_tool_call_duration_seconds_sum", service: "checkout" },
            { __name__: "pi_tool_call_duration_seconds_count", service: "checkout" },
          ],
        });
      if (url.pathname.endsWith("/metadata")) {
        assert.equal(url.searchParams.get("metric"), "pi_tool_call_duration_seconds");
        return json({
          status: "success",
          data: { pi_tool_call_duration_seconds: [{ type: "histogram", unit: "seconds" }] },
        });
      }
      queries.push(url.searchParams.get("query")!);
      return json({ status: "success", data: { resultType: "matrix", result: [] } });
    },
  });
  const discovery = await provider.discoverMetrics({ target, window });
  const descriptor = discovery.data.metrics.find(
    (metric) => metric.name === "pi_tool_call_duration_seconds",
  )!;
  assert.equal(descriptor.type, "histogram");
  assert.deepEqual(descriptor.operations, ["quantile"]);
  assert.equal(descriptor.labels.includes("le"), false);
  assert.equal(
    discovery.data.metrics.find((metric) => metric.name.endsWith("_count"))?.type,
    "counter",
  );
  await provider.queryMetrics(
    { target, window, metric: descriptor.name, operation: "quantile", quantile: 0.99 },
    descriptor,
  );
  assert.match(queries[0]!, /histogram_quantile\(0.99/);
  assert.match(queries[0]!, /rate\(pi_tool_call_duration_seconds_bucket/);
});

test("Malformed backend success JSON is invalid_response rather than no_data", async () => {
  const options = {
    baseUrl: "http://backend.test",
    backendAlias: "test",
    fetchImpl: async () => json({ unexpected: "schema" }),
  };
  const isInvalid = (error: unknown) =>
    error instanceof LiveBackendError && error.code === "invalid_response";
  await assert.rejects(new TraceProvider(options).searchTraces({ target, window }), isInvalid);
  await assert.rejects(
    new TraceProvider(options).getTrace({ target, window, traceId: id }),
    isInvalid,
  );
  await assert.rejects(new LogProvider(options).searchLogs({ target, window }), isInvalid);
  await assert.rejects(new MetricsProvider(options).discoverMetrics({ target, window }), isInvalid);
});

test("Loki limit before structured postfilter is partial even with zero retained logs", async () => {
  const provider = new LogProvider({
    baseUrl: "http://loki.test",
    backendAlias: "loki",
    fetchImpl: async () =>
      json({
        status: "success",
        data: {
          result: [
            {
              stream: {},
              values: [
                [
                  "1791072000000000000",
                  JSON.stringify({ level: 30, lifecycleStatus: "success", msg: "done" }),
                ],
              ],
            },
          ],
        },
      }),
  });
  const result = await provider.searchLogs({
    target,
    window,
    mode: "all",
    lifecycleStatus: "error",
    limit: 1,
  });
  assert.equal(result.status, "partial");
  assert.deepEqual(result.data.logs, []);
  assert.ok(result.truncationReasons.length);
});

async function withService(
  callback: (
    repository: InvestigationRepository,
    registry: ObservabilityToolRegistry,
    service: RcaService,
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "live-review-"));
  try {
    const trace = new TraceProvider({
      baseUrl: "http://tempo.test",
      backendAlias: "tempo",
      fetchImpl: async (input) =>
        new URL(String(input)).pathname.endsWith("/search")
          ? json({ traces: [{ traceID: id }] })
          : json(traceResponse()),
    });
    const log = new LogProvider({
      baseUrl: "http://loki.test",
      backendAlias: "loki",
      fetchImpl: async () =>
        json({
          data: {
            result: [
              {
                stream: {},
                values: [["1791071400000000000", JSON.stringify({ level: 50, msg: "error" })]],
              },
            ],
          },
        }),
    });
    const metrics = new MetricsProvider({
      baseUrl: "http://prom.test",
      backendAlias: "prometheus",
      fetchImpl: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/series"))
          return json({ data: [{ __name__: "calls_total", service: "checkout" }] });
        if (path.endsWith("/metadata"))
          return json({ data: { calls_total: [{ type: "counter" }] } });
        return json({ data: { result: [] } });
      },
    });
    const repository = new InvestigationRepository(directory);
    const registry = new ObservabilityToolRegistry({ trace, log, metrics });
    await callback(repository, registry, new RcaService(repository, undefined, registry));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("Resume restores Trace and Metric authorization from committed snapshots without requery", async () => {
  await withService(async (repository, registry, service) => {
    const investigation = await service.beginAgentic({ symptom: "latency", target, window });
    await service.queryOverview(investigation.id, "traces");
    await service.queryOverview(investigation.id, "metrics");
    registry.clearAuthorization(investigation.id);
    await repository.recoverInterrupted();
    const restarted = new RcaService(repository, undefined, registry);
    const resumed = await restarted.resumeAgentic(investigation.id);
    const result = await registry.executePrepared(
      resumed.id,
      registry.prepare("get_trace", { traceId: id }, resumed),
    );
    assert.equal(result.result.status, "success");
    const queried = await restarted.queryOverview(resumed.id, "metrics", {
      metric: "calls_total",
      operation: "rate",
    });
    assert.ok(queried.toolCallId);
  });
});

test("Main directly reads an authorized Trace and closes with persisted Evidence and zero experts", async () => {
  await withService(async (repository, _registry, service) => {
    const investigation = await service.beginAgentic({ symptom: "latency", target, window });
    const tools = createRcaMainAgentTools({
      rcaService: service,
      conversationId: "main-only",
      getModelRef: () => ({ provider: "test", id: "test" }),
      onProjection: () => {},
      onLinkInvestigation: () => {},
    });
    const read = tools.find((tool) => tool.name === "read_rca_trace")!;
    const execute = read.execute as unknown as (
      callId: string,
      parameters: { investigationId: string; traceId: string },
    ) => Promise<{ content: Array<{ text: string }> }>;
    await assert.rejects(
      execute("not-discovered", { investigationId: investigation.id, traceId: id }),
      /must come from/,
    );
    const search = await service.queryOverview(investigation.id, "traces");
    const response = await execute("read", { investigationId: investigation.id, traceId: id });
    const detail = JSON.parse(response.content[0]!.text) as {
      evidenceId: string;
      toolCallId: string;
      snapshotRef: string;
      result: { data: { trace: { spans: unknown[] } } };
    };
    assert.equal(detail.result.data.trace.spans.length, 3);
    assert.ok(detail.snapshotRef);
    const before = await repository.get(investigation.id);
    assert.equal(before.toolCalls.find((call) => call.id === detail.toolCallId)?.tool, "get_trace");
    assert.ok(before.observations?.some((item) => item.toolCallId === detail.toolCallId));
    assert.equal(before.expertTasks.length, 0);
    assert.equal(service.getBudgetProjection(before).primary.used, 0);
    const conclusion = await service.concludeAgentic(investigation.id, {
      status: "inconclusive",
      rootCauseEntities: [],
      summary: "Trace has bounded timing evidence but no proven abnormal mechanism",
      evidenceIds: [search.evidenceId, detail.evidenceId],
      selectedHypothesisIds: [],
      rejectedHypotheses: [],
      unresolvedHypotheses: [],
      confidence: 0.3,
      causalAssessment: {
        temporalFit: "uncertain",
        temporalEvidenceIds: [],
        transitionEvidenceIds: [],
        propagationFit: "uncertain",
        propagationEvidenceIds: [],
        materialUnobservedGap: true,
        gapBridgeEvidenceIds: [],
        unresolvedContradictions: [],
      },
    });
    await service.waitForVisualizationIdle(investigation.id);
    assert.equal(conclusion.investigation.status, "inconclusive");
    assert.equal(conclusion.investigation.expertTasks.length, 0);
    assert.match(conclusion.report, new RegExp(detail.evidenceId));
    await assert.rejects(
      execute("terminal", { investigationId: investigation.id, traceId: id }),
      /not running|running|terminal/i,
    );
  });
});

test("Uncommitted search does not authorize a Trace after snapshot storage failure", async () => {
  await withService(async (repository, registry, service) => {
    const investigation = await service.beginAgentic({ symptom: "latency", target, window });
    repository.saveEvidenceSnapshot = async () => {
      throw new Error("disk failure");
    };
    await assert.rejects(service.queryOverview(investigation.id, "traces"), /disk failure/);
    await assert.rejects(
      registry.executePrepared(
        investigation.id,
        registry.prepare("get_trace", { traceId: id }, investigation),
      ),
      /must come from/,
    );
  });
});

test("Expert baseline Evidence inherits actual query window and rejects mismatched or invented refs", async () => {
  await withService(async (_repository, _registry, service) => {
    const investigation = await service.beginAgentic({ symptom: "latency", target, window });
    const baseline = { from: "2026-10-03T23:40:00.000Z", to: "2026-10-03T23:50:00.000Z" };
    await service.updateHypotheses(investigation.id, [
      { op: "create", id: "H01", statement: "baseline error explains latency" },
    ]);
    Object.assign(service, {
      expertRunner: {
        run: async (context: PiExpertRunContext) => {
          const recorded = await context.invoke("search_logs", {
            mode: "all",
            window: { kind: "baseline", ...baseline },
          });
          const claim = {
            toolCallId: recorded.callId,
            modality: "log",
            summary: "baseline error",
            sourceItems: ["log:0"],
            supports: [],
            contradicts: [],
          };
          return {
            sessionId: "fixture",
            termination: { reason: "completed" },
            finding: {
              status: "succeeded",
              strength: "moderate",
              summary: "baseline finding",
              conclusions: [],
              evidenceClaims: [
                claim,
                { ...claim, modality: "trace" },
                { ...claim, sourceItems: ["log:99"] },
                { ...claim, sourceItems: [] },
              ],
              candidateEntities: [],
              suggestedFollowUps: [],
            },
          };
        },
      },
    });
    await service.dispatchAgentic(investigation.id, [
      {
        role: "log",
        question: "baseline",
        hypothesisIds: ["H01"],
        context: { alertSummary: "latency", mainWindow: window, knownFacts: [] },
        expected: ["evidence"],
      },
    ]);
    const result = await service.get(investigation.id);
    assert.equal(result.evidence.length, 1);
    assert.deepEqual(result.evidence[0]?.timeRange, baseline);
    assert.deepEqual(result.evidence[0]?.sourceItems, ["log:0"]);
  });
});

test("Main state pagination reaches older Evidence and final tool serialization stays bounded", async () => {
  await withService(async (repository, _registry, service) => {
    const investigation = await service.beginAgentic({ symptom: "latency", target, window });
    await service.queryOverview(investigation.id, "logs", { mode: "all" });
    const saved = await repository.get(investigation.id);
    saved.evidence = Array.from({ length: 60 }, (_, index) => ({
      ...saved.evidence[0]!,
      id: `E${index + 1}`,
    }));
    await repository.save(saved);
    const tools = createRcaMainAgentTools({
      rcaService: service,
      conversationId: "test",
      getModelRef: () => ({ provider: "test", id: "test" }),
      onProjection() {},
      onLinkInvestigation() {},
    });
    const tool = tools.find((item) => item.name === "get_investigation_state")!;
    const execute = tool.execute as unknown as (
      id: string,
      parameters: Record<string, unknown>,
    ) => Promise<{ content: Array<{ text: string }> }>;
    const first = await execute("page-1", { investigationId: saved.id, limit: 20 });
    const body = JSON.parse((first.content[0] as { text: string }).text);
    assert.equal(body.evidence[0].id, "E41");
    const second = await execute("page-2", {
      investigationId: saved.id,
      limit: 20,
      offset: body.page.evidence.nextOffset,
    });
    assert.equal(JSON.parse((second.content[0] as { text: string }).text).evidence[0].id, "E21");
    const result = {
      data: {
        logs: Array.from({ length: 85 }, () => ({
          message: "x".repeat(240),
          timestamp: window.from,
          service: "checkout",
          severity: "error",
        })),
      },
    };
    const bounded = compactToolResultForAgent("search_logs", result);
    assert.ok(
      Buffer.byteLength(JSON.stringify({ toolCallId: "C01", result: bounded })) <=
        LIVE_LIMITS.maxAgentToolBytes,
    );
  });
});
