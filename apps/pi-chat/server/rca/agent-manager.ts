import type { AgentKind, AgentView, EvidenceView, ToolRunView } from "../../shared/rca-types";

import { BudgetGuard } from "./harness/budget-guard";
import { TaskExecutionError, taskError } from "./harness/errors";
import type { AgentTask, CaseContext, SpecialistExecutionContext } from "./harness/task-types";
import { ToolGuard } from "./harness/tool-guard";
import { EvidenceStore } from "./evidence-store";
import type { EventChannel } from "./event-channel";
import type {
  AgentRunResult,
  PiRcaAgentClient,
  SpecialistSessionHandle,
} from "./pi-agent-client";
import { Rca100ToolGateway, type RcaToolName } from "./tool-gateway";

export class AgentManager {
  private readonly sessions = new Map<AgentKind, Promise<SpecialistSessionHandle>>();
  private readonly toolGuard = new ToolGuard();

  constructor(
    private readonly channel: EventChannel,
    private readonly evidenceStore: EvidenceStore,
    private readonly llm: PiRcaAgentClient,
    private readonly toolGateway: Rca100ToolGateway,
    private readonly agents: Map<AgentKind, AgentView>,
    private readonly toolRuns: Map<string, ToolRunView>,
  ) {}

  async run(input: {
    task: AgentTask;
    caseContext: CaseContext;
    context: SpecialistExecutionContext;
    signal: AbortSignal;
  }): Promise<AgentRunResult> {
    const { task, caseContext, context, signal } = input;
    const kind = task.agent;
    const startedAt = Date.now();
    const collectedEvidence = new Map<string, EvidenceView>();
    const budget = new BudgetGuard(task.policy);
    const session = await this.getSession(kind);
    const abortSession = () => session.abort();
    signal.addEventListener("abort", abortSession, { once: true });
    this.updateAgent(kind, { state: "running", progress: 15, result: "" }, task);

    try {
      if (signal.aborted) throw this.abortReason(signal, task.id);
      const summary = await session.run(context, {
        onTurnStart: () => budget.onTurnStart(() => session.abort()),
        executeTool: async (name, args) => {
          if (signal.aborted) throw this.abortReason(signal, task.id);
          budget.throwIfViolated();
          budget.beforeToolCall();

          const rawPlan = this.toolGateway.createPlan(kind, name as RcaToolName, args);
          const plan = this.toolGuard.guardInput(rawPlan, caseContext);
          const toolRun: ToolRunView = {
            id: plan.id,
            investigationId: task.investigationId,
            runId: task.runId,
            taskId: task.id,
            datasetTaskId: caseContext.datasetTaskId,
            agent: kind,
            name: plan.name,
            args: plan.args,
            status: "running",
            startedAt: new Date().toISOString(),
          };
          this.toolRuns.set(toolRun.id, toolRun);
          this.channel.publish("tool.started", toolRun, {
            investigationId: task.investigationId,
            runId: task.runId,
            taskId: task.id,
            agent: kind,
            toolCallId: toolRun.id,
          });
          this.updateAgent(kind, {
            progress: Math.min(82, 25 + budget.metrics().toolCallCount * 8),
          }, task);

          try {
            const rawResult = await this.toolGateway.execute(plan, task, caseContext);
            if (signal.aborted) throw this.abortReason(signal, task.id);
            const toolResult = this.toolGuard.guardOutput(rawResult);
            const evidence: EvidenceView[] = [];
            for (const item of toolResult.evidence) {
              const reusable = this.evidenceStore.findReusable(item);
              if (!reusable) budget.beforeNewEvidence();
              const stored = this.evidenceStore.put(item);
              evidence.push(stored.evidence);
              collectedEvidence.set(stored.evidence.id, stored.evidence);
              if (!stored.reused) this.channel.publish("evidence.created", stored.evidence, {
                investigationId: task.investigationId,
                runId: task.runId,
                taskId: task.id,
                agent: kind,
                toolCallId: toolRun.id,
                evidenceId: stored.evidence.id,
              });
            }

            const completedTool: ToolRunView = {
              ...toolRun,
              status: "success",
              result: toolResult.display,
              completedAt: new Date().toISOString(),
            };
            this.toolRuns.set(toolRun.id, completedTool);
            this.channel.publish("tool.completed", completedTool, {
              investigationId: task.investigationId,
              runId: task.runId,
              taskId: task.id,
              agent: kind,
              toolCallId: toolRun.id,
            });
            return {
              display: toolResult.display,
              evidence,
              correlation: {
                investigationId: task.investigationId,
                runId: task.runId,
                taskId: task.id,
                agent: kind,
                toolCallId: toolRun.id,
              },
            };
          } catch (error) {
            const normalized = this.normalizeToolError(error);
            const failed: ToolRunView = {
              ...toolRun,
              status: "error",
              result: normalized.message,
              completedAt: new Date().toISOString(),
            };
            this.toolRuns.set(toolRun.id, failed);
            this.channel.publish("tool.completed", failed, {
              investigationId: task.investigationId,
              runId: task.runId,
              taskId: task.id,
              agent: kind,
              toolCallId: toolRun.id,
            });
            throw normalized;
          }
        },
      });

      budget.throwIfViolated();
      if (signal.aborted) throw this.abortReason(signal, task.id);
      const metrics = budget.metrics();
      const durationMs = Date.now() - startedAt;
      this.updateAgent(kind, { state: "done", progress: 100, result: summary }, task);
      return {
        agent: kind,
        taskId: task.id,
        summary,
        evidence: [...collectedEvidence.values()],
        toolCallCount: metrics.toolCallCount,
        turnCount: metrics.turnCount,
        durationMs,
      };
    } catch (error) {
      const effectiveError = this.resolveExecutionError(error, signal, budget, task.id);
      this.updateAgent(kind, {
        state: effectiveError.code === "TASK_CANCELLED" || effectiveError.code === "TASK_TIMEOUT"
          ? "cancelled"
          : "error",
        progress: 100,
        result: effectiveError.message,
      }, task);
      this.resetSession(kind);
      throw effectiveError;
    } finally {
      signal.removeEventListener("abort", abortSession);
    }
  }

  async abort(kind: AgentKind) {
    const pending = this.sessions.get(kind);
    if (!pending) return;
    const session = await pending.catch(() => undefined);
    session?.abort();
  }

  dispose() {
    for (const pending of this.sessions.values()) {
      void pending.then((session) => session.dispose()).catch(() => undefined);
    }
    this.sessions.clear();
  }

  private getSession(kind: AgentKind) {
    let session = this.sessions.get(kind);
    if (!session) {
      session = this.llm.createSpecialistSession(kind);
      this.sessions.set(kind, session);
    }
    return session;
  }

  private resetSession(kind: AgentKind) {
    const pending = this.sessions.get(kind);
    if (!pending) return;
    this.sessions.delete(kind);
    void pending.then((session) => session.dispose()).catch(() => undefined);
  }

  private abortReason(signal: AbortSignal, taskId: string) {
    if (signal.reason instanceof TaskExecutionError) return signal.reason;
    return taskError("TASK_CANCELLED", `Task ${taskId} was cancelled.`);
  }

  private resolveExecutionError(
    error: unknown,
    signal: AbortSignal,
    budget: BudgetGuard,
    taskId: string,
  ) {
    try {
      budget.throwIfViolated();
    } catch (budgetError) {
      return budgetError as TaskExecutionError;
    }
    if (signal.aborted) return this.abortReason(signal, taskId);
    if (error instanceof TaskExecutionError) return error;
    return taskError(
      "TASK_AGENT_ERROR",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }

  private normalizeToolError(error: unknown) {
    if (error instanceof TaskExecutionError) return error;
    const raw = error instanceof Error ? error.message : String(error);
    const sanitized = raw
      .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s"']+[\\/])+[^\s"']*/g, "<backend-path>")
      .slice(0, 1_500);
    return taskError("TASK_TOOL_ERROR", sanitized || "Tool execution failed.", error);
  }

  private updateAgent(kind: AgentKind, patch: Partial<AgentView>, task?: AgentTask) {
    const current = this.agents.get(kind)!;
    const next = { ...current, ...patch };
    this.agents.set(kind, next);
    this.channel.publish("agent.updated", next, task ? {
      investigationId: task.investigationId,
      runId: task.runId,
      taskId: task.id,
      agent: kind,
    } : { agent: kind });
  }
}
