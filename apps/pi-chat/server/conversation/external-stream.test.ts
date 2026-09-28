import assert from "node:assert/strict";
import test from "node:test";

import type { MessageListItem } from "@shared/types";

import { applyExternalStreamEvent, mergeMessageLists } from "./external-stream";

test("persists RCA thinking, tools, and messages in chronological order", () => {
  let items: MessageListItem[] = [];
  let sequence = 0;

  ({ items, sequence } = applyExternalStreamEvent(
    items,
    sequence,
    "message.added",
    {
      id: "u1",
      role: "user",
      text: "排查 checkout 延迟",
      images: [],
      timestamp: 1000,
    },
    1000,
  ));
  ({ items, sequence } = applyExternalStreamEvent(
    items,
    sequence,
    "thinking.started",
    { id: "think-1" },
    1001,
  ));
  ({ items, sequence } = applyExternalStreamEvent(
    items,
    sequence,
    "thinking.delta",
    { id: "think-1", delta: "先检查 trace" },
    1001,
  ));
  ({ items, sequence } = applyExternalStreamEvent(
    items,
    sequence,
    "tool.started",
    { id: "tool-1", name: "query_traces", args: { service: "checkout" } },
    1002,
  ));
  ({ items, sequence } = applyExternalStreamEvent(
    items,
    sequence,
    "tool.completed",
    {
      id: "tool-1",
      name: "query_traces",
      args: { service: "checkout" },
      status: "success",
      result: "20 traces",
    },
    1003,
  ));
  ({ items, sequence } = applyExternalStreamEvent(
    items,
    sequence,
    "thinking.completed",
    { id: "think-1" },
    1004,
  ));
  ({ items, sequence } = applyExternalStreamEvent(
    items,
    sequence,
    "agent.started",
    {
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
    1004,
  ));
  ({ items, sequence } = applyExternalStreamEvent(
    items,
    sequence,
    "agent.thinking.delta",
    { agentId: "agent-1", delta: "先查 trace catalog。" },
    1004,
  ));
  ({ items, sequence } = applyExternalStreamEvent(
    items,
    sequence,
    "agent.tool.started",
    {
      agentId: "agent-1",
      tool: {
        id: "agent-tool-1",
        name: "query_traces",
        args: { service: "checkout" },
        status: "running",
      },
    },
    1004,
  ));
  ({ items, sequence } = applyExternalStreamEvent(
    items,
    sequence,
    "agent.tool.completed",
    {
      agentId: "agent-1",
      tool: {
        id: "agent-tool-1",
        name: "query_traces",
        args: { service: "checkout" },
        status: "success",
        result: "shipping degraded",
      },
    },
    1004,
  ));
  ({ items, sequence } = applyExternalStreamEvent(
    items,
    sequence,
    "agent.thinking.delta",
    { agentId: "agent-1", delta: "trace 返回后继续判断传播路径。" },
    1004,
  ));
  ({ items, sequence } = applyExternalStreamEvent(
    items,
    sequence,
    "agent.evidence.added",
    {
      agentId: "agent-1",
      evidence: {
        id: "E01",
        modality: "trace",
        summary: "shipping is slow",
      },
    },
    1004,
  ));
  ({ items, sequence } = applyExternalStreamEvent(
    items,
    sequence,
    "agent.completed",
    { agentId: "agent-1", status: "completed", summary: "shipping localized" },
    1004,
  ));
  ({ items, sequence } = applyExternalStreamEvent(
    items,
    sequence,
    "report.ready",
    {
      investigationId: "INV-test",
      filename: "RCA-INV-test.md",
      status: "confirmed",
      summary: "shipping timeout is the root cause",
      confidence: 0.92,
    },
    1005,
  ));
  ({ items, sequence } = applyExternalStreamEvent(
    items,
    sequence,
    "message.completed",
    {
      message: {
        id: "a1",
        role: "assistant",
        text: "RCA completed",
        images: [],
        timestamp: 1005,
      },
    },
    1005,
  ));

  assert.deepEqual(
    items.map((item) => item.kind),
    ["message", "thinking", "tool", "agent", "report", "message"],
  );
  const thinking = items.find((item) => item.kind === "thinking");
  assert.equal(thinking?.kind === "thinking" ? thinking.thinking.text : "", "先检查 trace");
  assert.equal(thinking?.kind === "thinking" ? thinking.thinking.completed : false, true);
  const tool = items.find((item) => item.kind === "tool");
  assert.equal(tool?.kind === "tool" ? tool.tool.status : "", "success");
  assert.equal(tool?.kind === "tool" ? tool.tool.result : "", "20 traces");

  const agent = items.find((item) => item.kind === "agent");
  assert.equal(agent?.kind === "agent" ? agent.agent.status : "", "completed");
  assert.equal(agent?.kind === "agent" ? agent.agent.tools[0]?.status : "", "success");
  assert.equal(agent?.kind === "agent" ? agent.agent.evidence[0]?.id : "", "E01");
  if (agent?.kind === "agent") {
    assert.deepEqual(agent.agent.steps?.map((step) => step.type), [
      "reasoning",
      "tool",
      "reasoning",
    ]);
    assert.equal(
      agent.agent.steps?.[0]?.type === "reasoning"
        ? agent.agent.steps[0].text
        : "",
      "先查 trace catalog。",
    );
    assert.equal(
      agent.agent.steps?.[1]?.type === "tool"
        ? agent.agent.steps[1].tool.status
        : "",
      "success",
    );
  }

  const report = items.find((item) => item.kind === "report");
  assert.equal(
    report?.kind === "report" ? report.report.filename : "",
    "RCA-INV-test.md",
  );

  const merged = mergeMessageLists(
    [
      {
        kind: "message",
        id: "native-before",
        seqId: 999 * 100,
        message: { id: "native-before", role: "user", text: "before", images: [] },
      },
      {
        kind: "message",
        id: "native-after",
        seqId: 1006 * 100,
        message: { id: "native-after", role: "user", text: "after", images: [] },
      },
    ],
    items,
  );
  assert.deepEqual(
    merged.map((item) => item.id),
    ["native-before", "u1", "think-1", "tool-1", "agent-1", "INV-test:report", "a1", "native-after"],
  );
});
