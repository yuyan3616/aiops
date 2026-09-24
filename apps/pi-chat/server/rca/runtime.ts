import { randomUUID } from "node:crypto";

import type {
  AgentKind,
  AgentView,
  CoordinatorMessage,
  HypothesisView,
  InvestigationPhase,
  InvestigationSnapshot,
  InvestigationStatus,
  ThinkingStage,
  ThinkingView,
  ToolRunView,
} from "../../shared/rca-types";
import { AgentManager } from "./agent-manager";
import { EvidenceStore } from "./evidence-store";
import { EventChannel } from "./event-channel";
import {
  type DelegationAssignment,
  type FinalRcaInput,
  type HypothesisUpdateInput,
  PiRcaAgentClient,
} from "./pi-agent-client";
import { FakeToolGateway } from "./tool-gateway";

const DEFAULT_PROMPT = "order-service 从 10:31 开始 5xx 大幅上升，帮我分析一下可能的原因。";
const INCIDENT_WINDOW = "2026-09-23 10:20 ~ 2026-09-23 11:00";

const BASE_AGENTS: AgentView[] = [
  {
    id: "log",
    name: "Log Agent",
    description: "查询 order-service、payment-service 错误日志",
    result: "",
    state: "waiting",
    progress: 0,
  },
  {
    id: "metric",
    name: "Metric Agent",
    description: "分析 5xx、延迟、CPU、数据库连接池指标",
    result: "",
    state: "waiting",
    progress: 0,
  },
  {
    id: "trace",
    name: "Trace Agent",
    description: "分析调用链，定位异常耗时的下游服务",
    result: "",
    state: "waiting",
    progress: 0,
  },
  {
    id: "change",
    name: "Change Agent",
    description: "检查故障窗口内发布记录与配置变更",
    result: "",
    state: "waiting",
    progress: 0,
  },
];

const BASE_HYPOTHESES: HypothesisView[] = [
  {
    id: "H1",
    title: "payment-service 数据库连接池耗尽",
    state: "validating",
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
  },
  {
    id: "H2",
    title: "payment-service 新版本引入配置问题",
    state: "validating",
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
  },
  {
    id: "H3",
    title: "第三方支付接口超时",
    state: "possible",
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
  },
  {
    id: "H4",
    title: "order-service 自身资源异常",
    state: "possible",
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
  },
];

const DEFAULT_SERVICE: Record<AgentKind, string> = {
  log: "payment-service",
  metric: "payment-service",
  trace: "order-service",
  change: "payment-service",
};

const AGENT_NAME: Record<AgentKind, string> = {
  log: "Log Agent",
  metric: "Metric Agent",
  trace: "Trace Agent",
  change: "Change Agent",
};

export class RcaRuntime {
  readonly channel = new EventChannel();
  private readonly evidenceStore = new EvidenceStore();
  private readonly llm = new PiRcaAgentClient();
  private readonly toolGateway = new FakeToolGateway();
  private agents = new Map<AgentKind, AgentView>();
  private hypotheses = new Map<string, HypothesisView>();
  private messages: CoordinatorMessage[] = [];
  private thinking: ThinkingView[] = [];
  private toolRuns = new Map<string, ToolRunView>();
  private phase: InvestigationPhase = 1;
  private status: InvestigationStatus = "idle";
  private error?: string;
  private conclusion: InvestigationSnapshot["conclusion"];
  private runId = randomUUID();
  private runPromise?: Promise<void>;
  private activeThinking?: ThinkingView;
  private currentPrompt = DEFAULT_PROMPT;

  constructor(readonly incidentId: string) {
    this.resetState(false);
  }

  snapshot(): InvestigationSnapshot {
    return {
      incidentId: this.incidentId,
      title: "order-service 5xx 激增",
      severity: "P1",
      window: INCIDENT_WINDOW,
      status: this.status,
      error: this.error,
      phase: this.phase,
      agents: [...this.agents.values()],
      hypotheses: [...this.hypotheses.values()],
      evidence: this.evidenceStore.list(),
      messages: [...this.messages],
      thinking: [...this.thinking],
      toolRuns: [...this.toolRuns.values()],
      conclusion: this.conclusion,
      runId: this.runId,
      stream: { id: this.channel.streamId, lastEventId: this.channel.lastId },
    };
  }

  start(prompt = DEFAULT_PROMPT) {
    if (this.runPromise) return this.runPromise;
    this.currentPrompt = prompt.trim() || DEFAULT_PROMPT;
    this.runPromise = this.execute().finally(() => {
      this.runPromise = undefined;
    });
    return this.runPromise;
  }

  modelLabel() {
    return this.llm.modelLabel();
  }

  private resetState(publish: boolean) {
    this.runId = randomUUID();
    this.phase = 1;
    this.status = "idle";
    this.error = undefined;
    this.conclusion = undefined;
    this.activeThinking = undefined;
    this.evidenceStore.reset();
    this.agents = new Map(BASE_AGENTS.map((agent) => [agent.id, { ...agent }]));
    this.hypotheses = new Map(
      BASE_HYPOTHESES.map((hypothesis) => [
        hypothesis.id,
        { ...hypothesis, supportingEvidenceIds: [], contradictingEvidenceIds: [] },
      ]),
    );
    this.toolRuns.clear();
    this.thinking = [];
    this.messages = [];
    if (publish) this.channel.publish("investigation.reset", this.snapshot());
  }

  private setStatus(status: InvestigationStatus) {
    this.status = status;
    if (status !== "error") this.error = undefined;
    this.channel.publish("investigation.status", { status });
  }

  private setPhase(phase: InvestigationPhase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.channel.publish("investigation.phase", { phase });
  }

  private updateHypothesis(input: HypothesisUpdateInput) {
    const current = this.hypotheses.get(input.id);
    if (!current) return;
    const knownEvidence = new Set(this.evidenceStore.list().map((item) => item.id));
    const next: HypothesisView = {
      ...current,
      state: input.state,
      supportingEvidenceIds: (input.supportingEvidenceIds ?? current.supportingEvidenceIds).filter(
        (id) => knownEvidence.has(id),
      ),
      contradictingEvidenceIds: (
        input.contradictingEvidenceIds ?? current.contradictingEvidenceIds
      ).filter((id) => knownEvidence.has(id)),
    };
    this.hypotheses.set(input.id, next);
    this.channel.publish("hypothesis.updated", next);
  }

  private addMessage(kind: CoordinatorMessage["kind"], text: string) {
    const message: CoordinatorMessage = {
      id: randomUUID(),
      kind,
      text,
      createdAt: new Date().toISOString(),
    };
    this.messages.push(message);
    this.channel.publish("coordinator.message", message);
  }

  private thinkingStage(): { stage: ThinkingStage; title: string } {
    const evidenceCount = this.evidenceStore.list().length;
    if (evidenceCount === 0) return { stage: "plan", title: "分析计划" };
    if (evidenceCount < 3) return { stage: "evidence", title: "证据更新" };
    return { stage: "synthesis", title: "结论收敛" };
  }

  private startThinking() {
    if (this.activeThinking) this.completeThinking();
    const { stage, title } = this.thinkingStage();
    const now = new Date().toISOString();
    const thinking: ThinkingView = {
      id: randomUUID(),
      stage,
      title,
      text: "",
      completed: false,
      createdAt: now,
      updatedAt: now,
    };
    this.activeThinking = thinking;
    this.thinking.push(thinking);
    this.channel.publish("thinking.started", thinking);
  }

  private appendThinking(delta: string) {
    if (!this.activeThinking) this.startThinking();
    const thinking = this.activeThinking!;
    thinking.text += delta;
    thinking.updatedAt = new Date().toISOString();
    this.channel.publish("thinking.delta", {
      id: thinking.id,
      delta,
      updatedAt: thinking.updatedAt,
    });
  }

  private completeThinking() {
    const thinking = this.activeThinking;
    if (!thinking) return;
    thinking.completed = true;
    thinking.updatedAt = new Date().toISOString();
    this.channel.publish("thinking.completed", {
      id: thinking.id,
      completed: true,
      updatedAt: thinking.updatedAt,
    });
    this.activeThinking = undefined;
  }

  private async delegate(manager: AgentManager, assignments: DelegationAssignment[]) {
    const deduped = [...new Map(assignments.map((item) => [item.agent, item])).values()];
    const hasDeepAgent = deduped.some((item) => item.agent === "trace" || item.agent === "change");
    this.setPhase(hasDeepAgent ? 3 : 2);

    const names = deduped.map((item) => AGENT_NAME[item.agent]).join("、");
    this.addMessage(
      this.evidenceStore.list().length === 0 ? "plan" : "decision",
      `${this.evidenceStore.list().length === 0 ? "开始第一轮调查" : "根据当前证据继续验证"}：并行派发 ${names}。`,
    );

    const results = await Promise.all(
      deduped.map((assignment) =>
        manager.run(assignment.agent, {
          service: assignment.service?.trim() || DEFAULT_SERVICE[assignment.agent],
          window: INCIDENT_WINDOW,
          goal: assignment.goal,
        }),
      ),
    );

    this.addMessage(
      "finding",
      results.map((item) => `${AGENT_NAME[item.agent]}：${item.summary}`).join("\n"),
    );
    return results;
  }

  private finalize(input: FinalRcaInput) {
    const knownEvidence = new Set(this.evidenceStore.list().map((item) => item.id));
    const evidenceIds = [...new Set(input.evidenceIds.filter((id) => knownEvidence.has(id)))];
    if (evidenceIds.length === 0) {
      throw new Error("finalize_rca requires at least one valid evidence id.");
    }
    this.conclusion = {
      rootCause: input.rootCause,
      causalChain: input.causalChain,
      evidenceIds,
    };
    this.setPhase(4);
    this.addMessage("conclusion", input.rootCause);
    this.channel.publish("rca.completed", this.conclusion);
  }

  private async execute() {
    this.resetState(true);
    this.setStatus("running");

    const manager = new AgentManager(
      this.channel,
      this.evidenceStore,
      this.llm,
      this.toolGateway,
      this.agents,
      this.toolRuns,
    );

    try {
      await this.llm.runCoordinator(this.currentPrompt, {
        onTextStart: () => this.startThinking(),
        onTextDelta: (delta) => this.appendThinking(delta),
        onTextEnd: () => this.completeThinking(),
        delegate: (assignments) => this.delegate(manager, assignments),
        updateHypotheses: (updates) => {
          for (const update of updates) this.updateHypothesis(update);
        },
        finalize: (input) => this.finalize(input),
      });
      this.completeThinking();

      if (!this.conclusion) {
        throw new Error(
          "Coordinator finished without calling finalize_rca. Check model/tool support or RCA prompt configuration.",
        );
      }
      this.setStatus("completed");
    } catch (error) {
      this.completeThinking();
      this.status = "error";
      this.error = error instanceof Error ? error.message : String(error);
      this.channel.publish("runtime.error", {
        message: this.error,
      });
      this.channel.publish("investigation.status", { status: "error" });
    }
  }
}
