import {
  Activity,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Database,
  FileSearch,
  GitBranch,
  Menu,
  Network,
  PanelRight,
  Plus,
  Send,
  Sparkles,
  Square,
  TimerReset,
  Wrench,
  X,
  BarChart3,
  Brain,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type {
  AgentKind,
  AgentState,
  HypothesisState,
  InvestigationSnapshot,
} from "@shared/rca-types";

import {
  abortInvestigation,
  connectInvestigationEvents,
  createInvestigation,
  getInvestigation,
  listIncidents,
  runInvestigation,
  type IncidentSummary,
} from "./api";
import { applyRcaEvent } from "./rca-state";
import "./App.css";

const DEMO_PROMPT = "RCA100 t039：checkout::/oteldemo.CheckoutService/PlaceOrder 在 2026-04-28 09:20:55 出现响应时间突增，当前值约 3355ms，请基于可观测数据分析根因。";


const agentIcon: Record<AgentKind, typeof FileSearch> = {
  log: FileSearch,
  metric: BarChart3,
  trace: Network,
  context: GitBranch,
};

function statusLabel(state: AgentState) {
  if (state === "running") return "进行中";
  if (state === "done") return "已完成";
  if (state === "error") return "失败";
  if (state === "cancelled") return "已取消";
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

function investigationStatusLabel(status: IncidentSummary["status"]) {
  if (status === "completed") return "已完成";
  if (status === "interrupted") return "已中断";
  if (status === "cancelled") return "已取消";
  if (status === "error") return "失败";
  if (status === "running" || status === "stopping") return "进行中";
  return "未开始";
}

function historyTime(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function shortInvestigationId(id: string) {
  return id.length > 14 ? id.slice(-10).toUpperCase() : id.toUpperCase();
}

function investigationStateText(snapshot: InvestigationSnapshot) {
  if (snapshot.conclusion) return "根因已收敛";
  if (snapshot.status === "interrupted") return "服务重启后调查已中断";
  if (snapshot.status === "error") return "调查执行失败";
  if (snapshot.status === "cancelled") return "调查已停止";
  if (snapshot.status === "stopping") return "正在停止 Agent 任务";
  if (snapshot.status === "running") return "正在收集和验证证据";
  return "等待开始";
}

export default function App() {
  const [incidentId, setIncidentId] = useState("demo");
  const [snapshot, setSnapshot] = useState<InvestigationSnapshot>();
  const [conversations, setConversations] = useState<IncidentSummary[]>([]);
  const [connected, setConnected] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [rightTab, setRightTab] = useState<"overview" | "tools" | "evidence">("overview");
  const [draft, setDraft] = useState("");
  const [showWelcome, setShowWelcome] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);

  useEffect(() => {
    let disposed = false;
    let source: EventSource | undefined;
    setConnected(false);

    void Promise.all([getInvestigation(incidentId), listIncidents()])
      .then(([initialSnapshot, incidentList]) => {
        if (disposed) return;
        setSnapshot(initialSnapshot);
        setConversations(incidentList);
        if (incidentId !== "demo") setShowWelcome(false);
        source = connectInvestigationEvents(
          incidentId,
          initialSnapshot.stream.lastEventId,
          (event) => setSnapshot((current) => (current ? applyRcaEvent(current, event) : current)),
          setConnected,
        );
      })
      .catch((error: unknown) => {
        if (!disposed) setLoadError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      disposed = true;
      source?.close();
    };
  }, [incidentId]);

  useEffect(() => {
    setRightTab("overview");
    setDetailOpen(false);
  }, [incidentId]);

  useEffect(() => {
    if (!snapshot || incidentId === "demo") return;
    setConversations((current) => current.map((item) =>
      item.id === incidentId
        ? { ...item, title: snapshot.title, status: snapshot.status, updatedAt: new Date().toISOString() }
        : item,
    ));
  }, [incidentId, snapshot?.status, snapshot?.title]);

  const agents = snapshot?.agents ?? [];
  const hypotheses = snapshot?.hypotheses ?? [];
  const evidence = snapshot?.evidence ?? [];
  const toolRuns = snapshot?.toolRuns ?? [];
  const running = snapshot?.status === "running" || snapshot?.status === "stopping";
  const stopping = snapshot?.status === "stopping";
  const hasInvestigationStarted = !showWelcome;
  const composerPlaceholder = running
    ? "当前调查正在运行，可以先输入下一条问题…"
    : hasInvestigationStarted
      ? "继续输入问题，发送后将创建新的 Investigation…"
      : "描述故障现象，或点击上方推荐示例…";
  const composerHint = running
    ? "当前调查运行中，完成后即可发送"
    : hasInvestigationStarted
      ? "发送后会创建新的 Investigation，不会修改当前历史"
      : "发送后会创建一条新的 Investigation";
  const currentSummary = conversations.find((item) => item.id === incidentId);
  const promptTime = currentSummary ? messageTime(currentSummary.createdAt) : "--:--";
  const planMessages = snapshot?.messages.filter((message) => message.kind === "plan") ?? [];
  const decisionMessages = snapshot?.messages.filter((message) => message.kind === "decision") ?? [];
  const findingMessages = snapshot?.messages.filter((message) => message.kind === "finding") ?? [];
  const conclusionMessages = snapshot?.messages.filter((message) => message.kind === "conclusion") ?? [];
  const thinking = snapshot?.thinking ?? [];
  const planThinking = thinking.filter((item) => item.stage === "plan");
  const evidenceThinking = thinking.filter((item) => item.stage === "evidence");
  const synthesisThinking = thinking.filter((item) => item.stage === "synthesis");
  const visibleAgents = agents.filter((agent) => agent.state !== "waiting");

  const startInvestigation = async (prompt: string) => {
    if (running) return;
    const normalizedPrompt = prompt.trim() || DEMO_PROMPT;
    setShowWelcome(false);
    setLoadError(undefined);
    try {
      const created = await createInvestigation("t039");
      const id = created.investigation.id;
      setSnapshot(created.investigation.snapshot);
      setIncidentId(id);
      setConversations(await listIncidents());
      await runInvestigation(id, normalizedPrompt);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  };

  const rerun = () => void startInvestigation(snapshot?.prompt ?? DEMO_PROMPT);

  const stopInvestigation = () => {
    if (!running || stopping || incidentId === "demo") return;
    setLoadError(undefined);
    void abortInvestigation(incidentId).catch((error: unknown) => {
      setLoadError(error instanceof Error ? error.message : String(error));
    });
  };

  const newInvestigation = () => {
    if (running) return;
    setLoadError(undefined);
    setShowWelcome(true);
    setSidebarOpen(false);
    setIncidentId("demo");
  };

  const openHistory = (id: string) => {
    if (running || id === incidentId) return;
    setLoadError(undefined);
    setShowWelcome(false);
    setSidebarOpen(false);
    setIncidentId(id);
  };

  const submit = () => {
    const prompt = draft.trim();
    if (!prompt || running) return;
    setDraft("");
    void startInvestigation(prompt);
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
      <aside className={`conversation-sidebar ${sidebarOpen ? "mobile-open" : ""}`}>
        <div className="sidebar-brand">
          <div className="brand-mark"><Activity size={17} /></div>
          <div className="sidebar-brand-copy"><strong>AI Ops RCA</strong><span>基于 Pi 的多智能体根因分析</span></div>
          <button className="sidebar-mobile-close" type="button" onClick={() => setSidebarOpen(false)} aria-label="关闭历史调查">
            <X size={16} />
          </button>
        </div>

        <button className="new-chat" onClick={newInvestigation} disabled={running}><Plus size={16} /> 新的调查</button>
        <div className="sidebar-section-title"><span>历史调查</span></div>
        <div className="conversation-list">
          {conversations.map((item) => (
            <button
              key={item.id}
              className={`conversation-item ${item.id === incidentId && hasInvestigationStarted ? "active" : ""}`}
              onClick={() => openHistory(item.id)}
            >
              <strong>{item.title}</strong>
              <span className="conversation-meta">
                <i className={`history-status-dot ${item.status}`} />
                {investigationStatusLabel(item.status)} · {historyTime(item.updatedAt)}
              </span>
              <small className="conversation-submeta">RCA100 · {item.datasetTaskId} · {shortInvestigationId(item.id)}</small>
            </button>
          ))}
          {conversations.length === 0 && <div className="history-empty">暂无历史调查</div>}
        </div>
      </aside>

      {sidebarOpen && <button className="mobile-sidebar-backdrop" type="button" onClick={() => setSidebarOpen(false)} aria-label="关闭历史调查" />}

      <section className="chat-shell">
        <header className="chat-topbar">
          <div className="topbar-main">
            <button className="mobile-history-toggle" type="button" onClick={() => setSidebarOpen(true)} aria-label="打开历史调查">
              <Menu size={17} />
            </button>
            <div>
              <div className="chat-title-row">
                <h1>{hasInvestigationStarted ? snapshot.title : "新排查"}</h1>
                {hasInvestigationStarted && <span className={`investigation-status-pill ${snapshot.status}`}>{investigationStatusLabel(snapshot.status)}</span>}
              </div>
              <span className="chat-subtitle">
                {hasInvestigationStarted
                  ? `${snapshot.dataset.name} · ${snapshot.dataset.taskId} · ${shortInvestigationId(incidentId)} · ${snapshot.severity} · ${snapshot.window}`
                  : "选择推荐示例，或直接描述故障现象"}
              </span>
            </div>
          </div>
          <div className="topbar-actions">
            {running && <span className="runtime-pill">Pi Agent · {connected ? "实时连接" : "连接中"} <i className={connected ? "connection-dot online" : "connection-dot"} /></span>}
            {hasInvestigationStarted && (
              <button className="icon-text-button detail-trigger" type="button" onClick={() => setDetailOpen(true)}>
                <PanelRight size={14} />调查详情
              </button>
            )}
            {hasInvestigationStarted && (
              running ? (
                <button className="icon-text-button stop-investigation" onClick={stopInvestigation} disabled={stopping}>
                  <Square size={13} />{stopping ? "停止中" : "停止排查"}
                </button>
              ) : (
                <button className="icon-text-button rerun-button" onClick={rerun}><TimerReset size={15} />再次运行</button>
              )
            )}
          </div>
        </header>

        <main className={`conversation-stream ${!hasInvestigationStarted ? "empty-stream" : ""}`}>
          {(loadError || snapshot.error) && <div className="runtime-error">Runtime: {loadError ?? snapshot.error}</div>}

          {!hasInvestigationStarted ? (
            <DemoWelcome onRun={() => void startInvestigation(DEMO_PROMPT)} running={running} />
          ) : (
            <>
          <MessageRow time={promptTime}>
            {snapshot.prompt}
          </MessageRow>

          {planMessages.map((message) => (
            <CoordinatorMessage key={message.id} time={messageTime(message.createdAt)}>
              <p>{message.text}</p>
            </CoordinatorMessage>
          ))}

          {planThinking.map((item) => <ThinkingItem key={item.id} item={item} />)}

          {visibleAgents.length > 0 && (
            <AgentGroup
              title="Agent 调查"
              agents={visibleAgents}
              toolRuns={toolRuns}
              evidence={evidence}
            />
          )}

          {evidence.length > 0 && <EvidenceTimelineSummary evidence={evidence} />}
          {hypotheses.length > 0 && <HypothesisTimelineSummary hypotheses={hypotheses} />}

          {evidenceThinking.map((item) => <ThinkingItem key={item.id} item={item} />)}

          {decisionMessages.map((message) => (
            <CoordinatorMessage key={message.id} time={messageTime(message.createdAt)}>
              <p>{message.text}</p>
            </CoordinatorMessage>
          ))}

          {findingMessages.map((message) => (
            <CoordinatorMessage key={message.id} time={messageTime(message.createdAt)}>
              <p>{message.text}</p>
            </CoordinatorMessage>
          ))}

          {synthesisThinking.map((item) => <ThinkingItem key={item.id} item={item} />)}

          {conclusionMessages.map((message) => (
            <CoordinatorMessage key={message.id} time={messageTime(message.createdAt)} conclusion>
              <p>{message.text}</p>
            </CoordinatorMessage>
          ))}

          {snapshot.conclusion && (
            <section className="inline-conclusion">
              <div className="inline-conclusion-title"><Check size={16} /> RCA 结论</div>
              <p><strong>根因实体：</strong>{snapshot.conclusion.rootCauseEntity ?? "-"} · <strong>故障类型：</strong>{snapshot.conclusion.faultType ?? "-"}</p>
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
            </>
          )}
        </main>

        <form className="composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={composerPlaceholder}
            rows={2}
          />
          <div className="composer-footer">
            <span className="composer-hint">{composerHint}</span>
            <button className="send-button" type="submit" disabled={!draft.trim() || running} aria-label="发送"><Send size={16} /></button>
          </div>
        </form>
      </section>

      {detailOpen && hasInvestigationStarted && (
        <>
          <button className="detail-backdrop" type="button" onClick={() => setDetailOpen(false)} aria-label="关闭调查详情" />
          <aside className="investigation-drawer" aria-label="调查详情">
            <div className="drawer-header">
              <div><PanelRight size={15} /><strong>调查详情</strong></div>
              <button type="button" onClick={() => setDetailOpen(false)} aria-label="关闭调查详情"><X size={16} /></button>
            </div>

            <div className="drawer-tabs">
              <button className={rightTab === "overview" ? "active" : ""} onClick={() => setRightTab("overview")}>概览</button>
              <button className={rightTab === "tools" ? "active" : ""} onClick={() => setRightTab("tools")}>工具</button>
              <button className={rightTab === "evidence" ? "active" : ""} onClick={() => setRightTab("evidence")}>证据</button>
            </div>

            {rightTab === "overview" && (
              <div className="drawer-content">
                <section className="context-section context-basics">
                  <div className="context-heading"><strong>基本信息</strong></div>
                  <div className="context-facts">
                    <div><span>状态</span><strong className={`fact-status ${snapshot.status}`}>{investigationStatusLabel(snapshot.status)}</strong></div>
                    <div><span>数据集</span><b>{snapshot.dataset.name} · {snapshot.dataset.taskId}</b></div>
                    <div><span>调查 ID</span><code>{shortInvestigationId(incidentId)}</code></div>
                    <div><span>当前阶段</span><b>{investigationStateText(snapshot)}</b></div>
                  </div>
                </section>

                <section className="context-section">
                  <div className="context-heading"><strong>已派发 Agent</strong><span>{visibleAgents.length}</span></div>
                  <div className="compact-agent-list">
                    {visibleAgents.map((agent) => {
                      const Icon = agentIcon[agent.id];
                      return <div className="compact-agent" key={agent.id}><Icon size={13} /><span>{agent.name}</span><small>{statusLabel(agent.state)}</small><i className={`state-dot ${agent.state}`} /></div>;
                    })}
                    {visibleAgents.length === 0 && <span className="context-empty">Coordinator 尚未派发 Agent。</span>}
                  </div>
                </section>

                <section className="context-section">
                  <div className="context-heading"><strong>假设</strong><span>{hypotheses.length}</span></div>
                  <div className="compact-hypothesis-list">
                    {hypotheses.map((item) => (
                      <div className="compact-hypothesis" key={item.id}>
                        <span className="hypothesis-id">{item.id}</span>
                        <span>{item.title}</span>
                        <small className={item.state}>{hypothesisLabel(item.state)}</small>
                      </div>
                    ))}
                    {hypotheses.length === 0 && <span className="context-empty">尚未形成 Hypothesis。</span>}
                  </div>
                </section>
              </div>
            )}

            {rightTab === "tools" && <CompactTools toolRuns={toolRuns} />}
            {rightTab === "evidence" && <CompactEvidence evidence={evidence} />}
          </aside>
        </>
      )}
    </div>
  );
}

function DemoWelcome({ onRun, running }: { onRun(): void; running: boolean }) {
  return (
    <section className="demo-welcome">
      <div className="demo-welcome-icon"><Activity size={28} /></div>
      <h2>从一个真实 RCA100 Case 开始</h2>
      <p>不需要记 Prompt。点击推荐案例后，会按需准备 RCA100 t039 的真实 Logs / Metrics / Traces / Events / Topology，再运行多 Agent 调查。</p>

      <div className="recommendation-section">
        <div className="recommendation-label"><Sparkles size={14} /> 为你推荐</div>
        <button className="recommendation-card" type="button" onClick={onRun} disabled={running}>
          <div className="recommendation-card-main">
            <span className="recommendation-badge">RCA100 · t039 · 推荐案例</span>
            <strong>checkout 响应时间突增告警</strong>
            <p>{DEMO_PROMPT}</p>
            <div className="recommendation-flow">
              <span>Coordinator 动态派发</span><ChevronRight size={13} /><span>多模态 Evidence</span><ChevronRight size={13} /><span>RCA 结论</span>
            </div>
          </div>
          <span className="recommendation-action">{running ? "运行中" : "一键运行"}<ChevronRight size={15} /></span>
        </button>
      </div>

      <span className="demo-welcome-hint">首次运行会下载 t039 单案例数据；后续查询直接读取本地 Parquet/JSON，不再返回硬编码答案。</span>
    </section>
  );
}

function MessageRow({ time, children }: { time: string; children: ReactNode }) {
  return (
    <article className="message-row user-row">
      <div className="message-column">
        <div className="bubble user-bubble">{children}</div>
        <div className="message-meta">{time}</div>
      </div>
    </article>
  );
}

function CoordinatorMessage({ time, children, conclusion = false }: { time: string; children: ReactNode; conclusion?: boolean }) {
  return (
    <article className="message-row assistant-row">
      <div className="message-column">
        <div className="assistant-meta">
          <span>{conclusion ? <Check size={13} /> : <Sparkles size={13} />}</span>
          RCA Coordinator
          <small>{time}</small>
        </div>
        <div className="bubble assistant-bubble">{children}</div>
      </div>
    </article>
  );
}

function ThinkingItem({ item }: { item: InvestigationSnapshot["thinking"][number] }) {
  const [open, setOpen] = useState(true);

  return (
    <details
      className={`thinking ${item.completed ? "completed" : "streaming"}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <Brain size={16} />
        <span>{item.completed ? item.title : `正在${item.title}`}</span>
        <small>{item.completed ? "分析摘要" : "实时更新中"}</small>
        <ChevronDown size={15} className="thinking-chevron" />
      </summary>
      <div className="thinking-content-body">
        <p>{item.text || "正在整理当前信号与下一步调查方向…"}</p>
        {!item.completed && <span className="thinking-cursor" aria-hidden />}
      </div>
    </details>
  );
}

function AgentGroup({ title, agents, toolRuns, evidence }: {
  title: string;
  agents: InvestigationSnapshot["agents"];
  toolRuns: InvestigationSnapshot["toolRuns"];
  evidence: InvestigationSnapshot["evidence"];
}) {
  const completed = agents.filter((agent) => agent.state === "done").length;
  const active = agents.some((agent) => agent.state === "running");
  return (
    <div className="inline-agent-group">
      <div className="inline-agent-group-title">
        <span><CircleDot size={14} /> {title}</span>
        <small>{active ? "Agent 执行中" : `${completed}/${agents.length} 已完成`}</small>
      </div>
      {agents.map((agent) => (
        <AgentTaskCard
          key={agent.id}
          agent={agent}
          tools={toolRuns.filter((item) => item.agent === agent.id)}
          evidence={evidence.filter((item) => item.createdBy === agent.id)}
        />
      ))}
    </div>
  );
}

function AgentTaskCard({ agent, tools, evidence }: {
  agent: InvestigationSnapshot["agents"][number];
  tools: InvestigationSnapshot["toolRuns"];
  evidence: InvestigationSnapshot["evidence"];
}) {
  const Icon = agentIcon[agent.id];
  return (
    <details className={`agent-task ${agent.state}`}>
      <summary>
        <div className={`agent-task-icon ${agent.id}`}><Icon size={15} /></div>
        <div className="agent-task-main">
          <div><strong>{agent.name}</strong><span className={`agent-status ${agent.state}`}>{statusLabel(agent.state)}</span></div>
          <p>{agent.state === "done" ? agent.result : agent.description}</p>
        </div>
        <ChevronDown size={15} className="details-chevron" />
      </summary>
      <div className="agent-task-detail">
        {tools.length ? tools.map((tool) => (
          <div className="inline-tool-call" key={tool.id}>
            <div><Wrench size={13} /><strong>{tool.name}</strong><span>{tool.status}</span></div>
            <code>{JSON.stringify(tool.args)}</code>
            {tool.result && <p>{tool.result}</p>}
          </div>
        )) : <div className="inline-empty">等待 Tool Call…</div>}
        {evidence.map((item) => (
          <div className="inline-evidence" key={item.id}>
            <Database size={13} /><b>{item.id}</b><span>{item.label}</span><small>{item.modality}</small>
          </div>
        ))}
      </div>
    </details>
  );
}

function EvidenceTimelineSummary({ evidence }: { evidence: InvestigationSnapshot["evidence"] }) {
  return (
    <details className="timeline-summary evidence-summary">
      <summary>
        <span className="timeline-summary-icon"><Database size={14} /></span>
        <span className="timeline-summary-main">
          <strong>Evidence 更新</strong>
          <small>已生成 {evidence.length} 条可引用证据</small>
        </span>
        <ChevronDown size={15} className="details-chevron" />
      </summary>
      <div className="timeline-summary-body">
        {evidence.map((item) => (
          <div className="timeline-evidence-row" key={item.id}>
            <b>{item.id}</b>
            <span>{item.label}</span>
            <small>{item.modality}</small>
          </div>
        ))}
      </div>
    </details>
  );
}

function HypothesisTimelineSummary({ hypotheses }: { hypotheses: InvestigationSnapshot["hypotheses"] }) {
  const supported = hypotheses.filter((item) => item.state === "supported").length;
  const validating = hypotheses.filter((item) => item.state === "validating" || item.state === "possible").length;
  const rejected = hypotheses.filter((item) => item.state === "rejected").length;

  return (
    <details className="timeline-summary hypothesis-summary">
      <summary>
        <span className="timeline-summary-icon"><CircleDot size={14} /></span>
        <span className="timeline-summary-main">
          <strong>假设更新</strong>
          <small>{supported} 支持 · {validating} 待验证 · {rejected} 已排除</small>
        </span>
        <ChevronDown size={15} className="details-chevron" />
      </summary>
      <div className="timeline-summary-body">
        {hypotheses.map((item) => (
          <div className="timeline-hypothesis-row" key={item.id}>
            <b>{item.id}</b>
            <span>{item.title}</span>
            <small className={item.state}>{hypothesisLabel(item.state)}</small>
          </div>
        ))}
      </div>
    </details>
  );
}

function CompactTools({ toolRuns }: { toolRuns: InvestigationSnapshot["toolRuns"] }) {
  return <div className="context-scroll-list">{toolRuns.map((tool) => <article className="compact-tool-card" key={tool.id}><div><span className={`tool-kind ${tool.agent}`}>{tool.agent}</span><strong>{tool.name}</strong></div><code>{JSON.stringify(tool.args)}</code>{tool.result && <p>{tool.result}</p>}</article>)}{toolRuns.length === 0 && <span className="context-empty">等待 Tool Call…</span>}</div>;
}

function CompactEvidence({ evidence }: { evidence: InvestigationSnapshot["evidence"] }) {
  return <div className="context-scroll-list">{evidence.map((item) => <article className="compact-evidence-card" key={item.id}><div><b>{item.id}</b><strong>{item.label}</strong><span className="tool-kind">{item.modality}</span></div><p>{item.summary}</p><code>{item.rawRef}</code></article>)}{evidence.length === 0 && <span className="context-empty">Evidence 尚未生成。</span>}</div>;
}
