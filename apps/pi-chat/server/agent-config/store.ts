import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPERT_TOOLS = [
  "search_traces",
  "get_trace",
  "search_logs",
  "discover_metrics",
  "query_metrics",
] as const;
export const MAIN_TOOLS = [
  "utc_time",
  "start_rca_investigation",
  "resume_rca_investigation",
  "query_rca_overview",
  "update_hypotheses",
  "dispatch_investigations",
  "get_investigation_state",
  "conclude_investigation",
] as const;
export interface ConfigSkill {
  id: string;
  keywords?: string[];
  baseline?: boolean;
}
export interface ConfigRole {
  id: string;
  kind: "main" | "expert";
  name: string;
  systemPrompt: string;
  tools: string[];
  skills: ConfigSkill[];
}
export interface ConfigBundle {
  version: string;
  roles: Record<string, ConfigRole>;
  skills: Record<string, { id: string; title: string; content: string }>;
}
export type ConfigFiles = Record<string, string>;
const MAX_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_FILES = 128;
const VERSION = /^(?:[a-f0-9]{40}|bundled-[a-f0-9]{40})$/;
const ID = /^[a-z][a-z0-9-]{0,47}$/;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("config_invalid_object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("config_unknown_field");
}
function string(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("config_invalid_string");
  return value;
}
function strings(value: unknown, max = 32): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("config_invalid_array");
  const result = value.map((entry) => string(entry));
  if (new Set(result).size !== result.length) throw new Error("config_duplicate_entry");
  return result;
}
function identifier(value: unknown): string {
  const id = string(value, 48);
  if (!ID.test(id) || ["__proto__", "constructor", "prototype", "event-topology"].includes(id))
    throw new Error("config_invalid_id");
  return id;
}
export function configPath(value: unknown): string {
  const path = string(value);
  if (!/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:json|md)$/.test(path))
    throw new Error("config_invalid_path");
  return path;
}
export function referencedPaths(manifestText: string): string[] {
  const manifest = object(JSON.parse(manifestText));
  keys(manifest, ["schemaVersion", "roles", "skills"]);
  if (manifest.schemaVersion !== 1) throw new Error("config_unsupported_schema");
  return [
    ...strings(manifest.roles, 16).map(configPath),
    ...Object.values(object(manifest.skills)).map((entry) => configPath(object(entry).path)),
  ];
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function validateBundle(version: string, files: ConfigFiles): ConfigBundle {
  if (!VERSION.test(version)) throw new Error("config_invalid_version");
  if (
    Object.keys(files).length > MAX_FILES ||
    Object.values(files).reduce((sum, text) => sum + Buffer.byteLength(text), 0) > MAX_BYTES
  )
    throw new Error("config_bundle_too_large");
  for (const [path, content] of Object.entries(files)) {
    configPath(path);
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_FILE_BYTES)
      throw new Error("config_file_too_large");
  }
  const read = (path: unknown) => {
    const key = configPath(path);
    if (!Object.hasOwn(files, key)) throw new Error("config_missing_file");
    return files[key]!;
  };
  const manifest = object(JSON.parse(read("manifest.json")));
  referencedPaths(read("manifest.json"));
  const skills: ConfigBundle["skills"] = Object.create(null);
  for (const [rawId, rawSkill] of Object.entries(object(manifest.skills))) {
    const id = identifier(rawId);
    const skill = object(rawSkill);
    keys(skill, ["title", "path"]);
    skills[id] = {
      id,
      title: string(skill.title),
      content: string(read(skill.path), MAX_FILE_BYTES),
    };
  }
  const roles: ConfigBundle["roles"] = Object.create(null);
  for (const path of strings(manifest.roles, 16)) {
    const role = object(JSON.parse(read(path)));
    keys(role, ["id", "kind", "name", "systemPrompt", "tools", "skills"]);
    const id = identifier(role.id);
    if (roles[id]) throw new Error("config_duplicate_role");
    if (role.kind !== "main" && role.kind !== "expert") throw new Error("config_invalid_kind");
    if ((id === "main") !== (role.kind === "main")) throw new Error("config_requires_single_main");
    const tools = strings(role.tools);
    const allowed: readonly string[] = role.kind === "main" ? MAIN_TOOLS : EXPERT_TOOLS;
    if (tools.some((tool) => !allowed.includes(tool)) || !tools.length)
      throw new Error("config_unknown_tool");
    if (
      (tools.includes("get_trace") && !tools.includes("search_traces")) ||
      (tools.includes("query_metrics") && !tools.includes("discover_metrics"))
    )
      throw new Error("config_missing_discovery_tool");
    if (!Array.isArray(role.skills) || role.skills.length > 32)
      throw new Error("config_invalid_skills");
    const selected = role.skills.map((raw) => {
      const entry = object(raw);
      keys(entry, ["id", "keywords", "baseline"]);
      const skillId = identifier(entry.id);
      if (!skills[skillId]) throw new Error("config_unknown_skill");
      if (entry.baseline !== undefined && typeof entry.baseline !== "boolean")
        throw new Error("config_invalid_selector");
      return {
        id: skillId,
        ...(entry.keywords !== undefined ? { keywords: strings(entry.keywords) } : {}),
        ...(entry.baseline !== undefined ? { baseline: entry.baseline as boolean } : {}),
      };
    });
    roles[id] = {
      id,
      kind: role.kind,
      name: string(role.name),
      systemPrompt: string(read(role.systemPrompt), MAX_FILE_BYTES),
      tools,
      skills: selected,
    };
  }
  if (!roles.main || Object.values(roles).filter((role) => role.kind === "expert").length < 1)
    throw new Error("config_missing_roles");
  return freeze({ version, roles, skills });
}
const bundledDir = join(dirname(fileURLToPath(import.meta.url)), "bundled");
export function readBundledFiles(): ConfigFiles {
  const files: ConfigFiles = {
    "manifest.json": readFileSync(join(bundledDir, "manifest.json"), "utf8"),
  };
  for (const path of referencedPaths(files["manifest.json"]!))
    files[path] = readFileSync(join(bundledDir, path), "utf8");
  for (const path of JSON.parse(files["manifest.json"]!).roles as string[]) {
    const prompt = configPath(JSON.parse(files[path]!).systemPrompt);
    files[prompt] = readFileSync(join(bundledDir, prompt), "utf8");
  }
  return files;
}
export function bundledVersion(files: ConfigFiles): string {
  return `bundled-${createHash("sha1")
    .update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))))
    .digest("hex")}`;
}
interface CacheSnapshot {
  version: string;
  files: ConfigFiles;
}
export interface ConfigStoreOptions {
  cacheDir?: string;
  repository?: string;
  ref?: string;
  token?: string;
  refreshMs?: number;
  fetch?: typeof fetch;
}
export class AgentConfigStore {
  private readonly bundles = new Map<string, ConfigBundle>();
  private active: ConfigBundle;
  private readonly defaultBundle: ConfigBundle;
  private pending?: Promise<boolean>;
  private timer?: ReturnType<typeof setInterval>;
  private options: ConfigStoreOptions;
  lastRefreshError?: string;
  constructor(options: ConfigStoreOptions = {}) {
    this.options = options;
    const files = readBundledFiles();
    this.active = validateBundle(bundledVersion(files), files);
    this.defaultBundle = this.active;
    this.bundles.set(this.active.version, this.active);
  }
  get current(): ConfigBundle {
    return this.active;
  }
  get bundled(): ConfigBundle {
    return this.defaultBundle;
  }
  get(version?: string): ConfigBundle {
    if (!version) return this.active;
    if (!VERSION.test(version)) throw new Error("config_invalid_version");
    const loaded = this.bundles.get(version);
    if (loaded) return loaded;
    if (!this.options.cacheDir) throw new Error("config_pinned_version_missing");
    const path = join(this.options.cacheDir, `${version}.json`);
    if (!existsSync(path)) throw new Error("config_pinned_version_missing");
    if (Buffer.byteLength(readFileSync(path)) > MAX_BYTES * 2)
      throw new Error("config_cache_too_large");
    const snapshot = JSON.parse(readFileSync(path, "utf8")) as CacheSnapshot;
    if (snapshot.version !== version) throw new Error("config_cache_version_mismatch");
    const bundle = validateBundle(version, snapshot.files);
    this.bundles.set(version, bundle);
    return bundle;
  }
  private atomicWrite(path: string, content: string) {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  }
  activate(version: string, files: ConfigFiles): ConfigBundle {
    const bundle = validateBundle(version, files);
    const existing = this.bundles.get(version);
    if (existing && JSON.stringify(existing) !== JSON.stringify(bundle))
      throw new Error("config_immutable_version_conflict");
    if (this.options.cacheDir) {
      const path = join(this.options.cacheDir, `${version}.json`);
      if (existsSync(path)) {
        const cached = this.get(version);
        if (JSON.stringify(cached) !== JSON.stringify(bundle))
          throw new Error("config_immutable_version_conflict");
      } else this.atomicWrite(path, JSON.stringify({ version, files }));
      this.atomicWrite(join(this.options.cacheDir, "active.json"), JSON.stringify({ version }));
    }
    this.bundles.set(version, bundle);
    this.active = bundle;
    return bundle;
  }
  async start(options?: ConfigStoreOptions): Promise<void> {
    if (options) this.options = options;
    if (this.options.cacheDir) {
      const pointer = join(this.options.cacheDir, "active.json");
      try {
        if (existsSync(pointer))
          this.active = this.get(JSON.parse(readFileSync(pointer, "utf8")).version);
      } catch {
        this.lastRefreshError = "config_cache_invalid";
        process.stderr.write("Agent configuration: config_cache_invalid; using bundled snapshot\n");
      }
      const files = readBundledFiles();
      const version = bundledVersion(files);
      const path = join(this.options.cacheDir, `${version}.json`);
      if (!existsSync(path)) this.atomicWrite(path, JSON.stringify({ version, files }));
    }
    await this.refresh();
    if (this.options.repository && !this.timer) {
      this.timer = setInterval(
        () => {
          void this.refresh();
        },
        Math.max(30_000, this.options.refreshMs ?? 60_000),
      );
      this.timer.unref();
    }
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  refresh(): Promise<boolean> {
    if (this.pending) return this.pending;
    this.pending = this.download()
      .catch(() => {
        if (this.lastRefreshError !== "config_refresh_failed")
          process.stderr.write(
            "Agent configuration: config_refresh_failed; retaining last good version\n",
          );
        this.lastRefreshError = "config_refresh_failed";
        return false;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private async download(): Promise<boolean> {
    const { repository, ref = "main", token } = this.options;
    if (!repository) return false;
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) || !ref || ref.length > 200)
      throw new Error("config_invalid_repository");
    const signal = AbortSignal.timeout(20_000);
    let total = 0;
    const request = async (suffix: string) => {
      const response = await (this.options.fetch ?? fetch)(
        `https://api.github.com/repos/${repository}/${suffix}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal,
          redirect: "error",
        },
      );
      if (!response.ok || !response.body) throw new Error("config_github_unavailable");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          total += value.byteLength;
          if (bytes > MAX_BYTES * 2 || total > MAX_BYTES * 4)
            throw new Error("config_download_too_large");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    };
    const commit = await request(`commits/${encodeURIComponent(ref)}`);
    const version = string(commit.sha);
    if (!/^[a-f0-9]{40}$/.test(version)) throw new Error("config_invalid_commit");
    if (version === this.active.version) {
      this.lastRefreshError = undefined;
      return false;
    }
    const files: ConfigFiles = {};
    const read = async (path: string) => {
      configPath(path);
      if (Object.hasOwn(files, path)) return files[path]!;
      if (Object.keys(files).length >= MAX_FILES) throw new Error("config_too_many_files");
      const result = await request(`contents/${path}?ref=${version}`);
      if (
        result.type !== "file" ||
        result.encoding !== "base64" ||
        typeof result.content !== "string" ||
        typeof result.size !== "number" ||
        result.size > MAX_FILE_BYTES
      )
        throw new Error("config_invalid_remote_file");
      files[path] = Buffer.from(result.content, "base64").toString("utf8");
      return files[path]!;
    };
    for (const path of referencedPaths(await read("manifest.json"))) await read(path);
    for (const path of JSON.parse(files["manifest.json"]!).roles as string[])
      await read(configPath(JSON.parse(files[path]!).systemPrompt));
    this.activate(version, files);
    this.lastRefreshError = undefined;
    return true;
  }
}
export const agentConfigStore = new AgentConfigStore();
export function renderMainConfig(bundle: ConfigBundle): string {
  const role = bundle.roles.main!;
  const skills = role.skills
    .map((entry) => bundle.skills[entry.id]!)
    .map((entry) => `## 技能：${entry.title}\n${entry.content}`)
    .join("\n\n");
  const experts = Object.values(bundle.roles)
    .filter((entry) => entry.kind === "expert")
    .map((entry) => `- ${entry.id}：${entry.name}；工具：${entry.tools.join(", ")}`)
    .join("\n");
  return `# 角色：${role.name}\n\n${role.systemPrompt}\n\n${skills}\n\n## 当前角色注册表（配置版本 ${bundle.version}）\ndispatch 的 role 必须使用下列 ID。\n${experts}`;
}
