import assert from "node:assert/strict";
import test from "node:test";

import { MetricsExpert, type ExpertContext, type RecordedToolExecution } from "./experts";
import type { Investigation, RcaTask } from "./types";

test("metrics expert can inspect the alerted service without a trace candidate", async () => {
  const task = {
    caseId: "t999",
    version: "test",
    availableModalities: ["metric"],
    alert: {
      eventId: "evt",
      title: "checkout latency",
      triggerTime: "2026-01-01T00:10:00.000Z",
      service: "checkout",
      operation: "PlaceOrder",
      window: {
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-01T00:10:00.000Z",
      },
      entity: {
        id: "checkout::PlaceOrder",
        name: "checkout::PlaceOrder",
        type: "operation",
        domain: "apm",
      },
    },
  } as RcaTask;

  let calls = 0;
  const context: ExpertContext = {
    investigation: {} as Investigation,
    task,
    hypothesisIds: {
      local: "H01",
      downstream: "H02",
      infrastructure: "H03",
    },
    invoke: async (tool, arguments_) => {
      calls++;
      if (tool === "get_metric_catalog") {
        return {
          callId: `C${calls}`,
          execution: {
            tool,
            result: { metrics: ["latency"] },
            summary: "catalog",
            rawRef: "rca100://t999/metrics/catalog",
          },
        } as RecordedToolExecution;
      }
      return {
        callId: `C${calls}`,
        execution: {
          tool,
          result: {
            caseId: "t999",
            query: arguments_,
            matchedRows: 10,
            returnedRows: 1,
            truncated: false,
            rawRef: "rca100://t999/metrics/query",
            data: {
              anomalies: [
                {
                  entity: "checkout",
                  metric: "latency",
                  direction: "increase",
                  ratio: 4,
                  baselineMedian: 100,
                  incidentMedian: 400,
                  rawRef: "rca100://t999/metrics/latency",
                },
              ],
              peerOutliers: [],
            },
          },
          summary: "metrics",
          rawRef: "rca100://t999/metrics/query",
        },
      } as RecordedToolExecution;
    },
  };

  const finding = await new MetricsExpert().investigate(context);
  assert.ok(finding.evidence.length >= 1);
  assert.ok(finding.evidence.some((item) => item.supports.includes("H01")));
  assert.equal(finding.evidence.some((item) => item.contradicts.includes("H01")), false);
});
