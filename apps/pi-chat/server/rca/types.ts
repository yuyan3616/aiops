import type { BudgetClass, BudgetLedgerEvent } from "./budget";

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

export interface IncidentContext {
  symptom: string;
  trigger:
    | { type: "manual" }
    | { type: "alert"; eventId?: string; title?: string; source?: string }
    | { type: "api"; source?: string };
  window: TimeRange;
  target: {
    service?: string;
    operation?: string;
    entity?: string;
    environment?: string;
    region?: string;
    container?: string;
  };
}

export interface RcaTask {
  version: string;
  context?: IncidentContext;
  // Legacy benchmark fields are retained only for offline adapter/test compatibility.
  caseId?: string;
  alert?: AlertContext;
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
  supersedes?: string;
}

export interface Observation {
  id: string;
  investigationId?: string;
  caseId?: string;
  modality: EvidenceModality;
  toolCallId: string;
  expertTaskId?: string;
  summary: string;
  rawRef: string;
  snapshotRef?: string;
  facts: Record<string, unknown>;
  createdAt: string;
}

export interface Evidence {
  id: string;
  investigationId?: string;
  caseId?: string;
  modality: EvidenceModality;
  entity?: string;
  timeRange?: TimeRange;
  summary: string;
  rawRef?: string;
  snapshotRef?: string;
  sourceItems?: string[];
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
  recoveryOfTaskId?: string;
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
  failureReason?:
    | "json_missing"
    | "json_invalid"
    | "finding_missing"
    | "finding_invalid"
    | "aborted"
    | "model_error"
    | "unknown";
  failureDetail?: string;
}

export interface AgentUsage {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  // Latest valid Assistant response, not a cumulative or exact final context size.
  contextTokens: number;
  // Pi's estimated USD cost; absent when pricing is unavailable.
  cost?: number;
}

export type AgentTerminationReason =
  | "completed"
  | "aborted"
  | "provider_error"
  | "invalid_output"
  | "tool_error"
  | "runtime_error";

export interface AgentTermination {
  reason: AgentTerminationReason;
  detail?: string;
  /** Verified provider retryability; Service still applies its own Recovery policy. */
  providerTransient?: boolean;
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
  // "deterministic" is retained only to read investigations persisted by pre-agentic builds.
  // New runtime tasks are always written as "pi-session".
  implementation?: "deterministic" | "pi-session";
  sessionId?: string;
  finding?: AgentExpertFinding;
  usage?: AgentUsage;
  diagnostics?: AgentRunDiagnostics;
  termination?: AgentTermination;
  interruptedByRestart?: boolean;
  budgetClass?: BudgetClass;
  budgetReservationId?: string;
  dispatchOperationId?: string;
  taskGeneration?: number;
  recoveryOfTaskId?: string;
  terminationReason?: string;
  recoveryEligible?: boolean;
  createdAt: string;
  completedAt?: string;
}

export interface RuntimeResourceSnapshot {
  at: string;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  activeParquetScans?: number;
  maxConcurrentParquetScans?: number;
  totalParquetScans?: number;
  parquetBatchesRead?: number;
  parquetRowsScanned?: number;
}

export interface ToolCallRecord {
  id: string;
  expertTaskId?: string;
  tool: string;
  query: Record<string, unknown>;
  status: "running" | "completed" | "failed" | "cancelled";
  resultSummary?: string;
  rawRef?: string;
  snapshotRef?: string;
  resultStatus?: "success" | "no_data" | "partial" | "unsupported";
  startedAt: string;
  completedAt?: string;
  runtime?: {
    before: RuntimeResourceSnapshot;
    after?: RuntimeResourceSnapshot;
  };
  interruptedByRestart?: boolean;
  error?: string;
}

export interface CausalAssessment {
  temporalFit: "aligned" | "pre_existing_explained" | "uncertain";
  propagationFit: "supported" | "uncertain" | "not_available";
  unresolvedContradictions: string[];

  // Optional on persisted results so investigations created by older builds remain readable.
  // New conclusions must provide these fields through AgenticConclusionInput.
  temporalEvidenceIds?: string[];
  transitionEvidenceIds?: string[];
  propagationEvidenceIds?: string[];
  materialUnobservedGap?: boolean;
  gapBridgeEvidenceIds?: string[];
}

export interface RCAResult {
  investigationId: string;
  status: "confirmed" | "probable" | "inconclusive";
  rootCauseEntities: string[];
  mechanism?: string;
  summary: string;
  evidenceIds: string[];
  rejectedHypotheses: string[];
  selectedHypothesisIds?: string[];
  unresolvedHypotheses?: Array<{
    id: string;
    reason: string;
    missingEvidence?: string[];
  }>;
  confidence: number;
  missingEvidence?: string[];
  // Optional for backward compatibility with investigations persisted before
  // causal assessment became part of the conclusion contract.
  causalAssessment?: CausalAssessment;
}

export interface InvestigationScope {
  // Legacy RCA100 fields remain readable.
  alertService?: string;
  alertOperation?: string;
  timeRange?: TimeRange;
  candidateEntities: string[];
  extensions?: Array<{
    target?: Record<string, string>;
    window?: TimeRange;
    reason: string;
    createdAt: string;
  }>;
}

export interface InvestigationUserIntervention {
  id: string;
  content: string;
  createdAt: string;
}

export interface Investigation {
  id: string;
  caseId?: string;
  status: InvestigationStatus;
  symptom: string;
  alertContext?: AlertContext;
  context?: IncidentContext;
  formatVersion?: 3;
  source?: {
    kind: "live";
    contractVersion: "1";
  };
  creation?: {
    operationId?: string;
    requestHash: string;
  };
  scope: InvestigationScope;
  hypotheses: Hypothesis[];
  observations?: Observation[];
  evidence: Evidence[];
  expertTasks: ExpertTask[];
  toolCalls: ToolCallRecord[];
  userInterventions?: InvestigationUserIntervention[];
  rootCause?: RCAResult;
  rounds: number;
  startedAt: string;
  completedAt?: string;
  interruptions?: Array<{ at: string; reason: string }>;
  error?: string;
  schemaVersion?: 2;
  budgetLedger?: BudgetLedgerEvent[];
}

export type InvestigationEventType =
  | "investigation.started"
  | "user.intervention"
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
  entityId?: string;
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

export interface TraceQueryWindowRelation {
  startedBeforeWindow: boolean;
  startedInWindow: boolean;
  endedInWindow: boolean;
  spansEntireWindow: boolean;
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
  queryWindowRelation?: TraceQueryWindowRelation;
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
