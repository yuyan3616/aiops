import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DefaultResourceLoader, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { createApp } from "../app";
import { getGlobalConfig, ensureDir } from "../config";
import { ConversationService } from "../conversation/service";
import { InvestigationRepository } from "../rca/repository";
import { RcaService } from "../rca/service";
import { AgentConfigStore, AgentConfigUnavailableError, agentConfigStore } from "./store";
import { fixtureFiles, TEST_CONFIG_VERSION } from "./test-fixture";

test("Pi SDK uses injected prompt without local SYSTEM, APPEND_SYSTEM or AGENTS content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "config-pi-init-"));
  try {
    for (const name of ["SYSTEM.md", "APPEND_SYSTEM.md", "AGENTS.md"])
      await writeFile(join(directory, name), "LOCAL_SENTINEL_MUST_NOT_LOAD");
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPromptOverride: () => "Injected versioned prompt",
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    assert.equal(loader.getSystemPrompt(), "Injected versioned prompt");
    assert.deepEqual(loader.getAppendSystemPrompt(), []);
    assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
    assert.deepEqual(loader.getSkills().skills, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cold/offline start stays unavailable and imports no embedded roles", async () => {
  const store = new AgentConfigStore({
    repository: "example/config",
    fetch: (async () => {
      throw new Error("offline");
    }) as typeof fetch,
  });
  try {
    await store.start();
    assert.equal(store.isReady, false);
    assert.throws(() => store.current, AgentConfigUnavailableError);
    assert.deepEqual(store.status, { state: "unavailable", error: "config_refresh_failed" });
  } finally {
    store.stop();
  }
});

test("invalid cache cannot enable an Agent; successful remote refresh can recover readiness", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "config-empty-"));
  let online = false;
  const files = fixtureFiles();
  const store = new AgentConfigStore({
    cacheDir,
    repository: "example/config",
    fetch: (async (input) => {
      if (!online) throw new Error("offline");
      const url = new URL(String(input));
      if (url.pathname.includes("/commits/")) return Response.json({ sha: TEST_CONFIG_VERSION });
      const value = files[url.pathname.split("/contents/")[1]!]!;
      return Response.json({
        type: "file",
        size: Buffer.byteLength(value),
        encoding: "base64",
        content: Buffer.from(value).toString("base64"),
      });
    }) as typeof fetch,
  });
  try {
    await writeFile(join(cacheDir, "active.json"), "corrupt");
    await store.start();
    store.stop();
    assert.equal(store.isReady, false);
    online = true;
    assert.equal(await store.refresh(), true);
    assert.equal(store.current.version, TEST_CONFIG_VERSION);
  } finally {
    store.stop();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("configuration unavailable still permits persisted conversation reading but rejects new work with 503", async () => {
  const directory = await mkdtemp(join(tmpdir(), "config-history-"));
  const globalConfig = getGlobalConfig(directory);
  await ensureDir([globalConfig.recordsDir, globalConfig.sessionsDir, globalConfig.workspacesDir]);
  const rca = new RcaService(new InvestigationRepository(globalConfig.rcaInvestigationsDir));
  const service = new ConversationService({ ...globalConfig }, {} as ModelRuntime, rca);
  const now = new Date();
  await writeFile(
    join(globalConfig.recordsDir, "history.json"),
    JSON.stringify({
      id: "history",
      title: "历史调查",
      workspaceDir: globalConfig.workspacesDir,
      sessionId: "history",
      sessionFile: join(globalConfig.sessionsDir, "absent.jsonl"),
      createdAt: now,
      updatedAt: now,
      selectedSkills: [],
      externalMessageList: [
        {
          type: "message",
          id: "old",
          role: "assistant",
          text: "已保存的历史结论",
          timestamp: now.getTime(),
        },
      ],
    }),
  );
  Object.defineProperty(agentConfigStore, "isReady", { configurable: true, get: () => false });
  Object.defineProperty(agentConfigStore, "current", {
    configurable: true,
    get: () => {
      throw new AgentConfigUnavailableError();
    },
  });
  try {
    const snapshot = await service.snapshot("history");
    assert.match(JSON.stringify(snapshot.messageList), /已保存的历史结论/);
    assert.equal(snapshot.status, "cold");
    assert.match(snapshot.error!, /agent_config_unavailable/);
    const app = createApp(service, rca);
    const health = await app.request("/api/system/health");
    assert.equal(
      ((await health.json()) as { agentConfiguration: { state: string } }).agentConfiguration.state,
      "unavailable",
    );
    await assert.rejects(service.send("history", "继续排障"), AgentConfigUnavailableError);
    const create = await app.request("/api/conversation", { method: "POST" });
    assert.equal(create.status, 503);
  } finally {
    Reflect.deleteProperty(agentConfigStore, "current");
    Reflect.deleteProperty(agentConfigStore, "isReady");
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
