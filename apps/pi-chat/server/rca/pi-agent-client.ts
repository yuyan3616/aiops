import { readFile } from "node:fs/promises";

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

import type { AgentKind, EvidenceView, HypothesisState } from "../../shared/rca-types";
import type { SpecialistExecutionContext } from "./harness/task-types";
import type { RcaToolName } from "./tool-gateway";

const AGENT_LABELS: Record<AgentKind, string> = {
  log: "Log Agent",
  metric: "Metric Agent",
  trace: "Trace Agent",
  context: "Context Agent",
};

const SPECIALIST_PROMPTS: Record<AgentKind, string> = {
  log: `You are Log Agent, a specialist in production log analysis for root cause analysis.
You can use query_logs and analyze_log_patterns against an RCA100 incident case.
You MUST call at least one tool before answering. Use more than one query when needed to validate a pattern.
Do not invent logs, counts, timestamps, entities, or causes. Tool output is factual observation, not a root-cause answer.
Return a concise Chinese finding in 1-3 sentences and cite Evidence IDs explicitly.`,
  metric: `You are Metric Agent, a specialist in metrics and time-series evidence for root cause analysis.
You can use list_metrics to discover metric names and query_metrics to retrieve incident-window statistics.
Do not guess metric names when discovery is needed. You MUST call at least one tool before answering.
Do not invent values or causal claims. Return a concise Chinese finding in 1-3 sentences and cite Evidence IDs explicitly.`,
  trace: `You are Trace Agent, a specialist in distributed tracing for root cause analysis.
You can use search_traces to locate slow/error spans and get_trace to inspect a concrete trace.
You MUST call at least one tool before answering. Distinguish the alerted service from the span/service where latency or errors accumulate.
Do not invent spans or latency values. Return a concise Chinese finding in 1-3 sentences and cite Evidence IDs explicitly.`,
  context: `You are Context Agent, a specialist in Kubernetes events, alert context, and service topology for root cause analysis.
You can use query_events, query_alerts, and get_topology_neighbors.
You MUST call at least one tool before answering. Use topology to describe relationships; use events/alerts only as corroborating context.
Do not infer a deployment/configuration change unless the queried data supports it. Return a concise Chinese finding in 1-3 sentences and cite Evidence IDs explicitly.`,
};

const COORDINATOR_BASE_PROMPT = `You are the RCA Coordinator for an evidence-driven multi-agent production incident investigation.

You do NOT query observability data directly. You orchestrate specialist agents through delegate_agents.
Available specialist roles: log, metric, trace, context.

Hard rules:
1. Before every tool call, write 1-2 short Chinese sentences as a USER-VISIBLE investigation summary. This is a bounded investigation summary, not private chain-of-thought.
2. Choose specialists based on the current evidence. Do not call all agents mechanically.
3. Evidence IDs must come from specialist tool results. Never invent EV ids.
4. update_hypotheses may only reference evidence IDs already returned by specialists.
5. Do not equate the alerted entity with the root cause without evidence.
6. When multiple modalities are available, collect evidence from at least two independent modalities before finalizing unless the case genuinely lacks them.
7. finalize_rca exactly once, only when the evidence chain explains root-cause entity -> fault/mechanism -> propagation -> alert symptom.
8. If evidence is insufficient or contradictory, continue investigating rather than guessing.
9. Reply in Chinese. Keep user-visible summaries concise and operational.`;

export interface SpecialistToolResult {
  display: string;
  evidence: EvidenceView[];
  correlation?: Record<string, string>;
}

export interface AgentRunResult {
  agent: AgentKind;
  taskId: string;
  summary: string;
  evidence: EvidenceView[];
  toolCallCount: number;
  turnCount: number;
  durationMs: number;
}

export interface DelegationAssignment {
  agent: AgentKind;
  goal: string;
  service?: string;
  operation?: string;
  evidenceIds?: string[];
  hypothesisIds?: string[];
}

export interface HypothesisUpdateInput {
  id: string;
  state: HypothesisState;
  supportingEvidenceIds?: string[];
  contradictingEvidenceIds?: string[];
}

export interface FinalRcaInput {
  rootCauseEntity: string;
  faultType: string;
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

export type ExecuteSpecialistTool = (
  name: RcaToolName,
  args: Record<string, unknown>,
) => Promise<SpecialistToolResult>;


export interface SpecialistRunHooks {
  executeTool: ExecuteSpecialistTool;
  onTurnStart(): void;
}

export interface SpecialistSessionHandle {
  readonly kind: AgentKind;
  run(context: SpecialistExecutionContext, hooks: SpecialistRunHooks): Promise<string>;
  abort(): void;
  dispose(): void;
}

function evidenceForModel(evidence: EvidenceView[]) {
  return evidence.map((item) => ({
    id: item.id,
    modality: item.modality,
    label: item.label,
    summary: item.summary,
    entityRefs: item.entityRefs,
    timeRange: item.timeRange,
    observation: item.observation,
    rawRef: item.rawRef,
  }));
}

function optionalTimeFields() {
  return {
    startTime: Type.Optional(Type.String({ description: "ISO8601 start time; defaults to incident start" })),
    endTime: Type.Optional(Type.String({ description: "ISO8601 end time; defaults to incident end" })),
  };
}

export class PiRcaAgentClient {
  private modelRuntimePromise?: Promise<ModelRuntime>;
  private currentModel = "auto";
  private skillPromise?: Promise<string>;

  modelLabel() {
    return this.currentModel;
  }

  private modelRuntime() {
    this.modelRuntimePromise ??= ModelRuntime.create();
    return this.modelRuntimePromise;
  }

  private rcaSkill() {
    this.skillPromise ??= readFile(
      new URL("../../skills/rca-investigation/SKILL.md", import.meta.url),
      "utf8",
    );
    return this.skillPromise;
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

  private specialistTools(
    kind: AgentKind,
    executeTool: ExecuteSpecialistTool,
  ): ToolDefinition[] {
    const wrap = (
      name: RcaToolName,
      description: string,
      parameters: ReturnType<typeof Type.Object>,
    ) => defineTool({
      name,
      label: name,
      description,
      parameters,
      execute: async (_toolCallId, params) => {
        const result = await executeTool(name, params as Record<string, unknown>);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ display: result.display, evidence: evidenceForModel(result.evidence) }, null, 2),
          }],
          details: {
            evidenceIds: result.evidence.map((item) => item.id),
            ...(result.correlation ?? {}),
          },
        };
      },
    });

    if (kind === "log") {
      return [
        wrap("query_logs", "Query RCA100 application logs using service/time/level/keyword filters and return factual samples.", Type.Object({
          service: Type.Optional(Type.String()),
          keyword: Type.Optional(Type.String()),
          level: Type.Optional(Type.String()),
          ...optionalTimeFields(),
          limit: Type.Optional(Type.Number()),
        })),
        wrap("analyze_log_patterns", "Aggregate repeated RCA100 log messages under the supplied filters. This groups observations; it does not diagnose the root cause.", Type.Object({
          service: Type.Optional(Type.String()),
          keyword: Type.Optional(Type.String()),
          level: Type.Optional(Type.String()),
          ...optionalTimeFields(),
          limit: Type.Optional(Type.Number()),
        })),
      ];
    }
    if (kind === "metric") {
      return [
        wrap("list_metrics", "Discover metric names and series available for an entity/service before querying unknown metric names.", Type.Object({
          entity: Type.Optional(Type.String()),
          service: Type.Optional(Type.String()),
          keyword: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Number()),
        })),
        wrap("query_metrics", "Query RCA100 metric samples in the incident window and return factual min/avg/max/first/last statistics per series.", Type.Object({
          entity: Type.Optional(Type.String()),
          service: Type.Optional(Type.String()),
          metric: Type.Optional(Type.String()),
          metrics: Type.Optional(Type.Array(Type.String(), { maxItems: 12 })),
          keyword: Type.Optional(Type.String()),
          ...optionalTimeFields(),
          limit: Type.Optional(Type.Number()),
        })),
      ];
    }
    if (kind === "trace") {
      return [
        wrap("search_traces", "Search slow/error RCA100 spans by service, operation, duration and incident time range.", Type.Object({
          service: Type.Optional(Type.String()),
          operation: Type.Optional(Type.String()),
          minDurationMs: Type.Optional(Type.Number()),
          status: Type.Optional(Type.String()),
          ...optionalTimeFields(),
          limit: Type.Optional(Type.Number()),
        })),
        wrap("get_trace", "Inspect all spans belonging to one concrete traceId returned by search_traces.", Type.Object({
          traceId: Type.String(),
        })),
      ];
    }
    return [
      wrap("query_events", "Query Kubernetes events from RCA100. Use for infrastructure/pod/node/change context, not as a direct diagnosis.", Type.Object({
        service: Type.Optional(Type.String()),
        resource: Type.Optional(Type.String()),
        keyword: Type.Optional(Type.String()),
        reason: Type.Optional(Type.String()),
        ...optionalTimeFields(),
        limit: Type.Optional(Type.Number()),
      })),
      wrap("query_alerts", "Query related alert lifecycle records from RCA100.", Type.Object({
        service: Type.Optional(Type.String()),
        subject: Type.Optional(Type.String()),
        severity: Type.Optional(Type.String()),
        status: Type.Optional(Type.String()),
        ...optionalTimeFields(),
        limit: Type.Optional(Type.Number()),
      })),
      wrap("get_topology_neighbors", "Inspect upstream/downstream/reference topology relationships for an entity or service.", Type.Object({
        entity: Type.Optional(Type.String()),
        service: Type.Optional(Type.String()),
        direction: Type.Optional(Type.Union([Type.Literal("upstream"), Type.Literal("downstream"), Type.Literal("both")])),
        relation: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
      })),
    ];
  }

  async createSpecialistSession(kind: AgentKind): Promise<SpecialistSessionHandle> {
    let activeHooks: SpecialistRunHooks | undefined;
    let localToolCallCount = 0;
    const dynamicExecutor: ExecuteSpecialistTool = async (name, args) => {
      if (!activeHooks) {
        throw new Error(`${AGENT_LABELS[kind]} received a tool call outside an active task.`);
      }
      localToolCallCount += 1;
      return activeHooks.executeTool(name, args);
    };
    const session = await this.createSession(
      SPECIALIST_PROMPTS[kind],
      this.specialistTools(kind, dynamicExecutor),
    );

    const handle: SpecialistSessionHandle = {
      kind,
      run: async (context, hooks) => {
        if (activeHooks) throw new Error(`${AGENT_LABELS[kind]} is already running a task.`);
        activeHooks = hooks;
        localToolCallCount = 0;
        let output = "";
        const unsubscribe = session.subscribe((event) => {
          if (event.type === "turn_start") hooks.onTurnStart();
          if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            output += event.assistantMessageEvent.delta;
          }
        });

        try {
          await session.prompt(
            `<SPECIALIST_EXECUTION_CONTEXT>\n${JSON.stringify(context, null, 2)}\n</SPECIALIST_EXECUTION_CONTEXT>\n\n` +
              "请只根据以上任务上下文和你拥有的观测工具进行调查。不要访问其他 Agent transcript。先获取事实 Evidence，再给出简洁结论。",
          );
          if (localToolCallCount === 0) {
            await session.prompt(
              "你尚未调用任何观测工具。请先调用合适工具获取 RCA100 Evidence，再输出结论；不要凭已有常识猜测。",
            );
          }
          if (localToolCallCount === 0) {
            throw new Error(`${AGENT_LABELS[kind]} did not call any observability tool after retry.`);
          }
          return output.trim() || `${AGENT_LABELS[kind]} 已完成查询，但未生成文本摘要。`;
        } finally {
          unsubscribe();
          activeHooks = undefined;
        }
      },
      abort: () => session.abort(),
      dispose: () => session.dispose(),
    };
    return handle;
  }

  async runCoordinator(
    userPrompt: string,
    incidentContext: string,
    hypothesisContext: string,
    hooks: CoordinatorHooks,
    signal?: AbortSignal,
  ): Promise<void> {
    const skill = await this.rcaSkill();
    const coordinatorPrompt = `${COORDINATOR_BASE_PROMPT}\n\n<RCA_INVESTIGATION_SKILL>\n${skill}\n</RCA_INVESTIGATION_SKILL>`;
    const delegateAgents = defineTool({
      name: "delegate_agents",
      label: "delegate_agents",
      description: "Dispatch one investigation round to one or more specialist RCA agents. Assignments in the same call are scheduled concurrently when Harness limits permit.",
      parameters: Type.Object({
        assignments: Type.Array(
          Type.Object({
            agent: Type.Union([
              Type.Literal("log"),
              Type.Literal("metric"),
              Type.Literal("trace"),
              Type.Literal("context"),
            ]),
            goal: Type.String(),
            service: Type.Optional(Type.String()),
            operation: Type.Optional(Type.String()),
            evidenceIds: Type.Optional(Type.Array(Type.String(), { maxItems: 12 })),
            hypothesisIds: Type.Optional(Type.Array(Type.String(), { maxItems: 8 })),
          }),
          { minItems: 1, maxItems: 8 },
        ),
      }),
      execute: async (_toolCallId, params) => {
        const results = await hooks.delegate(params.assignments as DelegationAssignment[]);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(results.map((result) => ({
              taskId: result.taskId,
              agent: result.agent,
              summary: result.summary,
              evidence: evidenceForModel(result.evidence),
              metrics: {
                toolCallCount: result.toolCallCount,
                turnCount: result.turnCount,
                durationMs: result.durationMs,
              },
            })), null, 2),
          }],
          details: {
            agents: results.map((item) => item.agent),
            taskIds: results.map((item) => item.taskId),
          },
        };
      },
    });

    const updateHypotheses = defineTool({
      name: "update_hypotheses",
      label: "update_hypotheses",
      description: "Update RCA hypotheses using only evidence ids already returned by specialist agents.",
      parameters: Type.Object({
        updates: Type.Array(Type.Object({
          id: Type.String(),
          state: Type.Union([
            Type.Literal("possible"),
            Type.Literal("validating"),
            Type.Literal("supported"),
            Type.Literal("rejected"),
          ]),
          supportingEvidenceIds: Type.Optional(Type.Array(Type.String())),
          contradictingEvidenceIds: Type.Optional(Type.Array(Type.String())),
        })),
      }),
      execute: async (_toolCallId, params) => {
        hooks.updateHypotheses(params.updates as HypothesisUpdateInput[]);
        return { content: [{ type: "text" as const, text: "Hypotheses updated." }], details: {} };
      },
    });

    let finalized = false;
    const finalizeRca = defineTool({
      name: "finalize_rca",
      label: "finalize_rca",
      description: "Finalize the RCA after enough independent evidence has been collected.",
      parameters: Type.Object({
        rootCauseEntity: Type.String(),
        faultType: Type.String(),
        rootCause: Type.String(),
        causalChain: Type.Array(Type.String(), { minItems: 2, maxItems: 10 }),
        evidenceIds: Type.Array(Type.String(), { minItems: 2 }),
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

    const session = await this.createSession(coordinatorPrompt, [delegateAgents, updateHypotheses, finalizeRca]);
    let textOpen = false;
    const onAbort = () => session.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "assistant") textOpen = false;
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
        `用户/告警输入：\n${userPrompt}\n\nRCA100 Case Context：\n${incidentContext}\n\n当前候选假设：\n${hypothesisContext}\n\n请开始 RCA。注意：RCA100 Ground Truth 不在你的上下文中，只能通过 specialist tools 获取观测事实。`,
      );
      if (!finalized && !signal?.aborted) {
        await session.prompt(
          "你还没有调用 finalize_rca。请检查当前 Evidence；若证据仍不足或只有单一 modality，继续 delegate_agents 调查；若证据已形成完整因果链，更新假设并调用 finalize_rca。不要凭空补证据。",
        );
      }
      if (textOpen) hooks.onTextEnd();
    } finally {
      signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      session.dispose();
    }
  }
}
