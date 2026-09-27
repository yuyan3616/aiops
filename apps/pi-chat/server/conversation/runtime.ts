import { createRequire } from "node:module";
import { dirname } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import {
  createAgentSessionRuntime,
  getAgentDir,
  SessionManager,
  createAgentSessionServices,
  ModelRuntime,
  createAgentSessionFromServices,
  type CreateAgentSessionRuntimeFactory,
  defineTool,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { GlobalConfig } from "@server/config";

import type { ConversationRecord } from "./types";

export interface RuntimeOptions {
  conversationRecord: ConversationRecord;
  globalConfig: GlobalConfig;
  modelRuntime: ModelRuntime;
  sessionManager: SessionManager;
  selectedSkills?: string[];
  customTools?: ToolDefinition[];
}

const SYSTEM_PROMPT = `You are Pi Chat, an SRE and root-cause-analysis assistant.

Reply in the user's language. Be precise and evidence-grounded. Never invent telemetry, evidence IDs, tool results, or root causes.

When the user asks you to investigate, diagnose, troubleshoot, or find the root cause of a concrete RCA case (for example t039), call investigate_rca_case. That tool runs the auditable RCA workflow, streams specialist investigations into the conversation, and returns the structured result. Do not simulate that workflow in prose and do not guess from the case ID.

After investigate_rca_case returns, synthesize the result for the user. Cite the returned evidence IDs when explaining why a conclusion is supported or why an alternative was rejected. Preserve uncertainty when the result is inconclusive.

For follow-up questions, use the investigation result already present in the conversation when it is sufficient. Start another investigation only when the user explicitly asks to re-run, deepen, or investigate a new case.

Your visible thinking stream is produced by the Pi runtime itself. Do not manufacture fake thinking or fixed investigation narration in normal answers.`;

const utcTimeTool = defineTool({
  name: "utc_time",
  label: "utc_time",
  description: "return the current UTC ISO timestamp",
  parameters: Type.Object({}),
  execute: async () => ({
    content: [{ type: "text", text: new Date().toISOString() }],
    details: {},
  }),
});

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
    selectedSkills = [],
    customTools = [],
  } = options;
  const selectedSkillsSet = new Set(selectedSkills);
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
        systemPromptOverride: () => SYSTEM_PROMPT,
        additionalExtensionPaths: [webAccessExtensionPath, langfuseExtensionPath],
        extensionFactories: [
          async (pi) => {
            const packageName = "pi-mcp-adapter";
            const { createMcpAdapter } = (await import(packageName)) as {
              createMcpAdapter(options: { configPath: string }): ExtensionFactory;
            };
            await createMcpAdapter({ configPath: globalConfig.mcpConfigPath })(pi);
          },
        ],
        noSkills: true,
        additionalSkillPaths: [globalConfig.skillsDir],
        skillsOverride: (base) => ({
          ...base,
          skills: base.skills.filter((skill) => selectedSkillsSet.has(skill.name)),
        }),
      },
    });
    const toolDefinitions = [utcTimeTool, ...customTools];
    const agentSession = await createAgentSessionFromServices({
      services,
      sessionManager,
      noTools: "builtin",
      tools: toolDefinitions.map((tool) => tool.name),
      customTools: toolDefinitions,
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
