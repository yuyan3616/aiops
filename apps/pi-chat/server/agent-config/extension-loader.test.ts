import assert from "node:assert/strict";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { moduleHash, validateModule } from "./extension-loader";
import { AgentConfigStore, type ConfigFiles } from "./store";
import { fixtureFiles } from "./test-fixture";

function executableFiles(): ConfigFiles {
  const files = fixtureFiles();
  const manifest = JSON.parse(files["manifest.json"]!);
  manifest.schemaVersion = 2;
  manifest.hostApiVersion = "1";
  manifest.extensions = {};
  for (const rolePath of manifest.roles) {
    const role = JSON.parse(files[rolePath]);
    const entry = `dist/${role.id}.mjs`;
    const tools = [...role.tools, ...(role.kind === "expert" ? ["submit_finding"] : [])];
    files[entry] =
      `export function createExtension({sdk,host}) {return pi=>{for(const name of ${JSON.stringify(tools)}) pi.registerTool({name,label:name,description:name,parameters:sdk.Type.Object({}),execute:()=>host[name]()});};}`;
    manifest.extensions[role.id] = { entry, sha256: moduleHash(files[entry]) };
    role.extensions = [role.id];
    files[rolePath] = JSON.stringify(role);
  }
  files["manifest.json"] = JSON.stringify(manifest);
  return files;
}

test("invalid module fails before activation and keeps the previous valid version", async () => {
  const store = new AgentConfigStore();
  const old = "1".repeat(40);
  store.activate(old, fixtureFiles());
  const files = executableFiles();
  files["dist/main.mjs"] += "\nthrow new Error('bad');";
  const manifest = JSON.parse(files["manifest.json"]!);
  manifest.extensions.main.sha256 = moduleHash(files["dist/main.mjs"]!);
  files["manifest.json"] = JSON.stringify(manifest);
  await assert.rejects(store.install("2".repeat(40), files), /top_level_effect/);
  assert.equal(store.current.version, old);
  for (const source of [
    "import x from './missing.mjs';",
    "export function createExtension(){return import('node:fs')}",
  ])
    assert.throws(() => validateModule(source));
});

test("fixed executable versions survive offline restart and a missing module fails explicitly", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "config-code-"));
  const a = "3".repeat(40);
  const b = "4".repeat(40);
  try {
    const store = new AgentConfigStore({ cacheDir });
    const first = executableFiles();
    await store.install(a, first);
    const second = executableFiles();
    second["agents/main/SYSTEM.md"] += " changed";
    await store.install(b, second);
    const restarted = new AgentConfigStore({ cacheDir });
    await restarted.start();
    restarted.stop();
    assert.equal(restarted.current.version, b);
    const tools = await restarted.toolsFor(a, "main", {
      utc_time: async () => ({ content: [{ type: "text", text: "old" }], details: {} }),
    });
    assert.deepEqual(
      await tools
        .find((x) => x.name === "utc_time")!
        .execute("id", {}, undefined, undefined, {} as never),
      { content: [{ type: "text", text: "old" }], details: {} },
    );
    await unlink(join(cacheDir, "versions", a, "dist/main.mjs"));
    await assert.rejects(restarted.toolsFor(a, "main", {}), /ENOENT/);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("duplicate registrations, missing allowed tools and factory I/O are refused", async () => {
  for (const source of [
    "export function createExtension({sdk}) {return pi=>{const t={name:'utc_time',label:'x',description:'x',parameters:sdk.Type.Object({}),execute:async()=>({})};pi.registerTool(t);pi.registerTool(t)}}",
    "export function createExtension(){return pi=>{}}",
    "export function createExtension({host}){host.read();return pi=>{}}",
  ]) {
    const files = executableFiles();
    files["dist/main.mjs"] = source;
    const manifest = JSON.parse(files["manifest.json"]!);
    manifest.extensions.main.sha256 = moduleHash(source);
    files["manifest.json"] = JSON.stringify(manifest);
    await assert.rejects(new AgentConfigStore().install("5".repeat(40), files));
  }
});

test("legacy bindings are explicit, immutable and recover offline", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "config-binding-"));
  const old = "6".repeat(40),
    code = "7".repeat(40);
  try {
    const store = new AgentConfigStore({ cacheDir });
    store.activate(old, fixtureFiles());
    await assert.rejects(store.toolsFor(old, "main", {}), /binding_missing/);
    await store.install(code, executableFiles());
    store.bindLegacy(old, code);
    const restarted = new AgentConfigStore({ cacheDir });
    await restarted.start();
    restarted.stop();
    assert.equal(restarted.get(old).schemaVersion, 1);
    assert.equal(restarted.legacyExtensionVersion(old), code);
    assert.equal((await restarted.toolsFor(old, "main", {})).length, 2);
    const other = "8".repeat(40);
    await store.install(other, executableFiles());
    assert.throws(() => store.bindLegacy(old, other), /binding_conflict/);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});
