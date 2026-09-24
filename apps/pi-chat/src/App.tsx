import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  Database,
  FileSearch,
  GitBranch,
  Link2,
  Network,
  Plus,
  Search,
  Send,
  Settings,
  Sparkles,
  TimerReset,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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
  const [selectedTab, setSelectedTab] = useState("对话与过程");
  const [connected, setConnected] = useState(false);
  const [loadError, setLoadError] = useState<string>();

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
        if (!disposed) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
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
  const showConclusion = Boolean(snapshot?.conclusion);
  const phase = snapshot?.phase ?? 1;
  const doneCount = agents.filter((agent) => agent.state === "done").length;
  const runningCount = agents.filter((agent) => agent.state === "running").length;

  const investigationProgress = useMemo(() => {
    if (showConclusion) return 100;
    if (doneCount === 4) return 86;
    if (phase === 3) return 78;
    return Math.max(12, doneCount * 18 + runningCount * 8);
  }, [doneCount, phase, runningCount, showConclusion]);

  const rerun = () => {
    setLoadError(undefined);
    void runInvestigation(incidentId).catch((error: unknown) => {
      setLoadError(error instanceof Error ? error.message : String(error));
    });
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
    <div className="rca-app">
      <header className="global-header">
        <div className="brand">
          <div className="brand-mark"><Activity size={18} /></div>
          <strong>RCA 多 Agent 故障排查系统</strong>
        </div>
        <nav className="global-nav">
          <button className="nav-item active"><Sparkles size={16} />排查</button>
          <button className="nav-item"><Database size={16} />知识库</button>
          <button className="nav-item"><Network size={16} />服务拓扑</button>
          <button className="nav-item"><Settings size={16} />设置</button>
        </nav>
        <div className="model-badge">
          Fake LLM <span>Server Orchestrated</span>
          <i className={connected ? "connection-dot online" : "connection-dot"} />
        </div>
      </header>

      <div className="workspace">
        <aside className="history-panel">
          <button className="primary-new"><Plus size={17} /> 新建排查</button>
          <div className="history-title"><span>历史会话</span><Search size={16} /></div>
          <div className="history-list">
            {conversations.map((item) => (
              <button key={item.id} className={`history-item ${item.id === incidentId ? "active" : ""}`}>
                <div className="history-item-title">{item.title}</div>
                <div className="history-meta">
                  <span>{item.time}</span>
                  <span className={`history-status ${item.status}`}>{item.status}</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <main className="investigation-panel">
          <section className="incident-header">
            <div>
              <div className="incident-title-row">
                <h1>{snapshot.title}</h1>
                <span className="severity">{snapshot.severity}</span>
              </div>
              <div className="incident-window"><Clock3 size={14} /> {snapshot.window}</div>
            </div>
            <button className="ghost-action" onClick={rerun} disabled={running}>
              <TimerReset size={16} /> {running ? "Server 调查运行中" : "重新运行 Fake 调查"}
            </button>
          </section>

          <div className="content-tabs">
            {["对话与过程", "时间线", "工具调用", "证据", "配置"].map((tab) => (
              <button key={tab} className={selectedTab === tab ? "active" : ""} onClick={() => setSelectedTab(tab)}>{tab}</button>
            ))}
          </div>

          <div className="scroll-area">
            {loadError && <div className="runtime-error">Runtime: {loadError}</div>}

            {selectedTab === "工具调用" ? (
              <ToolRunsPanel toolRuns={toolRuns} />
            ) : selectedTab === "证据" ? (
              <EvidencePanel evidence={evidence} />
            ) : selectedTab === "时间线" ? (
              <TimelinePanel snapshot={snapshot} />
            ) : selectedTab === "配置" ? (
              <RuntimeConfigPanel connected={connected} />
            ) : (
              <>
                <div className="message user-message">
                  <div className="avatar user-avatar">U</div>
                  <div>
                    <div className="speaker">用户 <span>10:24</span></div>
                    <div className="message-bubble">order-service 从 10:31 开始 5xx 大幅上升，帮我分析一下可能的原因。</div>
                  </div>
                </div>

                {snapshot.messages.map((message) => (
                  <div className="message" key={message.id}>
                    <div className="avatar coordinator-avatar">
                      {message.kind === "conclusion" ? <Check size={17} /> : message.kind === "finding" ? <Bot size={17} /> : <Sparkles size={17} />}
                    </div>
                    <div className="message-body">
                      <div className="speaker">RCA Coordinator <span>{messageTime(message.createdAt)}</span></div>
                      <div className={`coordinator-card ${message.kind !== "plan" ? "evidence-summary" : ""}`}>
                        <p>{message.text}</p>
                        {message.kind === "plan" && (
                          <ol>
                            <li>第一轮并行分析日志错误模式与关键指标</li>
                            <li>根据第一轮 Evidence 更新候选假设</li>
                            <li>动态决定是否追加 Trace / Change Agent</li>
                            <li>汇聚证据链并输出可解释 RCA 结论</li>
                          </ol>
                        )}
                      </div>
                    </div>
                  </div>
                ))}

                <section className="agent-execution-card">
                  <div className="section-heading">
                    <div><CircleDot size={17} /> 多 Agent 调查任务</div>
                    <span>{running ? "Server fan-out / fan-in 执行中" : doneCount === 4 ? "Agent 结果已汇聚" : "等待执行"}</span>
                  </div>
                  <div className="agent-list">
                    {agents.map((agent) => {
                      const Icon = agentIcon[agent.id];
                      return (
                        <div className={`agent-row ${agent.state}`} key={agent.id}>
                          <div className={`agent-icon ${agent.id}`}><Icon size={17} /></div>
                          <div className="agent-main">
                            <div className="agent-topline">
                              <strong>{agent.name}</strong>
                              <span className={`agent-status ${agent.state}`}>{statusLabel(agent.state)}</span>
                            </div>
                            <span className="agent-desc">{agent.state === "done" ? agent.result : agent.description}</span>
                          </div>
                          <div className="progress-track"><span style={{ width: `${agent.progress}%` }} /></div>
                          <ChevronRight size={17} className="chevron" />
                        </div>
                      );
                    })}
                  </div>
                </section>

                {snapshot.conclusion && (
                  <section className="conclusion-card">
                    <div className="conclusion-title"><Check size={18} /> RCA 初步结论</div>
                    <p><strong>根因：</strong>{snapshot.conclusion.rootCause}</p>
                    <div className="causal-chain">
                      {snapshot.conclusion.causalChain.map((item, index) => (
                        <span className="chain-fragment" key={item}>
                          <span>{item}</span>
                          {index < snapshot.conclusion!.causalChain.length - 1 && <ChevronRight size={15} />}
                        </span>
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>

          <div className="composer">
            <input placeholder="输入你的问题，或描述故障现象..." />
            <div className="composer-tools">
              <button><Link2 size={15} /> 附件</button>
              <button><Wrench size={15} /> 服务</button>
              <button><Clock3 size={15} /> 时间范围</button>
              <button className="send"><Send size={16} /></button>
            </div>
          </div>
        </main>

        <aside className="insight-panel">
          <div className="right-tabs"><button className="active">调查概览</button><button>服务关系</button><button>相关图表</button></div>

          <section className="side-card progress-card">
            <div className="side-card-title">调查进度 <span>{investigationProgress}%</span></div>
            <div className="stage-line">
              {[
                [1, "收集证据"], [2, "分析验证"], [3, "定位根因"], [4, "输出结论"],
              ].map(([index, label], i) => (
                <div className={`stage ${phase >= Number(index) ? "active" : ""}`} key={String(label)}>
                  <div className="stage-dot">{phase > Number(index) ? <Check size={12} /> : i + 1}</div>
                  <span>{label}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="side-card">
            <div className="side-card-title">Agent 状态 <span>{doneCount}/4</span></div>
            <div className="agent-mini-list">
              {agents.map((agent) => {
                const Icon = agentIcon[agent.id];
                return (
                  <div className="agent-mini" key={agent.id}>
                    <Icon size={15} />
                    <strong>{agent.name}</strong>
                    <span className={`agent-status ${agent.state}`}>{statusLabel(agent.state)}</span>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="side-card">
            <div className="side-card-title">假设列表 <button>+ 新增假设</button></div>
            <div className="hypothesis-list">
              {hypotheses.map((item) => (
                <div className="hypothesis" key={item.id}>
                  <span className="hypothesis-id">{item.id}</span>
                  <span className="hypothesis-title">{item.title}</span>
                  <span className={`hypothesis-status ${item.state}`}>{hypothesisLabel(item.state)}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="side-card">
            <div className="side-card-title">关键证据 <button>查看全部</button></div>
            <div className="evidence-list">
              {evidence.map((item) => (
                <button className="evidence-item" key={item.id} title={`${item.summary}\n${item.rawRef}`}>
                  <span className="evidence-id">{item.id}</span>
                  <span>{item.label}</span>
                  <small>{item.type}</small>
                </button>
              ))}
              {evidence.length === 0 && <div className="empty-evidence">等待 Agent 生成 Evidence…</div>}
            </div>
          </section>

          <section className={`side-card result-card ${showConclusion ? "ready" : ""}`}>
            <div className="side-card-title"><AlertTriangle size={16} /> 初步结论 <span>{showConclusion ? "已生成" : "生成中"}</span></div>
            <p>{snapshot.conclusion ? `已关联 ${snapshot.conclusion.evidenceIds.length} 条 Evidence，发布变更与连接池异常构成连续因果链。` : "Coordinator 正在汇总各 Agent 结果，并根据 Evidence 动态更新候选根因。"}</p>
          </section>
        </aside>
      </div>
    </div>
  );
}

function ToolRunsPanel({ toolRuns }: { toolRuns: InvestigationSnapshot["toolRuns"] }) {
  return (
    <section className="detail-panel">
      <div className="detail-heading">
        <div><Wrench size={17} /><strong>Tool Gateway 调用</strong></div>
        <span>Agent 只通过受控 Tool 获取证据</span>
      </div>
      <div className="tool-run-list">
        {toolRuns.map((tool) => (
          <article className="tool-run-card" key={tool.id}>
            <div className="tool-run-topline">
              <span className={`tool-agent ${tool.agent}`}>{tool.agent.toUpperCase()}</span>
              <strong>{tool.name}</strong>
              <span className={`tool-run-status ${tool.status}`}>{tool.status}</span>
              <time>{messageTime(tool.startedAt)}</time>
            </div>
            <pre>{JSON.stringify(tool.args, null, 2)}</pre>
            {tool.result && <p>{tool.result}</p>}
          </article>
        ))}
        {toolRuns.length === 0 && <div className="detail-empty">等待 Coordinator 派发 Agent Tool Call…</div>}
      </div>
    </section>
  );
}

function EvidencePanel({ evidence }: { evidence: InvestigationSnapshot["evidence"] }) {
  return (
    <section className="detail-panel">
      <div className="detail-heading">
        <div><Database size={17} /><strong>Evidence Store</strong></div>
        <span>evidenceId / rawRef / queryKey</span>
      </div>
      <div className="evidence-detail-grid">
        {evidence.map((item) => (
          <article className="evidence-detail-card" key={item.id}>
            <div className="evidence-detail-head">
              <span>{item.id}</span><strong>{item.label}</strong><small>{item.source}</small>
            </div>
            <p>{item.summary}</p>
            <dl>
              <div><dt>rawRef</dt><dd>{item.rawRef}</dd></div>
              <div><dt>queryKey</dt><dd>{item.queryKey}</dd></div>
            </dl>
          </article>
        ))}
        {evidence.length === 0 && <div className="detail-empty">Evidence 尚未生成。</div>}
      </div>
    </section>
  );
}

function TimelinePanel({ snapshot }: { snapshot: InvestigationSnapshot }) {
  const items = [
    ...snapshot.messages.map((item) => ({
      id: `m-${item.id}`,
      time: item.createdAt,
      title: `Coordinator · ${item.kind}`,
      text: item.text,
    })),
    ...snapshot.evidence.map((item) => ({
      id: `e-${item.id}`,
      time: item.createdAt,
      title: `${item.id} · ${item.label}`,
      text: item.summary,
    })),
    ...snapshot.toolRuns.map((item) => ({
      id: `t-${item.id}`,
      time: item.startedAt,
      title: `${item.agent} · ${item.name}`,
      text: item.result ?? "Tool running…",
    })),
  ].sort((a, b) => a.time.localeCompare(b.time));

  return (
    <section className="detail-panel">
      <div className="detail-heading"><div><Clock3 size={17} /><strong>调查时间线</strong></div><span>{items.length} 个事件</span></div>
      <div className="timeline-list">
        {items.map((item) => (
          <div className="timeline-row" key={item.id}>
            <time>{messageTime(item.time)}</time>
            <span className="timeline-dot" />
            <div><strong>{item.title}</strong><p>{item.text}</p></div>
          </div>
        ))}
      </div>
    </section>
  );
}

function RuntimeConfigPanel({ connected }: { connected: boolean }) {
  return (
    <section className="detail-panel">
      <div className="detail-heading"><div><Settings size={17} /><strong>Runtime 配置</strong></div><span>Demo</span></div>
      <div className="config-grid">
        <div><span>Coordinator</span><strong>Server Orchestrated</strong></div>
        <div><span>LLM Provider</span><strong>FakeLlmClient</strong></div>
        <div><span>Tool Gateway</span><strong>FakeToolGateway</strong></div>
        <div><span>Transport</span><strong>{connected ? "SSE Connected" : "SSE Reconnecting"}</strong></div>
        <div><span>Parallel Strategy</span><strong>Log + Metric → Trace + Change</strong></div>
        <div><span>Evidence Cache</span><strong>normalized queryKey</strong></div>
      </div>
    </section>
  );
}
