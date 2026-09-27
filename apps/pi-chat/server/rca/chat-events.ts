import type { EventType } from "@shared/types";

import type { ExpertKind, ExpertTask, InvestigationEvent, ToolCallRecord } from "./types";

export interface ChatStreamProjection {
  type: EventType;
  payload: Record<string, unknown>;
}

const expertLabels: Record<ExpertKind, string> = {
  trace: "Trace 调查员",
  metrics: "Metrics 调查员",
  log: "Log 调查员",
  "event-topology": "Event / Topology 调查员",
};

function expertLabel(task?: ExpertTask): string {
  return task ? expertLabels[task.expert] : "专业调查员";
}

/**
 * Projects RCA business events into structured Pi Chat UI events.
 * User-visible thinking is reserved for the real Pi model stream.
 */
export class RcaChatEventMapper {
  private readonly investigationId: string;
  private readonly toolToAgent = new Map<string, string>();

  constructor(investigationId: string) {
    this.investigationId = investigationId;
  }

  map(event: InvestigationEvent): ChatStreamProjection[] {
    switch (event.type) {
      case "hypothesis.created": {
        const hypothesis = event.payload.hypothesis as
          | {
              id?: string;
              statement?: string;
              status?: string;
              confidence?: number;
              supportingEvidenceIds?: string[];
              contradictingEvidenceIds?: string[];
            }
          | undefined;
        if (!hypothesis?.id) return [];
        return [{
          type: "hypothesis.updated",
          payload: { investigationId: this.investigationId, hypothesis },
        }];
      }
      case "hypothesis.updated": {
        const id = String(event.payload.hypothesisId ?? "");
        if (!id) return [];
        return [{
          type: "hypothesis.updated",
          payload: {
            investigationId: this.investigationId,
            hypothesis: {
              id,
              ...(typeof event.payload.current === "string" ? { status: event.payload.current } : {}),
              ...(Array.isArray(event.payload.supportingEvidenceIds)
                ? { supportingEvidenceIds: event.payload.supportingEvidenceIds }
                : {}),
              ...(Array.isArray(event.payload.contradictingEvidenceIds)
                ? { contradictingEvidenceIds: event.payload.contradictingEvidenceIds }
                : {}),
              ...(typeof event.payload.reason === "string" ? { reason: event.payload.reason } : {}),
            },
          },
        }];
      }
      case "expert.started": {
        const task = event.payload.expertTask as ExpertTask | undefined;
        if (!task) return [];
        return [{
          type: "agent.started",
          payload: {
            agent: {
              id: this.agentId(task.id),
              taskId: task.id,
              expert: task.expert,
              label: expertLabel(task),
              objective: task.objective,
              status: "running",
              tools: [],
              evidence: [],
              // Missing implementation occurs only in older persisted investigation events.
              implementation: task.implementation ?? "deterministic",
            },
          },
        }];
      }
      case "tool.started": {
        const call = event.payload.toolCall as ToolCallRecord | undefined;
        if (!call) return [];
        if (call.expertTaskId) {
          const agentId = this.agentId(call.expertTaskId);
          this.toolToAgent.set(call.id, agentId);
          return [{
            type: "agent.tool.started",
            payload: {
              agentId,
              tool: {
                id: this.toolId(call.id),
                name: call.tool,
                args: call.query,
                status: "running",
                details: { expertTaskId: call.expertTaskId },
              },
            },
          }];
        }
        return [{
          type: "tool.started",
          payload: {
            id: this.toolId(call.id),
            name: call.tool,
            args: call.query,
            details: {},
          },
        }];
      }
      case "tool.completed": {
        const call = event.payload.toolCall as ToolCallRecord | undefined;
        if (!call) return [];
        const status =
          call.status === "completed"
            ? "success"
            : call.status === "cancelled"
              ? "cancelled"
              : "error";
        if (call.expertTaskId) {
          const agentId = this.agentId(call.expertTaskId);
          this.toolToAgent.set(call.id, agentId);
          return [{
            type: "agent.tool.completed",
            payload: {
              agentId,
              tool: {
                id: this.toolId(call.id),
                name: call.tool,
                args: call.query,
                status,
                result: call.resultSummary ?? call.error ?? event.summary,
                details: {
                  expertTaskId: call.expertTaskId,
                  rawRef: call.rawRef,
                },
              },
            },
          }];
        }
        return [{
          type: "tool.completed",
          payload: {
            id: this.toolId(call.id),
            name: call.tool,
            args: call.query,
            status,
            result: call.resultSummary ?? call.error ?? event.summary,
            details: { rawRef: call.rawRef },
          },
        }];
      }
      case "evidence.created": {
        const evidence = event.payload.evidence as
          | { id?: string; modality?: string; summary?: string; toolCallId?: string }
          | undefined;
        if (!evidence?.id || !evidence.toolCallId) return [];
        const agentId = this.toolToAgent.get(evidence.toolCallId);
        if (!agentId) return [];
        return [{
          type: "agent.evidence.added",
          payload: {
            agentId,
            evidence: {
              id: evidence.id,
              modality: evidence.modality ?? "unknown",
              summary: evidence.summary ?? "",
            },
          },
        }];
      }
      case "expert.thinking.delta": {
        const taskId = String(event.payload.expertTaskId ?? "");
        const delta = String(event.payload.delta ?? "");
        if (!taskId || !delta) return [];
        return [{
          type: "agent.thinking.delta",
          payload: {
            agentId: this.agentId(taskId),
            delta,
          },
        }];
      }
      case "expert.completed": {
        const task = event.payload.expertTask as ExpertTask | undefined;
        if (!task) return [];
        return [{
          type: "agent.completed",
          payload: {
            agentId: this.agentId(task.id),
            status: task.status,
            summary: event.summary,
          },
        }];
      }
      case "investigation.started":
      case "investigation.interrupted":
      case "investigation.resumed":
      case "observation.created":
      case "round.completed":
      case "investigation.completed":
      case "investigation.failed":
      case "investigation.cancelled":
        return [];
    }
  }

  private toolId(callId: string): string {
    return `${this.investigationId}:${callId}`;
  }

  private agentId(taskId: string): string {
    return `${this.investigationId}:agent:${taskId}`;
  }
}
