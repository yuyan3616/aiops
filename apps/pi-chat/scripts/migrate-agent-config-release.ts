import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";

import { AgentConfigStore } from "../server/agent-config/store.ts";
import { InvestigationRepository } from "../server/rca/repository.ts";
const candidate = process.env.AGENT_CONFIG_MIGRATE_EXTENSION_SHA;
if (!candidate || !/^[a-f0-9]{40}$/.test(candidate))
  throw Error("explicit_extension_commit_required");
const root = process.env.PI_CHAT_ROOT_DIR;
if (!root || !isAbsolute(root)) throw Error("persistent_root_required");
const cache = join(root, "agent-config");
const pointerPath = join(cache, "active.json");
const prior = JSON.parse(readFileSync(pointerPath, "utf8")).version;
const local = new AgentConfigStore({ cacheDir: cache });
await local.start();
local.stop();
const priorBundle = local.get(prior);
const legacyDefault =
  priorBundle.schemaVersion === 1 ? prior : "013e27faf865a0cc38a6f99fc4075e220679d1b9";
const backupDir = join(cache, "release-backups");
mkdirSync(backupDir, { recursive: true });
const backupPath = join(backupDir, "versioned-extensions-20261005.json");
if (!existsSync(backupPath))
  writeFileSync(
    backupPath,
    JSON.stringify({
      applicationVersion: "c1eb277156ae2fa6121006ac42ebd37ff485bc00",
      rollbackConfigVersion: "013e27faf865a0cc38a6f99fc4075e220679d1b9",
      observedConfigVersion: prior,
      active: JSON.parse(readFileSync(pointerPath, "utf8")),
      bindings: existsSync(join(cache, "legacy-bindings.json"))
        ? JSON.parse(readFileSync(join(cache, "legacy-bindings.json"), "utf8"))
        : {},
      createdAt: new Date().toISOString(),
    }),
    { mode: 0o600, flag: "wx" },
  );
const remote = new AgentConfigStore({
  repository: process.env.AGENT_CONFIG_REPOSITORY,
  ref: candidate,
  token: process.env.AGENT_CONFIG_GITHUB_TOKEN,
});
await remote.start();
remote.stop();
if (!remote.isReady || remote.current.version !== candidate || remote.current.schemaVersion !== 2)
  throw Error("fixed_extension_package_unavailable");
await local.install(candidate, remote.current.sourceFiles!, false);
const oldVersions = readdirSync(cache)
  .filter((p) => /^[a-f0-9]{40}\.json$/.test(p))
  .map((p) => p.slice(0, -5))
  .filter((v) => local.get(v).schemaVersion === 1);
for (const old of oldVersions) {
  try {
    if (local.legacyExtensionVersion(old) !== candidate)
      throw Error("config_immutable_binding_conflict");
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "config_legacy_extension_binding_missing") throw e;
  }
  await local.validateLegacyBinding(old, candidate);
}
for (const old of oldVersions) local.bindLegacy(old, candidate);
const investigationsDir =
  process.env.RCA_INVESTIGATIONS_DIR || join(root, "data", "rca", "investigations");
const repository = new InvestigationRepository(investigationsDir);
let pinned = 0;
if (existsSync(investigationsDir))
  for (const entry of readdirSync(investigationsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^INV-[A-Za-z0-9-]+$/.test(entry.name)) continue;
    const file = join(investigationsDir, entry.name, "investigation.json");
    if (!existsSync(file)) continue;
    const investigation = await repository.get(entry.name);
    if (
      investigation.schemaVersion !== 2 ||
      !["running", "interrupted"].includes(investigation.status)
    )
      continue;
    if (!investigation.agentConfigVersion) {
      local.get(legacyDefault);
      investigation.agentConfigVersion = legacyDefault;
      await repository.save(investigation);
      pinned++;
    }
    if (investigation.agentConfigVersion) {
      const bundle = local.get(investigation.agentConfigVersion);
      if (bundle.schemaVersion === 1) local.legacyExtensionVersion(bundle.version);
    }
  }
if (JSON.parse(readFileSync(pointerPath, "utf8")).version !== prior)
  throw Error("migration_changed_active");
const report = { event: "extension_migration_ready", candidate, prior, oldVersions, pinned };
writeFileSync(join(backupDir, "migration-result.json"), JSON.stringify(report), { mode: 0o600 });
console.log(JSON.stringify(report));
