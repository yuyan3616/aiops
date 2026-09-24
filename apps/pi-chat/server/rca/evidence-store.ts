import { randomUUID } from "node:crypto";

import type { AgentKind, EvidenceView } from "../../shared/rca-types";

export interface PutEvidenceInput {
  type: AgentKind;
  label: string;
  source: string;
  summary: string;
  rawRef: string;
  query: Record<string, unknown>;
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

  put(input: PutEvidenceInput): { evidence: EvidenceView; reused: boolean } {
    const queryKey = `${input.type}:${stableStringify(input.query)}`;
    const existingId = this.idByQueryKey.get(queryKey);
    if (existingId) {
      return { evidence: this.byId.get(existingId)!, reused: true };
    }

    const index = this.byId.size + 1;
    const evidence: EvidenceView = {
      id: `EV${String(index).padStart(2, "0")}`,
      type: input.type,
      label: input.label,
      source: input.source,
      summary: input.summary,
      rawRef: input.rawRef || `fake://${randomUUID()}`,
      queryKey,
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
