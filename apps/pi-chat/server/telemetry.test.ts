import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveMetricsEndpoint,
  resolveServiceInstanceId,
  resolveTraceEndpoint,
} from "./telemetry";

test("signal-specific endpoints override the shared OTLP endpoint", () => {
  const env = {
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://trace-backend:4318/custom",
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://metrics-backend:4318/custom",
  } as NodeJS.ProcessEnv;

  assert.equal(resolveTraceEndpoint(env), "http://trace-backend:4318/custom");
  assert.equal(resolveMetricsEndpoint(env), "http://metrics-backend:4318/custom");
});

test("shared OTLP endpoint expands to independent HTTP signal paths", () => {
  const env = {
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/",
  } as NodeJS.ProcessEnv;

  assert.equal(resolveTraceEndpoint(env), "http://collector:4318/v1/traces");
  assert.equal(resolveMetricsEndpoint(env), "http://collector:4318/v1/metrics");
});

test("explicit signal suffix on the shared endpoint is not duplicated", () => {
  assert.equal(
    resolveTraceEndpoint({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/v1/traces",
    } as NodeJS.ProcessEnv),
    "http://collector:4318/v1/traces",
  );
  assert.equal(
    resolveMetricsEndpoint({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/v1/metrics",
    } as NodeJS.ProcessEnv),
    "http://collector:4318/v1/metrics",
  );
});

test("signals remain disabled independently when no endpoint is configured", () => {
  assert.equal(resolveTraceEndpoint({} as NodeJS.ProcessEnv), undefined);
  assert.equal(resolveMetricsEndpoint({} as NodeJS.ProcessEnv), undefined);
});

test("resolveServiceInstanceId prefers explicit OTel identity and falls back to hostname", () => {
  assert.equal(
    resolveServiceInstanceId({
      OTEL_SERVICE_INSTANCE_ID: "replica-a",
      HOSTNAME: "container-b",
    } as NodeJS.ProcessEnv),
    "replica-a",
  );
  assert.equal(
    resolveServiceInstanceId({ HOSTNAME: "container-b" } as NodeJS.ProcessEnv),
    "container-b",
  );
  assert.equal(resolveServiceInstanceId({} as NodeJS.ProcessEnv), undefined);
});
