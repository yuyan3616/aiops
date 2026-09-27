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
    ["message", "thinking", "tool", "message"],
  );
  const thinking = items.find((item) => item.kind === "thinking");
  assert.equal(thinking?.kind === "thinking" ? thinking.thinking.text : "", "先检查 trace");
  assert.equal(thinking?.kind === "thinking" ? thinking.thinking.completed : false, true);
  const tool = items.find((item) => item.kind === "tool");
  assert.equal(tool?.kind === "tool" ? tool.tool.status : "", "success");
  assert.equal(tool?.kind === "tool" ? tool.tool.result : "", "20 traces");

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
    ["native-before", "u1", "think-1", "tool-1", "a1", "native-after"],
  );
});
