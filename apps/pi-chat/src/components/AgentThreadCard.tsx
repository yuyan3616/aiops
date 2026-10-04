import { Markdown } from "@components/Markdown";
import { ToolCard } from "@components/ToolCard";
import type { AgentStep, AgentThreadRun } from "@shared/types";
import {
  Brain,
  CheckCircle2,
  ChevronDown,
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

const terminationLabels: Record<string, string> = {
  completed: "正常完成",
  aborted: "已中止",
  provider_error: "模型服务错误",
  invalid_output: "输出格式无效",
  tool_error: "工具执行错误",
  runtime_error: "运行时错误",
  provider_transient_error: "模型服务暂时不可用",
  service_restart: "服务重启中断",
  user_superseded: "用户更新了调查",
  investigation_cancelled: "调查已取消",
};

function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toLocaleString();
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

function AgentReasoningStep({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(active);

  useEffect(() => {
    // Keep the currently streaming reasoning visible. Once a tool starts or
    // the agent settles, the completed reasoning collapses automatically.
    // oxlint-disable-next-line react/set-state-in-effect -- sync UI with runtime boundary.
    setOpen(active);
  }, [active]);

  return (
    <div className={"agent-thread-reasoning " + (open ? "open" : "collapsed")}>
      <button
        className="agent-thread-reasoning-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>分析</span>
        {active && <small>进行中</small>}
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && (
        <div className="agent-thread-reasoning-body">
          <Markdown content={text || "正在分析…"} />
        </div>
      )}
    </div>
  );
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
            {agent.label || (labels[agent.expert] ?? agent.expert)}
            <small className={"agent-thread-status " + agent.status}>{stateLabel(agent)}</small>
          </span>
          <span className="agent-thread-objective">{agent.objective}</span>
        </span>
        <span className="agent-thread-meta">
          {agent.usage
            ? `${agent.usage.turns} turns · ${formatTokens(agent.usage.totalTokens)} tokens · ${agent.tools.length} tools${agent.usage.cost !== undefined ? ` · $${agent.usage.cost.toFixed(4)}` : ""}`
            : `${agent.tools.length} tools · ${agent.evidence.length} evidence`}
        </span>
        {icon}
        <ChevronRight size={17} className="agent-thread-chevron" />
      </button>

      {open && (
        <div
          className="agent-thread-overlay"
          role="presentation"
          onMouseDown={() => setOpen(false)}
        >
          <aside
            className="agent-thread-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={agent.label || (labels[agent.expert] ?? agent.expert)}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="agent-thread-drawer-header">
              <div>
                <div className="agent-thread-drawer-title">
                  <Network size={16} />
                  <strong>{agent.label || (labels[agent.expert] ?? agent.expert)}</strong>
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

              {(agent.usage ||
                agent.diagnostics ||
                agent.termination ||
                agent.terminationReason) && (
                <section className="agent-thread-brief">
                  <label>运行信息</label>
                  {agent.usage && (
                    <p>
                      模型响应 {agent.usage.turns} 次 · Input{" "}
                      {agent.usage.inputTokens.toLocaleString()} · Output{" "}
                      {agent.usage.outputTokens.toLocaleString()} · Cache Read{" "}
                      {agent.usage.cacheReadTokens.toLocaleString()} · Cache Write{" "}
                      {agent.usage.cacheWriteTokens.toLocaleString()} · 最近响应上下文{" "}
                      {agent.usage.contextTokens.toLocaleString()}
                      {agent.usage.cost !== undefined &&
                        ` · Pi 估算 $${agent.usage.cost.toFixed(4)}`}
                    </p>
                  )}
                  {agent.diagnostics && (
                    <p>
                      工具调用 {agent.diagnostics.toolCallCount}
                      {agent.diagnostics.parquetRowsScanned !== undefined &&
                        ` · 扫描 ${agent.diagnostics.parquetRowsScanned.toLocaleString()} 行`}
                      {agent.diagnostics.rssPeakMb !== undefined &&
                        ` · Peak RSS ${agent.diagnostics.rssPeakMb} MB`}
                      {agent.diagnostics.repairAttempted &&
                        ` · JSON Repair ${agent.diagnostics.repairSucceeded ? "成功" : "失败"}`}
                    </p>
                  )}
                  {(agent.termination || agent.terminationReason) && (
                    <p>
                      结束原因：
                      {terminationLabels[
                        agent.termination?.reason ?? agent.terminationReason ?? ""
                      ] ??
                        agent.termination?.reason ??
                        agent.terminationReason}
                      {agent.termination?.detail && ` · ${agent.termination.detail}`}
                    </p>
                  )}
                </section>
              )}

              <section>
                <div className="agent-thread-section-title">
                  <Brain size={14} />
                  调查过程
                  <span>{agent.tools.length} 次工具调用</span>
                </div>
                <div className="agent-thread-timeline">
                  {steps.length > 0 ? (
                    steps.map((step, index) =>
                      step.type === "reasoning" ? (
                        <div className="agent-thread-timeline-step reasoning" key={step.id}>
                          <div className="agent-thread-timeline-marker">
                            <Brain size={12} />
                          </div>
                          <AgentReasoningStep
                            text={step.text}
                            active={agent.status === "running" && index === steps.length - 1}
                          />
                        </div>
                      ) : (
                        <div className="agent-thread-timeline-step tool" key={step.id}>
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
