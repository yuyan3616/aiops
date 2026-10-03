# Live Observability RCA 迁移规格

状态：待审查（仅方案，尚未实现）  
目标分支：main  
目标：将当前以 RCA100 caseId / parquet 为核心的数据集型 RCA Runtime，迁移为面向真实可观测系统的 Live RCA Runtime。首个在线数据源为 Tempo，后续按同一边界接入 Loki、Prometheus 等真实后端。迁移完成后，RCA100 不再作为生产运行时数据源保留。

## 1. 背景

当前 RCA 主链已经形成：

~~~text
Conversation
→ Main Agent
→ Investigation
→ Hypothesis
→ Expert Agent
→ Tool / Evidence
→ RCA Report
~~~

但调查启动与数据访问仍然带有明显的 RCA100 数据集约束：

~~~text
start_rca_investigation(caseId)
→ RcaService.beginAgentic(caseId)
→ get_alert_context
→ RCA100Adapter
→ task.json / parquet
~~~

Trace Expert 也固定依赖：

~~~text
get_trace_fields
get_service_dependencies
query_traces
~~~

因此用户即使已经明确提供真实目标和时间范围，例如：

> 帮我分析一下 aiops-rca-target 最近 10 分钟的 Trace，看看请求耗时主要集中在哪些 Span 上。

Main Agent 仍会要求 t039 这类 caseId。

这与后续真实 AIOps 产品方向不一致。未来系统会直接查询：

~~~text
Trace   → Tempo
Logs    → Loki
Metrics → Prometheus
Events  → 后续真实事件源
~~~

因此本规格不再设计 Dataset / Live 双轨长期共存，而是把 Live Observability 作为唯一生产主线，并在迁移完成后删除 RCA100 Runtime 路径。

## 2. 最终目标架构

最终运行时：

~~~text
                    Investigation
                          │
                          ▼
                     Main Agent
                          │
           ┌──────────────┼──────────────┐
           ▼              ▼              ▼
      Trace Expert     Log Expert    Metrics Expert
           │              │              │
           ▼              ▼              ▼
     TraceProvider    LogProvider   MetricsProvider
           │              │              │
           ▼              ▼              ▼
         Tempo           Loki        Prometheus
~~~

核心原则：

1. Investigation 是唯一调查核心对象。
2. caseId 不再是生产领域模型中的必填身份。
3. Main Agent 面向“需要什么证据”，不面向“哪个数据集”。
4. Expert 面向 Trace / Log / Metrics / Event 能力，不面向后端品牌。
5. 后端连接信息完全由 Server 管理。
6. 真实可观测数据是生产 Runtime 的唯一证据来源。
7. RCA100 只作为迁移前历史实现存在；迁移完成后从生产 Runtime 移除。

## 3. 非目标

本轮不做：

- 不同时长期维护 RCA100 + Tempo 双轨查询。
- 不保留 Dataset / Live 两套 Prompt 与 Tool Runtime。
- 不接 Grafana。
- 不接 Loki、Prometheus、Alertmanager。
- 不实现任意 TraceQL Agent Tool。
- 不做大规模 UI 重构。
- 不做故障注入。
- 不重写 Main Agent / Expert / Evidence 的职责边界。
- 不把 Tempo 原始 OTel JSON 整体发送给模型。
- 不把 Tempo URL、凭据或 tenant secret 暴露给 Agent。

## 4. Investigation 领域模型调整

### 4.1 移除 caseId 作为核心身份

目标 Investigation：

~~~ts
export interface Investigation {
  id: string;

  status: InvestigationStatus;
  symptom: string;

  context: IncidentContext;
  scope: InvestigationScope;

  hypotheses: Hypothesis[];
  observations?: Observation[];
  evidence: Evidence[];
  expertTasks: ExpertTask[];
  toolCalls: ToolCallRecord[];

  rounds: number;
  startedAt: string;
  completedAt?: string;

  // 其余现有预算、恢复、事件字段保持
}
~~~

不再要求：

~~~ts
caseId: string;
~~~

### 4.2 IncidentContext

当前 AlertContext 偏向“预制数据集告警”。改为更通用的 IncidentContext：

~~~ts
export interface IncidentContext {
  symptom: string;

  trigger:
    | {
        type: "manual";
      }
    | {
        type: "alert";
        eventId?: string;
        title?: string;
        source?: string;
      }
    | {
        type: "api";
        source?: string;
      };

  window: TimeRange;

  target: {
    service?: string;
    operation?: string;
    entity?: string;
    environment?: string;
    region?: string;
  };
}
~~~

首版主要支持 manual。

以后 Alertmanager / Grafana Alert / 外部 API 只负责构造 IncidentContext，不改变后续调查主链。

### 4.3 InvestigationScope

保留现有 scope 概念，但字段与真实环境对齐：

~~~ts
export interface InvestigationScope {
  service?: string;
  operation?: string;
  entity?: string;

  timeRange: TimeRange;

  candidateEntities: string[];
}
~~~

## 5. start_rca_investigation 新协议

不再接受 caseId。

建议：

~~~ts
interface StartRcaInvestigationInput {
  symptom: string;

  target: {
    service?: string;
    operation?: string;
    entity?: string;
    environment?: string;
  };

  window:
    | {
        kind: "absolute";
        from: string;
        to: string;
      }
    | {
        kind: "lookback";
        minutes: number;
      };

  forceNew?: boolean;
}
~~~

约束：

- service / entity 至少一个。
- absolute from/to 必须合法且 from <= to。
- lookback 建议限制 1～1440 分钟。
- forceNew 保持现有会话关联语义。
- 不允许再因为缺少 caseId 而拒绝调查。

## 6. 相对时间冻结

“最近 10 分钟”不再由 Main Agent 自己调用 utc_time 并计算。

推荐调用：

~~~json
{
  "symptom": "aiops-rca-target 请求耗时分析",
  "target": {
    "service": "aiops-rca-target"
  },
  "window": {
    "kind": "lookback",
    "minutes": 10
  }
}
~~~

Server 在工具真正执行时读取当前时间 T：

~~~text
from = T - 10min
to = T
~~~

随后将绝对窗口持久化到 Investigation。

之后所有 Trace / Log / Metrics / Event 查询都使用同一绝对窗口。

禁止：

~~~text
Trace Agent   08:36 ~ 08:46
Log Agent     08:38 ~ 08:48
Metrics Agent 08:40 ~ 08:50
~~~

这种多模态窗口漂移。

## 7. Main Agent 行为调整

Prompt 与工具说明从“case 驱动”改为“Investigation 驱动”。

规则：

1. telemetry 调查仍必须绑定 Investigation。
2. 当前会话已有与用户目标一致的活动 Investigation 时优先复用。
3. 用户提供真实 service/entity 与时间范围后即可创建调查。
4. 不再询问 RCA100 caseId。
5. 用户无需知道 Tempo / Loki / Prometheus。
6. 只有真正缺少目标或时间范围时才追问。

例如：

> 帮我分析一下 aiops-rca-target 最近 10 分钟的 Trace，看看请求耗时主要集中在哪些 Span 上。

应直接：

~~~text
解析 service=aiops-rca-target
解析 lookback=10min
→ start_rca_investigation
→ Server 固定绝对时间窗口
→ Trace overview
→ 必要时 dispatch Trace Expert
~~~

## 8. Provider 能力边界

不建立包含大量 optional 方法的通用 ObservabilityProvider。

按模态拆分：

~~~ts
interface TraceProvider {
  searchTraces(
    query: TraceSearchQuery,
    signal?: AbortSignal
  ): Promise<TraceSearchResult>;

  getTrace(
    traceId: string,
    options?: GetTraceOptions,
    signal?: AbortSignal
  ): Promise<NormalizedTrace>;
}
~~~

首版：

~~~text
TraceProvider
└─ TempoTraceProvider
~~~

后续：

~~~text
LogProvider
└─ LokiLogProvider

MetricsProvider
└─ PrometheusMetricsProvider
~~~

Runtime 只知道能力接口，不知道具体后端实现。

## 9. ObservabilityToolRegistry 重构目标

现状：

~~~ts
new ObservabilityToolRegistry(
  new RCA100Adapter(...)
)
~~~

目标：

~~~ts
new ObservabilityToolRegistry({
  traceProvider: new TempoTraceProvider(...),
  // 后续：
  // logProvider
  // metricsProvider
})
~~~

本轮实现完成后，ObservabilityToolRegistry 不再直接依赖 RCA100Adapter。

## 10. Trace Expert 最终工具集

最终 Trace Expert 只保留真实在线工具：

~~~text
search_traces
get_trace
~~~

移除 RCA100 Trace Runtime 工具：

~~~text
get_trace_fields
query_traces
~~~

是否保留 get_service_dependencies 取决于后续是否存在真实 topology provider；本轮不能继续通过 RCA100 topology 文件实现。

若真实 topology 尚未接入，则 Trace Expert 暂时不提供该能力，不允许偷偷回退到数据集文件。

## 11. Tempo 模块

建议新增：

~~~text
apps/pi-chat/server/rca/observability/trace/
├─ types.ts
├─ provider.ts
├─ tempo-client.ts
├─ tempo-provider.ts
├─ trace-analysis.ts
└─ tempo-provider.test.ts
~~~

### TempoClient

负责：

- Base URL。
- HTTP request。
- timeout。
- 有限 retry。
- AbortSignal。
- tenant header。
- API 错误归类。

首版需要：

~~~text
GET /api/search
GET /api/v2/traces/{traceId}
~~~

不依赖 Grafana。

配置：

~~~text
TEMPO_URL
TEMPO_REQUEST_TIMEOUT_MS=10000
TEMPO_MAX_RESULTS=100
TEMPO_TENANT_ID    # 可选
~~~

## 12. Retry / Cancel 边界

可恢复网络错误最多重试 1～2 次：

- connection reset。
- timeout。
- 502。
- 503。
- 504。

不重试：

- 400。
- 401。
- 403。
- 非法查询。
- 参数校验失败。

Pause / Cancel 必须通过现有 AbortSignal 继续传到 Tempo fetch。

不能再次出现：

~~~text
Agent 已停止
但工具 HTTP 请求仍继续运行
~~~

## 13. search_traces

第一版不允许 Agent 任意写 TraceQL。

LLM-facing 参数使用结构化查询：

~~~ts
interface TraceSearchQuery {
  from: string;
  to: string;

  service?: string;
  operation?: string;
  status?: "ok" | "error" | "unset";
  minDurationMs?: number;

  limit?: number;

  baselineFrom?: string;
  baselineTo?: string;
}
~~~

TempoTraceProvider 内部生成 TraceQL。

返回 compact result，例如：

~~~json
{
  "sampleCount": 86,
  "sampleStats": {
    "minMs": 812,
    "p50Ms": 1320,
    "p90Ms": 2740,
    "p95Ms": 3310,
    "p99Ms": 4910,
    "maxMs": 5260
  },
  "traces": [
    {
      "traceId": "abc",
      "rootService": "aiops-rca-target",
      "rootSpan": "pi.agent.run",
      "durationMs": 5260,
      "status": "ok",
      "startTime": "..."
    }
  ],
  "truncated": true
}
~~~

必须叫 sampleStats。

Tempo Search 返回有限条目时，其 P99 是样本 P99，不能被 Agent 描述成整个系统全量 P99。

## 14. Baseline 对比

search_traces 支持可选 baselineFrom / baselineTo。

用于回答：

~~~text
故障前：
provider.request ≈ 1.8s

故障窗口：
provider.request ≈ 4.8s
~~~

首版允许用搜索样本做 baseline comparison，但必须明确样本性质。

后续如需要真实全量 percentile，再评估 TraceQL Metrics。

## 15. NormalizedTrace

Tempo 原始 OTel 结构不直接交给 Agent。

内部统一：

~~~ts
interface NormalizedSpan {
  spanId: string;
  parentSpanId?: string;

  name: string;
  service: string;

  startTime: string;
  endTime: string;
  durationMs: number;

  status: "ok" | "error" | "unset";

  attributes?: Record<string, string | number | boolean>;
}

interface NormalizedTrace {
  traceId: string;

  durationMs: number;
  spanCount: number;
  errorSpanCount: number;

  spans: NormalizedSpan[];

  truncated: boolean;
}
~~~

TempoProvider 只负责：

~~~text
Tempo response
→ NormalizedTrace
~~~

不负责 RCA 结论。

## 16. TraceAnalyzer

trace-analysis.ts 负责：

~~~text
buildSpanTree()
calculateCriticalPath()
calculateUnobservedGaps()
summarizeTrace()
~~~

这样 Trace 分析逻辑与 Tempo 解耦。

未来即使替换 tracing backend，也不重写 RCA reasoning 层。

## 17. Gap 计算

不能：

~~~text
parentDuration
- child1Duration
- child2Duration
~~~

因为 children 可能并发。

必须：

~~~text
direct child intervals
→ interval union
→ covered intervals
→ parent uncovered intervals
~~~

并区分：

~~~text
before children
between children
after children
~~~

Gap 只表示“未观测时间”。

不能仅凭 gap 直接推断：

- 服务内部阻塞。
- 网络慢。
- queueing。
- runtime pause。
- missing instrumentation。

继续保留当前 Trace Profile 中已有的因果边界。

## 18. Span Context 控制

不能把所有 OTel attributes 无界交给模型。

首版白名单优先保留：

~~~text
service.name
span.name
status
duration
gen_ai.*
http.*
rpc.*
db.*
error.*
tool.*
~~~

对当前 Target 重点识别：

~~~text
pi.agent.run
pi.model.turn
pi.provider.request
pi.tool.call
~~~

必须有：

- 最大 spans。
- 最大 attributes。
- attribute value 最大长度。
- 最大树深度。
- truncated 标记。

## 19. Evidence / Observation

现有链路继续保留：

~~~text
ToolCall
→ Observation
→ Evidence
→ Finding
→ Hypothesis
→ RCA
~~~

Observation / Evidence 不再依赖 caseId 作为身份。

推荐改为 investigationId 关联。

rawRef：

~~~text
tempo://search/<query-hash>
tempo://trace/<trace-id>
~~~

Investigation 只保存：

- traceId。
- query。
- compact result。
- rawRef。
- evidence facts。

不保存完整 OTel JSON。

## 20. Main Agent Overview

query_rca_overview(kind="traces") 保留低成本候选发现语义，但后端只走真实 Provider：

~~~text
Main Agent
→ query_rca_overview(traces)
→ TraceProvider.searchTraces()
→ Tempo
~~~

Main Agent 不需要知道 Tempo 名字。

需要单条 Trace 的：

- Span Tree。
- Critical Path。
- Gap。
- Error Span。

再 dispatch Trace Expert。

Trace Expert：

~~~text
search_traces
→ 选择 exemplar
→ get_trace
→ reasoning
→ submit_finding
~~~

## 21. RCA100 Runtime 移除范围

迁移完成后，应从生产 Runtime 删除或停止引用：

~~~text
RCA100Adapter
rcaCasesDir
task.json 启动逻辑
parquet Trace 查询
parquet Metrics 查询
parquet Logs 查询
parquet Events 查询
RCA100 topology 文件查询
caseId 校验
t039 运行时 Prompt / Tool 语义
get_trace_fields
get_log_fields
get_metric_catalog（RCA100 版本）
query_traces（RCA100 版本）
query_logs（RCA100 版本）
query_metrics（RCA100 版本）
query_events（RCA100 版本）
query_alerts（RCA100 版本）
~~~

具体删除必须以真实调用关系为准，不能机械删文件。

如果某些通用算法仍有价值，应迁移到与 RCA100 无关的位置后复用，例如：

- percentile 计算。
- critical path。
- interval union。
- evidence compact。
- causal reasoning。

## 22. 历史调查与兼容策略

这里不长期维护旧 Runtime，但要区分“代码运行兼容”和“历史文件可读”。

建议：

- 新调查不再写 caseId。
- 新 Runtime 不再执行 RCA100 查询。
- 旧 Investigation 文件可以继续只读展示。
- Resume 旧 RCA100 Investigation 时明确标记为 legacy / unsupported，不再继续执行旧数据集取证。
- 不为历史调查保留整套 RCA100 Adapter 运行能力。

这样避免为了“能继续跑旧 t039”长期保留两套 observability runtime。

## 23. 迁移实施顺序

### 阶段一：去 caseId 化

- 新建 IncidentContext。
- start_rca_investigation 改为真实目标 + 时间窗口。
- Server 负责 lookback 冻结。
- 新 Investigation 不再依赖 caseId。
- Main Agent Prompt 移除 t039 / dataset 前提。

预期：

> “分析 aiops-rca-target 最近 10 分钟 Trace”可以直接创建调查。

### 阶段二：Tempo 接入

- TraceProvider。
- TempoClient。
- TempoTraceProvider。
- NormalizedTrace。
- TraceAnalyzer。
- search_traces。
- get_trace。

预期：

> Trace Expert 可以查询真实 Tempo，并输出结构化证据。

### 阶段三：Main Agent / Trace Expert 切换

- query_rca_overview(traces) 切到 TraceProvider。
- Trace Expert 只暴露 search_traces / get_trace。
- Evidence 链去除 caseId 依赖。
- AlertContext 迁移为 IncidentContext。

预期：

> 生产 Trace 调查完全不经过 RCA100。

### 阶段四：删除 RCA100 Runtime

- 删除 RCA100Adapter 生产依赖。
- 删除 rcaCasesDir 配置。
- 删除 Dataset Tool。
- 删除 parquet runtime 依赖中仅供 RCA100 的部分。
- 更新测试。
- 更新 Prompt。
- 更新 README / env。

预期：

> 生产运行时只存在真实 observability provider。

### 阶段五：真实闭环验证

~~~text
ECS Target
→ OTel Collector
→ Tempo
→ Investigation
→ Main Agent
→ Trace Expert
→ Evidence
→ RCA
~~~

闭环稳定后，再开始：

~~~text
Provider Slow
Tool Timeout
Error
~~~

故障注入实验。

## 24. 验收标准

### 用户体验

输入：

> 帮我分析一下 aiops-rca-target 最近 10 分钟的 Trace，看看请求耗时主要集中在哪些 Span 上。

必须：

- 不询问 caseId。
- 自动建立 Investigation。
- Server 固定绝对时间窗口。
- 查询真实 Tempo。
- 必要时自动下钻 traceId。
- 输出 Span / Critical Path / Gap 证据。

### Trace

至少能解释：

~~~text
pi.agent.run
├─ pi.model.turn
│  └─ pi.provider.request
└─ pi.tool.call
~~~

并报告：

- 总耗时。
- 主要已观测耗时。
- error spans。
- critical path。
- unobserved gap。
- 当前证据不能证明的机制。

### 生命周期

- Pause / Cancel 能终止 Tempo 请求。
- Tempo 超时不挂死 Expert。
- Tempo 不可用不能解释成“无异常”。
- 页面刷新 / Server 重启后新 Investigation 可恢复。
- 不存在运行时回退 RCA100 的隐藏路径。

### 架构

最终生产代码中：

~~~text
caseId
RCA100Adapter
RCA100 parquet observability
~~~

不再是调查主链依赖。

## 25. 后续 Loki / Prometheus

完成本规格后，后续不再修改 Investigation 身份模型。

只增加：

~~~text
LogProvider
→ LokiLogProvider

MetricsProvider
→ PrometheusMetricsProvider
~~~

Main Agent / Evidence / Investigation 主链不需要再次为数据源类型分叉。

## 26. 审查重点

进入开发前确认：

1. 是否接受生产 Runtime 最终完全移除 RCA100。
2. 是否接受 Investigation 不再拥有 caseId 核心字段。
3. 是否接受 AlertContext 演进为 IncidentContext。
4. 是否接受 lookback 由 Server 冻结。
5. 是否接受 Trace Expert 最终只保留 search_traces / get_trace。
6. 是否接受 TempoProvider 内部生成 TraceQL。
7. 是否接受旧 RCA100 Investigation 只读，不继续支持 Resume 取证。
8. 是否接受迁移成功后删除 RCA100 Tool / Adapter / parquet Runtime。
9. 是否接受后续 Loki / Prometheus 按 Provider 能力扩展，而不再引入 Dataset 分支。
