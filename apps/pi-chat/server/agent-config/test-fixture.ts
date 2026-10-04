// Synthetic test data only. Runtime must never import or fall back to this module.
import { agentConfigStore, type ConfigFiles } from "./store";
export const TEST_CONFIG_VERSION = "0".repeat(40);
export function fixtureFiles(): ConfigFiles {
  const skillIds = ["critical-path", "latency-gap", "baseline-validation"];
  const roles = [
    {
      id: "main",
      kind: "main",
      name: "Test Main",
      systemPrompt: "agents/main/SYSTEM.md",
      tools: ["utc_time", "get_investigation_state"],
      skills: [],
    },
    {
      id: "trace",
      kind: "expert",
      name: "Test Trace",
      systemPrompt: "agents/trace/SYSTEM.md",
      tools: ["search_traces", "get_trace"],
      skills: [{ id: "critical-path" }, { id: "latency-gap", keywords: ["gap"] }],
    },
    {
      id: "metrics",
      kind: "expert",
      name: "Test Metrics",
      systemPrompt: "agents/metrics/SYSTEM.md",
      tools: ["discover_metrics", "query_metrics"],
      skills: [{ id: "baseline-validation" }],
    },
    {
      id: "log",
      kind: "expert",
      name: "Test Log",
      systemPrompt: "agents/log/SYSTEM.md",
      tools: ["search_logs"],
      skills: [],
    },
  ];
  const files: ConfigFiles = {
    "manifest.json": JSON.stringify({
      schemaVersion: 1,
      roles: roles.map((role) => `agents/${role.id}/agent.json`),
      skills: Object.fromEntries(
        skillIds.map((id) => [id, { title: `Test ${id}`, path: `skills/${id}/SKILL.md` }]),
      ),
    }),
  };
  for (const role of roles) {
    files[`agents/${role.id}/agent.json`] = JSON.stringify(role);
    files[role.systemPrompt] = `Synthetic prompt: ${role.id}`;
  }
  for (const id of skillIds) files[`skills/${id}/SKILL.md`] = `Synthetic skill: ${id}`;
  return files;
}
agentConfigStore.activate(TEST_CONFIG_VERSION, fixtureFiles());
