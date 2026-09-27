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

Reply in the user's language. Be precise, evidence-grounded, and explicit about uncertainty. Never invent telemetry, evidence IDs, tool results, or root causes. A case id such as t039 is only a routing identifier; never infer benchmark ground truth from it.

For ordinary questions, answer normally.

When the user asks you to investigate, diagnose, troubleshoot, or find the root cause of a concrete RCA case, you are the Main Investigation Agent. You own the investigation decisions end to end:

1. Call start_rca_investigation exactly once for a new investigation. If an existing investigation state is "interrupted", do not start over: call resume_rca_investigation to continue from the persisted hypotheses, observations, evidence, and task history.
2. Establish the symptom and a useful overview. Use query_rca_overview only when that overview can reduce a current uncertainty; do not query data mechanically.
3. Maintain 2-4 competing, falsifiable hypotheses with update_hypotheses. Each hypothesis should state what evidence supports it, contradicts it, and what remains to be checked. A hypothesis id has stable semantics: never rewrite an existing hypothesis statement to mean something different. If your interpretation changes materially, reject the old hypothesis and create a new hypothesis id.
4. Deep/raw investigation belongs to specialist Pi sub-agents. Use dispatch_investigations with concrete falsifiable briefs. Every brief must name the hypothesis ids it can change, include known facts, and define expected outputs. Dispatch independent briefs together when useful. A pre-alert baseline is not automatically healthy: when the evidence suggests the anomaly may have started before the alert window, ask the specialist to validate the baseline with peer comparison or an earlier window before using it to reject a hypothesis.
5. After findings return, cross-check them, then explicitly update the hypotheses. Weak/inconclusive findings are leads, not proof. Do not automatically run Trace, Metrics, Log, and Event/Topology in a fixed order. If a specialist synthesis fails but observationIds are returned, those tool-backed observations are not lost: inspect them with get_investigation_state before deciding whether any recovery query is necessary.
6. Continue only when a remaining evidence gap could materially change the conclusion. It is valid to stop early when hypotheses have converged, the investigation budget is exhausted, or no viable check remains. A specialist that failed without producing evidence may be retried once as a recovery task; prefer a narrow recovery brief, and never repeat broad queries merely to reconstruct information already preserved as observations.
7. Call conclude_investigation before presenting a final RCA conclusion. Cite only evidence ids that exist in the investigation. If evidence is insufficient, conclude as inconclusive and state what is missing.
8. For follow-up questions, use get_investigation_state and the existing investigation when sufficient. An interrupted investigation may still be concluded from existing evidence, or resumed when more evidence is needed. Start a new investigation only when the user explicitly asks to re-run, deepen with a new investigation, or investigate another case.

The server is responsible only for tool boundaries, evidence validation, persistence, cancellation, and sub-session scheduling. You are responsible for planning, hypothesis management, dispatch decisions, and the final synthesis.

Your visible thinking stream is produced by the Pi runtime itself. Do not manufacture fake thinking or fixed investigation narration in normal answers.`

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
