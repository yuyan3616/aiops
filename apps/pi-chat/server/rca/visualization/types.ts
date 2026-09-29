export type FlowNodeKind =
  | "start"
  | "alert"
  | "overview"
  | "hypothesis"
  | "dispatch"
  | "expert"
  | "interruption"
  | "resume"
  | "intervention"
  | "recovery"
  | "conclusion"
  | "root-cause";

export type FlowNodeStatus =
  | "neutral"
  | "running"
  | "success"
  | "failed"
  | "supported"
  | "rejected"
  | "interrupted"
  | "recovery";

export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  label: string;
  status?: FlowNodeStatus;
}

export interface FlowEdge {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
}

export interface InvestigationFlowModel {
  investigationId: string;
  direction: "TD";
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export type VisualizationStatus = "pending" | "generating" | "ready" | "failed";

export interface InvestigationVisualizationSummary {
  durationMs?: number;
  expertCost?: number;
  expertTokens: number;
  budget: {
    used: number;
    total: number;
    primaryUsed: number;
    primaryLimit: number;
    recoveryUsed: number;
    recoveryLimit: number;
  };
}

export interface InvestigationVisualizationArtifact {
  schemaVersion: 1;
  investigationId: string;
  status: VisualizationStatus;
  sourceHash: string;
  updatedAt: string;
  generatedAt?: string;
  summary: InvestigationVisualizationSummary;
  mermaid?: string;
  error?: string;
}

export interface InvestigationVisualizationEvent {
  investigationId: string;
  conversationId?: string;
  status: VisualizationStatus;
  updatedAt: string;
}
