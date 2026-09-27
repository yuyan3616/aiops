import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";

import type { ExpertKind, Investigation, RcaTask } from "./types";

export interface PlannerCandidate {
  service: string;
  operation?: string;
  host?: string;
}

export interface RcaPlannerContext {
  investigation: Investigation;
  task: RcaTask;
  candidate?: PlannerCandidate;
  maxRounds: number;
}

export interface RcaPlannerDecision {
  action: ExpertKind | "finish";
  reason: string;
  source: "agent" | "deterministic-fallback";
}

export interface RcaPlanner {
  decide(context: RcaPlannerContext): Promise<RcaPlannerDecision>;
}

export class DeterministicRcaPlanner implements RcaPlanner {
  async decide(context: RcaPlannerContext): Promise<RcaPlannerDecision> {
    const { investigation, task, candidate } = context;
    const modalities = new Set(investigation.evidence.map((item) => item.modality));

    if (task.alert.entity.domain === "apm" && !modalities.has("trace")) {
      return {
        action: "trace",
        reason: "Start with traces to determine whether alert latency is local or propagated.",
        source: "deterministic-fallback",
      };
    }
    if (!modalities.has("metric")) {
      return {
        action: "metrics",
        reason: candidate
          ? "Validate the trace-localized candidate with latency, peer, and resource metrics."
          : "Trace did not localize a dependency; inspect the alerted service metrics next.",
        source: "deterministic-fallback",
      };
    }
    if (!modalities.has("log")) {
      return {
        action: "log",
        reason: candidate
          ? "Check the candidate logs for slow successful requests or explicit failures."
          : "No downstream candidate is established; inspect the alerted service logs for local evidence.",
        source: "deterministic-fallback",
      };
    }
    if (!modalities.has("topology") || !modalities.has("event")) {
      return {
        action: "event-topology",
        reason: candidate
          ? "Correlate the candidate with infrastructure topology and nearby runtime events."
          : "Use topology and runtime events to test infrastructure or environment hypotheses.",
        source: "deterministic-fallback",
      };
    }
    return {
      action: "finish",
      reason: "All available specialist modalities have been checked; synthesize the evidence.",
      source: "deterministic-fallback",
    };
  }
}

const SYSTEM_PROMPT = `You are the coordinator planner for an evidence-driven production RCA investigation.
Choose exactly one next action from: trace, metrics, log, event-topology, finish.

Rules:
- Base the choice only on the alert, current hypotheses, collected evidence, completed expert tasks, and candidate entity shown in the prompt.
- Do not infer benchmark answers from a case id; the case id is intentionally not provided.
- Do not call every specialist mechanically. Pick the check that most reduces uncertainty.
- Prefer an independent modality when one hypothesis is supported by only one modality.
- If traces fail to localize a downstream candidate, metrics/log/event-topology may inspect the alerted service itself.
- Choose finish only when the evidence is sufficient for a guarded conclusion or remaining checks are unlikely to reduce uncertainty.
- Return JSON only, exactly: {"action":"trace|metrics|log|event-topology|finish","reason":"one concise user-visible reason"}.
- The reason must be a short investigation summary, never private chain-of-thought.`;

export class PiRcaPlanner implements RcaPlanner {
  private readonly fallback = new DeterministicRcaPlanner();

  constructor(private readonly modelRuntime: ModelRuntime) {}

  async decide(context: RcaPlannerContext): Promise<RcaPlannerDecision> {
    try {
      return await this.decideWithAgent(context);
    } catch (error) {
      const fallback = await this.fallback.decide(context);
      return {
        ...fallback,
        reason: `${fallback.reason} Planner fallback: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  private async decideWithAgent(context: RcaPlannerContext): Promise<RcaPlannerDecision> {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1 },
    });
    const agentDir = getAgentDir();
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => SYSTEM_PROMPT,
    });
    await resourceLoader.reload();

    const requestedProvider = process.env.RCA_MODEL_PROVIDER?.trim();
    const requestedModelId = process.env.RCA_MODEL_ID?.trim();
    if ((requestedProvider && !requestedModelId) || (!requestedProvider && requestedModelId)) {
      throw new Error("RCA_MODEL_PROVIDER and RCA_MODEL_ID must be configured together");
    }
    const model =
      requestedProvider && requestedModelId
        ? this.modelRuntime.getModel(requestedProvider, requestedModelId)
        : undefined;
    if (requestedProvider && requestedModelId && !model) {
      throw new Error(
        `Configured RCA planner model ${requestedProvider}/${requestedModelId} was not found`,
      );
    }

    const { session } = await createAgentSession({
      cwd: process.cwd(),
      agentDir,
      modelRuntime: this.modelRuntime,
      ...(model ? { model } : {}),
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(),
      noTools: "builtin",
    });

    let output = "";
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        output += event.assistantMessageEvent.delta;
      }
    });

    const plannerState = {
      alert: {
        service: context.task.alert.service,
        operation: context.task.alert.operation,
        title: context.task.alert.title,
        window: context.task.alert.window,
      },
      round: context.investigation.rounds,
      maxRounds: context.maxRounds,
      candidate: context.candidate,
      hypotheses: context.investigation.hypotheses.map((item) => ({
        id: item.id,
        statement: item.statement,
        status: item.status,
        confidence: item.confidence,
        supportingEvidenceIds: item.supportingEvidenceIds,
        contradictingEvidenceIds: item.contradictingEvidenceIds,
        nextChecks: item.nextChecks,
      })),
      evidence: context.investigation.evidence.slice(-12).map((item) => ({
        id: item.id,
        modality: item.modality,
        entity: item.entity,
        summary: item.summary,
        supports: item.supports,
        contradicts: item.contradicts,
      })),
      completedExperts: context.investigation.expertTasks
        .filter((item) => item.status === "completed")
        .map((item) => ({ expert: item.expert, objective: item.objective })),
    };

    try {
      await session.prompt(
        `Select the next RCA check from the current investigation state below.\n\n${JSON.stringify(
          plannerState,
          null,
          2,
        )}`,
      );
    } finally {
      unsubscribe();
      session.dispose();
    }

    const json = output.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error("RCA planner did not return a JSON decision");
    const parsed = JSON.parse(json) as { action?: unknown; reason?: unknown };
    const actions = new Set(["trace", "metrics", "log", "event-topology", "finish"]);
    if (typeof parsed.action !== "string" || !actions.has(parsed.action)) {
      throw new Error("RCA planner returned an unsupported action");
    }

    return {
      action: parsed.action as ExpertKind | "finish",
      reason:
        typeof parsed.reason === "string" && parsed.reason.trim()
          ? parsed.reason.trim().slice(0, 500)
          : "Agent selected the next check from current evidence.",
      source: "agent",
    };
  }
}
