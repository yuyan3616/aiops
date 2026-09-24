import type { AgentKind, AgentView, EvidenceView, ToolRunView } from "../../shared/rca-types";

import { EvidenceStore } from "./evidence-store";
import type { EventChannel } from "./event-channel";
import { FakeLlmClient, type AgentTask } from "./fake-llm";
import { FakeToolGateway } from "./tool-gateway";

export class AgentManager {
  constructor(
    private readonly channel: EventChannel,
    private readonly evidenceStore: EvidenceStore,
    private readonly llm: FakeLlmClient,
    private readonly toolGateway: FakeToolGateway,
    private readonly agents: Map<AgentKind, AgentView>,
    private readonly toolRuns: Map<string, ToolRunView>,
  ) {}

  async run(kind: AgentKind, task: AgentTask): Promise<EvidenceView[]> {
    this.updateAgent(kind, { state: "running", progress: 22, result: "" });

    const plan = this.toolGateway.createPlan(kind, task);
    const toolRun: ToolRunView = {
      id: plan.id,
      agent: kind,
      name: plan.name,
      args: plan.args,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.toolRuns.set(toolRun.id, toolRun);
    this.channel.publish("tool.started", toolRun);
    this.updateAgent(kind, { progress: 42 });

    try {
      const toolResult = await this.toolGateway.execute(plan);
      const completedTool: ToolRunView = {
        ...toolRun,
        status: "success",
        result: toolResult.display,
        completedAt: new Date().toISOString(),
      };
      this.toolRuns.set(toolRun.id, completedTool);
      this.channel.publish("tool.completed", completedTool);
      this.updateAgent(kind, { progress: 76 });

      const evidence: EvidenceView[] = [];
      for (const item of toolResult.evidence) {
        const stored = this.evidenceStore.put(item);
        evidence.push(stored.evidence);
        if (!stored.reused) this.channel.publish("evidence.created", stored.evidence);
      }

      const summary = await this.llm.summarizeAgent(kind, evidence);
      this.updateAgent(kind, { state: "done", progress: 100, result: summary });
      return evidence;
    } catch (error) {
      const failed: ToolRunView = {
        ...toolRun,
        status: "error",
        result: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString(),
      };
      this.toolRuns.set(toolRun.id, failed);
      this.channel.publish("tool.completed", failed);
      this.updateAgent(kind, { state: "error", progress: 100, result: failed.result ?? "Tool failed" });
      throw error;
    }
  }

  private updateAgent(kind: AgentKind, patch: Partial<AgentView>) {
    const current = this.agents.get(kind)!;
    const next = { ...current, ...patch };
    this.agents.set(kind, next);
    this.channel.publish("agent.updated", next);
  }
}
