import type { Investigation, ToolCallRecord } from "@server/rca/types";
import type { MessageListItem, ToolRun } from "@shared/types";

const restartMessage = "执行已因服务重启而中断。";

function detailsRecord(details: unknown): Record<string, unknown> {
  return details && typeof details === "object" && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : {};
}

function toolStatus(status: ToolCallRecord["status"]): ToolRun["status"] {
  if (status === "completed") return "success";
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "error";
  return "running";
}

function investigationIdForAgent(agentId: string): string | undefined {
  const separator = ":agent:";
  const index = agentId.indexOf(separator);
  return index > 0 ? agentId.slice(0, index) : undefined;
}

function wasInterruptedByRestart(
  investigation: Investigation,
  explicitFlag?: boolean,
): boolean {
  if (explicitFlag) return true;
  return (
    investigation.status === "interrupted" &&
    /process restart/i.test(investigation.error ?? "")
  );
}

function reconcileAgentTools(
  investigation: Investigation,
  taskId: string,
  current: ToolRun[],
): ToolRun[] {
  const prefix = `${investigation.id}:`;
  const existingByCallId = new Map(
    current
      .filter((tool) => tool.id.startsWith(prefix))
      .map((tool) => [tool.id.slice(prefix.length), tool]),
  );
  const task = investigation.expertTasks.find((entry) => entry.id === taskId);
  if (!task) return current;

  const reconciled = task.toolCallIds.flatMap((callId) => {
    const call = investigation.toolCalls.find((entry) => entry.id === callId);
    if (!call) return [];
    const existing = existingByCallId.get(callId);
    const observation = investigation.observations?.find(
      (entry) => entry.toolCallId === call.id,
    );
    const observationFacts = detailsRecord(observation?.facts);
    const details = {
      ...detailsRecord(existing?.details),
      ...(call.expertTaskId ? { expertTaskId: call.expertTaskId } : {}),
      ...(call.rawRef ? { rawRef: call.rawRef } : {}),
      ...(observationFacts.result !== undefined
        ? { agentContextResult: observationFacts.result }
        : {}),
      ...(wasInterruptedByRestart(investigation, call.interruptedByRestart)
        ? { interruptedByRestart: true }
        : {}),
    };
    return [{
      id: `${prefix}${call.id}`,
      name: call.tool,
      args: call.query,
      status: toolStatus(call.status),
      ...(call.resultSummary || call.error || existing?.result
        ? { result: call.resultSummary ?? call.error ?? existing?.result }
        : {}),
      ...(Object.keys(details).length > 0 ? { details } : {}),
    } satisfies ToolRun];
  });

  const knownIds = new Set(reconciled.map((tool) => tool.id));
  return [...reconciled, ...current.filter((tool) => !knownIds.has(tool.id))];
}

export function reconcileRcaExecutionItems(
  items: MessageListItem[],
  investigations: ReadonlyMap<string, Investigation>,
): MessageListItem[] {
  return items.map((item) => {
    if (item.kind !== "agent") return item;
    const investigationId = investigationIdForAgent(item.id);
    if (!investigationId) return item;
    const investigation = investigations.get(investigationId);
    if (!investigation) return item;
    const task = investigation.expertTasks.find((entry) => entry.id === item.agent.taskId);
    if (!task) return item;

    const evidence = investigation.evidence
      .filter((entry) => entry.expertTaskId === task.id)
      .map((entry) => ({
        id: entry.id,
        modality: entry.modality,
        summary: entry.summary,
      }));
    const evidenceIds = new Set(evidence.map((entry) => entry.id));
    const mergedEvidence = [
      ...evidence,
      ...item.agent.evidence.filter((entry) => !evidenceIds.has(entry.id)),
    ];

    const status = task.status === "pending" ? "running" : task.status;
    const interruptedByRestart = wasInterruptedByRestart(
      investigation,
      task.interruptedByRestart,
    );
    return {
      ...item,
      agent: {
        ...item.agent,
        status,
        tools: reconcileAgentTools(investigation, task.id, item.agent.tools),
        evidence: mergedEvidence,
        ...(interruptedByRestart
          ? {
              interruptedByRestart: true,
              summary: item.agent.summary ?? investigation.error ?? restartMessage,
            }
          : {}),
      },
    };
  });
}

export function settleInterruptedRcaSessionTools(
  items: MessageListItem[],
  investigations: ReadonlyMap<string, Investigation>,
  isStreaming: boolean,
): MessageListItem[] {
  if (isStreaming) return items;

  return items.map((item) => {
    if (item.kind !== "tool" || item.tool.status !== "running") return item;
    const investigationId =
      typeof item.tool.args.investigationId === "string"
        ? item.tool.args.investigationId
        : undefined;
    if (!investigationId) return item;
    const investigation = investigations.get(investigationId);
    if (investigation?.status !== "interrupted") return item;

    return {
      ...item,
      tool: {
        ...item.tool,
        status: "error",
        result: investigation.error ?? restartMessage,
        details: {
          ...detailsRecord(item.tool.details),
          interruptedByRestart: true,
        },
      },
    };
  });
}
