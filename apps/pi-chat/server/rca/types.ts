export interface AgentTask {
  taskId: string;
  service: string;
  operation?: string;
  alertEntity?: string;
  startTime: string;
  endTime: string;
  goal: string;
}
