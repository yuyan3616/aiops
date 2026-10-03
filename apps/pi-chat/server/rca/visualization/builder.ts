import type {
  ExpertTask,
  Hypothesis,
  HypothesisStatus,
  Investigation,
  InvestigationEvent,
  ToolCallRecord,
} from "../types";

import type {
  FlowEdge,
  FlowNode,
  FlowNodeStatus,
  InvestigationFlowModel,
} from "./types";

const MAX_TASKS = 12;
const MAX_TASK_SUMMARY = 32;
const MAX_HYPOTHESIS_SUMMARY = 30;

interface HypothesisSnapshot {
  id: string;
  statement: string;
  status: HypothesisStatus;
  confidence: number;
  entity?: string;
  mechanism?: string;
}

interface HypothesisChange {
  at: string;
  id: string;
  fromConfidence: number;
  toConfidence: number;
  fromStatus: HypothesisStatus;
  toStatus: HypothesisStatus;
}

function truncate(value: string | undefined, max: number): string {
  const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "未提供摘要";
  return cleaned.length > max ? cleaned.slice(0, max - 1) + "…" : cleaned;
}

function compactStatement(value: string | undefined, max = MAX_HYPOTHESIS_SUMMARY): string {
  const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "未提供假设摘要";

  const candidates = [
    cleaned.split(/[（(]/, 1)[0],
    cleaned.split(/[，。；;]/, 1)[0],
  ].filter((item): item is string => Boolean(item && item.trim().length >= 4));

  return truncate(candidates[0] ?? cleaned, max);
}

function hypothesisCaption(hypothesis: HypothesisSnapshot): string {
  if (hypothesis.entity && hypothesis.mechanism) {
    return truncate(
      hypothesis.entity + " · " + compactStatement(hypothesis.mechanism, 18),
      MAX_HYPOTHESIS_SUMMARY,
    );
  }
  if (hypothesis.entity) {
    return truncate(
      hypothesis.entity + " · " + compactStatement(hypothesis.statement, 18),
      MAX_HYPOTHESIS_SUMMARY,
    );
  }
  return compactStatement(hypothesis.statement);
}

function confidenceLabel(value: number): string {
  return Math.round(Math.max(0, Math.min(1, value)) * 100) + "%";
}

function hypothesisStatusLabel(status: HypothesisStatus): string {
  return {
    possible: "待验证",
    investigating: "调查中",
    supported: "已支持",
    rejected: "已排除",
    confirmed: "已确认",
  }[status];
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

function expertName(task: ExpertTask): string {
  return {
    trace: "Trace",
    metrics: "Metrics",
    log: "Log",
    "event-topology": "Event / Topology",
  }[task.expert];
}

function failureReason(task: ExpertTask, toolCalls: ToolCallRecord[]): string {
  const detail = [
    task.terminationReason,
    task.termination?.detail,
    task.finding?.blockedOn,
    ...toolCalls.map((call) => call.error ?? call.resultSummary ?? ""),
  ]
    .filter(Boolean)
    .join(" ");

  if (/concurrent_request_limit|too many concurrent|concurrency|并发/i.test(detail)) {
    return "并发限制";
  }
  if (/429|rate.?limit|限流/i.test(detail)) return "请求限流";
  if (/timeout|timed out|超时/i.test(detail)) return "请求超时";
  if (/restart|service_restart|重启/i.test(detail)) return "服务重启中断";
  if (/user intervention|aborted|abort|用户介入|取消/i.test(detail)) return "用户介入中断";
  if (/context|token.*limit|上下文/i.test(detail)) return "上下文限制";
  return task.status === "cancelled" ? "任务取消" : "任务失败";
}

function taskSummary(task: ExpertTask, toolCalls: ToolCallRecord[]): string {
  if (task.status === "failed" || task.status === "cancelled") {
    return failureReason(task, toolCalls);
  }

  if (task.finding?.status === "inconclusive") return "未形成明确证据";
  if (task.finding?.verdict === "no-signal") return "未发现有效信号";
  if (task.finding?.conclusions?.[0]) {
    return truncate(task.finding.conclusions[0], MAX_TASK_SUMMARY);
  }
  if (task.finding?.summary) return truncate(task.finding.summary, MAX_TASK_SUMMARY);
  if (task.evidenceIds.length > 0) return task.evidenceIds.length + " 条关键证据";
  return "取证完成";
}

function expertLabel(task: ExpertTask, toolCalls: ToolCallRecord[]): string {
  const marker =
    task.status === "completed"
      ? "✓"
      : task.status === "failed"
        ? "✕"
        : task.status === "cancelled"
          ? "⊘"
          : "•";
  const prefix = task.budgetClass === "recovery" || task.recoveryOfTaskId ? "Recovery " : "";
  return (
    marker +
    " " +
    prefix +
    expertName(task) +
    "\n" +
    taskSummary(task, toolCalls.filter((call) => call.expertTaskId === task.id))
  );
}

function snapshotFromEvent(event: InvestigationEvent): HypothesisSnapshot | undefined {
  if (event.type !== "hypothesis.created" && event.type !== "hypothesis.updated") return undefined;
  const raw = event.payload.hypothesis;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;

  const hypothesis = raw as Partial<Hypothesis>;
  if (
    typeof hypothesis.id !== "string" ||
    typeof hypothesis.statement !== "string" ||
    typeof hypothesis.status !== "string" ||
    typeof hypothesis.confidence !== "number"
  ) {
    return undefined;
  }

  return {
    id: hypothesis.id,
    statement: hypothesis.statement,
    status: hypothesis.status as HypothesisStatus,
    confidence: hypothesis.confidence,
    ...(hypothesis.entity ? { entity: hypothesis.entity } : {}),
    ...(hypothesis.mechanism ? { mechanism: hypothesis.mechanism } : {}),
  };
}

function hypothesisTimeline(
  hypotheses: Hypothesis[],
  events: InvestigationEvent[],
): { initial: HypothesisSnapshot[]; changes: HypothesisChange[] } {
  const finalById = new Map(hypotheses.map((hypothesis) => [hypothesis.id, hypothesis]));
  const firstById = new Map<string, HypothesisSnapshot>();
  const previousById = new Map<string, HypothesisSnapshot>();
  const changes: HypothesisChange[] = [];

  for (const event of [...events].sort((left, right) => left.id - right.id)) {
    const snapshot = snapshotFromEvent(event);
    if (!snapshot || !finalById.has(snapshot.id)) continue;

    const previous = previousById.get(snapshot.id);
    if (!firstById.has(snapshot.id)) firstById.set(snapshot.id, snapshot);

    if (
      event.type === "hypothesis.updated" &&
      previous &&
      (Math.abs(previous.confidence - snapshot.confidence) >= 0.005 ||
        previous.status !== snapshot.status)
    ) {
      changes.push({
        at: event.at,
        id: snapshot.id,
        fromConfidence: previous.confidence,
        toConfidence: snapshot.confidence,
        fromStatus: previous.status,
        toStatus: snapshot.status,
      });
    }

    previousById.set(snapshot.id, snapshot);
  }

  const initial = [...hypotheses]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((hypothesis) => {
      return (
        firstById.get(hypothesis.id) ?? {
          id: hypothesis.id,
          statement: hypothesis.statement,
          status: hypothesis.status,
          confidence: hypothesis.confidence,
          ...(hypothesis.entity ? { entity: hypothesis.entity } : {}),
          ...(hypothesis.mechanism ? { mechanism: hypothesis.mechanism } : {}),
        }
      );
    });

  return { initial, changes };
}

function aggregateChanges(
  changes: HypothesisChange[],
  from: string,
  to?: string,
): HypothesisChange[] {
  const byId = new Map<string, HypothesisChange>();
  for (const change of changes) {
    if (change.at < from || (to && change.at >= to)) continue;
    const current = byId.get(change.id);
    if (!current) {
      byId.set(change.id, { ...change });
      continue;
    }
    current.toConfidence = change.toConfidence;
    current.toStatus = change.toStatus;
    current.at = change.at;
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function changeLabel(change: HypothesisChange): string {
  const delta = change.toConfidence - change.fromConfidence;
  const marker = delta > 0.005 ? "↑" : delta < -0.005 ? "↓" : "→";
  const status =
    change.fromStatus === change.toStatus ? "" : " · " + hypothesisStatusLabel(change.toStatus);
  return (
    change.id +
    " " +
    confidenceLabel(change.fromConfidence) +
    " → " +
    confidenceLabel(change.toConfidence) +
    " " +
    marker +
    status
  );
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

  const incidentLabel =
    investigation.caseId ??
    investigation.context?.target.service ??
    investigation.context?.target.entity ??
    investigation.context?.target.container ??
    investigation.symptom;
  const startId = addNode(nodes, {
    id: "start",
    kind: "start",
    label: "开始调查\n" + truncate(incidentLabel, 34),
  });
  const alertLabel = investigation.context
    ? "IncidentContext\n" +
      truncate(investigation.context.symptom, 34) +
      "\n" +
      truncate(
        investigation.context.target.service ??
          investigation.context.target.entity ??
          investigation.context.target.container,
        28,
      )
    : "告警上下文\n" +
      truncate(investigation.alertContext?.title, 34) +
      "\n" +
      truncate(investigation.alertContext?.entity.name, 28);
  const alertId = addNode(nodes, {
    id: "alert",
    kind: "alert",
    label: alertLabel,
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
        "初步调查\n" +
        overviewEvidence.length +
        " 条证据 · " +
        overviewCalls.length +
        " 次查询" +
        (modalities.length ? "\n" + modalities.slice(0, 4).join(" / ") : ""),
    });
    addEdge(edges, cursor, overviewId);
    cursor = overviewId;
  }

  const hypotheses = [...investigation.hypotheses].sort((a, b) => a.id.localeCompare(b.id));
  const timeline = hypothesisTimeline(hypotheses, events);
  if (timeline.initial.length > 0) {
    const initialLines = timeline.initial.slice(0, 5).map(
      (hypothesis) =>
        hypothesis.id +
        " · " +
        hypothesisCaption(hypothesis) +
        " · " +
        confidenceLabel(hypothesis.confidence),
    );
    if (timeline.initial.length > initialLines.length) {
      initialLines.push("另 " + (timeline.initial.length - initialLines.length) + " 个候选方向");
    }

    const hypothesisId = addNode(nodes, {
      id: "hypotheses-initial",
      kind: "hypothesis",
      label:
        "建立 " +
        timeline.initial.length +
        " 个竞争假设\n" +
        initialLines.join("\n"),
    });
    addEdge(edges, cursor, hypothesisId);
    cursor = hypothesisId;
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
        ? "Recovery 专项取证\n" + group.length + " 个窄化任务"
        : "第 " + (index + 1) + " 轮专项取证\n" + group.length + " 个专家任务",
    });
    addEdge(edges, cursor, dispatchId);

    const taskNodeIds: string[] = [];
    for (const task of group) {
      const taskId = addNode(nodes, {
        id: "task-" + task.id,
        kind: "expert",
        status: taskStatus(task),
        label: expertLabel(task, investigation.toolCalls),
      });
      taskNodeIds.push(taskId);
      addEdge(edges, dispatchId, taskId);
    }

    const groupStart = group[0]!.createdAt;
    const nextGroupStart = taskGroups[index + 1]?.[0]?.createdAt;
    const roundChanges = aggregateChanges(timeline.changes, groupStart, nextGroupStart);
    const groupHasFailure = group.some(
      (task) => task.status === "failed" || task.status === "cancelled",
    );

    const resultId = addNode(nodes, {
      id: roundChanges.length > 0 ? "hypothesis-update-" + (index + 1) : "round-result-" + (index + 1),
      kind: roundChanges.length > 0 ? "hypothesis" : "dispatch",
      status: roundChanges.length > 0 ? "neutral" : groupHasFailure ? "interrupted" : "success",
      label:
        roundChanges.length > 0
          ? "假设重新评估\n" + roundChanges.slice(0, 5).map(changeLabel).join("\n")
          : groupHasFailure
            ? "本轮取证结束\n部分专家任务未完成"
            : "本轮取证完成",
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
        label: "专项取证受阻\n已保留有效证据",
      });
      addEdge(edges, cursor, interruptedId);
      cursor = interruptedId;

      const resumed = events.some(
        (event) =>
          event.type === "investigation.resumed" &&
          event.at >= groupStart &&
          (!nextGroupStart || event.at <= nextGroupStart),
      );
      if (resumed) {
        const resumeId = addNode(nodes, {
          id: "resume-" + (index + 1),
          kind: "resume",
          label: "恢复调查\n继续窄化取证",
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

  const rootCause = investigation.rootCause;
  const conclusionLines = rootCause
    ? [
        "最终结论 · " + rootCause.status + " · " + confidenceLabel(rootCause.confidence),
        rootCause.rootCauseEntities.length
          ? truncate(rootCause.rootCauseEntities.join(", "), 34)
          : truncate(rootCause.summary, 34),
        ...(rootCause.mechanism ? [truncate(rootCause.mechanism, 38)] : []),
      ]
    : ["调查结束 · " + investigation.status];

  const conclusionId = addNode(nodes, {
    id: "conclusion",
    kind: "conclusion",
    status: rootCause?.status === "inconclusive" ? "interrupted" : "success",
    label: conclusionLines.join("\n"),
  });
  addEdge(edges, cursor, conclusionId);

  return {
    investigationId: investigation.id,
    direction: "TD",
    nodes,
    edges,
  };
}
