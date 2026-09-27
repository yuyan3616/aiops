import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ensurePackyModelsConfig,
  resolvePackyProviderSettings,
} from "./model-provider";

test("resolvePackyProviderSettings prefers PACKY_API_KEY and uses explicit endpoint/model", () => {
  const settings = resolvePackyProviderSettings({
    API_KEY: "legacy",
    PACKY_API_KEY: "packy",
    PACKY_BASE_URL: "https://example.test/v1",
    PACKY_MODEL_ID: "deepseek-custom",
  });
  assert.deepEqual(settings, {
    providerId: "packy",
    baseUrl: "https://example.test/v1",
    modelId: "deepseek-custom",
    apiKeyEnv: "PACKY_API_KEY",
  });
});

test("ensurePackyModelsConfig merges a Packy provider without writing the secret", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-chat-packy-"));
  try {
    await writeFile(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          existing: {
            api: "openai-completions",
            baseUrl: "https://existing.test/v1",
            apiKey: "$EXISTING_API_KEY",
            models: [{ id: "existing-model" }],
          },
        },
      }),
      "utf8",
    );

    const settings = await ensurePackyModelsConfig(dir, {
      API_KEY: "super-secret",
      PACKY_BASE_URL: "https://www.packyapi.ai/v1",
      PACKY_MODEL_ID: "deepseek-flash",
    });
    assert.equal(settings?.apiKeyEnv, "API_KEY");

    const raw = await readFile(join(dir, "models.json"), "utf8");
    assert.equal(raw.includes("super-secret"), false);
    const parsed = JSON.parse(raw) as {
      providers: Record<
        string,
        { apiKey?: string; baseUrl?: string; models?: Array<{ id?: string }> }
      >;
    };
    assert.ok(parsed.providers.existing);
    assert.equal(parsed.providers.packy?.apiKey, "$API_KEY");
    assert.equal(parsed.providers.packy?.baseUrl, "https://www.packyapi.ai/v1");
    assert.equal(parsed.providers.packy?.models?.[0]?.id, "deepseek-flash");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
