import type { Investigation } from "./types";

export const RCA_BUDGET_POLICY = {
  primaryLimit: 4,
  recoveryLimit: 2,
  maxParallelTasks: 3,
  maxGlobalParallelTasks: 9,
  safety: {
    maxTaskIntents: 32,
    maxStartedTasks: 16,
    maxUnderlyingToolCalls: 100,
  },
} as const;

export type BudgetClass = "primary" | "recovery";

interface LedgerBase {
  sequence: number;
  id: string;
  at: string;
}

export type BudgetLedgerEvent = LedgerBase &
  (
    | {
        type: "budget.reserved";
        reservationId: string;
        dispatchOperationId: string;
        requestHash: string;
        taskId: string;
        budgetClass: BudgetClass;
        recoveryOfTaskId?: string;
      }
    | {
        type: "budget.committed" | "budget.released";
        reservationId: string;
        taskId: string;
        budgetClass: BudgetClass;
        reason: string;
      }
    | {
        type: "safety.consumed";
        executionId: string;
        resource: "task_intent" | "started_task" | "tool_execution";
      }
  );

type NewBudgetEvent = BudgetLedgerEvent extends infer E
  ? E extends BudgetLedgerEvent
    ? Omit<E, keyof LedgerBase>
    : never
  : never;

type Reservation = {
  event: Extract<BudgetLedgerEvent, { type: "budget.reserved" }>;
  terminal?: Extract<BudgetLedgerEvent, { type: "budget.committed" | "budget.released" }>;
};

export interface BudgetProjection {
  primary: { used: number; reserved: number; limit: number; remaining: number };
  recovery: { used: number; reserved: number; limit: number; remaining: number };
  runtime: { running: number; limit: number };
  safety: {
    taskIntents: number;
    startedTasks: number;
    toolExecutions: number;
    intentLimit: number;
    startedLimit: number;
    toolLimit: number;
  };
}

export interface BudgetFold {
  projection: BudgetProjection;
  reservations: Map<string, Reservation>;
  operations: Map<string, { requestHash: string; taskIds: string[] }>;
  recoveredTaskIds: Set<string>;
}

export function nextLedgerEvent(
  investigation: Investigation,
  event: NewBudgetEvent,
): BudgetLedgerEvent {
  const sequence = (investigation.budgetLedger?.at(-1)?.sequence ?? 0) + 1;
  return {
    ...event,
    sequence,
    id: `B${String(sequence).padStart(4, "0")}`,
    at: new Date().toISOString(),
  } as BudgetLedgerEvent;
}

export function appendLedgerEvent(investigation: Investigation, event: BudgetLedgerEvent): void {
  investigation.budgetLedger ??= [];
  investigation.budgetLedger.push(event);
}

export function foldBudget(investigation: Investigation, running = 0): BudgetFold {
  const reservations = new Map<string, Reservation>();
  const operations = new Map<string, { requestHash: string; taskIds: string[] }>();
  const recoveredTaskIds = new Set<string>();
  const eventIds = new Map<string, string>();
  const safetyIds = new Map<string, string>();
  let sequence = 0;
  let taskIntents = 0;
  let startedTasks = 0;
  let toolExecutions = 0;

  for (const event of investigation.budgetLedger ?? []) {
    const encoded = JSON.stringify(event);
    const duplicate = eventIds.get(event.id);
    if (duplicate) {
      if (duplicate !== encoded) throw new Error(`Conflicting budget event ${event.id}`);
      continue;
    }
    if (event.sequence !== ++sequence) throw new Error(`Budget ledger sequence gap at ${event.id}`);
    eventIds.set(event.id, encoded);

    if (event.type === "budget.reserved") {
      if (reservations.has(event.reservationId))
        throw new Error(`Duplicate reservation ${event.reservationId}`);
      const operation = operations.get(event.dispatchOperationId);
      if (operation && operation.requestHash !== event.requestHash) {
        throw new Error(`Conflicting dispatch operation ${event.dispatchOperationId}`);
      }
      if (event.budgetClass === "recovery") {
        if (!event.recoveryOfTaskId || recoveredTaskIds.has(event.recoveryOfTaskId)) {
          throw new Error(`Invalid recovery source for ${event.taskId}`);
        }
        recoveredTaskIds.add(event.recoveryOfTaskId);
      }
      reservations.set(event.reservationId, { event });
      if (operation) operation.taskIds.push(event.taskId);
      else
        operations.set(event.dispatchOperationId, {
          requestHash: event.requestHash,
          taskIds: [event.taskId],
        });
      continue;
    }
    if (event.type === "safety.consumed") {
      const key = `${event.resource}:${event.executionId}`;
      if (safetyIds.has(key)) continue; // Same physical execution retried with a new event id.
      safetyIds.set(key, event.id);
      if (event.resource === "task_intent") taskIntents++;
      else if (event.resource === "started_task") startedTasks++;
      else toolExecutions++;
      continue;
    }
    const reservation = reservations.get(event.reservationId);
    if (
      !reservation ||
      reservation.event.taskId !== event.taskId ||
      reservation.event.budgetClass !== event.budgetClass
    ) {
      throw new Error(`Conflicting budget terminal ${event.reservationId}`);
    }
    if (reservation.terminal) {
      if (reservation.terminal.type === event.type && reservation.terminal.reason === event.reason)
        continue;
      throw new Error(`Conflicting budget terminal ${event.reservationId}`);
    }
    reservation.terminal = event;
  }

  const primary = { used: 0, reserved: 0, limit: RCA_BUDGET_POLICY.primaryLimit, remaining: 0 };
  const recovery = { used: 0, reserved: 0, limit: RCA_BUDGET_POLICY.recoveryLimit, remaining: 0 };
  for (const { event, terminal } of reservations.values()) {
    const entry = event.budgetClass === "primary" ? primary : recovery;
    if (!terminal) entry.reserved++;
    else if (terminal.type === "budget.committed") entry.used++;
  }
  primary.remaining = Math.max(0, primary.limit - primary.used - primary.reserved);
  recovery.remaining = Math.max(0, recovery.limit - recovery.used - recovery.reserved);
  return {
    reservations,
    operations,
    recoveredTaskIds,
    projection: {
      primary,
      recovery,
      runtime: { running, limit: RCA_BUDGET_POLICY.maxParallelTasks },
      safety: {
        taskIntents,
        startedTasks,
        toolExecutions,
        intentLimit: RCA_BUDGET_POLICY.safety.maxTaskIntents,
        startedLimit: RCA_BUDGET_POLICY.safety.maxStartedTasks,
        toolLimit: RCA_BUDGET_POLICY.safety.maxUnderlyingToolCalls,
      },
    },
  };
}

export function assertBudgetConsistency(investigation: Investigation): void {
  if (investigation.schemaVersion !== 2) return;
  const { reservations } = foldBudget(investigation);
  const tasks = new Map(investigation.expertTasks.map((task) => [task.id, task]));
  for (const { event, terminal } of reservations.values()) {
    const task = tasks.get(event.taskId);
    if (
      !task ||
      task.budgetReservationId !== event.reservationId ||
      task.budgetClass !== event.budgetClass ||
      task.dispatchOperationId !== event.dispatchOperationId ||
      task.recoveryOfTaskId !== event.recoveryOfTaskId
    ) {
      throw new Error(`Task intent does not match budget reservation ${event.reservationId}`);
    }
    const finished =
      task.status === "completed" || task.status === "failed" || task.status === "cancelled";
    if (Boolean(terminal) !== finished)
      throw new Error(`Task/ledger terminal mismatch for ${task.id}`);
  }
  for (const task of investigation.expertTasks) {
    if (!task.budgetReservationId || !reservations.has(task.budgetReservationId)) {
      throw new Error(`Task ${task.id} lacks a budget reservation`);
    }
    if (
      !(investigation.budgetLedger ?? []).some(
        (event) =>
          event.type === "safety.consumed" &&
          event.resource === "task_intent" &&
          event.executionId === task.id,
      )
    ) {
      throw new Error(`Task ${task.id} lacks Safety intent accounting`);
    }
  }
}
