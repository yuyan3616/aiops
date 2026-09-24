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
import { FakeLlmClient } from "./fake-llm";
import { FakeToolGateway } from "./tool-gateway";

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

export class RcaRuntime {
  readonly channel = new EventChannel();
  private readonly evidenceStore = new EvidenceStore();
  private readonly llm = new FakeLlmClient();
  private agents = new Map<AgentKind, AgentView>();
  private hypotheses = new Map<string, HypothesisView>();
  private messages: CoordinatorMessage[] = [];
  private thinking: ThinkingView[] = [];
  private toolRuns = new Map<string, ToolRunView>();
  private phase: InvestigationPhase = 1;
  private status: InvestigationStatus = "idle";
  private conclusion: InvestigationSnapshot["conclusion"];
  private runId = randomUUID();
  private runPromise?: Promise<void>;

  constructor(readonly incidentId: string) {
    this.resetState(false);
  }

  snapshot(): InvestigationSnapshot {
    return {
      incidentId: this.incidentId,
      title: "order-service 5xx 激增",
      severity: "P1",
      window: "2026-09-23 10:20 ~ 2026-09-23 11:00",
      status: this.status,
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

  start() {
    if (this.runPromise) return this.runPromise;
    this.runPromise = this.execute().finally(() => {
      this.runPromise = undefined;
    });
    return this.runPromise;
  }

  private resetState(publish: boolean) {
    this.runId = randomUUID();
    this.phase = 1;
    this.status = "idle";
    this.conclusion = undefined;
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
    this.messages = [
      {
        id: randomUUID(),
        kind: "plan",
        text: "我已理解当前故障现象，将先并行调用 Log Agent 与 Metric Agent 建立异常基线，再根据证据动态决定下一轮调查。",
        createdAt: new Date().toISOString(),
      },
    ];
    if (publish) this.channel.publish("investigation.reset", this.snapshot());
  }

  private setStatus(status: InvestigationStatus) {
    this.status = status;
    this.channel.publish("investigation.status", { status });
  }

  private setPhase(phase: InvestigationPhase) {
    this.phase = phase;
    this.channel.publish("investigation.phase", { phase });
  }

  private updateHypothesis(id: string, patch: Partial<HypothesisView>) {
    const current = this.hypotheses.get(id)!;
    const next = { ...current, ...patch };
    this.hypotheses.set(id, next);
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


  private async streamThinking(
    stage: ThinkingStage,
    title: string,
    chunks: string[],
  ) {
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
    this.thinking.push(thinking);
    this.channel.publish("thinking.started", thinking);

    for (const chunk of chunks) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      thinking.text += chunk;
      thinking.updatedAt = new Date().toISOString();
      this.channel.publish("thinking.delta", { id: thinking.id, delta: chunk, updatedAt: thinking.updatedAt });
    }

    thinking.completed = true;
    thinking.updatedAt = new Date().toISOString();
    this.channel.publish("thinking.completed", {
      id: thinking.id,
      completed: true,
      updatedAt: thinking.updatedAt,
    });
  }

  private async execute() {
    this.resetState(true);
    this.setStatus("running");
    await this.streamThinking("plan", "分析计划", [
      "已确定异常起点在 10:31，当前最直接的两个信号是 order-service 5xx 上升与 payment-service timeout。",
      "先并行检查 payment-service 错误日志和数据库连接池指标，用低成本证据判断是否需要继续扩大调查范围。",
    ]);
    this.setPhase(2);

    const toolGateway = new FakeToolGateway();
    const manager = new AgentManager(
      this.channel,
      this.evidenceStore,
      this.llm,
      toolGateway,
      this.agents,
      this.toolRuns,
    );
    const window = "2026-09-23 10:20 ~ 2026-09-23 11:00";

    try {
      const [logEvidence, metricEvidence] = await Promise.all([
        manager.run("log", {
          service: "payment-service",
          window,
          goal: "识别错误模式和异常开始时间",
        }),
        manager.run("metric", {
          service: "payment-service",
          window,
          goal: "验证资源、延迟与数据库连接池是否异常",
        }),
      ]);

      this.updateHypothesis("H1", {
        state: "supported",
        supportingEvidenceIds: [...logEvidence, ...metricEvidence].map((item) => item.id),
      });
      this.updateHypothesis("H4", {
        state: "rejected",
        contradictingEvidenceIds: metricEvidence.map((item) => item.id),
      });
      await this.streamThinking("evidence", "证据更新", [
        "EV01 显示 connection timeout 从 10:31 开始集中出现，EV02 显示 db_pool_active 同期接近上限，两条独立证据同时支持 H1。",
        "order-service 自身资源异常缺少指标支持，因此 H4 可以暂时排除；接下来需要验证异常耗时是否落在 DB，以及故障前是否存在配置变更。",
      ]);
      this.addMessage(
        "decision",
        "第一轮证据共同指向 payment-service 的数据库连接池问题。下一轮动态补充 Trace Agent 与 Change Agent，用调用链确认耗时位置，并检查故障前是否存在变更。",
      );

      const [traceEvidence, changeEvidence] = await Promise.all([
        manager.run("trace", {
          service: "order-service",
          window,
          goal: "确认 order → payment 的异常耗时是否集中于数据库调用",
        }),
        manager.run("change", {
          service: "payment-service",
          window,
          goal: "检查故障前发布和配置变更",
        }),
      ]);

      this.updateHypothesis("H2", {
        state: "supported",
        supportingEvidenceIds: changeEvidence.map((item) => item.id),
      });
      this.updateHypothesis("H3", {
        state: "rejected",
        contradictingEvidenceIds: traceEvidence.map((item) => item.id),
      });
      this.setPhase(3);
      this.addMessage(
        "finding",
        "Trace 显示异常耗时集中在 payment-service 的数据库访问，同时 Change Agent 发现故障前 3 分钟发布 v1.8.4 并修改连接池配置，H1 与 H2 形成连续证据链。",
      );
      await this.streamThinking("synthesis", "结论收敛", [
        "EV03 将延迟位置收敛到 payment-service 的数据库调用，EV04 则把异常前的 v1.8.4 发布与连接池配置变更关联起来。",
        "目前 H1 与 H2 获得支持，H3 与 H4 已被反证；证据链已经闭合，可以生成 RCA 结论。",
      ]);

      const synthesis = await this.llm.synthesize();
      this.conclusion = {
        ...synthesis,
        evidenceIds: this.evidenceStore.list().map((item) => item.id),
      };
      this.setPhase(4);
      this.setStatus("completed");
      this.addMessage("conclusion", synthesis.rootCause);
      this.channel.publish("rca.completed", this.conclusion);
    } catch (error) {
      this.status = "error";
      this.channel.publish("runtime.error", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
