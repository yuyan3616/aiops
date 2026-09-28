import type { AgentStep, AgentThreadRun, ToolRun } from "./types";

function nextReasoningId(agent: AgentThreadRun, steps: AgentStep[]): string {
  const count = steps.filter((step) => step.type === "reasoning").length + 1;
  return `${agent.id}:reasoning:${String(count).padStart(2, "0")}`;
}

export function appendAgentReasoning(
  agent: AgentThreadRun,
  delta: string,
): AgentThreadRun {
  if (!delta) return agent;
  const steps = [...(agent.steps ?? [])];
  const last = steps.at(-1);

  if (last?.type === "reasoning") {
    steps[steps.length - 1] = {
      ...last,
      text: last.text + delta,
    };
  } else {
    steps.push({
      id: nextReasoningId(agent, steps),
      type: "reasoning",
      text: delta,
    });
  }

  return {
    ...agent,
    steps,
    // Keep the aggregate field for backward compatibility and diagnostics.
    thinking: (agent.thinking ?? "") + delta,
  };
}

export function upsertAgentTool(
  agent: AgentThreadRun,
  tool: ToolRun,
): AgentThreadRun {
  const existingToolIndex = agent.tools.findIndex((entry) => entry.id === tool.id);
  const tools =
    existingToolIndex < 0
      ? [...agent.tools, tool]
      : agent.tools.map((entry, index) =>
          index === existingToolIndex ? { ...entry, ...tool } : entry,
        );

  const steps = [...(agent.steps ?? [])];
  const stepIndex = steps.findIndex(
    (step) => step.type === "tool" && step.tool.id === tool.id,
  );
  if (stepIndex < 0) {
    steps.push({
      id: `${agent.id}:tool:${tool.id}`,
      type: "tool",
      tool,
    });
  } else {
    const current = steps[stepIndex];
    if (current?.type === "tool") {
      steps[stepIndex] = {
        ...current,
        tool: { ...current.tool, ...tool },
      };
    }
  }

  return { ...agent, tools, steps };
}

export function reconcileAgentToolSteps(
  agent: AgentThreadRun,
  tools: ToolRun[],
): AgentThreadRun {
  const toolById = new Map(tools.map((tool) => [tool.id, tool]));
  const steps = agent.steps ? [...agent.steps] : undefined;

  if (!steps) return { ...agent, tools };

  const knownStepToolIds = new Set<string>();
  const reconciledSteps = steps.map((step) => {
    if (step.type !== "tool") return step;
    const tool = toolById.get(step.tool.id);
    if (!tool) return step;
    knownStepToolIds.add(tool.id);
    return {
      ...step,
      tool: { ...step.tool, ...tool },
    };
  });

  for (const tool of tools) {
    if (knownStepToolIds.has(tool.id)) continue;
    reconciledSteps.push({
      id: `${agent.id}:tool:${tool.id}`,
      type: "tool",
      tool,
    });
  }

  return { ...agent, tools, steps: reconciledSteps };
}
