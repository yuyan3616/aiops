import { Type } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type {
  AgentKind,
  EvidenceView,
  HypothesisState,
} from "../../shared/rca-types";
import type { AgentTask } from "./types";

const AGENT_LABELS: Record<AgentKind, string> = {
  log: "Log Agent",
  metric: "Metric Agent",
  trace: "Trace Agent",
  change: "Change Agent",
};

const TOOL_NAMES: Record<AgentKind, string> = {
  log: "get_log_overview",
  metric: "query_metrics",
  trace: "query_traces",
  change: "get_deployments",
};

const SPECIALIST_PROMPTS: Record<AgentKind, string> = {
  log: `You are Log Agent, a specialist in production log analysis for RCA.
You have exactly one observability tool: get_log_overview.
For every investigation task, you MUST call the tool before answering.
Base conclusions only on tool output. Do not invent logs, counts, timestamps, or causes.
Return a concise Chinese finding in 1-3 sentences. Mention the strongest signal and its time correlation.`,
  metric: `You are Metric Agent, a specialist in service and database metrics for RCA.
You have exactly one observability tool: query_metrics.
For every investigation task, you MUST call the tool before answering.
Base conclusions only on tool output. Do not invent metric values or causal claims.
Return a concise Chinese finding in 1-3 sentences. Mention abnormal metrics and correlation with the incident window.`,
  trace: `You are Trace Agent, a specialist in distributed tracing for RCA.
You have exactly one observability tool: query_traces.
For every investigation task, you MUST call the tool before answering.
Base conclusions only on tool output. Do not invent spans or latency values.
Return a concise Chinese finding in 1-3 sentences. State where abnormal latency concentrates.`,
  change: `You are Change Agent, a specialist in deployment and configuration change analysis for RCA.
You have exactly one observability tool: get_deployments.
For every investigation task, you MUST call the tool before answering.
Base conclusions only on tool output. Do not invent releases or configuration changes.
Return a concise Chinese finding in 1-3 sentences. State whether a change is temporally relevant to the incident.`,
};

const COORDINATOR_PROMPT = `You are the RCA Coordinator for a multi-agent production incident investigation.

You do NOT query observability systems directly. You orchestrate specialist agents through tools.
Available specialist roles: log, metric, trace, change.

Rules:
1. Before every tool call, write 1-2 short Chinese sentences as a USER-VISIBLE investigation summary. This is not private chain-of-thought. State only current evidence and the next action.
2. Use delegate_agents to fan out one or more specialist tasks. Choose agents based on current evidence. Do not call every agent without a reason.
3. After specialist results return, use update_hypotheses to mark hypotheses supported/rejected/validating when evidence justifies it.
4. For the bundled order-service demo, start with log + metric. Do NOT finalize from those two signals alone: use trace to verify the latency locus and change to verify recent deployment/config changes before final RCA.
5. Evidence IDs must come from tool results. Never invent EV ids.
6. When evidence is sufficient, call finalize_rca exactly once with a concise root cause, causal chain, and the evidence ids that support it.
7. If evidence is insufficient, keep investigating rather than guessing.
8. Reply in Chinese. Keep user-visible summaries concise and operational.
`;

export interface SpecialistToolResult {
  display: string;
  evidence: EvidenceView[];
}

export interface AgentRunResult {
  agent: AgentKind;
  summary: string;
  evidence: EvidenceView[];
}

export interface DelegationAssignment {
  agent: AgentKind;
  goal: string;
  service?: string;
}

export interface HypothesisUpdateInput {
  id: string;
  state: HypothesisState;
  supportingEvidenceIds?: string[];
  contradictingEvidenceIds?: string[];
}

export interface FinalRcaInput {
  rootCause: string;
  causalChain: string[];
  evidenceIds: string[];
}

export interface CoordinatorHooks {
  onTextStart(): void;
  onTextDelta(delta: string): void;
  onTextEnd(): void;
  delegate(assignments: DelegationAssignment[]): Promise<AgentRunResult[]>;
  updateHypotheses(updates: HypothesisUpdateInput[]): void;
  finalize(input: FinalRcaInput): void;
}

export class PiRcaAgentClient {
  private modelRuntimePromise?: Promise<ModelRuntime>;
  private currentModel = "auto";

  modelLabel() {
    return this.currentModel;
  }

  private modelRuntime() {
    this.modelRuntimePromise ??= ModelRuntime.create();
    return this.modelRuntimePromise;
  }

  private async createSession(systemPrompt: string, customTools: ToolDefinition[]) {
    const modelRuntime = await this.modelRuntime();
    const cwd = process.cwd();
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => systemPrompt,
    });
    await resourceLoader.reload();

    const requestedProvider = process.env.RCA_MODEL_PROVIDER?.trim();
    const requestedModelId = process.env.RCA_MODEL_ID?.trim();
    if ((requestedProvider && !requestedModelId) || (!requestedProvider && requestedModelId)) {
      throw new Error("RCA_MODEL_PROVIDER and RCA_MODEL_ID must be configured together.");
    }
    const model =
      requestedProvider && requestedModelId
        ? modelRuntime.getModel(requestedProvider, requestedModelId)
        : undefined;
    if (requestedProvider && requestedModelId && !model) {
      throw new Error(`Configured RCA model ${requestedProvider}/${requestedModelId} was not found.`);
    }

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      ...(model ? { model } : {}),
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      noTools: "builtin",
      customTools,
    });
    this.currentModel = `${session.agent.state.model.provider}/${session.agent.state.model.id}`;
    return session;
  }

  async runSpecialist(
    kind: AgentKind,
    task: AgentTask,
    executeTool: () => Promise<SpecialistToolResult>,
  ): Promise<string> {
    let toolCalled = false;
    const toolName = TOOL_NAMES[kind];
    const tool = defineTool({
      name: toolName,
      label: toolName,
      description: `Query fake observability data for ${AGENT_LABELS[kind]}. This tool must be called before giving a finding.`,
      parameters: Type.Object({}),
      execute: async () => {
        toolCalled = true;
        const result = await executeTool();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  display: result.display,
                  evidence: result.evidence.map((item) => ({
                    id: item.id,
                    type: item.type,
                    label: item.label,
                    summary: item.summary,
                    rawRef: item.rawRef,
                  })),
                },
                null,
                2,
              ),
            },
          ],
          details: { evidenceIds: result.evidence.map((item) => item.id) },
        };
      },
    });

    const session = await this.createSession(SPECIALIST_PROMPTS[kind], [tool]);
    let text = "";
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        text += event.assistantMessageEvent.delta;
      }
    });

    try {
      await session.prompt(
        `调查任务：${task.goal}\n服务：${task.service}\n时间窗口：${task.window}\n请先调用 ${toolName}，再基于 Evidence 给出简洁结论。`,
      );
      if (!toolCalled) {
        await session.prompt(`你尚未调用必需工具 ${toolName}。请立即调用该工具，并且只基于工具返回的 Evidence 输出结论。`);
      }
      if (!toolCalled) {
        throw new Error(`${AGENT_LABELS[kind]} did not call required tool ${toolName} after retry.`);
      }
      return text.trim() || `${AGENT_LABELS[kind]} 已完成调查，但未生成文本摘要。`;
    } finally {
      unsubscribe();
      session.dispose();
    }
  }

  async runCoordinator(userPrompt: string, hooks: CoordinatorHooks): Promise<void> {
    const delegateAgents = defineTool({
      name: "delegate_agents",
      label: "delegate_agents",
      description: "Dispatch one investigation round to one or more specialist RCA agents. Assignments in the same call run concurrently.",
      parameters: Type.Object({
        assignments: Type.Array(
          Type.Object({
            agent: Type.Union([
              Type.Literal("log"),
              Type.Literal("metric"),
              Type.Literal("trace"),
              Type.Literal("change"),
            ]),
            goal: Type.String(),
            service: Type.Optional(Type.String()),
          }),
          { minItems: 1, maxItems: 4 },
        ),
      }),
      execute: async (_toolCallId, params) => {
        const results = await hooks.delegate(params.assignments as DelegationAssignment[]);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                results.map((result) => ({
                  agent: result.agent,
                  summary: result.summary,
                  evidence: result.evidence.map((item) => ({
                    id: item.id,
                    type: item.type,
                    label: item.label,
                    summary: item.summary,
                  })),
                })),
                null,
                2,
              ),
            },
          ],
          details: { agents: results.map((item) => item.agent) },
        };
      },
    });

    const updateHypotheses = defineTool({
      name: "update_hypotheses",
      label: "update_hypotheses",
      description: "Update RCA hypotheses using only evidence ids already returned by specialist agents.",
      parameters: Type.Object({
        updates: Type.Array(
          Type.Object({
            id: Type.String(),
            state: Type.Union([
              Type.Literal("possible"),
              Type.Literal("validating"),
              Type.Literal("supported"),
              Type.Literal("rejected"),
            ]),
            supportingEvidenceIds: Type.Optional(Type.Array(Type.String())),
            contradictingEvidenceIds: Type.Optional(Type.Array(Type.String())),
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        hooks.updateHypotheses(params.updates as HypothesisUpdateInput[]);
        return {
          content: [{ type: "text" as const, text: "Hypotheses updated." }],
          details: {},
        };
      },
    });

    let finalized = false;
    const finalizeRca = defineTool({
      name: "finalize_rca",
      label: "finalize_rca",
      description: "Finalize the RCA only after enough evidence has been collected.",
      parameters: Type.Object({
        rootCause: Type.String(),
        causalChain: Type.Array(Type.String(), { minItems: 2, maxItems: 8 }),
        evidenceIds: Type.Array(Type.String(), { minItems: 1 }),
      }),
      execute: async (_toolCallId, params) => {
        hooks.finalize(params as FinalRcaInput);
        finalized = true;
        return {
          content: [{ type: "text" as const, text: "RCA finalized and published to the investigation UI." }],
          details: {},
        };
      },
    });

    const session = await this.createSession(COORDINATOR_PROMPT, [
      delegateAgents,
      updateHypotheses,
      finalizeRca,
    ]);
    let textOpen = false;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "assistant") {
        textOpen = false;
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        if (!textOpen) {
          hooks.onTextStart();
          textOpen = true;
        }
        hooks.onTextDelta(event.assistantMessageEvent.delta);
      }
      if (event.type === "message_end" && textOpen) {
        hooks.onTextEnd();
        textOpen = false;
      }
    });

    try {
      await session.prompt(
        `用户故障描述：${userPrompt}\n\n当前候选假设：\nH1 payment-service 数据库连接池耗尽\nH2 payment-service 新版本引入配置问题\nH3 第三方支付接口超时\nH4 order-service 自身资源异常\n\n请开始 RCA。`,
      );
      if (!finalized) {
        await session.prompt(
          "你还没有调用 finalize_rca。请检查当前 Evidence；若证据仍不足，继续 delegate_agents 调查；若已足够，先更新假设，然后调用 finalize_rca。不要凭空补证据。",
        );
      }
      if (textOpen) hooks.onTextEnd();
    } finally {
      unsubscribe();
      session.dispose();
    }
  }
}
