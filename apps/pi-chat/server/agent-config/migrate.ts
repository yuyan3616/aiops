import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { readConfigDirectory } from "./local-files";
import { AgentConfigStore } from "./store";

// Operator-only command. This capability is never exposed to an Agent.
const [cachePath, packagePath, profileVersions] = process.argv.slice(2);
if (!cachePath || !packagePath || !profileVersions)
  throw new Error(
    "用法：pnpm agent-config:migrate <cache-dir> <已提交配置仓库目录> <旧Profile SHA，逗号分隔>",
  );
const directory = resolve(packagePath);
const version = execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (!/^[a-f0-9]{40}$/.test(version)) throw new Error("config_invalid_commit");
if (execFileSync("git", ["-C", directory, "status", "--porcelain"], { encoding: "utf8" }).trim())
  throw new Error("config_package_must_be_committed");
const store = new AgentConfigStore({ cacheDir: resolve(cachePath) });
await store.start();
store.stop();
const versions = [...new Set(profileVersions.split(","))];
for (const old of versions)
  if (store.get(old).schemaVersion !== 1) throw new Error("config_invalid_legacy_binding");
await store.install(version, readConfigDirectory(directory), false);
// Existing different bindings are refused before any new binding is written.
for (const old of versions) {
  try {
    if (store.legacyExtensionVersion(old) !== version)
      throw new Error("config_immutable_binding_conflict");
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "config_legacy_extension_binding_missing")
      throw error;
  }
}
for (const old of versions) await store.validateLegacyBinding(old, version);
for (const old of versions) store.bindLegacy(old, version);
process.stdout.write(
  `已预存固定工具包并绑定 ${versions.length} 个旧 Profile；active 版本未切换。\n`,
);
