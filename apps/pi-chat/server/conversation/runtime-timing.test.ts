import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeStatus } from "@shared/types";

import { EventChannel } from "./channel";
import { activeStreamItems } from "./external-stream";
import { ConversationService } from "./service";
import type { ManagedSession } from "./types";

test("execution start survives steering, waiting, stopping and resets only for a new run", (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const service = Object.create(ConversationService.prototype) as ConversationService;
  const setStatus = (
    Reflect.get(service, "setStatus") as (session: ManagedSession, status: RuntimeStatus) => void
  ).bind(service);
  const session = { status: "ready", channel: new EventChannel() } as ManagedSession;
  setStatus(session, "running");
  now = 181000;
  for (const status of [
    "waiting_for_human",
    "running",
    "compacting",
    "stopping",
  ] as RuntimeStatus[]) {
    setStatus(session, status);
    assert.equal(session.runStartedAt, 1000);
    assert.equal(
      (session.channel.replay(0).events.at(-1)?.payload as { runStartedAt: number }).runStartedAt,
      1000,
    );
  }
  setStatus(session, "ready");
  assert.equal(session.runStartedAt, undefined);
  setStatus(session, "running");
  assert.equal(session.runStartedAt, 181000);
  setStatus(session, "error");
  assert.equal(session.runStartedAt, undefined);
});

test("snapshot restores only current streaming fragments without replaying old replies", () => {
  const channel = new EventChannel();
  channel.publish("message.delta", { id: "old", delta: "old reply" });
  channel.publish("thinking.started", { id: "thought" });
  channel.publish("thinking.delta", { id: "thought", delta: "current step" });
  channel.publish("message.delta", { id: "current", delta: "Hello", timestamp: 1000 });
  channel.publish("message.delta", { id: "current", delta: " world", timestamp: 1000 });
  const items = activeStreamItems(channel.replay(0).events, "current", "thought");
  assert.equal(items.length, 2);
  assert.ok(items[0].kind === "thinking");
  assert.equal(items[0].thinking.text, "current step");
  assert.ok(items[1].kind === "message");
  assert.equal(items[1].message.text, "Hello world");
  assert.equal(items[1].message.streaming, true);
  assert.deepEqual(activeStreamItems(channel.replay(0).events), []);
});
