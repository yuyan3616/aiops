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
  Square,
  TimerReset,
  Wrench,
  BarChart3,
  Brain,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

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

export default function App() {
  const [incidentId, setIncidentId] = useState("demo");
  const [snapshot, setSnapshot] = useState<InvestigationSnapshot>();
  const [conversations, setConversations] = useState<IncidentSummary[]>([]);
  const [connected, setConnected] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [rightTab, setRightTab] = useState<"overview" | "tools" | "evidence">("overview");
  const [draft, setDraft] = useState("");
  const [showWelcome, setShowWelcome] = useState(true);

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
  const tasks = snapshot?.tasks ?? [];
  const running = snapshot?.status === "running" || snapshot?.status === "stopping";
  const stopping = snapshot?.status === "stopping";
  const hasInvestigationStarted = !showWelcome;
  const doneCount = agents.filter((agent) => agent.state === "done").length;
  const runningCount = agents.filter((agent) => agent.state === "running").length;
  const planMessages = snapshot?.messages.filter((message) => message.kind === "plan") ?? [];
  const decisionMessages = snapshot?.messages.filter((message) => message.kind === "decision") ?? [];
  const findingMessages = snapshot?.messages.filter((message) => message.kind === "finding") ?? [];
  const conclusionMessages = snapshot?.messages.filter((message) => message.kind === "conclusion") ?? [];
  const thinking = snapshot?.thinking ?? [];
  const planThinking = thinking.filter((item) => item.stage === "plan");
  const evidenceThinking = thinking.filter((item) => item.stage === "evidence");
  const synthesisThinking = thinking.filter((item) => item.stage === "synthesis");
  const visibleAgents = agents.filter((agent) => agent.state !== "waiting");

  const investigationProgress = useMemo(() => {
    if (snapshot?.conclusion) return 100;
    if (doneCount === 4) return 88;
    return Math.max(10, doneCount * 20 + runningCount * 9);
  }, [doneCount, runningCount, snapshot?.conclusion]);

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
    setIncidentId("demo");
  };

  const openHistory = (id: string) => {
    if (running || id === incidentId) return;
    setLoadError(undefined);
    setShowWelcome(false);
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
      <aside className="conversation-sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark"><Activity size={17} /></div>
          <div><strong>RCA Assistant</strong><span>Multi-Agent</span></div>
        </div>

        <button className="new-chat" onClick={newInvestigation} disabled={running}><Plus size={16} /> 新建排查</button>
        <div className="sidebar-section-title"><span>历史会话</span><Search size={14} /></div>
        <div className="conversation-list">
          {conversations.map((item) => (
            <button
              key={item.id}
              className={`conversation-item ${item.id === incidentId && hasInvestigationStarted ? "active" : ""}`}
              onClick={() => openHistory(item.id)}
            >
              <strong>{item.title}</strong>
              <span>
                <i className={item.status === "completed" ? "finished" : "running"} />
                {investigationStatusLabel(item.status)} · {historyTime(item.updatedAt)}
              </span>
            </button>
          ))}
          {conversations.length === 0 && <div className="history-empty">暂无历史调查</div>}
        </div>
      </aside>

      <section className="chat-shell">
        <header className="chat-topbar">
          <div>
            <div className="chat-title-row">
              <h1>{hasInvestigationStarted ? snapshot.title : "新排查"}</h1>
              {hasInvestigationStarted && <span className="severity">{snapshot.severity}</span>}
            </div>
            <span className="chat-subtitle"><Clock3 size={12} /> {hasInvestigationStarted ? snapshot.window : "选择推荐示例，或直接描述故障现象"}</span>
          </div>
          <div className="topbar-actions">
            <span className="runtime-pill">Pi Agent · RCA100 {snapshot.dataset.taskId}{snapshot.dataset.telemetryReady ? " · Ready" : " · On demand"} <i className={connected ? "connection-dot online" : "connection-dot"} /></span>
            {hasInvestigationStarted && (
              running ? (
                <button className="icon-text-button stop-investigation" onClick={stopInvestigation} disabled={stopping}>
                  <Square size={13} />{stopping ? "停止中" : "停止排查"}
                </button>
              ) : (
                <button className="icon-text-button" onClick={rerun}><TimerReset size={15} />重新运行</button>
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
          <MessageRow time="09:20">
            {snapshot.prompt}
          </MessageRow>

          {planMessages.map((message) => (
            <CoordinatorMessage key={message.id} time={messageTime(message.createdAt)}>
              <p>{message.text}</p>
              <div className="plan-points">
                <span>Coordinator 动态选择 Agent</span>
                <span>Evidence 驱动假设更新</span>
                <span>同轮 Agent 并行执行</span>
              </div>
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
            placeholder={hasInvestigationStarted ? "继续追问，或描述新的故障现象…" : "描述故障现象，或点击上方推荐示例…"}
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
          !hasInvestigationStarted ? (
            <div className="context-welcome">
              <Sparkles size={17} />
              <strong>等待开始排查</strong>
              <p>运行 RCA100 t039 后，这里会实时显示 Agent、Hypothesis、Evidence 和 RCA 结论。</p>
            </div>
          ) : (
          <>
            <section className="context-section">
              <div className="context-heading"><strong>调查进度</strong><span>{investigationProgress}%</span></div>
              <div className="progress-bar"><span style={{ width: `${investigationProgress}%` }} /></div>
              <div className="phase-text">{snapshot.conclusion ? "根因已收敛" : snapshot.status === "interrupted" ? "调查在服务重启时中断" : snapshot.status === "error" ? "调查执行失败" : snapshot.status === "cancelled" ? "调查已停止" : stopping ? "正在停止 Agent 任务" : running ? "正在收集和验证证据" : "等待开始"}</div>
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
              <div className="context-heading"><strong>Tasks</strong><span>{tasks.filter((task) => task.status === "succeeded").length}/{tasks.length}</span></div>
              <div className="compact-task-list">
                {tasks.slice(-6).map((task) => (
                  <div className="compact-task" key={task.id}>
                    <b>{task.id}</b><span>{task.agent}</span><small className={task.status}>{task.status}</small>
                  </div>
                ))}
                {tasks.length === 0 && <span className="context-empty">等待 Coordinator 创建 AgentTask…</span>}
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
          )
        )}

        {rightTab === "tools" && <CompactTools toolRuns={toolRuns} />}
        {rightTab === "evidence" && <CompactEvidence evidence={evidence} />}
      </aside>
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
  return (
    <details className={`thinking ${item.completed ? "completed" : "streaming"}`} open={!item.completed}>
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

function CompactTools({ toolRuns }: { toolRuns: InvestigationSnapshot["toolRuns"] }) {
  return <div className="context-scroll-list">{toolRuns.map((tool) => <article className="compact-tool-card" key={tool.id}><div><span className={`tool-kind ${tool.agent}`}>{tool.agent}</span><strong>{tool.name}</strong></div><code>{JSON.stringify(tool.args)}</code>{tool.result && <p>{tool.result}</p>}</article>)}{toolRuns.length === 0 && <span className="context-empty">等待 Tool Call…</span>}</div>;
}

function CompactEvidence({ evidence }: { evidence: InvestigationSnapshot["evidence"] }) {
  return <div className="context-scroll-list">{evidence.map((item) => <article className="compact-evidence-card" key={item.id}><div><b>{item.id}</b><strong>{item.label}</strong><span className="tool-kind">{item.modality}</span></div><p>{item.summary}</p><code>{item.rawRef}</code></article>)}{evidence.length === 0 && <span className="context-empty">Evidence 尚未生成。</span>}</div>;
}
