export type InvestigationStatus =
  | "running"
  | "interrupted"
  | "completed"
  | "inconclusive"
  | "failed"
  | "cancelled";

export type HypothesisStatus =
  | "possible"
  | "investigating"
  | "supported"
  | "rejected"
  | "confirmed";

export type EvidenceModality = "metric" | "log" | "trace" | "event" | "alert" | "topology";

export type ExpertKind = "trace" | "metrics" | "log" | "event-topology";

export interface TimeRange {
  from: string;
  to: string;
}

export interface AlertContext {
  eventId: string;
  title: string;
  triggerTime: string;
  window: TimeRange;
  entity: {
    id: string;
    name: string;
    type: string;
    domain: string;
  };
  service?: string;
  operation?: string;
  currentValue?: number;
  workspace?: string;
  region?: string;
}

export interface RcaTask {
  caseId: string;
  version: string;
  alert: AlertContext;
  availableModalities: EvidenceModality[];
}

export interface Hypothesis {
  id: string;
  statement: string;
  status: HypothesisStatus;
  confidence: number;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  nextChecks: string[];
  entity?: string;
  mechanism?: string;
}

export interface Observation {
  id: string;
  caseId: string;
  modality: EvidenceModality;
  toolCallId: string;
  expertTaskId?: string;
  summary: string;
  rawRef?: string;
  facts: Record<string, unknown>;
  createdAt: string;
}

export interface Evidence {
  id: string;
  caseId: string;
  modality: EvidenceModality;
  entity?: string;
  timeRange?: TimeRange;
  summary: string;
  rawRef: string;
  supports: string[];
  contradicts: string[];
  sourceQuery: Record<string, unknown>;
  toolCallId: string;
  expertTaskId?: string;
  facts: Record<string, unknown>;
  createdAt: string;
}

export type ExpertFindingStatus = "succeeded" | "failed" | "inconclusive" | "blocked";
export type FindingStrength = "strong" | "moderate" | "weak" | "inconclusive";

export interface InvestigationBrief {
  role: ExpertKind;
  question: string;
  hypothesisIds: string[];
  context: {
    alertSummary: string;
    service?: string;
    mainWindow: TimeRange;
    baselineWindow?: TimeRange;
    knownFacts: string[];
    refs?: Record<string, string[]>;
  };
  expected: string[];
  notInScope?: string;
}

export interface AgentEvidenceClaim {
  toolCallId: string;
  modality: EvidenceModality;
  entity?: string;
  summary: string;
  supports: string[];
  contradicts: string[];
}

export type FindingVerdict = "supports" | "contradicts" | "no-signal" | "mixed" | "inconclusive";

export interface AgentRunDiagnostics {
  toolCallCount: number;
  thinkingChars: number;
  outputChars: number;
  repairAttempted: boolean;
  repairSucceeded: boolean;
  rssPeakMb?: number;
  heapUsedPeakMb?: number;
  heapTotalPeakMb?: number;
  externalPeakMb?: number;
  arrayBuffersPeakMb?: number;
  parquetBatchesRead?: number;
  parquetRowsScanned?: number;
  maxConcurrentParquetScansObserved?: number;
  activeParquetScansAtEnd?: number;
  failureReason?: "json_missing" | "json_invalid" | "aborted" | "model_error" | "unknown";
  failureDetail?: string;
}

export interface AgentExpertFinding {
  status: ExpertFindingStatus;
  strength: FindingStrength;
  verdict?: FindingVerdict;
  summary: string;
  conclusions: string[];
  evidenceClaims: AgentEvidenceClaim[];
  candidateEntities: string[];
  candidateMechanism?: string;
  suggestedFollowUps: string[];
  blockedOn?: string;
}

export interface ExpertTask {
  id: string;
  expert: ExpertKind;
  objective: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  hypothesisIds: string[];
  toolCallIds: string[];
  evidenceIds: string[];
  brief?: InvestigationBrief;
  implementation?: "deterministic" | "pi-session";
  sessionId?: string;
  finding?: AgentExpertFinding;
  diagnostics?: AgentRunDiagnostics;
  createdAt: string;
  completedAt?: string;
}

export interface ToolCallRecord {
  id: string;
  expertTaskId?: string;
  tool: string;
  query: Record<string, unknown>;
  status: "running" | "completed" | "failed" | "cancelled";
  resultSummary?: string;
  rawRef?: string;
  startedAt: string;
  completedAt?: string;
  interruptions?: Array<{ at: string; reason: string }>;
  error?: string;
}

export interface RCAResult {
  investigationId: string;
  status: "confirmed" | "probable" | "inconclusive";
  rootCauseEntities: string[];
  mechanism?: string;
  summary: string;
  evidenceIds: string[];
  rejectedHypotheses: string[];
  confidence: number;
  missingEvidence?: string[];
}

export interface InvestigationScope {
  alertService?: string;
  alertOperation?: string;
  timeRange: TimeRange;
  candidateEntities: string[];
}

export interface Investigation {
  id: string;
  caseId: string;
  status: InvestigationStatus;
  symptom: string;
  alertContext: AlertContext;
  scope: InvestigationScope;
  hypotheses: Hypothesis[];
  observations?: Observation[];
  evidence: Evidence[];
  expertTasks: ExpertTask[];
  toolCalls: ToolCallRecord[];
  rootCause?: RCAResult;
  rounds: number;
  startedAt: string;
  completedAt?: string;
  interruptions?: Array<{ at: string; reason: string }>;
  error?: string;
}

export type InvestigationEventType =
  | "investigation.started"
  | "hypothesis.created"
  | "hypothesis.updated"
  | "expert.started"
  | "expert.thinking.delta"
  | "expert.completed"
  | "tool.started"
  | "tool.completed"
  | "observation.created"
  | "evidence.created"
  | "round.completed"
  | "investigation.completed"
  | "investigation.interrupted"
  | "investigation.resumed"
  | "investigation.failed"
  | "investigation.cancelled";

export interface InvestigationEvent {
  id: number;
  investigationId: string;
  type: InvestigationEventType;
  at: string;
  summary: string;
  payload: Record<string, unknown>;
}

export interface ExpertFinding {
  summary: string;
  evidence: Array<Omit<Evidence, "id" | "createdAt" | "toolCallId"> & { toolCallId?: string }>;
  candidateEntities: string[];
  candidateMechanism?: string;
  nextChecks: string[];
}

export interface SchemaField {
  name: string;
  type: string;
}

export interface ModalitySchema {
  modality: EvidenceModality;
  rowCount: number;
  fields: SchemaField[];
  file: string;
}

export interface MetricAnomaly {
  entitySet: string;
  entity: string;
  service?: string;
  metric: string;
  baselineCount: number;
  incidentCount: number;
  baselineMedian: number;
  incidentMedian: number;
  baselineP95: number;
  incidentP95: number;
  ratio: number;
  robustZ: number;
  direction: "increase" | "decrease" | "flat";
  score: number;
  rawRef: string;
}

export interface TraceAnomaly {
  service: string;
  operation: string;
  host?: string;
  baselineCount: number;
  incidentCount: number;
  baselineP95Ms: number;
  incidentP95Ms: number;
  ratio: number;
  maxIncidentMs: number;
  rawRef: string;
}

export interface TracePathNode {
  service: string;
  operation: string;
  host?: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  spanId: string;
  parentSpanId?: string;
  statusCode?: string;
}

export interface CriticalTracePath {
  traceId: string;
  totalDurationMs: number;
  path: TracePathNode[];
  rawRef: string;
}

export interface QueryEnvelope<T> {
  caseId: string;
  modality: EvidenceModality;
  query: Record<string, unknown>;
  matchedRows: number;
  returnedRows: number;
  truncated: boolean;
  rawRef: string;
  data: T;
}
