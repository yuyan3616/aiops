export const RCA100_CASE_FILES = [
  "task.json",
  "metrics.parquet",
  "logs.parquet",
  "traces.parquet",
  "events.parquet",
  "alerts.parquet",
  "topology.json",
] as const;

export type Rca100CaseFile = (typeof RCA100_CASE_FILES)[number];

export interface Rca100AlertWindow {
  start: string;
  end: string;
}

export interface Rca100AlertEntity {
  entity_id: string | null;
  entity_name: string | null;
  entity_type: string | null;
  entity_domain: string | null;
}

export interface Rca100Task {
  task_id: string;
  task_version: string;
  alert_event_id: string;
  alert_title: string;
  alert_trigger_time: string;
  alert_window: Rca100AlertWindow;
  alert_entity: Rca100AlertEntity;
  prompt_text: string;
  workspace: string;
  region_id: string;
  available_modalities: string[];
  scoring_note?: string;
  alert_trans_id?: string;
}

export interface Rca100CasePaths {
  taskId: string;
  root: string;
  task: string;
  metrics: string;
  logs: string;
  traces: string;
  events: string;
  alerts: string;
  topology: string;
}

export interface Rca100CaseDescriptor {
  task: Rca100Task;
  paths: Rca100CasePaths;
}

export interface Rca100TopologyEntity {
  id?: string;
  name?: string;
  type?: string;
  domain?: string;
  labels?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Rca100TopologyEdge {
  src?: string;
  dst?: string;
  relation?: string;
  [key: string]: unknown;
}

export interface Rca100Topology {
  entities: Rca100TopologyEntity[];
  edges: Rca100TopologyEdge[];
  [key: string]: unknown;
}
