import type {
  InvestigationSnapshot,
  InvestigationStatus,
  PiSessionRef,
  RcaAgentRole,
} from "../../../shared/rca-types.ts";

export interface InvestigationRecord {
  version: 1;
  id: string;
  datasetTaskId: string;
  title: string;
  prompt: string;
  status: InvestigationStatus;
  createdAt: string;
  updatedAt: string;
  snapshot: InvestigationSnapshot;
  sessions: Partial<Record<RcaAgentRole, PiSessionRef>>;
}
