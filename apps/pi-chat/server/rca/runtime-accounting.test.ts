import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantMessage } from "@earendil-works/pi-ai";

import { AgentUsageAccumulator, safeRuntimeDetail } from "./runtime-accounting";

function assistant(
  usage: Partial<AssistantMessage["usage"]>,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "test",
    provider: "test",
    model: "test",
    timestamp: 0,
    stopReason,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      ...usage,
    },
  };
}

test("accounts tool turns and repair responses once, preserving cache and last valid context", () => {
  const tally = new AgentUsageAccumulator();
  tally.record(
    assistant(
      {
        input: 100,
        output: 20,
        cacheRead: 40,
        cacheWrite: 5,
        totalTokens: 165,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
      },
      "toolUse",
    ),
  );
  tally.record(assistant({ input: 80, output: 10, cacheRead: 70, totalTokens: 160 }, "stop"));
  tally.record(assistant({ input: 50, output: 5, cacheRead: 60, totalTokens: 115 }, "stop")); // repair
  assert.deepEqual(tally.snapshot(), {
    turns: 3,
    inputTokens: 230,
    outputTokens: 35,
    cacheReadTokens: 170,
    cacheWriteTokens: 5,
    totalTokens: 440,
    contextTokens: 115,
    cost: 0.01,
  });
});

test("counts reported usage on errors without replacing the last valid context", () => {
  const tally = new AgentUsageAccumulator();
  tally.record(assistant({ input: 10, output: 1, totalTokens: 11 }));
  tally.record(assistant({ input: 2, output: 1, cacheRead: 20, totalTokens: 0 }, "error"));
  assert.equal(tally.snapshot().totalTokens, 34);
  assert.equal(tally.snapshot().contextTokens, 11);
  assert.equal(tally.snapshot().cost, undefined);
  assert.equal(tally.snapshot().turns, 2);
});

test("removes credentials from persisted error detail", () => {
  const detail = safeRuntimeDetail(
    new Error(
      'Authorization: Bearer secret-token api_key=hidden123 https://x.test/?access_token=other sk-1234567890abcdef {"password":"json-secret"}',
    ),
  );
  assert.equal(/secret-token|hidden123|other|sk-1234567890abcdef|json-secret/.test(detail), false);
});
