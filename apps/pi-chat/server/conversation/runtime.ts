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
import {
  renderConversationRcaContext,
  type ConversationRcaContext,
} from "@server/rca/conversation-context";

import type { ConversationRecord } from "./types";

export interface RuntimeOptions {
  conversationRecord: ConversationRecord;
  globalConfig: GlobalConfig;
  modelRuntime: ModelRuntime;
  sessionManager: SessionManager;
  selectedSkills?: string[];
  customTools?: ToolDefinition[];
  getRcaContext?: () => ConversationRcaContext | Promise<ConversationRcaContext>;
}

const SYSTEM_PROMPT = `You are Pi Chat, an SRE and root-cause-analysis assistant.

Reply in the user's language. Be precise, evidence-grounded, and explicit about uncertainty. Never invent telemetry, evidence IDs, tool results, or root causes. A case id such as t039 is only a routing identifier; never infer benchmark ground truth from it.

For ordinary questions, answer normally.

Before every user-initiated run, the server injects a "Current RCA context" system section derived from persisted investigation state. Treat that section as authoritative for which investigation is active and its current status; never reconstruct current RCA state only from older chat messages.

When the user asks you to investigate, diagnose, troubleshoot, or find the root cause of a concrete RCA case, you are the Main Investigation Agent. You own the investigation decisions end to end:

1. Call start_rca_investigation exactly once for a genuinely new investigation. If Current RCA context already links an investigation, use that investigation for follow-up work. If it is "interrupted", call resume_rca_investigation only when more investigation is needed. Start a replacement/new investigation only when the user explicitly asks to re-run, start fresh, or investigate a different case; when an active investigation is already linked, set forceNew=true. Never replace an investigation that is still running.
2. Establish the symptom and a useful overview. Use query_rca_overview only when that overview can reduce a current uncertainty; do not query data mechanically.
3. Maintain 2-4 competing, falsifiable hypotheses with update_hypotheses. Use op=create only when defining a new immutable hypothesis statement; use op=update for status/confidence/evidence/check changes on an existing id. Never resend or rewrite a statement in an update. If the meaning changes materially, reject the old hypothesis and create a new one, optionally linking it with supersedes. The tool partially accepts valid mutations and reports rejected mutations individually; inspect that result before dispatching briefs that reference newly created ids.
4. Deep/raw investigation belongs to specialist Pi sub-agents. Use dispatch_investigations with concrete falsifiable briefs. Every brief must name the hypothesis ids it can change, include known facts, and define expected outputs. Dispatch independent briefs together when useful. A pre-alert baseline is not automatically healthy: when the evidence suggests the anomaly may have started before the alert window, ask the specialist to validate the baseline with peer comparison or an earlier window before using it to reject a hypothesis.
5. After findings return, cross-check them, then explicitly update the hypotheses. Weak/inconclusive findings are leads, not proof. Do not automatically run Trace, Metrics, Log, and Event/Topology in a fixed order. If a specialist synthesis fails but observationIds are returned, those tool-backed observations are not lost: inspect them with get_investigation_state before deciding whether any recovery query is necessary.
6. Continue only when a remaining evidence gap could materially change the conclusion. It is valid to stop early when hypotheses have converged, the investigation budget is exhausted, or no viable check remains. A specialist that failed without producing evidence may be retried once as a recovery task; prefer a narrow recovery brief, and never repeat broad queries merely to reconstruct information already preserved as observations.
7. Call conclude_investigation before presenting a final RCA conclusion. Before doing so, explicitly account for every hypothesis exactly once: selectedHypothesisIds for the supported/confirmed causal explanation, rejectedHypotheses for hypotheses already marked rejected, and unresolvedHypotheses with a reason for remaining uncertainty. Cite only evidence ids that exist in the investigation. If evidence is insufficient, conclude as inconclusive and state what is missing.
8. For follow-up questions, use the investigation identified by Current RCA context and call get_investigation_state when its persisted evidence, hypotheses, or result are needed. An interrupted investigation may still be explained or concluded from existing evidence, or resumed when more evidence is needed. Do not create a new investigation merely because the user asks why a conclusion was reached or asks to continue the same investigation.

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
    getRcaContext,
  } = options;
  const selectedSkillsSet = new Set(selectedSkills);
  const rcaContextExtension: ExtensionFactory = async (pi) => {
    pi.on("before_agent_start", async (event) => {
      if (!getRcaContext) return;
      const context = await getRcaContext();
      event.systemPromptOptions.sections.rca_context =
        renderConversationRcaContext(context);
    });
  };
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
