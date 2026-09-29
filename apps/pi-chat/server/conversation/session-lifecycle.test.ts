import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EventChannel } from "./channel";
import { ConversationService } from "./service";

type PrivateService = {
  ensureManagedSession(id: string): Promise<Session>;
  withSessionLock<T>(id: string, task: () => Promise<T>): Promise<T>;
  done(session: Session): void;
  sweepIdleSessions(): Promise<void>;
  loadManagedSession(id: string): Promise<Session>;
  deleteMany(ids: string[]): Promise<string[]>;
};

type Session = {
  id: string;
  lastAccessAt: number;
  activeUses: number;
  status: string;
  runtime: {
    session: { isStreaming: boolean; agent: { state: { isStreaming: boolean } }; dispose(): void };
  };
  channel: EventChannel;
  unsubscribe?: () => void;
};

function service(): PrivateService {
  const instance = Object.create(ConversationService.prototype) as PrivateService;
  Object.assign(instance, {
    sessionLocks: new Map(),
    managedSessions: new Map(),
    channels: new Map(),
    recordWriteQueues: new Map(),
    promptPerformance: new Map(),
    pendingTitleRefinements: new Map(),
    sessionIdleTtlMs: 100,
  });
  return instance;
}

function session(id: string, channel = new EventChannel(), dispose = () => {}): Session {
  return {
    id,
    channel,
    status: "ready",
    lastAccessAt: Date.now() - 1000,
    activeUses: 0,
    runtime: { session: { isStreaming: false, agent: { state: { isStreaming: false } }, dispose } },
  };
}

test("cold concurrent requests join one initialization and release their own uses", async () => {
  const subject = service();
  const root = await mkdtemp(join(tmpdir(), "conversation-session-"));
  const workspaceDir = join(root, "workspace");
  const sessionsDir = join(root, "sessions");
  await Promise.all([mkdir(workspaceDir), mkdir(sessionsDir)]);
  let calls = 0;
  let complete!: (value: Session) => void;
  const pending = new Promise<Session>((resolve) => {
    complete = resolve;
  });
  const instances = (subject as unknown as { managedSessions: Map<string, Session> })
    .managedSessions;
  Object.assign(subject, {
    globalConfig: { sessionsDir },
    conversationRepository: {
      get: async () => ({
        id: "a",
        workspaceDir,
        sessionFile: join(root, "missing.json"),
        selectedSkills: [],
      }),
    },
    createManagedSession: async () => {
      calls++;
      const created = await pending;
      instances.set("a", created);
      return created;
    },
  });
  try {
    const first = subject.ensureManagedSession("a");
    const second = subject.ensureManagedSession("a");
    await Promise.resolve();
    complete(session("a"));
    const [a, b] = await Promise.all([first, second]);
    assert.strictEqual(a, b);
    assert.equal(calls, 1);
    assert.equal(a.activeUses, 2);
    subject.done(a);
    subject.done(b);
    assert.equal(a.activeUses, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed initialization releases the lock so a subsequent request can retry", async () => {
  const subject = service();
  let attempts = 0;
  subject.loadManagedSession = async () => {
    if (++attempts === 1) throw new Error("initialization failed");
    return session("a");
  };
  await assert.rejects(subject.ensureManagedSession("a"), /initialization failed/);
  const recovered = await subject.ensureManagedSession("a");
  assert.equal(attempts, 2);
  subject.done(recovered);
});

test("idle eviction skips leased and streaming sessions, and preserves the channel", async () => {
  const subject = service();
  const channel = new EventChannel();
  let disposed = 0;
  const target = session("a", channel, () => {
    disposed++;
  });
  const instances = (subject as unknown as { managedSessions: Map<string, Session> })
    .managedSessions;
  const channels = (subject as unknown as { channels: Map<string, EventChannel> }).channels;
  instances.set("a", target);
  channels.set("a", channel);

  target.activeUses = 1;
  await subject.sweepIdleSessions();
  assert.equal(disposed, 0);
  target.activeUses = 0;
  target.runtime.session.isStreaming = true;
  await subject.sweepIdleSessions();
  assert.equal(disposed, 0);
  target.runtime.session.isStreaming = false;
  await subject.sweepIdleSessions();
  assert.equal(disposed, 1);
  assert.equal(instances.has("a"), false);
  assert.strictEqual(channels.get("a"), channel);
});

test("delete waits for initialization, then rejects a running session", async () => {
  const subject = service();
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const target = session("a");
  const instances = (subject as unknown as { managedSessions: Map<string, Session> })
    .managedSessions;
  Object.assign(subject, {
    conversationRepository: {
      get: async () => ({ id: "a", sessionFile: "/missing", workspaceDir: "/missing" }),
    },
  });
  const initializing = subject.withSessionLock("a", async () => {
    entered();
    await gate;
    target.status = "running";
    instances.set("a", target);
  });
  await started;
  const deleting = subject.deleteMany(["a"]);
  unblock();
  await initializing;
  await assert.rejects(deleting, /busy/);
  assert.strictEqual(instances.get("a"), target);
});
