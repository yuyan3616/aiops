import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

import { configPath, referencedPaths, validateBundle, type ConfigFiles } from "./store";

if (!process.argv[2])
  throw new Error("请提供独立配置仓库目录：pnpm agent-config:validate /path/to/aiops-agent-config");
const directory = realpathSync(resolve(process.argv[2]));
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
const bundle = validateBundle("0".repeat(40), files);
process.stdout.write(
  `配置验证通过：${Object.keys(bundle.roles).length} 个角色，${Object.keys(bundle.skills).length} 个技能\n`,
);
