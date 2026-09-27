import { Markdown } from "@components/Markdown";
import { ToolCard } from "@components/ToolCard";
import type { AgentThreadRun } from "@shared/types";
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

function stateLabel(status: AgentThreadRun["status"]): string {
  return {
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  }[status];
}

export function AgentThreadCard({ agent }: { agent: AgentThreadRun }) {
  const [open, setOpen] = useState(false);

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
            <small className={"agent-thread-status " + agent.status}>{stateLabel(agent.status)}</small>
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

              {agent.thinking && (
                <section>
                  <div className="agent-thread-section-title">
                    <Brain size={14} />
                    思考过程
                  </div>
                  <div className="agent-thread-thinking">
                    <Markdown content={agent.thinking} />
                  </div>
                </section>
              )}

              <section>
                <div className="agent-thread-section-title">
                  执行过程 <span>{agent.tools.length}</span>
                </div>
                <div className="agent-thread-tools">
                  {agent.tools.length > 0 ? (
                    agent.tools.map((tool) => <ToolCard key={tool.id} tool={tool} />)
                  ) : (
                    <p className="agent-thread-empty">等待工具调用…</p>
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
