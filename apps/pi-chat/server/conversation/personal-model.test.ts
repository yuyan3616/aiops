import assert from "node:assert/strict";
import test from "node:test";

import {
  createPersonalModelRuntime,
  personalModelFingerprint,
  validatePersonalModel,
} from "./personal-model";

const input = {
  baseUrl: "https://api.deepseek.com/v1",
  modelId: "deepseek-chat",
  apiKey: "private-key-value",
};

test("only approved HTTPS endpoints can receive a personal Key", () => {
  assert.deepEqual(validatePersonalModel(input, "api.deepseek.com"), input);
  for (const baseUrl of [
    "http://api.deepseek.com/v1",
    "https://127.0.0.1/v1",
    "https://api.deepseek.com.evil.test/v1",
    "https://api.deepseek.com:8443/v1",
    "https://api.deepseek.com@evil.test/v1",
    "https://api.deepseek.com/v1?redirect=http://localhost",
  ]) {
    assert.throws(() => validatePersonalModel({ ...input, baseUrl }, "api.deepseek.com"));
  }
  assert.throws(() => validatePersonalModel(input, ""));
});

test("each conversation gets an isolated in-memory provider and no raw Key in its identifier", async () => {
  const a = await createPersonalModelRuntime(input);
  const b = await createPersonalModelRuntime({ ...input, apiKey: "another-secret" });
  assert.notEqual(a.runtime, b.runtime);
  assert.notEqual(a.provider, b.provider);
  assert.equal(a.runtime.getModel(a.provider, a.modelId)?.id, input.modelId);
  assert.equal(a.runtime.getModel(b.provider, b.modelId), undefined);
  assert.equal(a.fingerprint, personalModelFingerprint(input));
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.equal(
    JSON.stringify({ provider: a.provider, modelId: a.modelId }).includes(input.apiKey),
    false,
  );
});

test("provider errors cannot echo the Key and requests cannot follow redirects", async () => {
  const personal = await createPersonalModelRuntime(input);
  const model = personal.runtime.getModel(personal.provider, personal.modelId);
  assert.ok(model);
  const originalFetch = globalThis.fetch;
  let redirect: string | undefined;
  globalThis.fetch = async (_url, init) => {
    redirect = init?.redirect;
    return new Response(JSON.stringify({ error: `invalid credential ${input.apiKey}` }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const result = await personal.runtime.completeSimple(model, {
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
    });
    assert.equal(result.stopReason, "error");
    assert.equal(JSON.stringify(result).includes(input.apiKey), false);
    assert.equal(redirect, "error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
