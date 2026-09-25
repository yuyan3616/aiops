import type { AgentKind, AgentView, EvidenceView, ToolRunView } from "../../shared/rca-types";

import { EvidenceStore } from "./evidence-store";
import type { EventChannel } from "./event-channel";
import type { AgentRunResult, PiRcaAgentClient } from "./pi-agent-client";
import { Rca100ToolGateway, type RcaToolName } from "./tool-gateway";
import type { AgentTask } from "./types";

export class AgentManager {
  constructor(
    private readonly channel: EventChannel,
    private readonly evidenceStore: EvidenceStore,
    private readonly llm: PiRcaAgentClient,
    private readonly toolGateway: Rca100ToolGateway,
    private readonly agents: Map<AgentKind, AgentView>,
    private readonly toolRuns: Map<string, ToolRunView>,
  ) {}

  async run(kind: AgentKind, task: AgentTask): Promise<AgentRunResult> {
    this.updateAgent(kind, { state: "running", progress: 15, result: "" });
    const collectedEvidence = new Map<string, EvidenceView>();
    let toolCallCount = 0;

    try {
      const summary = await this.llm.runSpecialist(kind, task, async (name, args) => {
        toolCallCount += 1;
        const plan = this.toolGateway.createPlan(kind, name as RcaToolName, args);
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
        this.updateAgent(kind, { progress: Math.min(75, 25 + toolCallCount * 18) });

        try {
          const toolResult = await this.toolGateway.execute(plan, task);
          const completedTool: ToolRunView = {
            ...toolRun,
            status: "success",
            result: toolResult.display,
            completedAt: new Date().toISOString(),
          };
          this.toolRuns.set(toolRun.id, completedTool);
          this.channel.publish("tool.completed", completedTool);

          const evidence: EvidenceView[] = [];
          for (const item of toolResult.evidence) {
            const stored = this.evidenceStore.put(item);
            evidence.push(stored.evidence);
            collectedEvidence.set(stored.evidence.id, stored.evidence);
            if (!stored.reused) this.channel.publish("evidence.created", stored.evidence);
          }
          return { display: toolResult.display, evidence };
        } catch (error) {
          const failed: ToolRunView = {
            ...toolRun,
            status: "error",
            result: error instanceof Error ? error.message : String(error),
            completedAt: new Date().toISOString(),
          };
          this.toolRuns.set(toolRun.id, failed);
          this.channel.publish("tool.completed", failed);
          throw error;
        }
      });

      this.updateAgent(kind, { state: "done", progress: 100, result: summary });
      return { agent: kind, summary, evidence: [...collectedEvidence.values()] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateAgent(kind, { state: "error", progress: 100, result: message });
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
