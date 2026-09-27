import assert from "node:assert/strict";
import test from "node:test";

import type { ConversationSnapshot, StreamEvent } from "@shared/types";

import { browserPanelReducer, conversationReducer, createBrowserPanelState } from "./state";

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


test("conversationReducer keeps expert tools nested in an agent thread", () => {
  let items = conversationReducer([], {
    type: "event",
    event: {
      id: 1,
      streamId: "s1",
      type: "agent.started",
      payload: {
        agent: {
          id: "agent-1",
          taskId: "T01",
          expert: "trace",
          label: "Trace Expert",
          objective: "Locate latency propagation.",
          status: "running",
          tools: [],
          evidence: [],
          implementation: "deterministic",
        },
      },
    },
  });
  items = conversationReducer(items, {
    type: "event",
    event: {
      id: 2,
      streamId: "s1",
      type: "agent.tool.completed",
      payload: {
        agentId: "agent-1",
        tool: {
          id: "tool-1",
          name: "query_traces",
          args: {},
          status: "success",
          result: "shipping degraded",
        },
      },
    },
  });
  items = conversationReducer(items, {
    type: "event",
    event: {
      id: 3,
      streamId: "s1",
      type: "agent.completed",
      payload: {
        agentId: "agent-1",
        status: "completed",
        summary: "shipping localized",
      },
    },
  });

  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "agent");
  if (items[0]?.kind !== "agent") return;
  assert.equal(items[0].agent.tools[0]?.name, "query_traces");
  assert.equal(items[0].agent.status, "completed");
  assert.equal(items[0].agent.summary, "shipping localized");
});


test("conversationReducer merges structured RCA hypothesis updates", () => {
  let items = conversationReducer([], {
    type: "event",
    event: {
      id: 10,
      streamId: "s1",
      type: "hypothesis.updated",
      payload: {
        investigationId: "INV-test",
        hypothesis: {
          id: "H01",
          statement: "checkout local slowdown",
          status: "possible",
          supportingEvidenceIds: [],
          contradictingEvidenceIds: [],
        },
      },
    },
  });
  items = conversationReducer(items, {
    type: "event",
    event: {
      id: 11,
      streamId: "s1",
      type: "hypothesis.updated",
      payload: {
        investigationId: "INV-test",
        hypothesis: {
          id: "H01",
          status: "rejected",
          contradictingEvidenceIds: ["E01"],
        },
      },
    },
  });

  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "hypotheses");
  if (items[0]?.kind !== "hypotheses") return;
  assert.equal(items[0].board.hypotheses[0]?.statement, "checkout local slowdown");
  assert.equal(items[0].board.hypotheses[0]?.status, "rejected");
  assert.deepEqual(items[0].board.hypotheses[0]?.contradictingEvidenceIds, ["E01"]);
});
