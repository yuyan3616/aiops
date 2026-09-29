import type { ExpertTask, Hypothesis, Investigation, InvestigationEvent } from "../types";

import type {
  FlowEdge,
  FlowNode,
  FlowNodeStatus,
  InvestigationFlowModel,
} from "./types";

const MAX_TASKS = 12;
const MAX_LABEL = 88;

function truncate(value: string | undefined, max = MAX_LABEL): string {
  const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "未提供摘要";
  return cleaned.length > max ? cleaned.slice(0, max - 1) + "…" : cleaned;
}

function hypothesisStatus(hypothesis: Hypothesis): FlowNodeStatus {
  if (hypothesis.status === "rejected") return "rejected";
  if (hypothesis.status === "supported" || hypothesis.status === "confirmed") return "supported";
  return "neutral";
}

function taskStatus(task: ExpertTask): FlowNodeStatus {
  if (task.budgetClass === "recovery" || task.recoveryOfTaskId) return "recovery";
  if (task.status === "completed") return "success";
  if (task.status === "failed" || task.status === "cancelled") return "failed";
  return "neutral";
}

function groupTasks(tasks: ExpertTask[]): ExpertTask[][] {
  const groups = new Map<string, ExpertTask[]>();
  for (const task of tasks) {
    const key =
      task.dispatchOperationId ??
      (task.budgetClass ?? "primary") + ":" + task.createdAt.slice(0, 19);
    const group = groups.get(key);
    if (group) group.push(task);
    else groups.set(key, [task]);
  }
  return [...groups.values()].sort((left, right) =>
    left[0]!.createdAt.localeCompare(right[0]!.createdAt),
  );
}

function expertLabel(task: ExpertTask): string {
  const expert = {
    trace: "Trace",
    metrics: "Metrics",
    log: "Log",
    "event-topology": "Event / Topology",
  }[task.expert];
  const result = task.finding?.summary
    ? truncate(task.finding.summary, 58)
    : truncate(task.objective, 58);
  const marker =
    task.status === "completed"
      ? "✓"
      : task.status === "failed"
        ? "✕"
        : task.status === "cancelled"
          ? "⊘"
          : "•";
  const prefix = task.budgetClass === "recovery" || task.recoveryOfTaskId ? "Recovery " : "";
  return marker + " " + task.id + " · " + prefix + expert + "\n" + result;
}

function addNode(nodes: FlowNode[], node: FlowNode): string {
  if (!nodes.some((item) => item.id === node.id)) nodes.push(node);
  return node.id;
}

function addEdge(edges: FlowEdge[], from: string, to: string, options: Partial<FlowEdge> = {}): void {
  if (from === to) return;
  if (edges.some((edge) => edge.from === from && edge.to === to && edge.label === options.label)) {
    return;
  }
  edges.push({ from, to, ...options });
}

export function buildInvestigationFlow(
  investigation: Investigation,
  events: InvestigationEvent[],
): InvestigationFlowModel {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  const startId = addNode(nodes, {
    id: "start",
    kind: "start",
    label: "开始调查\ncaseId=" + investigation.caseId,
  });
  const alertId = addNode(nodes, {
    id: "alert",
    kind: "alert",
    label:
      "告警上下文\n" +
      truncate(investigation.alertContext.title, 64) +
      "\n" +
      truncate(investigation.alertContext.entity.name, 48),
  });
  addEdge(edges, startId, alertId);

  const overviewEvidence = investigation.evidence.filter((item) => !item.expertTaskId);
  const overviewCalls = investigation.toolCalls.filter((item) => !item.expertTaskId);
  let cursor = alertId;
  if (overviewEvidence.length > 0 || overviewCalls.length > 1) {
    const modalities = [...new Set(overviewEvidence.map((item) => item.modality))];
    const overviewId = addNode(nodes, {
      id: "overview",
      kind: "overview",
      label:
        "初步调查 / Overview\n" +
        overviewEvidence.length +
        " 条证据 · " +
        overviewCalls.length +
        " 次查询" +
        (modalities.length ? "\n" + modalities.join(" / ") : ""),
    });
    addEdge(edges, cursor, overviewId);
    cursor = overviewId;
  }

  const hypotheses = [...investigation.hypotheses].sort((a, b) => a.id.localeCompare(b.id));
  if (hypotheses.length > 0) {
    const hypothesisGate = addNode(nodes, {
      id: "hypothesis-created",
      kind: "hypothesis",
      label: "建立竞争假设\n" + hypotheses.length + " 个候选方向",
    });
    addEdge(edges, cursor, hypothesisGate);

    const initialHypothesisIds: string[] = [];
    for (const hypothesis of hypotheses) {
      const id = addNode(nodes, {
        id: "hypothesis-initial-" + hypothesis.id,
        kind: "hypothesis",
        label: hypothesis.id + "\n" + truncate(hypothesis.statement, 68),
      });
      initialHypothesisIds.push(id);
      addEdge(edges, hypothesisGate, id);
    }

    const mergeId = addNode(nodes, {
      id: "hypothesis-ready",
      kind: "hypothesis",
      label: "进入专项取证",
    });
    for (const id of initialHypothesisIds) addEdge(edges, id, mergeId);
    cursor = mergeId;
  }

  const allTasks = [...investigation.expertTasks]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, MAX_TASKS);
  const omittedTaskCount = Math.max(0, investigation.expertTasks.length - allTasks.length);
  const taskGroups = groupTasks(allTasks);

  for (const [index, group] of taskGroups.entries()) {
    const recovery = group.every(
      (task) => task.budgetClass === "recovery" || Boolean(task.recoveryOfTaskId),
    );
    const dispatchId = addNode(nodes, {
      id: "dispatch-" + (index + 1),
      kind: recovery ? "recovery" : "dispatch",
      status: recovery ? "recovery" : "neutral",
      label: recovery
        ? "Recovery Dispatch\n" + group.length + " 个窄化任务"
        : "第 " + (index + 1) + " 轮 Dispatch\n" + group.length + " 个专家任务",
    });
    addEdge(edges, cursor, dispatchId);

    const taskNodeIds: string[] = [];
    for (const task of group) {
      const taskId = addNode(nodes, {
        id: "task-" + task.id,
        kind: "expert",
        status: taskStatus(task),
        label: expertLabel(task),
      });
      taskNodeIds.push(taskId);
      addEdge(edges, dispatchId, taskId);
    }

    const groupHasFailure = group.some(
      (task) => task.status === "failed" || task.status === "cancelled",
    );
    const resultId = addNode(nodes, {
      id: "dispatch-result-" + (index + 1),
      kind: "dispatch",
      status: groupHasFailure ? "interrupted" : "success",
      label: groupHasFailure ? "本轮部分任务未完成" : "本轮取证完成",
    });
    for (const taskId of taskNodeIds) addEdge(edges, taskId, resultId);
    cursor = resultId;

    const nextGroup = taskGroups[index + 1];
    const nextIsRecovery = nextGroup?.some(
      (task) => task.budgetClass === "recovery" || Boolean(task.recoveryOfTaskId),
    );
    if (groupHasFailure && nextIsRecovery) {
      const interruptedId = addNode(nodes, {
        id: "interruption-" + (index + 1),
        kind: "interruption",
        status: "interrupted",
        label: "调查中断 / 专家失败\n保留已落盘 observation / evidence",
      });
      addEdge(edges, cursor, interruptedId);
      cursor = interruptedId;

      if (events.some((event) => event.type === "investigation.resumed")) {
        const resumeId = addNode(nodes, {
          id: "resume-" + (index + 1),
          kind: "resume",
          label: "恢复调查\nresume_rca_investigation",
        });
        addEdge(edges, cursor, resumeId);
        cursor = resumeId;
      }
    }
  }

  if (omittedTaskCount > 0) {
    const omittedId = addNode(nodes, {
      id: "tasks-omitted",
      kind: "expert",
      label: "其余 " + omittedTaskCount + " 个专家任务已折叠",
    });
    addEdge(edges, cursor, omittedId);
    cursor = omittedId;
  }

  if ((investigation.userInterventions ?? []).length > 0) {
    const interventionId = addNode(nodes, {
      id: "user-intervention",
      kind: "intervention",
      label: "用户补充信息\n" + investigation.userInterventions!.length + " 次 steering",
    });
    addEdge(edges, cursor, interventionId);
    cursor = interventionId;
  }

  if (hypotheses.length > 0) {
    const updateId = addNode(nodes, {
      id: "hypothesis-final",
      kind: "hypothesis",
      label: "更新并收敛假设",
    });
    addEdge(edges, cursor, updateId);

    const finalIds: string[] = [];
    for (const hypothesis of hypotheses) {
      const confidence = Number.isFinite(hypothesis.confidence)
        ? " · " + Math.round(hypothesis.confidence * 100) + "%"
        : "";
      const id = addNode(nodes, {
        id: "hypothesis-final-" + hypothesis.id,
        kind: "hypothesis",
        status: hypothesisStatus(hypothesis),
        label:
          hypothesis.id +
          " · " +
          hypothesis.status +
          confidence +
          "\n" +
          truncate(hypothesis.statement, 64),
      });
      finalIds.push(id);
      addEdge(edges, updateId, id);
    }

    const conclusionGate = addNode(nodes, {
      id: "conclusion-gate",
      kind: "conclusion",
      label: "conclude_investigation",
    });
    for (const id of finalIds) addEdge(edges, id, conclusionGate);
    cursor = conclusionGate;
  }

  const rootCause = investigation.rootCause;
  const conclusionId = addNode(nodes, {
    id: "conclusion",
    kind: "conclusion",
    status: rootCause?.status === "inconclusive" ? "interrupted" : "success",
    label: rootCause
      ? "结论 · " +
        rootCause.status +
        " · " +
        Math.round(rootCause.confidence * 100) +
        "%\n" +
        truncate(rootCause.summary, 76)
      : "调查结束 · " + investigation.status,
  });
  addEdge(edges, cursor, conclusionId);
  cursor = conclusionId;

  if (rootCause?.rootCauseEntities.length) {
    const rootId = addNode(nodes, {
      id: "root-cause",
      kind: "root-cause",
      status: rootCause.status === "inconclusive" ? "interrupted" : "supported",
      label:
        "Root Cause\n" +
        truncate(rootCause.rootCauseEntities.join(", "), 72) +
        (rootCause.mechanism ? "\n" + truncate(rootCause.mechanism, 72) : ""),
    });
    addEdge(edges, cursor, rootId);
  }

  return {
    investigationId: investigation.id,
    direction: "TD",
    nodes,
    edges,
  };
}
