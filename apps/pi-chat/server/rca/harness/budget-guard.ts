import type { TaskPolicy } from "./task-types.ts";
import { taskError, type TaskExecutionError } from "./errors.ts";

export class BudgetGuard {
  private readonly policy: TaskPolicy;
  private toolCalls = 0;
  private turns = 0;
  private newEvidence = 0;
  private violation?: TaskExecutionError;

  constructor(policy: TaskPolicy) {
    this.policy = policy;
  }

  beforeToolCall() {
    if (this.toolCalls + 1 > this.policy.maxToolCalls) {
      const error = taskError(
        "TASK_TOOL_BUDGET_EXCEEDED",
        `Task tool-call budget exceeded (${this.policy.maxToolCalls}).`,
      );
      this.violation = error;
      throw error;
    }
    this.toolCalls += 1;
  }

  onTurnStart(abort: () => void) {
    this.turns += 1;
    if (this.turns > this.policy.maxTurns && !this.violation) {
      this.violation = taskError(
        "TASK_TURN_BUDGET_EXCEEDED",
        `Task turn budget exceeded (${this.policy.maxTurns}).`,
      );
      abort();
    }
  }

  beforeNewEvidence(count = 1) {
    if (this.newEvidence + count > this.policy.maxEvidence) {
      const error = taskError(
        "TASK_EVIDENCE_BUDGET_EXCEEDED",
        `Task Evidence budget exceeded (${this.policy.maxEvidence}).`,
      );
      this.violation = error;
      throw error;
    }
    this.newEvidence += count;
  }

  throwIfViolated() {
    if (this.violation) throw this.violation;
  }

  metrics() {
    return {
      toolCallCount: this.toolCalls,
      turnCount: this.turns,
      newEvidenceCount: this.newEvidence,
    };
  }
}
