import assert from "node:assert/strict";
import test from "node:test";

import { ConversationService } from "./service";

function subject() {
  const service = Object.create(ConversationService.prototype);
  const manager = {},
    channel = {},
    oldModel = { id: "old-model" };
  const events: string[] = [];
  const previous = {
    id: "c",
    executionVersion: "old",
    activeUses: 0,
    status: "ready",
    activeSkillNames: [],
    channel,
    runtime: {
      session: {
        isIdle: true,
        isStreaming: false,
        agent: { state: { isStreaming: false } },
        sessionManager: manager,
        model: oldModel,
        thinkingLevel: "high",
        dispose: () => events.push("dispose-old"),
      },
    },
    unsubscribe: () => events.push("unsubscribe-old"),
  };
  const candidate = {
    id: "c",
    executionVersion: "new",
    activeUses: 0,
    status: "ready",
    channel,
    runtime: {
      session: {
        setModel: async (model: unknown) => assert.strictEqual(model, oldModel),
        setThinkingLevel: (level: string) => assert.equal(level, "high"),
        dispose: () => events.push("dispose-new"),
      },
    },
  };
  Object.assign(service, {
    managedSessions: new Map([["c", previous]]),
    recordWriteQueues: new Map(),
    pendingTitleRefinements: new Map([["c", { pending: true }]]),
    conversationRepository: { get: async () => ({ id: "c" }) },
    createManagedSession: async (
      _record: unknown,
      suppliedManager: unknown,
      _skills: unknown,
      version: string,
      publish: boolean,
    ) => {
      assert.strictEqual(suppliedManager, manager);
      assert.equal(version, "new");
      assert.equal(publish, false);
      return candidate;
    },
    bind: () => events.push("bind-new"),
  });
  return { service, previous, candidate, events };
}

test("idle version replacement preserves manager/channel/model/thinking and pending title work", async () => {
  const { service, previous, candidate, events } = subject();
  assert.strictEqual(await service.replaceManagedRuntime(previous, "new"), candidate);
  assert.strictEqual(service.managedSessions.get("c"), candidate);
  assert.equal(service.pendingTitleRefinements.has("c"), true);
  assert.deepEqual(events, ["bind-new", "unsubscribe-old", "dispose-old"]);
});

test("candidate initialization failure preserves the existing idle runtime", async () => {
  const { service, previous, events } = subject();
  service.createManagedSession = async () => {
    throw new Error("module failed");
  };
  await assert.rejects(service.replaceManagedRuntime(previous, "new"), /module failed/);
  assert.strictEqual(service.managedSessions.get("c"), previous);
  assert.deepEqual(events, []);
});

test("streaming, queued continuation or leased runtime cannot be replaced", async () => {
  for (const state of ["streaming", "continuation", "leased"]) {
    const { service, previous, events } = subject();
    if (state === "streaming") previous.runtime.session.isStreaming = true;
    if (state === "continuation") previous.runtime.session.isIdle = false;
    if (state === "leased") previous.activeUses = 1;
    await assert.rejects(service.replaceManagedRuntime(previous, "new"), /busy/);
    assert.deepEqual(events, []);
  }
});
