import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

import {
  bundledVersion,
  configPath,
  referencedPaths,
  validateBundle,
  type ConfigFiles,
} from "./store";

const directory = realpathSync(resolve(process.argv[2] ?? "server/agent-config/bundled"));
const files: ConfigFiles = {};
function read(path: string): string {
  configPath(path);
  const absolute = resolve(directory, path);
  const stat = lstatSync(absolute);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 64 * 1024 ||
    !realpathSync(absolute).startsWith(directory + sep)
  )
    throw new Error("config_invalid_file");
  files[path] = readFileSync(absolute, "utf8");
  return files[path]!;
}
for (const path of referencedPaths(read("manifest.json"))) read(path);
for (const path of JSON.parse(files["manifest.json"]!).roles as string[])
  read(configPath(JSON.parse(files[path]!).systemPrompt));
const bundle = validateBundle(bundledVersion(files), files);
process.stdout.write(
  `配置验证通过：${Object.keys(bundle.roles).length} 个角色，${Object.keys(bundle.skills).length} 个技能\n`,
);
