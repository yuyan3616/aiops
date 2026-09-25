import type { AgentTaskView, EvidenceView, HypothesisView } from "../../../shared/rca-types.ts";
import type { AgentManager } from "../agent-manager.ts";
import type { EventChannel } from "../event-channel.ts";
import type { AgentRunResult, DelegationAssignment } from "../pi-agent-client.ts";
import { ContextBuilder } from "./context-builder.ts";
import { isCancellationError, isTimeoutError, taskError, toTaskErrorView } from "./errors.ts";
import { TaskScheduler } from "./task-scheduler.ts";
import { createAgentTask, transitionTask, type AgentTask, type CaseContext } from "./task-types.ts";
import { taskPolicyFromEnv } from "./task-policy.ts";

function globalConcurrency(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Number(env.RCA_TASK_GLOBAL_CONCURRENCY);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 3;
}

export class InvestigationHarness {
  private readonly input: {
    investigationId: string;
    runId: string;
    signal: AbortSignal;
    channel: EventChannel;
    agentManager: AgentManager;
    getCaseContext(): CaseContext;
    getHypotheses(): HypothesisView[];
    getEvidence(): EvidenceView[];
  };
  private readonly tasks = new Map<string, AgentTask>();
  private readonly scheduler = new TaskScheduler(globalConcurrency());
  private readonly contextBuilder = new ContextBuilder();
  private taskSequence = 0;

  constructor(input: {
    investigationId: string;
    runId: string;
    signal: AbortSignal;
    channel: EventChannel;
    agentManager: AgentManager;
    getCaseContext(): CaseContext;
    getHypotheses(): HypothesisView[];
    getEvidence(): EvidenceView[];
  }) {
    this.input = input;
  }

  taskViews(): AgentTaskView[] {
    return [...this.tasks.values()].map((task) => structuredClone(task));
  }

  async delegate(assignments: DelegationAssignment[]): Promise<AgentRunResult[]> {
    if (this.input.signal.aborted) {
      throw taskError("TASK_CANCELLED", "Investigation was cancelled before delegation.");
    }
    const scheduled = assignments.map((assignment) => this.createAndSchedule(assignment));
    return Promise.all(scheduled);
  }

  dispose() {
    this.input.agentManager.dispose();
  }

  private createAndSchedule(assignment: DelegationAssignment) {
    const task = createAgentTask({
      id: `T${String(++this.taskSequence).padStart(3, "0")}`,
      investigationId: this.input.investigationId,
      runId: this.input.runId,
      agent: assignment.agent,
      instruction: assignment.goal,
      service: assignment.service,
      operation: assignment.operation,
      evidenceIds: assignment.evidenceIds,
      hypothesisIds: assignment.hypothesisIds,
      policy: taskPolicyFromEnv(),
    });
    this.tasks.set(task.id, task);
    this.publish("task.created", task);

    return this.scheduler.schedule({
      key: task.agent,
      taskId: task.id,
      signal: this.input.signal,
      execute: () => this.executeTask(task.id),
    }).catch((error) => {
      // A queued task can be cancelled by the scheduler before executeTask starts.
      const current = this.tasks.get(task.id)!;
      if (current.status === "queued") {
        const cancelled = transitionTask(current, "cancelled", { error: toTaskErrorView(error, "TASK_CANCELLED") });
        this.tasks.set(task.id, cancelled);
        this.publish("task.cancelled", cancelled);
      }
      throw error;
    });
  }

  private async executeTask(taskId: string): Promise<AgentRunResult> {
    let task = this.tasks.get(taskId)!;
    if (this.input.signal.aborted) {
      const error = taskError("TASK_CANCELLED", `Task ${task.id} was cancelled before start.`);
      task = transitionTask(task, "cancelled", { error: toTaskErrorView(error) });
      this.tasks.set(task.id, task);
      this.publish("task.cancelled", task);
      throw error;
    }

    task = transitionTask(task, "running");
    this.tasks.set(task.id, task);
    this.publish("task.started", task);

    const child = new AbortController();
    const abortFromInvestigation = () => child.abort(
      this.input.signal.reason instanceof Error
        ? this.input.signal.reason
        : taskError("TASK_CANCELLED", `Task ${task.id} cancelled by investigation.`),
    );
    this.input.signal.addEventListener("abort", abortFromInvestigation, { once: true });
    const timeout = setTimeout(() => {
      child.abort(taskError("TASK_TIMEOUT", `Task ${task.id} exceeded ${task.policy.timeoutMs}ms timeout.`));
    }, task.policy.timeoutMs);

    try {
      const caseContext = this.input.getCaseContext();
      const context = this.contextBuilder.buildSpecialistContext({
        task,
        caseContext,
        hypotheses: this.input.getHypotheses(),
        evidence: this.input.getEvidence(),
      });
      const result = await this.input.agentManager.run({
        task,
        caseContext,
        context,
        signal: child.signal,
      });
      const completed = transitionTask(task, "succeeded", {
        result: {
          summary: result.summary,
          evidenceIds: result.evidence.map((item) => item.id),
          toolCallCount: result.toolCallCount,
          turnCount: result.turnCount,
          durationMs: result.durationMs,
        },
      });
      this.tasks.set(task.id, completed);
      this.publish("task.completed", completed);
      return result;
    } catch (error) {
      const current = this.tasks.get(task.id)!;
      if (isTimeoutError(error)) {
        const next = transitionTask(current, "timed_out", { error: toTaskErrorView(error) });
        this.tasks.set(task.id, next);
        this.publish("task.timed_out", next);
      } else if (isCancellationError(error) || this.input.signal.aborted) {
        const next = transitionTask(current, "cancelled", { error: toTaskErrorView(error, "TASK_CANCELLED") });
        this.tasks.set(task.id, next);
        this.publish("task.cancelled", next);
      } else {
        const next = transitionTask(current, "failed", { error: toTaskErrorView(error) });
        this.tasks.set(task.id, next);
        this.publish("task.failed", next);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.input.signal.removeEventListener("abort", abortFromInvestigation);
    }
  }

  private publish(
    type: "task.created" | "task.started" | "task.completed" | "task.failed" | "task.cancelled" | "task.timed_out",
    task: AgentTask,
  ) {
    this.input.channel.publish(type, structuredClone(task), {
      investigationId: task.investigationId,
      runId: task.runId,
      taskId: task.id,
      agent: task.agent,
    });
  }
}
