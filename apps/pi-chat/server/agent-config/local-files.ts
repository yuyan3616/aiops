import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

import { configPath, referencedPaths, type ConfigFiles } from "./store";

export function readConfigDirectory(path: string): ConfigFiles {
  const directory = realpathSync(resolve(path));
  const files: ConfigFiles = {};
  function read(path: string): string {
    configPath(path);
    const absolute = resolve(directory, path);
    const stat = lstatSync(absolute);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > (path.endsWith(".mjs") ? 256 * 1024 : 64 * 1024) ||
      !realpathSync(absolute).startsWith(directory + sep)
    )
      throw new Error("config_invalid_file");
    return (files[path] = readFileSync(absolute, "utf8"));
  }
  for (const path of referencedPaths(read("manifest.json"))) read(path);
  for (const path of JSON.parse(files["manifest.json"]!).roles as string[])
    read(configPath(JSON.parse(files[path]!).systemPrompt));
  return files;
}
