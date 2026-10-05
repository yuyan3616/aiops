import { createRequire } from "node:module";
import { dirname } from "node:path";

import {
  createAgentSessionRuntime,
  getAgentDir,
  SessionManager,
  createAgentSessionServices,
  ModelRuntime,
  createAgentSessionFromServices,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { GlobalConfig } from "@server/config";
import { type ConversationRcaContext } from "@server/rca/conversation-context";

import { toolsExtensionFactory } from "../agent-config/extension-loader";
import { createMainConfigExtension } from "../agent-config/main-extension";
import { agentConfigStore, renderMainConfig } from "../agent-config/store";
import type { ConversationRecord } from "./types";

export interface RuntimeOptions {
  conversationRecord: ConversationRecord;
  globalConfig: GlobalConfig;
  modelRuntime: ModelRuntime;
  sessionManager: SessionManager;
  configTools: ToolDefinition[];
  agentConfigVersion: string;
  getAgentConfigVersion?: () => Promise<string>;
  getRcaContext?: () => ConversationRcaContext | Promise<ConversationRcaContext>;
}

const webAccessExtensionPath = dirname(
  createRequire(import.meta.url).resolve("pi-web-access/package.json"),
);

const langfuseExtensionPath = dirname(
  createRequire(import.meta.url).resolve("@langfuse/pi-observability-plugin/package.json"),
);

export async function createRuntime(options: RuntimeOptions) {
  const {
    conversationRecord,
    globalConfig,
    modelRuntime,
    sessionManager,
    configTools,
    agentConfigVersion,
    getRcaContext,
    getAgentConfigVersion,
  } = options;
  const rcaContextExtension = createMainConfigExtension({ getAgentConfigVersion, getRcaContext });
  let runtimeSessionManager = sessionManager;
  if (!runtimeSessionManager) {
    SessionManager.create(conversationRecord.workspaceDir, globalConfig.sessionsDir, {
      id: conversationRecord.id,
    });
  }

  const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      resourceLoaderOptions: {
        noExtensions: true,
        systemPromptOverride: () => renderMainConfig(agentConfigStore.get(agentConfigVersion)),
        additionalExtensionPaths: [webAccessExtensionPath, langfuseExtensionPath],
        extensionFactories: [
          toolsExtensionFactory(configTools),
          rcaContextExtension,
          async (pi) => {
            const packageName = "pi-mcp-adapter";
            const { createMcpAdapter } = (await import(packageName)) as {
              createMcpAdapter(options: { configPath: string }): ExtensionFactory;
            };
            await createMcpAdapter({ configPath: globalConfig.mcpConfigPath })(pi);
          },
        ],
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
        appendSystemPromptOverride: () => [],
      },
    });
    const loaded = services.resourceLoader.getExtensions();
    if (loaded.errors.length) throw new Error("config_extension_binding_failed");
    const registered = new Set<string>();
    for (const extension of loaded.extensions) for (const name of extension.tools.keys()) {
      if (registered.has(name)) throw new Error("config_tool_name_conflict");
      registered.add(name);
    }
    const toolDefinitions = configTools;
    const agentSession = await createAgentSessionFromServices({
      services,
      sessionManager,
      noTools: "builtin",
      tools: toolDefinitions.map((tool) => tool.name),

    });

    await agentSession.session.bindExtensions({});
    return {
      ...agentSession,
      services,
      diagnostics: services.diagnostics,
    };
  };
  return createAgentSessionRuntime(factory, {
    cwd: conversationRecord.workspaceDir,
    agentDir: getAgentDir(),
    sessionManager: runtimeSessionManager,
  });
}
