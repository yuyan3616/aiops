import assert from "node:assert/strict";
import test from "node:test";

import { settleBeforeDeadline } from "./shutdown";

test("settleBeforeDeadline returns task value before timeout", async () => {
  const result = await settleBeforeDeadline(Promise.resolve("done"), 100);
  assert.deepEqual(result, { timedOut: false, value: "done" });
});

test("settleBeforeDeadline reports timeout without waiting forever", async () => {
  const never = new Promise<void>(() => undefined);
  const result = await settleBeforeDeadline(never, 5);
  assert.deepEqual(result, { timedOut: true });
});
