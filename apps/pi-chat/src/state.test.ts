import assert from "node:assert/strict";
import test from "node:test";

import type { ConversationSnapshot, MessageListItem, StreamEvent } from "@shared/types";

import { conversationReducer, createRuntimeState, runtimeReducer } from "./state";

test("runtime.error keeps the user-facing runtime error", () => {
  const initial = createRuntimeState("c1");
  const event = {
    id: 1,
    streamId: "s1",
    type: "runtime.error",
    payload: {
      error: "当前未配置可用的 LLM/API Key，请先配置模型提供商凭据后再使用普通聊天。",
    },
  } as StreamEvent;

  const failed = runtimeReducer(initial, {
    type: "event",
    conversationId: "c1",
    event,
  });

  assert.equal(failed.status, "error");
  assert.equal(
    failed.error,
    "当前未配置可用的 LLM/API Key，请先配置模型提供商凭据后再使用普通聊天。",
  );

  const running = runtimeReducer(failed, {
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
  const initial = createRuntimeState("c1");
  const snapshot = {
    status: "error",
    error: "模型未配置",
  } as ConversationSnapshot;

  const restored = runtimeReducer(initial, {
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
          steps: [],
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
      type: "agent.thinking.delta",
      payload: {
        agentId: "agent-1",
        delta: "先检查 trace。",
      },
    },
  });
  items = conversationReducer(items, {
    type: "event",
    event: {
      id: 3,
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
      id: 4,
      streamId: "s1",
      type: "agent.thinking.delta",
      payload: {
        agentId: "agent-1",
        delta: "根据 trace 继续收敛。",
      },
    },
  });
  items = conversationReducer(items, {
    type: "event",
    event: {
      id: 5,
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
  assert.deepEqual(
    items[0].agent.steps?.map((step) => step.type),
    ["reasoning", "tool", "reasoning"],
  );
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

test("conversationReducer adds a downloadable RCA report artifact", () => {
  const items = conversationReducer([], {
    type: "event",
    event: {
      id: 20,
      streamId: "s1",
      type: "report.ready",
      payload: {
        investigationId: "INV-test",
        filename: "RCA-INV-test.md",
        status: "confirmed",
        summary: "checkout dependency timeout",
        confidence: 0.91,
      },
    },
  });

  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "report");
  if (items[0]?.kind !== "report") return;
  assert.equal(items[0].report.filename, "RCA-INV-test.md");
  assert.equal(items[0].report.confidence, 0.91);
});

test("conversationReducer keeps a completed assistant error message visible", () => {
  const items = conversationReducer([], {
    type: "event",
    event: {
      id: 30,
      streamId: "s1",
      type: "message.completed",
      payload: {
        streamId: "assistant-stream",
        message: {
          id: "assistant-stream",
          role: "assistant",
          text: "",
          images: [],
          error: "模型服务认证失败，当前 API Key 可能已失效或被禁用，请检查模型配置后重新发送。",
        },
      },
    } as StreamEvent,
  });

  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "message");
  if (items[0]?.kind !== "message") return;
  assert.equal(items[0].message.text, "");
  assert.match(items[0].message.error ?? "", /API Key/);
});

test("events complete experts and dispatch tools loaded from a running snapshot", () => {
  let items: MessageListItem[] = [
    {
      kind: "agent",
      id: "expert",
      agent: {
        id: "expert",
        taskId: "T01",
        expert: "trace",
        label: "Trace",
        objective: "Find cause",
        implementation: "pi-session",
        status: "running",
        tools: [],
        evidence: [],
      },
    },
    {
      kind: "tool",
      id: "dispatch",
      tool: { id: "dispatch", name: "dispatch", args: {}, status: "running" },
    },
  ];
  items = conversationReducer([], { type: "snapshot", items });
  const events: StreamEvent[] = [
    {
      id: 11,
      streamId: "s",
      type: "agent.evidence.added",
      payload: {
        agentId: "expert",
        evidence: { id: "E01", modality: "trace", summary: "Observation" },
      },
    },
    {
      id: 12,
      streamId: "s",
      type: "agent.completed",
      payload: { agentId: "expert", status: "completed" },
    },
    {
      id: 13,
      streamId: "s",
      type: "tool.completed",
      payload: { id: "dispatch", name: "dispatch", status: "success" },
    },
  ];
  for (const event of events) items = conversationReducer(items, { type: "event", event });
  assert.equal(items.length, 2);
  assert.ok(items[0].kind === "agent");
  assert.equal(items[0].agent.status, "completed");
  assert.equal(items[0].agent.evidence.length, 1);
  assert.ok(items[1].kind === "tool");
  assert.equal(items[1].tool.status, "success");
});

test("switching conversations and reconnecting restore the server execution start", () => {
  const snapshot = { status: "running", runStartedAt: 1000 } as ConversationSnapshot;
  const restore = () =>
    runtimeReducer(createRuntimeState("c1"), { type: "snapshot", conversationId: "c1", snapshot });
  let state = restore();
  state = runtimeReducer(state, { type: "disconnect", conversationId: "c1" });
  state = runtimeReducer(state, { type: "snapshot", conversationId: "c1", snapshot });
  assert.equal(state.runStartedAt, 1000);
  assert.equal(restore().runStartedAt, 1000);
  assert.equal(
    runtimeReducer(state, { type: "select", conversationId: "c2" }).runStartedAt,
    undefined,
  );
  state = runtimeReducer(state, {
    type: "event",
    conversationId: "c1",
    event: { id: 4, streamId: "s", type: "runtime.status", payload: { status: "ready" } },
  });
  assert.equal(state.runStartedAt, undefined);
});

test("same-stream snapshot replaces stale cards while preserving an unacknowledged send", () => {
  const pending = {
    id: "pending",
    role: "user" as const,
    text: "Investigate",
    images: [],
    pending: true,
  };
  let items = conversationReducer([], { type: "optimistic-user", message: pending });
  items = conversationReducer(items, { type: "snapshot", items: [] });
  assert.equal(items.length, 1);
  items = conversationReducer(items, {
    type: "snapshot",
    items: [{ kind: "message", id: "saved", message: { ...pending, id: "saved", pending: false } }],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "saved");
});
