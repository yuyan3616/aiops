import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import {
  ROOT_CONTEXT,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AggregationType,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";

test("locked OTel metrics path does not export exemplars in real OTLP HTTP payload", async () => {
  const payloads: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      payloads.push(Buffer.concat(chunks).toString("utf8"));
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const exporter = new OTLPMetricExporter({
    url: `http://127.0.0.1:${address.port}/v1/metrics`,
  });
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000,
    exportTimeoutMillis: 5_000,
  });
  const provider = new MeterProvider({
    resource: resourceFromAttributes({
      "service.name": "otel-exemplar-probe",
    }),
    readers: [reader],
    views: [
      {
        instrumentName: "probe_duration",
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: {
            boundaries: [0.5, 1, 5],
            recordMinMax: true,
          },
        },
      },
    ],
  });

  try {
    const histogram = provider
      .getMeter("otel-exemplar-probe")
      .createHistogram("probe_duration", { unit: "s" });

    const traceId = "1234567890abcdef1234567890abcdef";
    const spanId = "1234567890abcdef";
    const spanContext = trace.setSpanContext(ROOT_CONTEXT, {
      traceId,
      spanId,
      traceFlags: TraceFlags.SAMPLED,
    });

    histogram.record(2.5, { status: "success" }, spanContext);
    await provider.forceFlush();

    assert.ok(payloads.length >= 1);
    const payload = payloads.join("\n");
    assert.match(payload, /probe_duration/);
    assert.doesNotMatch(payload, /"exemplars"\s*:/);
    assert.ok(!payload.includes(traceId));
    assert.ok(!payload.includes(spanId));
  } finally {
    await provider.shutdown();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});
