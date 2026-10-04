import { createHash } from "node:crypto";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { parse } from "acorn";

import { LIVE_LIMITS } from "../rca/live/types";
import type { ConfigBundle, ConfigFiles } from "./store";

export const HOST_API_VERSION = "1";
export interface ConfigExtension {
  entry: string;
  sha256: string;
}
export type ExtensionHost = Record<string, unknown>;
type ExtensionModule = {
  createExtension: (options: { sdk: typeof sdk; host: ExtensionHost }) => ExtensionFactory;
};
const sdk = Object.freeze({ Type, defineTool, limits: LIVE_LIMITS });
export function moduleHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// A format rule for trusted, self-contained modules. This is NOT a JS sandbox.
export function validateModule(text: string) {
  const ast = parse(text, { ecmaVersion: "latest", sourceType: "module" });
  for (const statement of ast.body) {
    if (
      statement.type !== "ExportNamedDeclaration" ||
      statement.declaration?.type !== "FunctionDeclaration"
    )
      throw new Error("config_module_top_level_effect");
  }
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    const node = value as { type?: string; callee?: { type?: string; name?: string } };
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ImportExpression" ||
      (node.type === "CallExpression" && ["require", "eval"].includes(node.callee?.name ?? ""))
    )
      throw new Error("config_module_dependency_forbidden");
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  }
  visit(ast);
}

export async function collectExtensionTools(
  bundle: ConfigBundle,
  roleId: string,
  host: ExtensionHost,
  files?: ConfigFiles,
  directory?: string,
): Promise<ToolDefinition[]> {
  const role = bundle.roles[roleId];
  if (!role || bundle.schemaVersion !== 2) throw new Error("config_extensions_unavailable");
  const definitions = new Map<string, ToolDefinition>();
  for (const id of role.extensions ?? []) {
    const extension = bundle.extensions![id]!;
    const absolute = directory ? join(directory, extension.entry) : undefined;
    if (
      absolute &&
      (lstatSync(absolute).isSymbolicLink() ||
        !lstatSync(absolute).isFile() ||
        !realpathSync(absolute).startsWith(realpathSync(directory!) + sep))
    )
      throw new Error("config_invalid_cached_module");
    const source = absolute ? readFileSync(absolute, "utf8") : files![extension.entry]!;
    if (moduleHash(source) !== extension.sha256) throw new Error("config_module_hash_mismatch");
    validateModule(source);
    const url = directory
      ? pathToFileURL(join(directory, extension.entry)).href
      : `data:text/javascript;base64,${Buffer.from(source + "\n// " + bundle.version).toString("base64")}`;
    const module = (await import(url)) as ExtensionModule;
    if (typeof module.createExtension !== "function")
      throw new Error("config_extension_export_missing");
    const factory = module.createExtension({ sdk, host });
    if (typeof factory !== "function") throw new Error("config_extension_factory_missing");
    let sealed = false;
    await factory({
      registerTool(tool: ToolDefinition) {
        if (sealed) throw new Error("config_late_tool_registration");
        if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name) || definitions.has(tool.name))
          throw new Error("config_tool_name_conflict");
        if (
          !tool.parameters ||
          typeof tool.parameters !== "object" ||
          Array.isArray(tool.parameters) ||
          (tool.parameters as { type?: unknown }).type !== "object" ||
          typeof tool.execute !== "function" ||
          typeof tool.description !== "string" ||
          typeof tool.label !== "string"
        )
          throw new Error("config_invalid_tool_definition");
        definitions.set(tool.name, tool);
      },
    } as Parameters<ExtensionFactory>[0]);
    sealed = true;
  }
  if (
    role.tools.some((name) => !definitions.has(name)) ||
    (role.kind === "expert" && !definitions.has("submit_finding"))
  )
    throw new Error("config_allowed_tool_missing");
  if (role.kind === "main" && definitions.has("submit_finding"))
    throw new Error("config_invalid_protocol_role");
  return [...definitions.values()].filter(
    (tool) => role.tools.includes(tool.name) || tool.name === "submit_finding",
  );
}

export async function preflightExtensions(bundle: ConfigBundle, files: ConfigFiles) {
  const host = new Proxy(Object.create(null), {
    get: () => () => {
      throw new Error("config_factory_host_io_forbidden");
    },
  });
  for (const role of Object.values(bundle.roles))
    await collectExtensionTools(bundle, role.id, host, files);
}

export function toolsExtensionFactory(tools: ToolDefinition[]): ExtensionFactory {
  return (pi) => {
    for (const tool of tools) pi.registerTool(tool);
  };
}
