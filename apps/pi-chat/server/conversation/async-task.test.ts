import assert from "node:assert/strict";
import test from "node:test";

import { normalizePromptError, runDetached } from "./async-task";

const flushDetachedTask = () => new Promise<void>((resolve) => setImmediate(resolve));

test("runDetached captures synchronous throws", async () => {
  let captured: unknown;
  runDetached(
    () => {
      throw new Error("sync failure");
    },
    (cause) => {
      captured = cause;
    },
  );

  await flushDetachedTask();
  assert.equal(captured instanceof Error ? captured.message : "", "sync failure");
});

test("runDetached captures rejected promises", async () => {
  let captured: unknown;
  runDetached(
    async () => {
      throw new Error("async failure");
    },
    (cause) => {
      captured = cause;
    },
  );

  await flushDetachedTask();
  assert.equal(captured instanceof Error ? captured.message : "", "async failure");
});

test("normalizePromptError turns missing API key failures into a user-facing message", () => {
  assert.equal(
    normalizePromptError(new Error("No API key found for the selected model.")),
    "当前未配置可用的 LLM/API Key，请先配置模型提供商凭据后再使用普通聊天。",
  );
  assert.equal(
    normalizePromptError(new Error("API key has been disabled")),
    "模型服务认证失败，当前 API Key 可能已失效或被禁用，请检查模型配置后重新发送。",
  );
  assert.equal(
    normalizePromptError(new Error("401 Unauthorized: authentication failed")),
    "模型服务认证失败，当前 API Key 可能已失效或被禁用，请检查模型配置后重新发送。",
  );
  assert.equal(normalizePromptError(new Error("provider timeout")), "provider timeout");
});
