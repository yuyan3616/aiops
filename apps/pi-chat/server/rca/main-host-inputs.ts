// Domain input shapes for the stable host operations; model schemas live in the configuration repository.
export interface MainToolInputs {
  start_rca_investigation: {
    symptom: string;
    target: {
      service?: string;
      operation?: string;
      entity?: string;
      environment?: string;
      region?: string;
      container?: string;
    };
    window: { from: string; to: string } | { lookbackMinutes: number };
    forceNew?: boolean;
  };
  resume_rca_investigation: { investigationId: string };
  query_rca_overview: {
    investigationId: string;
    kind: "metrics" | "traces" | "logs";
    target?: {
      service?: string;
      operation?: string;
      entity?: string;
      environment?: string;
      region?: string;
      container?: string;
    };
    scopeReason?: string;
    window?:
      | { kind: "incident" }
      | { kind: "baseline"; from: string; to: string }
      | { kind: "expanded"; from: string; to: string; reason: string };
    operation?: string;
    status?: "ok" | "error" | "unset";
    minDurationMs?: number;
    severity?: string;
    lifecycleStatus?: string;
    event?: string;
    keywords?: Array<string>;
    logTraceId?: string;
    mode?: "anomaly" | "all" | "custom";
    search?: string;
    metric?: string;
    metricOperation?: "raw" | "rate" | "increase" | "quantile";
    quantile?: number;
    limit?: number;
  };
  read_rca_trace: {
    investigationId: string;
    traceId: string;
    window?:
      | { kind: "incident" }
      | { kind: "baseline"; from: string; to: string }
      | { kind: "expanded"; from: string; to: string; reason: string };
  };
  update_hypotheses: {
    investigationId: string;
    mutations: Array<
      | {
          op: "create";
          requestId?: string;
          id?: string;
          statement: string;
          supersedes?: string;
          status?: "possible" | "investigating" | "supported" | "rejected" | "confirmed";
          confidence?: number;
          supportingEvidenceIds?: Array<string>;
          contradictingEvidenceIds?: Array<string>;
          nextChecks?: Array<string>;
          entity?: string;
          mechanism?: string;
        }
      | {
          op: "update";
          requestId?: string;
          id: string;
          status?: "possible" | "investigating" | "supported" | "rejected" | "confirmed";
          confidence?: number;
          supportingEvidenceIds?: Array<string>;
          contradictingEvidenceIds?: Array<string>;
          nextChecks?: Array<string>;
          entity?: string;
          mechanism?: string;
        }
    >;
  };
  dispatch_investigations: {
    investigationId: string;
    briefs: Array<{
      role: string;
      recoveryOfTaskId?: string;
      question: string;
      hypothesisIds: Array<string>;
      context: {
        alertSummary: string;
        service?: string;
        mainWindow: { from: string; to: string };
        baselineWindow?: { from: string; to: string };
        knownFacts: Array<string>;
        refs?: Array<{ key: string; values: Array<string> }>;
      };
      expected: Array<string>;
      notInScope?: string;
    }>;
  };
  get_investigation_state: { investigationId: string; limit?: number; offset?: number };
  conclude_investigation: {
    investigationId: string;
    status: "confirmed" | "probable" | "inconclusive";
    rootCauseEntities: Array<string>;
    mechanism?: string;
    summary: string;
    evidenceIds: Array<string>;
    selectedHypothesisIds: Array<string>;
    rejectedHypotheses: Array<string>;
    unresolvedHypotheses: Array<{ id: string; reason: string; missingEvidence?: Array<string> }>;
    confidence: number;
    missingEvidence?: Array<string>;
    causalAssessment: {
      temporalFit: "aligned" | "pre_existing_explained" | "uncertain";
      temporalEvidenceIds: Array<string>;
      transitionEvidenceIds: Array<string>;
      propagationFit: "supported" | "uncertain" | "not_available";
      propagationEvidenceIds: Array<string>;
      materialUnobservedGap: boolean;
      gapBridgeEvidenceIds: Array<string>;
      unresolvedContradictions: Array<string>;
    };
  };
}
