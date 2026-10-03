import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Span, Tracer } from "@opentelemetry/api";
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import type { LifecycleOutcome, RuntimeMetricRecorder } from "./pi-runtime-metrics";
import { createPiTracingExtension, forceClosePiTracingLifecycles } from "./pi-tracing-extension";

type Handler = (event: unknown, context: TestContext) => unknown;
let globalSpanSequence = 0;

interface TestContext {
  model?: { provider?: string; id?: string };
}

class FakeSpan {
  readonly attributes = new Map<string, unknown>();
  readonly name: string;
  private readonly traceId: string;
  private readonly spanId: string;
  statusCode: number | undefined;
  endCount = 0;

  constructor(name: string, traceId: string, spanId: string) {
    this.name = name;
    this.traceId = traceId;
    this.spanId = spanId;
  }

  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, value);
    return this;
  }

  setAttributes(attributes: Record<string, unknown>) {
    for (const [name, value] of Object.entries(attributes)) this.attributes.set(name, value);
    return this;
  }

  setStatus(status: { code: number }) {
    this.statusCode = status.code;
    return this;
  }

  updateName() {
    return this;
  }

  addEvent() {
    return this;
  }

  addLink() {
    return this;
  }

  addLinks() {
    return this;
  }

  recordException() {}

  isRecording() {
    return true;
  }

  spanContext() {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      traceFlags: 1,
    };
  }

  end() {
    this.endCount += 1;
  }
}

interface MetricRecord {
  kind: "agent" | "turn" | "provider" | "headers" | "tool";
  outcome: LifecycleOutcome | "success" | "error";
  durationSeconds: number;
  provider?: string;
  model?: string;
  toolName?: string;
  span: Span;
}

function createHarness(conversationId = "conversation-test", tracerOverride?: Tracer) {
  const handlers = new Map<string, Handler[]>();
  const spans: FakeSpan[] = [];
  const metrics: MetricRecord[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown>; span?: Span }> = [];
  let clockNs = 0n;
  let dispose = () => {};

  const tracer = {
    startSpan(name: string) {
      globalSpanSequence += 1;
      const span = new FakeSpan(
        name,
        globalSpanSequence.toString(16).padStart(32, "0"),
        globalSpanSequence.toString(16).padStart(16, "0"),
      );
      spans.push(span);
      return span as unknown as Span;
    },
  } as unknown as Tracer;

  const recorder: RuntimeMetricRecorder = {
    recordAgentCompletion(input) {
      metrics.push({
        kind: "agent",
        outcome: input.outcome,
        durationSeconds: input.durationSeconds,
        span: input.span,
      });
    },
    recordTurnCompletion(input) {
      metrics.push({
        kind: "turn",
        outcome: input.outcome,
        durationSeconds: input.durationSeconds,
        provider: input.provider,
        model: input.model,
        span: input.span,
      });
    },
    recordProviderGenerationCompletion(input) {
      metrics.push({
        kind: "provider",
        outcome: input.outcome,
        durationSeconds: input.durationSeconds,
        provider: input.provider,
        model: input.model,
        span: input.span,
      });
    },
    recordProviderResponseHeader(input) {
      metrics.push({
        kind: "headers",
        outcome: input.outcome,
        durationSeconds: input.durationSeconds,
        provider: input.provider,
        model: input.model,
        span: input.span,
      });
    },
    recordToolCompletion(input) {
      metrics.push({
        kind: "tool",
        outcome: input.outcome,
        durationSeconds: input.durationSeconds,
        toolName: input.toolName,
        span: input.span,
      });
    },
  };

  const pi = {
    on(event: string, handler: Handler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
      return () => undefined;
    },
  } as unknown as Parameters<ExtensionFactory>[0];

  const extension = createPiTracingExtension({
    conversationId,
    registerDispose: (cleanup) => {
      dispose = cleanup;
    },
    dependencies: {
      tracer: tracerOverride ?? tracer,
      metrics: recorder,
      nowNs: () => clockNs,
      log(event, fields, span) {
        logs.push({ event, fields, span });
      },
    },
  });

  const context: TestContext = {
    model: { provider: "provider-a", id: "model-a" },
  };

  return {
    dispose: () => dispose(),
    handlers,
    spans,
    metrics,
    logs,
    async bind() {
      await extension(pi);
    },
    advance(milliseconds: number) {
      clockNs += BigInt(milliseconds) * 1_000_000n;
    },
    emit(event: string, payload: unknown = {}, overrideContext: TestContext = context) {
      return (handlers.get(event) ?? []).map((handler) => handler(payload, overrideContext));
    },
  };
}

function assistant(stopReason: "stop" | "error" | "aborted" = "stop", errorMessage?: string) {
  return {
    role: "assistant",
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

test("Pi tracing extension registers the real 0.86.1 lifecycle hooks", async () => {
  const harness = createHarness();
  await harness.bind();

  assert.deepEqual(
    [...harness.handlers.keys()],
    [
      "cache_warming_decision",
      "agent_start",
      "turn_start",
      "before_provider_headers",
      "after_provider_response",
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "turn_end",
      "agent_settled",
      "session_shutdown",
    ],
  );
});

test("normal completion records headers, full generation, tool, turn and agent exactly once", async () => {
  const h = createHarness();
  await h.bind();

  h.emit("agent_start");
  h.emit("turn_start", { turnIndex: 0 });
  h.emit("before_provider_headers");
  h.advance(100);
  h.emit("after_provider_response", { status: 200 });
  h.advance(900);
  h.emit("message_end", { message: assistant() });
  h.advance(50);
  h.emit("tool_execution_start", {
    toolCallId: "tool-1",
    toolName: "read",
  });
  h.advance(200);
  h.emit("tool_execution_end", {
    toolCallId: "tool-1",
    toolName: "read",
    isError: false,
    result: { content: "ok" },
  });
  h.advance(50);
  h.emit("turn_end", { turnIndex: 0, message: assistant() });
  h.advance(50);
  h.emit("agent_settled");

  assert.equal(h.metrics.filter((record) => record.kind === "headers").length, 1);
  assert.equal(h.metrics.filter((record) => record.kind === "provider").length, 1);
  assert.equal(h.metrics.filter((record) => record.kind === "tool").length, 1);
  assert.equal(h.metrics.filter((record) => record.kind === "turn").length, 1);
  assert.equal(h.metrics.filter((record) => record.kind === "agent").length, 1);
  assert.equal(h.metrics.find((record) => record.kind === "headers")?.durationSeconds, 0.1);
  assert.equal(h.metrics.find((record) => record.kind === "provider")?.durationSeconds, 1);
  assert.ok((h.metrics.find((record) => record.kind === "turn")?.durationSeconds ?? 0) > 1);
  assert.ok(h.spans.every((span) => span.endCount === 1));
});

test("slow headers and slow streaming remain separate measurements", async () => {
  const h = createHarness();
  await h.bind();

  h.emit("agent_start");
  h.emit("turn_start", { turnIndex: 0 });
  h.emit("before_provider_headers");
  h.advance(2_000);
  h.emit("after_provider_response", { status: 200 });
  h.advance(5_000);
  h.emit("message_end", { message: assistant() });
  h.emit("turn_end", { turnIndex: 0, message: assistant() });
  h.emit("agent_settled");

  assert.equal(h.metrics.find((record) => record.kind === "headers")?.durationSeconds, 2);
  assert.equal(h.metrics.find((record) => record.kind === "provider")?.durationSeconds, 7);
});

test("stream error wins over successful HTTP headers", async () => {
  const h = createHarness();
  await h.bind();

  h.emit("agent_start");
  h.emit("turn_start", { turnIndex: 0 });
  h.emit("before_provider_headers");
  h.advance(20);
  h.emit("after_provider_response", { status: 200 });
  h.advance(30);
  h.emit("message_end", { message: assistant("error", "stream failed") });
  h.emit("turn_end", { turnIndex: 0, message: assistant("error", "stream failed") });
  h.emit("agent_settled");

  assert.equal(h.metrics.find((record) => record.kind === "headers")?.outcome, "success");
  assert.equal(h.metrics.find((record) => record.kind === "provider")?.outcome, "error");
  assert.equal(h.metrics.find((record) => record.kind === "turn")?.outcome, "error");
  assert.equal(h.metrics.find((record) => record.kind === "agent")?.outcome, "error");
});

test("agent-level retry keeps one parent run and preserves failed generation", async () => {
  const h = createHarness();
  await h.bind();

  h.emit("agent_start");
  h.emit("turn_start", { turnIndex: 0 });
  h.emit("before_provider_headers");
  h.advance(10);
  h.emit("after_provider_response", { status: 500 });
  h.emit("message_end", { message: assistant("error", "retryable") });
  h.emit("turn_end", { turnIndex: 0, message: assistant("error", "retryable") });

  h.emit("agent_start");
  h.emit("turn_start", { turnIndex: 0 });
  h.emit("before_provider_headers");
  h.advance(10);
  h.emit("after_provider_response", { status: 200 });
  h.emit("message_end", { message: assistant() });
  h.emit("turn_end", { turnIndex: 0, message: assistant() });
  h.emit("agent_settled");

  const providers = h.metrics.filter((record) => record.kind === "provider");
  assert.deepEqual(
    providers.map((record) => record.outcome),
    ["error", "success"],
  );
  const agents = h.metrics.filter((record) => record.kind === "agent");
  assert.equal(agents.length, 1);
  assert.equal(agents[0]?.outcome, "success");
  const agentSpan = h.spans.find((span) => span.name === "pi.agent.run");
  assert.equal(agentSpan?.attributes.get("pi.had_child_error"), true);
  assert.equal(agentSpan?.attributes.get("pi.agent.low_level_runs"), 2);
});

test("cancel propagates cancelled without treating it as backend error", async () => {
  const h = createHarness();
  await h.bind();

  h.emit("agent_start");
  h.emit("turn_start", { turnIndex: 0 });
  h.emit("before_provider_headers");
  h.advance(100);
  h.emit("after_provider_response", { status: 200 });
  h.advance(100);
  h.emit("message_end", { message: assistant("aborted") });
  h.emit("turn_end", { turnIndex: 0, message: assistant("aborted") });
  h.emit("agent_settled");

  assert.equal(h.metrics.find((record) => record.kind === "provider")?.outcome, "cancelled");
  assert.equal(h.metrics.find((record) => record.kind === "turn")?.outcome, "cancelled");
  assert.equal(h.metrics.find((record) => record.kind === "agent")?.outcome, "cancelled");
});

test("tool error and timeout are completed once with stable start identity", async () => {
  const h = createHarness();
  await h.bind();

  h.emit("agent_start");
  h.emit("turn_start", { turnIndex: 0 });
  h.emit("tool_execution_start", { toolCallId: "a", toolName: "shell" });
  h.advance(20);
  h.emit("tool_execution_end", {
    toolCallId: "a",
    toolName: "renamed-late",
    isError: true,
    result: { error: "timed out" },
  });
  h.emit("tool_execution_start", { toolCallId: "b", toolName: "read" });
  h.advance(20);
  h.emit("tool_execution_end", {
    toolCallId: "b",
    toolName: "read",
    isError: true,
    result: { error: "failed" },
  });

  const tools = h.metrics.filter((record) => record.kind === "tool");
  assert.equal(tools.length, 2);
  assert.equal(tools[0]?.toolName, "shell");
  assert.deepEqual(
    tools.map((record) => record.outcome),
    ["error", "error"],
  );
  assert.ok(
    h.logs.some(
      (entry) => entry.event === "pi.tool.call.completed" && entry.fields.reason === "tool_timeout",
    ),
  );
});

test("duplicate tool start, dangling close and late end cannot close a replacement span", async () => {
  const h = createHarness();
  await h.bind();

  h.emit("agent_start");
  h.emit("turn_start", { turnIndex: 0 });
  h.emit("tool_execution_start", { toolCallId: "same", toolName: "read" });
  h.emit("tool_execution_start", { toolCallId: "same", toolName: "write" });
  h.emit("turn_end", { turnIndex: 0, message: assistant() });

  assert.equal(h.metrics.filter((record) => record.kind === "tool").length, 1);
  assert.equal(h.metrics.find((record) => record.kind === "tool")?.outcome, "incomplete");
  assert.equal(h.metrics.find((record) => record.kind === "turn")?.outcome, "incomplete");
  h.emit("agent_settled");
  assert.equal(h.metrics.find((record) => record.kind === "agent")?.outcome, "incomplete");

  h.emit("tool_execution_end", {
    toolCallId: "same",
    toolName: "read",
    isError: false,
    result: {},
  });
  h.emit("tool_execution_start", { toolCallId: "same", toolName: "write" });

  assert.equal(h.metrics.filter((record) => record.kind === "tool").length, 1);
});

test("ambiguous duplicate provider start never guesses callback ownership", async () => {
  const h = createHarness();
  await h.bind();
  h.emit("agent_start");
  h.emit("turn_start", { turnIndex: 0 });
  h.emit("before_provider_headers");
  h.emit("before_provider_headers");
  h.emit("after_provider_response", { status: 200 });
  h.emit("message_end", { message: assistant() });
  h.emit("turn_end", { turnIndex: 0, message: assistant() });
  h.emit("agent_settled");
  assert.deepEqual(
    h.metrics.map((record) => [record.kind, record.outcome]),
    [
      ["provider", "incomplete"],
      ["turn", "incomplete"],
      ["agent", "incomplete"],
    ],
  );
  h.dispose();
});

test("provider generation without response headers does not poison the next header callback", async () => {
  const h = createHarness();
  await h.bind();

  h.emit("agent_start");
  h.emit("turn_start", { turnIndex: 0 });
  h.emit("before_provider_headers");
  h.advance(10);
  h.emit("message_end", { message: assistant("error", "connection failed before response") });
  h.emit("turn_end", {
    turnIndex: 0,
    message: assistant("error", "connection failed before response"),
  });

  h.emit("agent_start");
  h.emit("turn_start", { turnIndex: 0 });
  h.emit("before_provider_headers");
  h.advance(20);
  h.emit("after_provider_response", { status: 200 });
  h.advance(30);
  h.emit("message_end", { message: assistant() });

  assert.equal(h.metrics.filter((record) => record.kind === "headers").length, 1);
  assert.equal(h.metrics.find((record) => record.kind === "headers")?.outcome, "success");
  assert.deepEqual(
    h.metrics.filter((record) => record.kind === "provider").map((record) => record.outcome),
    ["error", "success"],
  );
});

test("session shutdown force-closes dangling lifecycles exactly once", async () => {
  const h = createHarness();
  await h.bind();

  h.emit("agent_start");
  h.emit("turn_start", { turnIndex: 0 });
  h.emit("before_provider_headers");
  h.emit("tool_execution_start", { toolCallId: "tool-1", toolName: "read" });
  h.advance(100);
  h.emit("session_shutdown");
  h.emit("session_shutdown");

  assert.equal(h.metrics.filter((record) => record.kind === "provider").length, 1);
  assert.equal(h.metrics.filter((record) => record.kind === "tool").length, 1);
  assert.equal(h.metrics.filter((record) => record.kind === "turn").length, 1);
  assert.equal(h.metrics.filter((record) => record.kind === "agent").length, 1);
  assert.ok(
    h.metrics
      .filter((record) => record.kind !== "headers")
      .every((record) => record.outcome === "incomplete"),
  );
  assert.ok(h.spans.every((span) => span.endCount === 1));
});

test("independent extension instances keep concurrent conversation spans isolated", async () => {
  const left = createHarness("left");
  const right = createHarness("right");
  await Promise.all([left.bind(), right.bind()]);

  left.emit("agent_start");
  right.emit("agent_start");
  left.emit("turn_start", { turnIndex: 0 });
  right.emit("turn_start", { turnIndex: 0 });
  left.emit("before_provider_headers");
  right.emit("before_provider_headers");
  left.advance(10);
  right.advance(20);
  left.emit("message_end", { message: assistant() });
  right.emit("message_end", { message: assistant() });

  const leftProvider = left.metrics.find((record) => record.kind === "provider");
  const rightProvider = right.metrics.find((record) => record.kind === "provider");
  assert.ok(leftProvider);
  assert.ok(rightProvider);
  assert.notEqual(
    leftProvider.span.spanContext().traceId,
    rightProvider.span.spanContext().traceId,
  );
});

test("cache refresh is vetoed before it can invoke provider headers", async () => {
  const h = createHarness();
  await h.bind();
  assert.deepEqual(h.emit("cache_warming_decision", { action: "refresh" }), [{ action: "stop" }]);
  h.emit("before_provider_headers"); // No model turn: do not invent a generation.
  assert.equal(h.spans.length, 0);
  h.dispose();
});

test("missing provider completion cannot poison the following turn", async () => {
  const h = createHarness();
  await h.bind();
  h.emit("agent_start");
  h.emit("turn_start", { turnIndex: 0 });
  h.emit("before_provider_headers");
  h.emit("turn_end", { turnIndex: 0, message: assistant() });
  h.emit("turn_start", { turnIndex: 1 });
  h.emit("before_provider_headers");
  h.emit("after_provider_response", { status: 200 });
  h.emit("message_end", { message: assistant() });
  h.emit("turn_end", { turnIndex: 1, message: assistant() });
  h.emit("agent_settled");
  assert.deepEqual(
    h.metrics.filter((m) => m.kind === "provider").map((m) => m.outcome),
    ["incomplete", "success"],
  );
  assert.equal(h.metrics.find((m) => m.kind === "agent")?.outcome, "incomplete");
  h.dispose();
});

test("host disposal is idempotent and ignores later callbacks", async () => {
  const h = createHarness();
  await h.bind();
  h.emit("agent_start");
  h.emit("turn_start", { turnIndex: 0 });
  h.emit("before_provider_headers");
  h.dispose();
  const count = h.metrics.length;
  h.dispose();
  h.emit("agent_start");
  h.emit("before_provider_headers");
  h.emit("message_end", { message: assistant() });
  forceClosePiTracingLifecycles();
  assert.equal(h.metrics.length, count);
  assert.ok(h.spans.every((span) => span.endCount === 1));
});

test("failed completion logging or recording cannot leave spans open", async () => {
  const h = createHarness();
  await h.bind();
  h.emit("agent_start");
  h.emit("turn_start", { turnIndex: 0 });
  h.emit("before_provider_headers");
  h.logs.push = () => {
    throw new Error("logger failure");
  };
  h.metrics.push = () => {
    throw new Error("recorder failure");
  };
  h.emit("message_end", { message: assistant() });
  h.emit("turn_end", { turnIndex: 0, message: assistant() });
  h.emit("agent_settled");
  h.dispose();
  assert.ok(h.spans.every((span) => span.endCount === 1));
});

test("real tracer preserves parentage and context across parallel conversations", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    sampler: new AlwaysOnSampler(),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const left = createHarness("real-left", provider.getTracer("test"));
  const right = createHarness("real-right", provider.getTracer("test"));
  try {
    await Promise.all([left.bind(), right.bind()]);
    for (const h of [left, right]) {
      h.emit("agent_start");
      h.emit("turn_start", { turnIndex: 0 });
    }
    for (const h of [right, left]) {
      h.emit("before_provider_headers");
      h.emit("message_end", { message: assistant() });
      h.emit("tool_execution_start", { toolCallId: "tool", toolName: "read" });
      h.emit("tool_execution_end", { toolCallId: "tool", isError: false, result: {} });
      h.emit("turn_end", { turnIndex: 0, message: assistant() });
      h.emit("agent_settled");
    }
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    const roots = spans.filter((span) => span.name === "pi.agent.run");
    assert.equal(roots.length, 2);
    assert.notEqual(roots[0].spanContext().traceId, roots[1].spanContext().traceId);
    for (const root of roots) {
      const related = spans.filter(
        (span) => span.spanContext().traceId === root.spanContext().traceId,
      );
      assert.equal(related.length, 4);
      const turn = related.find((span) => span.name === "pi.model.turn")!;
      assert.equal(turn.parentSpanContext?.spanId, root.spanContext().spanId);
      for (const span of related.filter(
        (span) => span.name === "pi.provider.generation" || span.name === "pi.tool.call",
      )) {
        assert.equal(span.parentSpanContext?.spanId, turn.spanContext().spanId);
      }
    }
    for (const h of [left, right]) {
      const traceIds = new Set(h.metrics.map((m) => m.span.spanContext().traceId));
      assert.equal(traceIds.size, 1);
    }
  } finally {
    left.dispose();
    right.dispose();
    await provider.shutdown();
  }
});
