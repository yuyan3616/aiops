import assert from "node:assert/strict";
import test from "node:test";

import type { ConversationSnapshot, StreamEvent } from "@shared/types";

import { browserPanelReducer, createBrowserPanelState } from "./state";

test("runtime.error keeps the user-facing error message in browser state", () => {
  const initial = createBrowserPanelState("c1");
  const event = {
    id: 1,
    streamId: "s1",
    type: "runtime.error",
    payload: {
      error: "当前未配置可用的 LLM/API Key，请先配置模型提供商凭据后再使用普通聊天。",
    },
  } as StreamEvent;

  const failed = browserPanelReducer(initial, {
    type: "event",
    conversationId: "c1",
    event,
  });

  assert.equal(failed.status, "error");
  assert.equal(
    failed.error,
    "当前未配置可用的 LLM/API Key，请先配置模型提供商凭据后再使用普通聊天。",
  );

  const running = browserPanelReducer(failed, {
    type: "event",
    conversationId: "c1",
    event: {
      id: 2,
      streamId: "s1",
      type: "runtime.status",
      payload: { status: "running" },
    } as StreamEvent,
  });

  assert.equal(running.status, "running");
  assert.equal(running.error, undefined);
});

test("snapshot restores a persisted runtime error after page refresh", () => {
  const initial = createBrowserPanelState("c1");
  const snapshot = {
    status: "error",
    error: "模型未配置",
  } as ConversationSnapshot;

  const restored = browserPanelReducer(initial, {
    type: "snapshot",
    conversationId: "c1",
    snapshot,
  });

  assert.equal(restored.status, "error");
  assert.equal(restored.error, "模型未配置");
  assert.equal(restored.connected, true);
});
