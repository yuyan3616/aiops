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
import { T039_FALLBACK_TASK } from "../datasets/rca100/fallback";
import type { Rca100Task } from "../datasets/rca100/schema";
import { AgentManager } from "./agent-manager";
import { EventChannel } from "./event-channel";
import { EvidenceStore } from "./evidence-store";
import {
  PiRcaAgentClient,
  type DelegationAssignment,
  type FinalRcaInput,
  type HypothesisUpdateInput,
} from "./pi-agent-client";
import { Rca100ToolGateway } from "./tool-gateway";

const DEFAULT_TASK_ID = "t039";

const BASE_AGENTS: AgentView[] = [
  {
    id: "log",
    name: "Log Agent",
    description: "查询 RCA100 应用日志与错误模式",
    result: "",
    state: "waiting",
    progress: 0,
  },
  {
    id: "metric",
    name: "Metric Agent",
    description: "发现并分析 RCA100 指标时序",
    result: "",
    state: "waiting",
    progress: 0,
  },
  {
    id: "trace",
    name: "Trace Agent",
    description: "查询慢 Trace / Span，定位异常耗时传播路径",
    result: "",
    state: "waiting",
    progress: 0,
  },
  {
    id: "context",
    name: "Context Agent",
    description: "查询 Kubernetes Events、关联告警与服务拓扑",
    result: "",
    state: "waiting",
    progress: 0,
  },
];

const BASE_HYPOTHESES: HypothesisView[] = [
  {
    id: "H1",
    title: "checkout / PlaceOrder 自身出现局部性能异常",
    state: "validating",
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
  },
  {
    id: "H2",
    title: "checkout 的下游依赖异常并向上游传播延迟",
    state: "validating",
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
  },
  {
    id: "H3",
    title: "Pod / Node 等基础设施资源异常导致服务退化",
    state: "possible",
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
  },
  {
    id: "H4",
    title: "Kubernetes 运行事件或其他环境变化与告警相关",
    state: "possible",
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
  },
];

const AGENT_NAME: Record<AgentKind, string> = {
  log: "Log Agent",
  metric: "Metric Agent",
  trace: "Trace Agent",
  context: "Context Agent",
};

function alertService(task: Rca100Task) {
  const entity = task.alert_entity?.entity_name ?? "";
  if (entity.includes("::")) return entity.split("::", 1)[0] || "checkout";
  const service = task.prompt_text.match(/\bservice="([^"]+)"/)?.[1];
  return service || "checkout";
}

function alertOperation(task: Rca100Task) {
  return task.prompt_text.match(/\boperation="([^"]+)"/)?.[1]
    ?? task.alert_entity?.entity_name?.split("::")[1]
    ?? undefined;
}

function windowLabel(task: Rca100Task) {
  const start = new Date(task.alert_window.start);
  const end = new Date(task.alert_window.end);
  const format = (date: Date) => date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return `${format(start)} ~ ${format(end)}`;
}

export class RcaRuntime {
  readonly channel = new EventChannel();
  private readonly evidenceStore = new EvidenceStore();
  private readonly llm = new PiRcaAgentClient();
  private readonly toolGateway = new Rca100ToolGateway();
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
  private task: Rca100Task = structuredClone(T039_FALLBACK_TASK);
  private telemetryReady = false;
  private currentPrompt = this.task.prompt_text;

  constructor(readonly incidentId: string, readonly taskId = DEFAULT_TASK_ID) {
    this.resetState(false);
  }

  snapshot(): InvestigationSnapshot {
    return {
      incidentId: this.incidentId,
      title: this.task.alert_title,
      severity: "P1",
      window: windowLabel(this.task),
      dataset: {
        name: "RCA100",
        version: this.task.task_version || "v1.1",
        taskId: this.taskId,
        telemetryReady: this.telemetryReady,
      },
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

  start(prompt = this.task.prompt_text) {
    if (this.runPromise) return this.runPromise;
    this.currentPrompt = prompt.trim() || this.task.prompt_text;
    this.runPromise = this.execute().finally(() => {
      this.runPromise = undefined;
    });
    return this.runPromise;
  }

  modelLabel() {
    return this.llm.modelLabel();
  }

  recommendedPrompt() {
    return this.task.prompt_text;
  }

  private resetState(publish: boolean) {
    this.runId = randomUUID();
    this.phase = 1;
    this.status = "idle";
    this.error = undefined;
    this.conclusion = undefined;
    this.telemetryReady = false;
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

  private addMessage(kind: CoordinatorMessage["kind"], messageText: string) {
    const message: CoordinatorMessage = {
      id: randomUUID(),
      kind,
      text: messageText,
      createdAt: new Date().toISOString(),
    };
    this.messages.push(message);
    this.channel.publish("coordinator.message", message);
  }

  private thinkingStage(): { stage: ThinkingStage; title: string } {
    const evidenceCount = this.evidenceStore.list().length;
    if (evidenceCount === 0) return { stage: "plan", title: "分析计划" };
    if (evidenceCount < 4) return { stage: "evidence", title: "证据更新" };
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
    const hasDeepAgent = deduped.some((item) => item.agent === "trace" || item.agent === "context");
    this.setPhase(hasDeepAgent ? 3 : 2);

    const names = deduped.map((item) => AGENT_NAME[item.agent]).join("、");
    this.addMessage(
      this.evidenceStore.list().length === 0 ? "plan" : "decision",
      `${this.evidenceStore.list().length === 0 ? "开始调查" : "根据当前证据继续验证"}：并行派发 ${names}。`,
    );

    const service = alertService(this.task);
    const operation = alertOperation(this.task);
    const results = await Promise.all(
      deduped.map((assignment) => manager.run(assignment.agent, {
        taskId: this.taskId,
        service: assignment.service?.trim() || service,
        operation: assignment.operation?.trim() || operation,
        alertEntity: this.task.alert_entity?.entity_name ?? undefined,
        startTime: this.task.alert_window.start,
        endTime: this.task.alert_window.end,
        goal: assignment.goal,
      })),
    );

    this.addMessage(
      "finding",
      results.map((item) => `${AGENT_NAME[item.agent]}：${item.summary}`).join("\n"),
    );
    return results;
  }

  private finalize(input: FinalRcaInput) {
    const evidenceById = new Map(this.evidenceStore.list().map((item) => [item.id, item]));
    const evidenceIds = [...new Set(input.evidenceIds.filter((id) => evidenceById.has(id)))];
    if (evidenceIds.length < 2) {
      throw new Error("finalize_rca requires at least two valid Evidence IDs.");
    }
    const modalities = new Set(evidenceIds.map((id) => evidenceById.get(id)!.modality));
    if (modalities.size < 2) {
      throw new Error("finalize_rca requires evidence from at least two independent modalities.");
    }
    this.conclusion = {
      rootCauseEntity: input.rootCauseEntity,
      faultType: input.faultType,
      rootCause: input.rootCause,
      causalChain: input.causalChain,
      evidenceIds,
    };
    this.setPhase(4);
    this.addMessage(
      "conclusion",
      `根因实体：${input.rootCauseEntity}\n故障类型：${input.faultType}\n${input.rootCause}`,
    );
    this.channel.publish("rca.completed", this.conclusion);
  }

  private hypothesisContext() {
    return [...this.hypotheses.values()]
      .map((hypothesis) => `${hypothesis.id} ${hypothesis.title} [${hypothesis.state}]`)
      .join("\n");
  }

  private incidentContext() {
    return [
      `dataset=RCA100`,
      `task_id=${this.taskId}`,
      `alert_title=${this.task.alert_title}`,
      `alert_entity=${this.task.alert_entity?.entity_name ?? "unknown"}`,
      `window=${this.task.alert_window.start} ~ ${this.task.alert_window.end}`,
      `available_modalities=${this.task.available_modalities.join(",")}`,
    ].join("\n");
  }

  private async execute() {
    this.resetState(true);
    this.setStatus("running");

    try {
      // Dataset preparation is intentionally outside Agent context. Ground truth is never fetched here.
      this.addMessage("plan", `正在准备 RCA100 ${this.taskId} 的 Logs / Metrics / Traces / Events / Alerts / Topology 数据。`);
      await this.toolGateway.ensureCase(this.taskId);
      this.task = await this.toolGateway.getTask(this.taskId, true);
      this.telemetryReady = true;
      const readySnapshot = this.snapshot();
      this.channel.publish("dataset.ready", {
        dataset: readySnapshot.dataset,
        title: readySnapshot.title,
        window: readySnapshot.window,
      });
      this.addMessage("decision", `RCA100 ${this.taskId} 数据已就绪。开始基于真实 Parquet/JSON 执行工具查询。`);

      const manager = new AgentManager(
        this.channel,
        this.evidenceStore,
        this.llm,
        this.toolGateway,
        this.agents,
        this.toolRuns,
      );

      await this.llm.runCoordinator(
        this.currentPrompt,
        this.incidentContext(),
        this.hypothesisContext(),
        {
          onTextStart: () => this.startThinking(),
          onTextDelta: (delta) => this.appendThinking(delta),
          onTextEnd: () => this.completeThinking(),
          delegate: (assignments) => this.delegate(manager, assignments),
          updateHypotheses: (updates) => {
            for (const update of updates) this.updateHypothesis(update);
          },
          finalize: (input) => this.finalize(input),
        },
      );
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
      this.channel.publish("runtime.error", { message: this.error });
      this.channel.publish("investigation.status", { status: "error" });
    }
  }
}
