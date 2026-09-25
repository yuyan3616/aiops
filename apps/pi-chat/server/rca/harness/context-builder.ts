import type { EvidenceView, HypothesisView } from "../../../shared/rca-types.ts";
import type { AgentTask, CaseContext, SpecialistExecutionContext } from "./task-types.ts";
import { taskError } from "./errors.ts";

function compactEvidence(item: EvidenceView) {
  return {
    id: item.id,
    modality: item.modality,
    label: item.label,
    summary: item.summary,
    entityRefs: item.entityRefs,
    timeRange: item.timeRange,
  };
}

function serviceMatches(item: EvidenceView, service: string | undefined) {
  if (!service) return false;
  const normalized = service.toLowerCase();
  return item.entityRefs.some((entity) => entity.toLowerCase().includes(normalized));
}

export class ContextBuilder {
  buildSpecialistContext(input: {
    task: AgentTask;
    caseContext: CaseContext;
    hypotheses: HypothesisView[];
    evidence: EvidenceView[];
  }): SpecialistExecutionContext {
    const { task, caseContext } = input;
    if (!task.instruction.trim()) {
      throw taskError("TASK_INVALID_CONTEXT", `Task ${task.id} has no instruction.`);
    }

    const hypothesesById = new Map(input.hypotheses.map((item) => [item.id, item]));
    const selectedHypotheses = task.hypothesisIds
      .map((id) => hypothesesById.get(id))
      .filter((item): item is HypothesisView => Boolean(item));

    const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));
    const selected = new Map<string, EvidenceView>();
    const add = (item: EvidenceView | undefined) => {
      if (!item || selected.size >= task.policy.maxEvidence) return;
      selected.set(item.id, item);
    };

    // 1. Explicit references always win.
    for (const id of task.evidenceIds) add(evidenceById.get(id));

    // 2. Evidence already attached to selected hypotheses.
    for (const hypothesis of selectedHypotheses) {
      for (const id of hypothesis.supportingEvidenceIds) add(evidenceById.get(id));
      for (const id of hypothesis.contradictingEvidenceIds) add(evidenceById.get(id));
    }

    // 3. Cheap entity/service match.
    for (const item of [...input.evidence].reverse()) {
      if (selected.size >= task.policy.maxEvidence) break;
      if (serviceMatches(item, task.service)) add(item);
    }

    // 4. Most recent evidence fills the remaining bounded context.
    for (const item of [...input.evidence].reverse()) {
      if (selected.size >= task.policy.maxEvidence) break;
      add(item);
    }

    return {
      case: {
        taskId: caseContext.datasetTaskId,
        alertTitle: caseContext.alertTitle,
        ...(caseContext.alertEntity ? { alertEntity: caseContext.alertEntity } : {}),
        startTime: caseContext.startTime,
        endTime: caseContext.endTime,
      },
      assignment: {
        taskId: task.id,
        instruction: task.instruction,
        ...(task.service ? { service: task.service } : {}),
        ...(task.operation ? { operation: task.operation } : {}),
      },
      hypotheses: selectedHypotheses.map((item) => ({
        id: item.id,
        title: item.title,
        state: item.state,
      })),
      evidence: [...selected.values()].map(compactEvidence),
      constraints: {
        timeoutMs: task.policy.timeoutMs,
        maxTurns: task.policy.maxTurns,
        maxToolCalls: task.policy.maxToolCalls,
        maxEvidence: task.policy.maxEvidence,
      },
    };
  }
}
