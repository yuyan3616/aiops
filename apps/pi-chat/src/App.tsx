import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  Database,
  FileSearch,
  GitBranch,
  Link2,
  Network,
  PanelRight,
  Plus,
  Search,
  Send,
  Sparkles,
  TimerReset,
  Wrench,
  BarChart3,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import type {
  AgentKind,
  AgentState,
  HypothesisState,
  InvestigationSnapshot,
} from "@shared/rca-types";

import {
  connectInvestigationEvents,
  getInvestigation,
  listIncidents,
  runInvestigation,
  type IncidentSummary,
} from "./api";
import { applyRcaEvent } from "./rca-state";
import "./App.css";

const incidentId = "demo";

const fallbackConversations: IncidentSummary[] = [
  { id: "demo", title: "order-service 5xx 激增", time: "今天 10:24", status: "进行中" },
  { id: "payment-timeout", title: "payment-service 超时", time: "今天 09:12", status: "已完成" },
  { id: "checkout-failed", title: "用户下单失败", time: "昨天 16:08", status: "已完成" },
];

const agentIcon: Record<AgentKind, typeof FileSearch> = {
  log: FileSearch,
  metric: BarChart3,
  trace: Network,
  change: GitBranch,
};

function statusLabel(state: AgentState) {
  if (state === "running") return "进行中";
  if (state === "done") return "已完成";
  if (state === "error") return "失败";
  return "等待中";
}

function hypothesisLabel(state: HypothesisState) {
  if (state === "supported") return "已支持";
  if (state === "rejected") return "已排除";
  if (state === "validating") return "待验证";
  return "可能";
}

function messageTime(iso: string) {
  return new Date(iso).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export default function App() {
  const [snapshot, setSnapshot] = useState<InvestigationSnapshot>();
  const [conversations, setConversations] = useState(fallbackConversations);
  const [connected, setConnected] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [rightTab, setRightTab] = useState<"overview" | "tools" | "evidence">("overview");
  const [draft, setDraft] = useState("");

  useEffect(() => {
    let disposed = false;
    let source: EventSource | undefined;

    void Promise.all([getInvestigation(incidentId), listIncidents()])
      .then(([initialSnapshot, incidentList]) => {
        if (disposed) return;
        setSnapshot(initialSnapshot);
        setConversations(incidentList);
        source = connectInvestigationEvents(
          incidentId,
          initialSnapshot.stream.lastEventId,
          (event) => setSnapshot((current) => (current ? applyRcaEvent(current, event) : current)),
          setConnected,
        );
        if (initialSnapshot.status === "idle") void runInvestigation(incidentId);
      })
      .catch((error: unknown) => {
        if (!disposed) setLoadError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      disposed = true;
      source?.close();
    };
  }, []);

  const agents = snapshot?.agents ?? [];
  const hypotheses = snapshot?.hypotheses ?? [];
  const evidence = snapshot?.evidence ?? [];
  const toolRuns = snapshot?.toolRuns ?? [];
  const running = snapshot?.status === "running";
  const doneCount = agents.filter((agent) => agent.state === "done").length;
  const runningCount = agents.filter((agent) => agent.state === "running").length;
  const planMessages = snapshot?.messages.filter((message) => message.kind === "plan") ?? [];
  const followupMessages = snapshot?.messages.filter((message) => message.kind !== "plan") ?? [];

  const investigationProgress = useMemo(() => {
    if (snapshot?.conclusion) return 100;
    if (doneCount === 4) return 88;
    return Math.max(10, doneCount * 20 + runningCount * 9);
  }, [doneCount, runningCount, snapshot?.conclusion]);

  const rerun = () => {
    setLoadError(undefined);
    void runInvestigation(incidentId).catch((error: unknown) => {
      setLoadError(error instanceof Error ? error.message : String(error));
    });
  };

  const submit = () => {
    if (!draft.trim() || running) return;
    setDraft("");
    rerun();
  };

  if (!snapshot) {
    return (
      <div className="boot-screen">
        <div className="boot-card">
          <div className="brand-mark"><Activity size={18} /></div>
          <strong>正在连接 RCA Runtime…</strong>
          <span>{loadError ?? "加载 Server Snapshot 与 SSE 事件流"}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-app">
      <aside className="conversation-sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark"><Activity size={17} /></div>
          <div><strong>RCA Assistant</strong><span>Multi-Agent</span></div>
        </div>

        <button className="new-chat"><Plus size={16} /> 新建排查</button>
        <div className="sidebar-section-title"><span>历史会话</span><Search size={14} /></div>
        <div className="conversation-list">
          {conversations.map((item) => (
            <button key={item.id} className={`conversation-item ${item.id === incidentId ? "active" : ""}`}>
              <strong>{item.title}</strong>
              <span><i className={item.status === "已完成" ? "finished" : "running"} />{item.time}</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="chat-shell">
        <header className="chat-topbar">
          <div>
            <div className="chat-title-row">
              <h1>{snapshot.title}</h1>
              <span className="severity">{snapshot.severity}</span>
            </div>
            <span className="chat-subtitle"><Clock3 size={12} /> {snapshot.window}</span>
          </div>
          <div className="topbar-actions">
            <span className="runtime-pill">Fake LLM <i className={connected ? "connection-dot online" : "connection-dot"} /></span>
            <button className="icon-text-button" onClick={rerun} disabled={running}><TimerReset size={15} />{running ? "排查中" : "重新运行"}</button>
          </div>
        </header>

        <main className="conversation-stream">
          {loadError && <div className="runtime-error">Runtime: {loadError}</div>}

          <MessageRow time="10:24">
            order-service 从 10:31 开始 5xx 大幅上升，帮我分析一下可能的原因。
          </MessageRow>

          {planMessages.map((message) => (
            <CoordinatorMessage key={message.id} time={messageTime(message.createdAt)}>
              <p>{message.text}</p>
              <div className="plan-points">
                <span>先并行看日志和指标</span>
                <span>根据 Evidence 收敛假设</span>
                <span>必要时继续查 Trace / Change</span>
              </div>
            </CoordinatorMessage>
          ))}

          <div className="inline-agent-group">
            <div className="inline-agent-group-title">
              <span><CircleDot size={14} /> 并行调查</span>
              <small>{running ? "Coordinator 正在调度" : doneCount === 4 ? "4 个 Agent 已完成" : `${doneCount}/4 已完成`}</small>
            </div>
            {agents.map((agent) => {
              const tool = toolRuns.find((item) => item.agent === agent.id);
              const agentEvidence = evidence.find((item) => item.type === agent.id);
              return <AgentTaskCard key={agent.id} agent={agent} tool={tool} evidence={agentEvidence} />;
            })}
          </div>

          {followupMessages.map((message) => (
            <CoordinatorMessage key={message.id} time={messageTime(message.createdAt)} conclusion={message.kind === "conclusion"}>
              <p>{message.text}</p>
            </CoordinatorMessage>
          ))}

          {snapshot.conclusion && (
            <section className="inline-conclusion">
              <div className="inline-conclusion-title"><Check size={16} /> RCA 结论</div>
              <p><strong>根因：</strong>{snapshot.conclusion.rootCause}</p>
              <div className="causal-chain">
                {snapshot.conclusion.causalChain.map((item, index) => (
                  <span className="chain-fragment" key={item}>
                    <span>{item}</span>
                    {index < snapshot.conclusion!.causalChain.length - 1 && <ChevronRight size={14} />}
                  </span>
                ))}
              </div>
            </section>
          )}
          <div className="bottom-anchor" />
        </main>

        <form className="composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="继续追问，或描述新的故障现象…"
            rows={2}
          />
          <div className="composer-footer">
            <div className="composer-tools">
              <button type="button"><Link2 size={14} />附件</button>
              <button type="button"><Wrench size={14} />服务</button>
              <button type="button"><Clock3 size={14} />时间范围</button>
            </div>
            <button className="send-button" type="submit" disabled={!draft.trim() || running} aria-label="发送"><Send size={16} /></button>
          </div>
        </form>
      </section>

      <aside className="investigation-sidebar">
        <div className="investigation-header"><PanelRight size={15} /><strong>调查上下文</strong></div>
        <div className="right-tabs">
          <button className={rightTab === "overview" ? "active" : ""} onClick={() => setRightTab("overview")}>概览</button>
          <button className={rightTab === "tools" ? "active" : ""} onClick={() => setRightTab("tools")}>工具</button>
          <button className={rightTab === "evidence" ? "active" : ""} onClick={() => setRightTab("evidence")}>证据</button>
        </div>

        {rightTab === "overview" && (
          <>
            <section className="context-section">
              <div className="context-heading"><strong>调查进度</strong><span>{investigationProgress}%</span></div>
              <div className="progress-bar"><span style={{ width: `${investigationProgress}%` }} /></div>
              <div className="phase-text">{snapshot.conclusion ? "根因已收敛" : running ? "正在收集和验证证据" : "等待开始"}</div>
            </section>

            <section className="context-section">
              <div className="context-heading"><strong>Agent</strong><span>{doneCount}/4</span></div>
              <div className="compact-agent-list">
                {agents.map((agent) => {
                  const Icon = agentIcon[agent.id];
                  return <div className="compact-agent" key={agent.id}><Icon size={13} /><span>{agent.name}</span><i className={`state-dot ${agent.state}`} title={statusLabel(agent.state)} /></div>;
                })}
              </div>
            </section>

            <section className="context-section">
              <div className="context-heading"><strong>Hypotheses</strong><span>{hypotheses.length}</span></div>
              <div className="compact-hypothesis-list">
                {hypotheses.map((item) => (
                  <div className="compact-hypothesis" key={item.id}>
                    <span className="hypothesis-id">{item.id}</span>
                    <span>{item.title}</span>
                    <small className={item.state}>{hypothesisLabel(item.state)}</small>
                  </div>
                ))}
              </div>
            </section>

            <section className="context-section">
              <div className="context-heading"><strong>Key Evidence</strong><span>{evidence.length}</span></div>
              <div className="compact-evidence-list">
                {evidence.slice(0, 4).map((item) => <div className="compact-evidence" key={item.id}><b>{item.id}</b><span>{item.label}</span></div>)}
                {evidence.length === 0 && <span className="context-empty">等待 Agent 生成 Evidence…</span>}
              </div>
            </section>

            <section className={`context-section context-result ${snapshot.conclusion ? "ready" : ""}`}>
              <div className="context-heading"><strong><AlertTriangle size={13} /> 当前结论</strong></div>
              <p>{snapshot.conclusion ? snapshot.conclusion.rootCause : "Coordinator 正在等待更多证据，暂不下结论。"}</p>
            </section>
          </>
        )}

        {rightTab === "tools" && <CompactTools toolRuns={toolRuns} />}
        {rightTab === "evidence" && <CompactEvidence evidence={evidence} />}
      </aside>
    </div>
  );
}

function MessageRow({ time, children }: { time: string; children: ReactNode }) {
  return (
    <div className="chat-message user-chat-message">
      <div className="avatar user-avatar">U</div>
      <div className="message-content"><div className="speaker">用户 <span>{time}</span></div><div className="user-bubble">{children}</div></div>
    </div>
  );
}

function CoordinatorMessage({ time, children, conclusion = false }: { time: string; children: ReactNode; conclusion?: boolean }) {
  return (
    <div className="chat-message assistant-chat-message">
      <div className={`avatar assistant-avatar ${conclusion ? "done" : ""}`}>{conclusion ? <Check size={15} /> : <Sparkles size={15} />}</div>
      <div className="message-content"><div className="speaker">RCA Coordinator <span>{time}</span></div><div className="assistant-copy">{children}</div></div>
    </div>
  );
}

function AgentTaskCard({ agent, tool, evidence }: {
  agent: InvestigationSnapshot["agents"][number];
  tool?: InvestigationSnapshot["toolRuns"][number];
  evidence?: InvestigationSnapshot["evidence"][number];
}) {
  const Icon = agentIcon[agent.id];
  return (
    <details className={`agent-task ${agent.state}`} open={agent.state === "running"}>
      <summary>
        <div className={`agent-task-icon ${agent.id}`}><Icon size={15} /></div>
        <div className="agent-task-main">
          <div><strong>{agent.name}</strong><span className={`agent-status ${agent.state}`}>{statusLabel(agent.state)}</span></div>
          <p>{agent.state === "done" ? agent.result : agent.description}</p>
        </div>
        <ChevronDown size={15} className="details-chevron" />
      </summary>
      <div className="agent-task-detail">
        {tool ? (
          <div className="inline-tool-call">
            <div><Wrench size={13} /><strong>{tool.name}</strong><span>{tool.status}</span></div>
            <code>{JSON.stringify(tool.args)}</code>
            {tool.result && <p>{tool.result}</p>}
          </div>
        ) : <div className="inline-empty">等待 Tool Call…</div>}
        {evidence && <div className="inline-evidence"><Database size={13} /><b>{evidence.id}</b><span>{evidence.label}</span><small>{evidence.type}</small></div>}
      </div>
    </details>
  );
}

function CompactTools({ toolRuns }: { toolRuns: InvestigationSnapshot["toolRuns"] }) {
  return <div className="context-scroll-list">{toolRuns.map((tool) => <article className="compact-tool-card" key={tool.id}><div><span className={`tool-kind ${tool.agent}`}>{tool.agent}</span><strong>{tool.name}</strong></div><code>{JSON.stringify(tool.args)}</code>{tool.result && <p>{tool.result}</p>}</article>)}{toolRuns.length === 0 && <span className="context-empty">等待 Tool Call…</span>}</div>;
}

function CompactEvidence({ evidence }: { evidence: InvestigationSnapshot["evidence"] }) {
  return <div className="context-scroll-list">{evidence.map((item) => <article className="compact-evidence-card" key={item.id}><div><b>{item.id}</b><strong>{item.label}</strong></div><p>{item.summary}</p><code>{item.rawRef}</code></article>)}{evidence.length === 0 && <span className="context-empty">Evidence 尚未生成。</span>}</div>;
}
