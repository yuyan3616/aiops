import assert from "node:assert/strict";
import test from "node:test";

import { trace, type Attributes, type Context, type Meter, type Span } from "@opentelemetry/api";

import {
  createPiRuntimeMetricViews,
  HISTOGRAM_BOUNDARIES_SECONDS,
  PiRuntimeMetrics,
  RUNTIME_METRIC_INSTRUMENTS,
} from "./pi-runtime-metrics";

interface RecordedPoint {
  instrument: string;
  value: number;
  attributes?: Attributes;
  context?: Context;
}

function createMeterHarness() {
  const points: RecordedPoint[] = [];
  const instruments: Array<{
    kind: "counter" | "histogram";
    name: string;
    unit?: string;
  }> = [];

  const meter = {
    createCounter(name: string, options?: { unit?: string }) {
      instruments.push({ kind: "counter", name, unit: options?.unit });
      return {
        add(value: number, attributes?: Attributes, context?: Context) {
          points.push({ instrument: name, value, attributes, context });
        },
      };
    },
    createHistogram(name: string, options?: { unit?: string }) {
      instruments.push({ kind: "histogram", name, unit: options?.unit });
      return {
        record(value: number, attributes?: Attributes, context?: Context) {
          points.push({ instrument: name, value, attributes, context });
        },
      };
    },
  } as unknown as Meter;

  return { meter, points, instruments };
}

function fakeSpan(): Span {
  return {
    spanContext() {
      return {
        traceId: "1".repeat(32),
        spanId: "2".repeat(16),
        traceFlags: 1,
      };
    },
  } as unknown as Span;
}

test("runtime metric instruments are centralized with seconds units", () => {
  const h = createMeterHarness();
  new PiRuntimeMetrics(h.meter, {});

  assert.deepEqual(
    h.instruments.map((instrument) => instrument.name),
    Object.values(RUNTIME_METRIC_INSTRUMENTS),
  );
  assert.ok(
    h.instruments
      .filter((instrument) => instrument.kind === "histogram")
      .every((instrument) => instrument.unit === "s"),
  );
  assert.ok(
    h.instruments
      .filter((instrument) => instrument.kind === "counter")
      .every((instrument) => instrument.unit === "1"),
  );
});

test("histogram views use explicit second-scale boundaries", () => {
  const views = createPiRuntimeMetricViews();
  const byName = new Map(views.map((view) => [view.instrumentName, view]));

  const providerView = byName.get(RUNTIME_METRIC_INSTRUMENTS.providerGenerationDuration);
  const toolView = byName.get(RUNTIME_METRIC_INSTRUMENTS.toolCallDuration);
  const turnView = byName.get(RUNTIME_METRIC_INSTRUMENTS.modelTurnDuration);

  assert.deepEqual(
    providerView?.aggregation &&
      "options" in providerView.aggregation
      ? providerView.aggregation.options?.boundaries
      : undefined,
    [...HISTOGRAM_BOUNDARIES_SECONDS.provider],
  );
  assert.deepEqual(
    toolView?.aggregation && "options" in toolView.aggregation
      ? toolView.aggregation.options?.boundaries
      : undefined,
    [...HISTOGRAM_BOUNDARIES_SECONDS.tool],
  );
  assert.deepEqual(
    turnView?.aggregation && "options" in turnView.aggregation
      ? turnView.aggregation.options?.boundaries
      : undefined,
    [...HISTOGRAM_BOUNDARIES_SECONDS.agentTurn],
  );
});

test("metric labels use bounded allowlists and unknown values collapse to other", () => {
  const h = createMeterHarness();
  const metrics = new PiRuntimeMetrics(h.meter, {
    OTEL_METRIC_PROVIDER_ALLOWLIST: "provider-a",
    OTEL_METRIC_MODEL_ALLOWLIST: "model-a",
    OTEL_METRIC_TOOL_ALLOWLIST: "read",
  });
  const span = fakeSpan();

  metrics.recordTurnCompletion({
    span,
    durationSeconds: 2,
    provider: "dynamic-provider",
    model: "dynamic-model",
    outcome: "success",
  });
  metrics.recordToolCompletion({
    span,
    durationSeconds: 1,
    toolName: "dynamic-tool",
    outcome: "error",
  });

  const turnCounter = h.points.find(
    (point) => point.instrument === RUNTIME_METRIC_INSTRUMENTS.modelTurns,
  );
  const toolCounter = h.points.find(
    (point) => point.instrument === RUNTIME_METRIC_INSTRUMENTS.toolCalls,
  );
  assert.deepEqual(turnCounter?.attributes, {
    provider: "other",
    model: "other",
    status: "success",
  });
  assert.deepEqual(toolCounter?.attributes, {
    tool_name: "other",
    status: "error",
  });
});

test("metric add and record receive the lifecycle span context explicitly", () => {
  const h = createMeterHarness();
  const metrics = new PiRuntimeMetrics(h.meter, {
    OTEL_METRIC_PROVIDER_ALLOWLIST: "provider-a",
    OTEL_METRIC_MODEL_ALLOWLIST: "model-a",
  });
  const span = fakeSpan();

  metrics.recordProviderGenerationCompletion({
    span,
    durationSeconds: 3,
    provider: "provider-a",
    model: "model-a",
    outcome: "success",
  });

  const providerPoints = h.points.filter((point) =>
    [
      RUNTIME_METRIC_INSTRUMENTS.providerGenerations,
      RUNTIME_METRIC_INSTRUMENTS.providerGenerationDuration,
    ].includes(point.instrument),
  );
  assert.equal(providerPoints.length, 2);
  for (const point of providerPoints) {
    assert.ok(point.context);
    assert.equal(trace.getSpan(point.context!), span);
  }
});

test("one completion records one counter sample and one histogram sample", () => {
  const h = createMeterHarness();
  const metrics = new PiRuntimeMetrics(h.meter, {
    OTEL_METRIC_TOOL_ALLOWLIST: "read",
  });
  const span = fakeSpan();

  metrics.recordToolCompletion({
    span,
    durationSeconds: 0.25,
    toolName: "read",
    outcome: "success",
  });

  assert.equal(
    h.points.filter((point) => point.instrument === RUNTIME_METRIC_INSTRUMENTS.toolCalls)
      .length,
    1,
  );
  assert.equal(
    h.points.filter(
      (point) => point.instrument === RUNTIME_METRIC_INSTRUMENTS.toolCallDuration,
    ).length,
    1,
  );
});
