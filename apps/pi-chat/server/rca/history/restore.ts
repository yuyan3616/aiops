import type { InvestigationSnapshot } from "../../../shared/rca-types.ts";

export function normalizeRestoredSnapshot(input: InvestigationSnapshot): InvestigationSnapshot {
  const snapshot = structuredClone(input);
  if (snapshot.status === "running" || snapshot.status === "stopping") {
    snapshot.status = "interrupted";
  }
  snapshot.agents = snapshot.agents.map((agent) =>
    agent.state === "running"
      ? { ...agent, state: "cancelled", result: agent.result || "服务重启时任务中断。" }
      : agent,
  );
  snapshot.tasks = snapshot.tasks.map((task) =>
    task.status === "running" || task.status === "queued"
      ? { ...task, status: "interrupted" }
      : task,
  );
  snapshot.toolRuns = snapshot.toolRuns.map((tool) =>
    tool.status === "running"
      ? { ...tool, status: "error", result: tool.result || "服务重启时工具调用中断。" }
      : tool,
  );
  snapshot.thinking = snapshot.thinking.map((item) => ({ ...item, completed: true }));
  return snapshot;
}
