import assert from "node:assert/strict";
import test from "node:test";

import {
  fallbackConversationTitle,
  sanitizeGeneratedTitle,
} from "./title-generator";

test("fallbackConversationTitle produces a compact RCA title with case id", () => {
  assert.equal(
    fallbackConversationTitle("帮我分析一下 t039 的根因，checkout 最近延迟突然升高"),
    "t039 根因排查",
  );
  assert.equal(
    fallbackConversationTitle("Please investigate the root cause of t039 latency"),
    "t039 RCA investigation",
  );
});

test("fallbackConversationTitle never returns the full long prompt", () => {
  const prompt =
    "请你帮我仔细分析这个很长很长的问题，我这里还有很多补充信息，需要逐步检查日志、指标、链路和各种上下文，最后给出一个结论";
  const title = fallbackConversationTitle(prompt);
  assert.ok(title.length <= 18);
  assert.notEqual(title, prompt);
});

test("sanitizeGeneratedTitle cleans valid titles and rejects unsafe or oversized output", () => {
  assert.equal(sanitizeGeneratedTitle('  "t039 Shipping 延迟排查。"  '), "t039 Shipping 延迟排查");
  assert.equal(sanitizeGeneratedTitle("https://example.com/sensitive"), undefined);
  assert.equal(sanitizeGeneratedTitle("用户想要分析 t039"), undefined);
  assert.equal(sanitizeGeneratedTitle("x".repeat(41)), undefined);
});
