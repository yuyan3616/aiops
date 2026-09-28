import { Markdown } from "@components/Markdown";
import { ToolCard } from "@components/ToolCard";
import type { AgentStep, AgentThreadRun } from "@shared/types";
import {
  Brain,
  CheckCircle2,
  ChevronRight,
  LoaderCircle,
  Network,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";

const labels: Record<AgentThreadRun["expert"], string> = {
  trace: "Trace 调查员",
  metrics: "Metrics 调查员",
  log: "Log 调查员",
  "event-topology": "Event / Topology 调查员",
};

function stateLabel(agent: AgentThreadRun): string {
  if (agent.interruptedByRestart) return "已中断";
  return {
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  }[agent.status];
}

function timelineSteps(agent: AgentThreadRun): AgentStep[] {
  if (agent.steps?.length) return agent.steps;
  const legacy: AgentStep[] = [];
  if (agent.thinking) {
    legacy.push({
      id: `${agent.id}:legacy-reasoning`,
      type: "reasoning",
      text: agent.thinking,
    });
  }
  for (const tool of agent.tools) {
    legacy.push({
      id: `${agent.id}:legacy-tool:${tool.id}`,
      type: "tool",
      tool,
    });
  }
  return legacy;
}

export function AgentThreadCard({ agent }: { agent: AgentThreadRun }) {
  const [open, setOpen] = useState(false);
  const steps = timelineSteps(agent);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const icon =
    agent.status === "running" ? (
      <LoaderCircle className="running" size={17} />
    ) : agent.status === "completed" ? (
      <CheckCircle2 className="success" size={17} />
    ) : (
      <XCircle className="error" size={17} />
    );

  return (
    <>
      <button className="agent-thread-card" type="button" onClick={() => setOpen(true)}>
        <span className="agent-thread-avatar">{agent.expert.slice(0, 1).toUpperCase()}</span>
        <span className="agent-thread-copy">
          <span className="agent-thread-title">
            {agent.label || labels[agent.expert]}
            <small className={"agent-thread-status " + agent.status}>{stateLabel(agent)}</small>
          </span>
          <span className="agent-thread-objective">{agent.objective}</span>
        </span>
        <span className="agent-thread-meta">
          {agent.tools.length} tools · {agent.evidence.length} evidence
        </span>
        {icon}
        <ChevronRight size={17} className="agent-thread-chevron" />
      </button>

      {open && (
        <div className="agent-thread-overlay" role="presentation" onMouseDown={() => setOpen(false)}>
          <aside
            className="agent-thread-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={agent.label || labels[agent.expert]}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="agent-thread-drawer-header">
              <div>
                <div className="agent-thread-drawer-title">
                  <Network size={16} />
                  <strong>{agent.label || labels[agent.expert]}</strong>
                </div>
                <small>
                  {agent.taskId} · 专业调查线程
                  {agent.implementation === "deterministic"
                    ? " · 当前为确定性 Expert"
                    : " · Pi Session"}
                </small>
              </div>
              <button type="button" onClick={() => setOpen(false)} aria-label="关闭子 Agent 线程">
                <X size={18} />
              </button>
            </header>

            <div className="agent-thread-drawer-body">
              <section className="agent-thread-brief">
                <label>调查目标</label>
                <p>{agent.objective}</p>
              </section>

              <section>
                <div className="agent-thread-section-title">
                  <Brain size={14} />
                  调查过程
                  <span>{agent.tools.length} 次工具调用</span>
                </div>
                <div className="agent-thread-timeline">
                  {steps.length > 0 ? (
                    steps.map((step) =>
                      step.type === "reasoning" ? (
                        <div
                          className="agent-thread-timeline-step reasoning"
                          key={step.id}
                        >
                          <div className="agent-thread-timeline-marker">
                            <Brain size={12} />
                          </div>
                          <div className="agent-thread-reasoning">
                            <small>分析</small>
                            <Markdown content={step.text} />
                          </div>
                        </div>
                      ) : (
                        <div
                          className="agent-thread-timeline-step tool"
                          key={step.id}
                        >
                          <div className="agent-thread-timeline-marker tool-marker" />
                          <div className="agent-thread-timeline-tool">
                            <ToolCard tool={step.tool} />
                          </div>
                        </div>
                      ),
                    )
                  ) : (
                    <p className="agent-thread-empty">等待调查过程…</p>
                  )}
                </div>
              </section>

              <section>
                <div className="agent-thread-section-title">
                  Findings <span>{agent.evidence.length}</span>
                </div>
                {agent.summary && <p className="agent-thread-summary">{agent.summary}</p>}
                <div className="agent-thread-evidence">
                  {agent.evidence.map((evidence) => (
                    <article key={evidence.id}>
                      <div>
                        <strong>{evidence.id}</strong>
                        <small>{evidence.modality.toUpperCase()}</small>
                      </div>
                      <p>{evidence.summary}</p>
                    </article>
                  ))}
                </div>
              </section>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
