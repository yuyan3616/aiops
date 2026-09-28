import assert from "node:assert/strict";
import test from "node:test";

import { normalizeConversationIds } from "./batch-delete";

test("normalizeConversationIds trims and de-duplicates ids", () => {
  assert.deepEqual(
    normalizeConversationIds([" c1 ", "c2", "c1"]),
    ["c1", "c2"],
  );
});

test("normalizeConversationIds rejects invalid input", () => {
  assert.throws(() => normalizeConversationIds([]));
  assert.throws(() => normalizeConversationIds([""]));
  assert.throws(() => normalizeConversationIds(["c1", 2]));
});
