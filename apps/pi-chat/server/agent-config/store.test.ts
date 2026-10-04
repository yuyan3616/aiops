import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";

import { RcaChatEventMapper } from "../rca/chat-events";
import { getExpertProfile } from "../rca/profiles/registry";
import { InvestigationRepository } from "../rca/repository";
import { RcaService } from "../rca/service";
import { createMainConfigExtension } from "./main-extension";
import {
  AgentConfigStore,
  agentConfigStore,
  validateBundle,
  renderMainConfig,
  type ConfigFiles,
} from "./store";
import { fixtureFiles } from "./test-fixture";

const v1 = "1".repeat(40);
const v2 = "2".repeat(40);
function changedFiles(): ConfigFiles {
  const files = fixtureFiles();
  files["agents/main/SYSTEM.md"] += "\n新版身份配置";
  const manifest = JSON.parse(files["manifest.json"]!);
  manifest.roles.push("agents/latency/agent.json");
  files["manifest.json"] = JSON.stringify(manifest);
  files["agents/latency/agent.json"] = JSON.stringify({
    id: "latency",
    kind: "expert",
    name: "延迟调查员",
    systemPrompt: "agents/trace/SYSTEM.md",
    tools: ["search_traces", "get_trace", "discover_metrics", "query_metrics"],
    skills: [{ id: "critical-path" }],
    capability: "多样本延迟对比",
    useWhen: ["需要独立多轮分析"],
    notFor: ["一次查询即可解决"],
  });
  return files;
}
function mockGithub(
  version: () => string,
  files: () => ConfigFiles,
  observed: string[] = [],
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    observed.push(url.toString());
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(init?.redirect, "error");
    if (url.pathname.includes("/commits/")) return Response.json({ sha: version() });
    assert.equal(url.searchParams.get("ref"), version());
    const path = url.pathname.split("/contents/")[1]!;
    const text = files()[path];
    if (text === undefined) return new Response(null, { status: 404 });
    return Response.json({
      type: "file",
      encoding: "base64",
      size: Buffer.byteLength(text),
      content: Buffer.from(text).toString("base64"),
    });
  }) as typeof fetch;
}

test("configuration validation rejects unknown tools, paths, executable fields and missing discovery", () => {
  const files = fixtureFiles();
  assert.ok(validateBundle(v1, files).roles.main);
  for (const change of [
    { tools: ["bash"] },
    { systemPrompt: "../secret.md" },
    { extensions: ["evil.ts"] },
    { tools: ["get_trace"] },
    { tools: ["query_metrics"] },
    { skills: [{ id: "missing" }] },
    { capability: "x".repeat(501) },
    { useWhen: ["valid", 123] },
    { notFor: Array.from({ length: 9 }, (_, i) => `scope ${i}`) },
  ]) {
    const invalid = { ...files };
    invalid["agents/trace/agent.json"] = JSON.stringify({
      ...JSON.parse(files["agents/trace/agent.json"]!),
      ...change,
    });
    assert.throws(() => validateBundle(v1, invalid));
  }
  assert.throws(() => validateBundle(v1, { ...files, "huge.md": "x".repeat(65 * 1024) }));
});

test("refresh validates complete commit bundle, retains last good on errors and restores offline cache", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "config-cache-"));
  let version = v1;
  let files = fixtureFiles();
  const observed: string[] = [];
  const store = new AgentConfigStore({
    cacheDir,
    repository: "example/config",
    fetch: mockGithub(
      () => version,
      () => files,
      observed,
    ),
  });
  try {
    await store.start();
    store.stop();
    assert.equal(store.current.version, v1);
    version = v2;
    files = changedFiles();
    assert.equal(await store.refresh(), true);
    assert.ok(store.current.roles.latency);
    assert.equal(store.get(v1).roles.latency, undefined);
    assert.throws(() => {
      store.current.roles.latency!.name = "changed";
    });
    version = "3".repeat(40);
    files = { ...files, "agents/main/agent.json": "invalid-json" };
    assert.equal(await store.refresh(), false);
    assert.equal(store.current.version, v2);
    assert.equal(store.lastRefreshError, "config_refresh_failed");
    const restored = new AgentConfigStore({
      cacheDir,
      repository: "example/config",
      fetch: (async () => {
        throw new Error("offline with credential in error");
      }) as typeof fetch,
    });
    await restored.start();
    restored.stop();
    assert.equal(restored.current.version, v2);
    assert.equal(restored.get(v1).version, v1);
    assert.equal(restored.lastRefreshError, "config_refresh_failed");
    assert.throws(() => restored.get("4".repeat(40)), /pinned_version_missing/);
    assert.ok(observed.every((url) => !url.includes("token")));
  } finally {
    store.stop();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("refresh is deduplicated and refuses redirects and oversized HTTP bodies", async () => {
  let count = 0;
  const store = new AgentConfigStore({
    repository: "example/config",
    fetch: (async () => {
      count++;
      return new Response("x".repeat(1024 * 1024 + 1));
    }) as typeof fetch,
  });
  assert.equal(store.isReady, false);
  await Promise.all([store.refresh(), store.refresh()]);
  assert.equal(count, 1);
  assert.equal(store.isReady, false);
  assert.throws(() => store.current, /agent_config_unavailable/);
});

test("investigations pin config; new registered role uses existing tools and budget, historical UI keeps label", async () => {
  const directory = await mkdtemp(join(tmpdir(), "config-investigation-"));
  const original = fixtureFiles();
  const originalVersion = agentConfigStore.current.version;
  try {
    agentConfigStore.activate(v1, original);
    const service = new RcaService(new InvestigationRepository(directory));
    const input = {
      symptom: "latency",
      target: { service: "checkout" },
      window: { lookbackMinutes: 10 },
    };
    const first = await service.beginAgentic(input, { operationId: "first" });
    const files = changedFiles();
    agentConfigStore.activate(v2, files);
    assert.equal(first.agentConfigVersion, v1);
    assert.equal(
      (await service.beginAgentic(input, { operationId: "first" })).agentConfigVersion,
      v1,
    );
    const second = await service.beginAgentic(input, { operationId: "second" });
    assert.equal(second.agentConfigVersion, v2);
    assert.match(renderMainConfig(agentConfigStore.get(v2)), /latency：延迟调查员/);
    assert.match(renderMainConfig(agentConfigStore.get(v2)), /适用：需要独立多轮分析/);
    assert.match(renderMainConfig(agentConfigStore.get(v2)), /不适用：一次查询即可解决/);
    assert.throws(() => getExpertProfile("latency", v1), /unknown_expert/);
    const profile = getExpertProfile("latency", v2);
    assert.equal(profile.maxToolCalls, 12);
    assert.equal(profile.toolBudgets?.query_metrics, 6);
    assert.deepEqual(profile.modalities, ["trace", "metric"]);
    const brief = {
      role: "latency",
      question: "test",
      hypothesisIds: ["H01"],
      context: { alertSummary: "test", mainWindow: second.context!.window, knownFacts: [] },
      expected: ["test"],
    };
    await assert.rejects(service.dispatchAgentic(first.id, [brief]), /not registered/);
    await assert.rejects(
      service.dispatchAgentic(second.id, [{ ...brief, role: "bash" }]),
      /not registered/,
    );
    await service.updateHypotheses(second.id, [
      { op: "create", statement: "test latency", confidence: 0.3, nextChecks: [] },
    ]);
    Object.assign(service, {
      expertRunner: {
        run: async () => ({
          sessionId: "config-test",
          termination: { reason: "completed" },
          diagnostics: {
            toolCallCount: 0,
            thinkingChars: 0,
            outputChars: 0,
            repairAttempted: false,
            repairSucceeded: false,
          },
          finding: {
            status: "inconclusive",
            strength: "inconclusive",
            summary: "no signal",
            conclusions: [],
            evidenceClaims: [],
            candidateEntities: [],
            suggestedFollowUps: [],
          },
        }),
      },
    });
    const dispatched = await service.dispatchAgentic(second.id, [brief], {
      dispatchOperationId: "config-new-role",
    });
    assert.equal(dispatched.findings[0]?.role, "latency");
    const persisted = await service.get(second.id);
    assert.equal(persisted.expertTasks[0]?.expertLabel, "延迟调查员");
    assert.equal(persisted.expertTasks[0]?.status, "completed");
    assert.equal(service.getBudgetProjection(persisted).safety.startedTasks, 1);
    const projections = new RcaChatEventMapper(second.id).map({
      id: 1,
      investigationId: second.id,
      type: "expert.started",
      at: new Date().toISOString(),
      summary: "",
      payload: {
        expertTask: { id: "T01", expert: "latency", expertLabel: profile.label, objective: "test" },
      },
    });
    assert.equal((projections[0]!.payload.agent as { label: string }).label, "延迟调查员");
  } finally {
    agentConfigStore.activate(originalVersion, original);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Main extension uses its selected version and tool allowlist despite a background refresh", async () => {
  const original = fixtureFiles();
  const originalVersion = agentConfigStore.current.version;
  const version = "5".repeat(40);
  let handler: ((event: BeforeAgentStartEvent) => Promise<void>) | undefined;
  let activeTools: string[] = [];
  try {
    const selected = fixtureFiles();
    selected["agents/main/agent.json"] = JSON.stringify({
      ...JSON.parse(selected["agents/main/agent.json"]!),
      tools: ["utc_time", "get_investigation_state"],
    });
    agentConfigStore.activate(version, selected);
    const extension = createMainConfigExtension({
      getAgentConfigVersion: async () => version,
      getRcaContext: () => ({ state: "idle" }),
    });
    await extension({
      on: (_event: string, callback: typeof handler) => {
        handler = callback;
      },
      setActiveTools: (tools: string[]) => {
        activeTools = tools;
      },
    } as unknown as ExtensionAPI);
    agentConfigStore.activate(v2, changedFiles());
    const event = { systemPromptOptions: { sections: {} } } as BeforeAgentStartEvent;
    await handler!(event);
    assert.deepEqual(activeTools, ["utc_time", "get_investigation_state"]);
    assert.match(event.systemPromptOptions.customPrompt!, new RegExp(version));
    assert.doesNotMatch(event.systemPromptOptions.customPrompt!, /新版身份配置/);
    assert.match(event.systemPromptOptions.sections.rca_context!, /state: idle/);
  } finally {
    agentConfigStore.activate(originalVersion, original);
  }
});

test("pre-versioning Live investigation pins current config once before continuing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "config-legacy-live-"));
  const originalVersion = agentConfigStore.current.version;
  const original = fixtureFiles();
  try {
    agentConfigStore.activate(v1, original);
    const repository = new InvestigationRepository(directory);
    const service = new RcaService(repository);
    const investigation = await service.beginAgentic({
      symptom: "latency",
      target: { service: "checkout" },
      window: { lookbackMinutes: 10 },
    });
    delete investigation.agentConfigVersion;
    await repository.save(investigation);
    agentConfigStore.activate(v2, changedFiles());
    assert.equal(await service.resolveAgentConfigVersion(investigation.id), v2);
    assert.equal((await repository.get(investigation.id)).agentConfigVersion, v2);
    agentConfigStore.activate(v1, original);
    assert.equal(await service.resolveAgentConfigVersion(investigation.id), v2);
  } finally {
    agentConfigStore.activate(originalVersion, original);
    await rm(directory, { recursive: true, force: true });
  }
});
