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
  Play,
  Plus,
  Search,
  Send,
  Settings,
  Sparkles,
  TimerReset,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import "./App.css";

type AgentState = "waiting" | "running" | "done";
type AgentKind = "log" | "metric" | "trace" | "change";
type HypothesisState = "possible" | "validating" | "supported" | "rejected";

interface AgentItem {
  id: AgentKind;
  name: string;
  description: string;
  result: string;
  state: AgentState;
  progress: number;
}

interface EvidenceItem {
  id: string;
  label: string;
  source: string;
  summary: string;
}

interface HypothesisItem {
  id: string;
  title: string;
  state: HypothesisState;
}

const conversations = [
  { title: "order-service 5xx 激增", time: "今天 10:24", status: "进行中", active: true },
  { title: "payment-service 超时", time: "今天 09:12", status: "已完成" },
  { title: "用户下单失败", time: "昨天 16:08", status: "已完成" },
  { title: "数据库连接异常", time: "09-21 11:32", status: "已完成" },
  { title: "消息堆积告警", time: "09-20 14:15", status: "已归档" },
];

const initialAgents: AgentItem[] = [
  {
    id: "log",
    name: "Log Agent",
    description: "查询 order-service、payment-service 错误日志",
    result: "发现大量 connection timeout，异常从 10:31 开始聚集。",
    state: "waiting",
    progress: 0,
  },
  {
    id: "metric",
    name: "Metric Agent",
    description: "分析 5xx、延迟、CPU、数据库连接池指标",
    result: "db_pool_active 接近上限，P99 与 5xx 同步上升。",
    state: "waiting",
    progress: 0,
  },
  {
    id: "trace",
    name: "Trace Agent",
    description: "分析调用链，定位异常耗时的下游服务",
    result: "order → payment span 从 90ms 升至 3.4s，耗时集中在 DB 调用。",
    state: "waiting",
    progress: 0,
  },
  {
    id: "change",
    name: "Change Agent",
    description: "检查故障窗口内发布记录与配置变更",
    result: "10:28 发布 v1.8.4，包含数据库连接池 maxSize 调整。",
    state: "waiting",
    progress: 0,
  },
];

const evidence: EvidenceItem[] = [
  {
    id: "EV01",
    label: "连接超时日志",
    source: "log",
    summary: "payment-service 在 10:31 后出现 286 条 connection timeout。",
  },
  {
    id: "EV02",
    label: "连接池指标异常",
    source: "metric",
    summary: "db_pool_active 持续接近 max，waiting_requests 明显抬升。",
  },
  {
    id: "EV03",
    label: "order → payment 调用耗时",
    source: "trace",
    summary: "关键 span P99 从 90ms 升至 3.4s，异常集中于数据库访问。",
  },
  {
    id: "EV04",
    label: "v1.8.4 发布记录",
    source: "change",
    summary: "故障发生前 3 分钟完成发布，并修改连接池配置。",
  },
];

const initialHypotheses: HypothesisItem[] = [
  { id: "H1", title: "payment-service 数据库连接池耗尽", state: "validating" },
  { id: "H2", title: "payment-service 新版本引入配置问题", state: "validating" },
  { id: "H3", title: "第三方支付接口超时", state: "possible" },
  { id: "H4", title: "order-service 自身资源异常", state: "possible" },
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
  return "等待中";
}

function hypothesisLabel(state: HypothesisState) {
  if (state === "supported") return "已支持";
  if (state === "rejected") return "已排除";
  if (state === "validating") return "待验证";
  return "可能";
}

export default function App() {
  const [agents, setAgents] = useState(initialAgents);
  const [hypotheses, setHypotheses] = useState(initialHypotheses);
  const [phase, setPhase] = useState(1);
  const [running, setRunning] = useState(false);
  const [showConclusion, setShowConclusion] = useState(false);
  const [selectedTab, setSelectedTab] = useState("对话与过程");

  const doneCount = agents.filter((agent) => agent.state === "done").length;
  const runningCount = agents.filter((agent) => agent.state === "running").length;
  const investigationProgress = useMemo(() => {
    if (showConclusion) return 100;
    if (doneCount === 4) return 82;
    return Math.max(12, doneCount * 18 + runningCount * 8);
  }, [doneCount, runningCount, showConclusion]);

  const runFakeInvestigation = () => {
    setAgents(initialAgents);
    setHypotheses(initialHypotheses);
    setShowConclusion(false);
    setPhase(1);
    setRunning(true);
  };

  useEffect(() => {
    if (!running) return;
    const timers: number[] = [];
    const schedule = (delay: number, fn: () => void) => {
      timers.push(window.setTimeout(fn, delay));
    };

    schedule(350, () => {
      setPhase(2);
      setAgents((items) =>
        items.map((item, index) =>
          index < 2 ? { ...item, state: "running", progress: index === 0 ? 58 : 42 } : item,
        ),
      );
    });
    schedule(1450, () => {
      setAgents((items) =>
        items.map((item) =>
          item.id === "log" || item.id === "metric"
            ? { ...item, state: "done", progress: 100 }
            : { ...item, state: "running", progress: item.id === "trace" ? 54 : 36 },
        ),
      );
      setHypotheses((items) =>
        items.map((item) =>
          item.id === "H1" ? { ...item, state: "supported" } : item.id === "H4" ? { ...item, state: "rejected" } : item,
        ),
      );
    });
    schedule(2650, () => {
      setAgents((items) => items.map((item) => ({ ...item, state: "done", progress: 100 })));
      setHypotheses((items) =>
        items.map((item) => {
          if (item.id === "H1" || item.id === "H2") return { ...item, state: "supported" };
          return { ...item, state: "rejected" };
        }),
      );
      setPhase(3);
    });
    schedule(3550, () => {
      setPhase(4);
      setShowConclusion(true);
      setRunning(false);
    });

    return () => timers.forEach(window.clearTimeout);
  }, [running]);

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
        <div className="model-badge">Fake LLM <span>RCA-Demo</span></div>
      </header>

      <div className="workspace">
        <aside className="history-panel">
          <button className="primary-new"><Plus size={17} /> 新建排查</button>
          <div className="history-title"><span>历史会话</span><Search size={16} /></div>
          <div className="history-list">
            {conversations.map((item) => (
              <button key={item.title} className={`history-item ${item.active ? "active" : ""}`}>
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
                <h1>order-service 5xx 激增</h1>
                <span className="severity">P1</span>
              </div>
              <div className="incident-window"><Clock3 size={14} /> 2026-09-25 10:20 ～ 2026-09-25 11:00</div>
            </div>
            <button className="ghost-action" onClick={runFakeInvestigation} disabled={running}>
              <TimerReset size={16} /> {running ? "Fake 调查运行中" : "重新运行 Fake 调查"}
            </button>
          </section>

          <div className="content-tabs">
            {["对话与过程", "时间线", "工具调用", "证据", "配置"].map((tab) => (
              <button key={tab} className={selectedTab === tab ? "active" : ""} onClick={() => setSelectedTab(tab)}>{tab}</button>
            ))}
          </div>

          <div className="scroll-area">
            <div className="message user-message">
              <div className="avatar user-avatar">U</div>
              <div>
                <div className="speaker">用户 <span>10:24</span></div>
                <div className="message-bubble">order-service 从 10:31 开始 5xx 大幅上升，帮我分析一下可能的原因。</div>
              </div>
            </div>

            <div className="message">
              <div className="avatar coordinator-avatar"><Sparkles size={17} /></div>
              <div className="message-body">
                <div className="speaker">RCA Coordinator <span>10:24</span></div>
                <div className="coordinator-card">
                  <p>我已理解当前故障现象。先建立时间窗口并并行派发专项 Agent，第一轮聚焦日志、指标、调用链和发布变更。</p>
                  <ol>
                    <li>分析 order-service 与 payment-service 错误日志</li>
                    <li>检查 5xx、P99、资源与数据库连接池指标</li>
                    <li>定位异常耗时集中在哪段调用链</li>
                    <li>关联故障时间窗口内的发布与配置变更</li>
                  </ol>
                </div>
              </div>
            </div>

            <section className="agent-execution-card">
              <div className="section-heading">
                <div><CircleDot size={17} /> 多 Agent 调查任务</div>
                <span>{running ? "并行执行中" : doneCount === 4 ? "第一轮已汇聚" : "等待执行"}</span>
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

            {doneCount >= 2 && (
              <div className="message">
                <div className="avatar coordinator-avatar"><Bot size={17} /></div>
                <div className="message-body">
                  <div className="speaker">RCA Coordinator <span>10:26</span></div>
                  <div className="coordinator-card evidence-summary">
                    <p><strong>第一轮证据已开始收敛：</strong></p>
                    <ul>
                      <li>payment-service 出现密集 connection timeout</li>
                      <li>数据库连接池 active 指标在异常开始后持续接近上限</li>
                      <li>order → payment 调用耗时显著增加</li>
                    </ul>
                    <p>当前优先验证数据库连接池与最近发布是否构成同一条因果链。</p>
                  </div>
                </div>
              </div>
            )}

            {showConclusion && (
              <section className="conclusion-card">
                <div className="conclusion-title"><Check size={18} /> RCA 初步结论</div>
                <p><strong>根因：</strong>payment-service v1.8.4 发布时修改数据库连接池配置，导致可用连接数不足。高峰流量下连接池快速耗尽，请求排队并触发 connection timeout，最终向上游表现为 order-service 5xx 激增。</p>
                <div className="causal-chain">
                  <span>v1.8.4 发布</span><ChevronRight size={15} /><span>连接池上限降低</span><ChevronRight size={15} /><span>DB 请求排队</span><ChevronRight size={15} /><span>payment 超时</span><ChevronRight size={15} /><span>order 5xx</span>
                </div>
              </section>
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
              {evidence.slice(0, showConclusion ? 4 : Math.max(1, doneCount)).map((item) => (
                <button className="evidence-item" key={item.id} title={item.summary}>
                  <span className="evidence-id">{item.id}</span>
                  <span>{item.label}</span>
                  <small>{item.source}</small>
                </button>
              ))}
            </div>
          </section>

          <section className={`side-card result-card ${showConclusion ? "ready" : ""}`}>
            <div className="side-card-title"><AlertTriangle size={16} /> 初步结论 <span>{showConclusion ? "已生成" : "生成中"}</span></div>
            <p>{showConclusion ? "发布变更与数据库连接池耗尽形成完整证据链，当前结论可信度较高。" : "正在汇总各 Agent 结果，并验证候选根因之间的因果关系。"}</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
