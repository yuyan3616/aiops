import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EventChannel } from "./channel";
import { ConversationService } from "./service";

type PrivateService = {
  ensureManagedSession(id: string): Promise<Session>;
  send(id: string, input: string): Promise<unknown>;
  beginShutdown(): void;
  shutdown(timeoutMs?: number): Promise<{ timedOut: boolean; activeSessions: number }>;
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
    acceptingWork: true,
    pendingSends: new Set(),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("shutdown rejects a send already waiting on title preparation and disposes its session", async () => {
  const subject = service();
  const root = await mkdtemp(join(tmpdir(), "shutdown-admission-"));
  const preparing = deferred<void>();
  const resume = deferred<void>();
  let prompts = 0;
  let disposed = 0;
  const target = session("a", undefined, () => {
    disposed++;
  });
  target.activeUses = 1;
  Object.assign(target.runtime.session, {
    prompt: async () => {
      prompts++;
    },
  });
  const instances = new Map([["a", target]]);
  Object.assign(subject, {
    globalConfig: { skillsDir: root },
    managedSessions: instances,
    ensureManagedSession: async () => target,
    ensureFallbackTitle: async () => {
      preparing.resolve();
      await resume.promise;
    },
  });
  try {
    const sending = subject.send("a", "hello");
    const rejected = assert.rejects(sending, /shutting down/);
    await preparing.promise;
    const closing = subject.shutdown(500);
    resume.resolve();
    await rejected;
    assert.equal((await closing).timedOut, false);
    assert.equal(prompts, 0);
    assert.equal(disposed, 1);
    assert.equal(instances.size, 0);
    await assert.rejects(subject.send("b", "hello"), /shutting down/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session initialization completing after shutdown timeout cannot start a prompt", async () => {
  const subject = service();
  const root = await mkdtemp(join(tmpdir(), "shutdown-cold-"));
  const initialized = deferred<Session>();
  let prompts = 0;
  let disposed = 0;
  const target = session("a", undefined, () => {
    disposed++;
  });
  target.activeUses = 1;
  Object.assign(target.runtime.session, {
    prompt: async () => {
      prompts++;
    },
  });
  const instances = new Map<string, Session>();
  Object.assign(subject, {
    globalConfig: { skillsDir: root },
    managedSessions: instances,
    ensureManagedSession: async () => {
      const created = await initialized.promise;
      instances.set("a", created);
      return created;
    },
    ensureFallbackTitle: async () => {},
  });
  try {
    const sending = subject.send("a", "hello");
    const rejected = assert.rejects(sending, /shutting down/);
    assert.equal((await subject.shutdown(5)).timedOut, true);
    initialized.resolve(target);
    await rejected;
    assert.equal(prompts, 0);
    assert.equal(disposed, 1);
    assert.equal(instances.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shutdown awaits Pi abort before disposing an active session", async () => {
  const subject = service();
  const idle = deferred<void>();
  const abortStarted = deferred<void>();
  let disposed = 0;
  const target = session("a", undefined, () => {
    disposed++;
  });
  target.status = "running";
  target.runtime.session.isStreaming = true;
  Object.assign(target.runtime.session, {
    abort: async () => {
      abortStarted.resolve();
      await idle.promise;
      target.runtime.session.isStreaming = false;
    },
  });
  Object.assign(subject, {
    managedSessions: new Map([["a", target]]),
    setStatus: (current: Session, status: string) => {
      current.status = status;
    },
  });
  const closing = subject.shutdown(500);
  await abortStarted.promise;
  assert.equal(disposed, 0);
  idle.resolve();
  assert.deepEqual(await closing, { timedOut: false, activeSessions: 1 });
  assert.equal(disposed, 1);
});

test("a stuck admitted initialization does not defer abort of an existing running session", async () => {
  const subject = service();
  const pending = deferred<void>();
  const target = session("a");
  target.status = "running";
  target.runtime.session.isStreaming = true;
  let aborted = false;
  Object.assign(target.runtime.session, {
    abort: async () => {
      aborted = true;
      target.runtime.session.isStreaming = false;
    },
  });
  Object.assign(subject, {
    pendingSends: new Set([pending.promise]),
    managedSessions: new Map([["a", target]]),
    setStatus: (current: Session, status: string) => {
      current.status = status;
    },
  });
  const closing = subject.shutdown(10);
  assert.equal(aborted, true);
  assert.deepEqual(await closing, { timedOut: true, activeSessions: 1 });
  pending.resolve();
});

test("abort rejection is handled while an admitted initialization remains pending", async () => {
  const subject = service();
  const pending = deferred<void>();
  const target = session("a");
  target.status = "running";
  target.runtime.session.isStreaming = true;
  Object.assign(target.runtime.session, {
    abort: async () => {
      throw new Error("abort failed");
    },
  });
  Object.assign(subject, {
    pendingSends: new Set([pending.promise]),
    managedSessions: new Map([["a", target]]),
    setStatus: (current: Session, status: string) => {
      current.status = status;
    },
  });
  assert.deepEqual(await subject.shutdown(10), { timedOut: true, activeSessions: 1 });
  pending.resolve();
});
