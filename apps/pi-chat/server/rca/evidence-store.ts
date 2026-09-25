import { randomUUID } from "node:crypto";

import type { AgentKind, EvidenceModality, EvidenceView } from "../../shared/rca-types";

export interface PutEvidenceInput {
  taskId: string;
  datasetTaskId: string;
  type: AgentKind;
  modality: EvidenceModality;
  label: string;
  source: string;
  summary: string;
  observation: Record<string, unknown>;
  rawRef: string;
  query: Record<string, unknown>;
  entityRefs: string[];
  timeRange: { start: string; end: string };
  createdBy: AgentKind;
}

function stableStringify(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(stableStringify).join(",")}]`;
  if (input && typeof input === "object") {
    const entries = Object.entries(input as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${stableStringify(value)}`).join(",")}}`;
  }
  return JSON.stringify(input);
}

export class EvidenceStore {
  private readonly byId = new Map<string, EvidenceView>();
  private readonly idByQueryKey = new Map<string, string>();

  reset() {
    this.byId.clear();
    this.idByQueryKey.clear();
  }

  queryKey(input: Pick<PutEvidenceInput, "datasetTaskId" | "type" | "query">) {
    return `${input.datasetTaskId}:${input.type}:${stableStringify(input.query)}`;
  }

  findReusable(input: Pick<PutEvidenceInput, "datasetTaskId" | "type" | "query">) {
    const id = this.idByQueryKey.get(this.queryKey(input));
    return id ? this.byId.get(id) : undefined;
  }

  put(input: PutEvidenceInput): { evidence: EvidenceView; reused: boolean } {
    const queryKey = this.queryKey(input);
    const existingId = this.idByQueryKey.get(queryKey);
    if (existingId) {
      return { evidence: this.byId.get(existingId)!, reused: true };
    }

    const index = this.byId.size + 1;
    const evidence: EvidenceView = {
      id: `EV${String(index).padStart(2, "0")}`,
      taskId: input.taskId,
      datasetTaskId: input.datasetTaskId,
      type: input.type,
      modality: input.modality,
      label: input.label,
      source: input.source,
      summary: input.summary,
      observation: input.observation,
      rawRef: input.rawRef || `rca100://${input.datasetTaskId}/raw/${randomUUID()}`,
      queryKey,
      entityRefs: [...new Set(input.entityRefs.filter(Boolean))],
      timeRange: input.timeRange,
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
    };
    this.byId.set(evidence.id, evidence);
    this.idByQueryKey.set(queryKey, evidence.id);
    return { evidence, reused: false };
  }

  list() {
    return [...this.byId.values()];
  }
}
