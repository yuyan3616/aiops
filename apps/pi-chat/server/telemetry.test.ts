import assert from "node:assert/strict";
import test from "node:test";

import { resolveTraceEndpoint } from "./telemetry";

test("resolveTraceEndpoint prefers the trace-specific endpoint", () => {
  assert.equal(
    resolveTraceEndpoint({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://trace-backend:4318/custom",
    } as NodeJS.ProcessEnv),
    "http://trace-backend:4318/custom",
  );
});

test("resolveTraceEndpoint appends the OTLP HTTP traces path", () => {
  assert.equal(
    resolveTraceEndpoint({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/",
    } as NodeJS.ProcessEnv),
    "http://collector:4318/v1/traces",
  );
});

test("resolveTraceEndpoint leaves an explicit traces path unchanged", () => {
  assert.equal(
    resolveTraceEndpoint({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/v1/traces",
    } as NodeJS.ProcessEnv),
    "http://collector:4318/v1/traces",
  );
});

test("resolveTraceEndpoint disables tracing when no endpoint is configured", () => {
  assert.equal(resolveTraceEndpoint({} as NodeJS.ProcessEnv), undefined);
});
