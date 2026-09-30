import assert from "node:assert/strict";
import test from "node:test";

import { verifyRuntimeExecutionToken } from "./execution-auth";

test("runtime execution token requires a configured sufficiently long secret", () => {
  assert.equal(verifyRuntimeExecutionToken("Bearer abc", undefined), false);
  assert.equal(verifyRuntimeExecutionToken("Bearer abc", "short"), false);
});

test("runtime execution token accepts only the exact bearer secret", () => {
  const token = "runtime-secret-at-least-16";
  assert.equal(verifyRuntimeExecutionToken(`Bearer ${token}`, token), true);
  assert.equal(verifyRuntimeExecutionToken("Bearer wrong-secret-value", token), false);
  assert.equal(verifyRuntimeExecutionToken(token, token), false);
});
