import assert from "node:assert/strict";
import test from "node:test";

import { drainAndFlush, settleBeforeDeadline } from "./shutdown";

test("settleBeforeDeadline returns task value before timeout", async () => {
  const result = await settleBeforeDeadline(Promise.resolve("done"), 100);
  assert.deepEqual(result, { timedOut: false, value: "done" });
});

test("settleBeforeDeadline reports timeout without waiting forever", async () => {
  const never = new Promise<void>(() => undefined);
  const result = await settleBeforeDeadline(never, 5);
  assert.deepEqual(result, { timedOut: true });
});

test("shutdown drains, closes and flushes in order", async () => {
  const events: string[] = [];
  const result = await drainAndFlush({
    timeoutMs: 100,
    drain: async () => {
      events.push("drain");
    },
    forceClose: () => {
      events.push("close");
    },
    flush: async () => {
      events.push("flush");
    },
  });
  assert.deepEqual(events, ["drain", "close", "flush"]);
  assert.deepEqual(result, { drainTimedOut: false, flushTimedOut: false });
});

test("one shutdown deadline bounds both stuck drain and stuck exporter", async () => {
  let forced = false;
  let flushed = false;
  const started = Date.now();
  const result = await drainAndFlush({
    timeoutMs: 50,
    drain: () => new Promise(() => {}),
    forceClose: (timedOut) => {
      forced = timedOut;
    },
    flush: () => {
      flushed = true;
      return new Promise(() => {});
    },
  });
  assert.deepEqual(result, { drainTimedOut: true, flushTimedOut: true });
  assert.ok(forced && flushed);
  assert.ok(Date.now() - started < 500);
});

test("drain rejection still closes and exports before rejection is returned", async () => {
  const events: string[] = [];
  await assert.rejects(
    drainAndFlush({
      timeoutMs: 100,
      drain: async () => {
        throw new Error("drain failed");
      },
      forceClose: () => {
        events.push("close");
      },
      flush: async () => {
        events.push("flush");
      },
    }),
    /drain failed/,
  );
  assert.deepEqual(events, ["close", "flush"]);
});
