# Live Observability RCA 迁移规格

状态：待审查；Target 可观测基础设施已完成，RCA Runtime 接入尚未实现  
目标分支：main  
基础设施基线分支：target/production-baseline  
基础设施基线 HEAD：f2c9746c7211fbc6b4ab9bf756a03f89c40965a4

目标：将当前以 RCA100 caseId / parquet 为核心的数据集型 RCA Runtime，迁移为面向真实可观测系统的 Live RCA Runtime。Target 侧 Trace / Logs / Metrics 三条真实链路已经部署并验证可查询；本规格只指导 `main` 分支的 RCA Runtime 如何消费 Tempo、Loki、Prometheus，不指导 Target 埋点实现。Target 侧应用指标、日志 Trace Context 与 Metric Exemplar 的实现另见 `target/production-baseline` 分支的 Target Observability 规格。迁移完成后，RCA100 不再作为生产运行时数据源保留。

## 1. 已完成基础设施基线

截至 target/production-baseline@f2c9746，Target 侧已经完成：

~~~text
Target
  ↓
OTel Collector
  ├─ Trace   → Tempo
  ├─ Logs    → Loki
  └─ Metrics → Prometheus
~~~

并已实际部署、验证可以查询。

当前仓库中对应配置位于：

~~~text
deploy/observability/
├─ otel-collector.yaml
├─ tempo.yaml
├─ loki.yaml
└─ prometheus.yaml
~~~

关键历史提交：

~~~text
33667a7  功能: 增加 Pi Agent OpenTelemetry Trace
6a0e0f5  修复: 兼容 Pi 0.86.1 Trace 生命周期事件
6e53bc0  功能: 接入 Tempo Trace 存储
032bbb3  功能: 接入 Loki 日志存储
37e817e  修复: 自动创建 Collector 状态目录
4c22b85  修复: 更新 Collector 日志接收器名称
f2c9746  功能: 接入 Prometheus 指标存储
~~~

因此以下工作不再属于本规格待办：

- Target Trace 埋点。
- Collector Trace pipeline。
- Collector Logs pipeline。
- Collector Metrics pipeline。
- Tempo 部署。
- Loki 部署。
- Prometheus 部署。
- 验证后端是否能存入和查询数据。

本规格的起点是：真实 telemetry 已经存在，下一步让 RCA Runtime 正确、安全、可审计地使用这些数据。

## 2. 当前数据覆盖范围

虽然三种后端都已可查询，但三种数据目前表达的语义不同，Agent 不得把它们当成同等粒度的证据。

### 2.1 Trace

Trace 来自 Target 的 Pi Agent OpenTelemetry 埋点。

当前重点 Span 包括：

~~~text
pi.agent.run
pi.model.turn
pi.provider.request
pi.tool.call
~~~

Trace 是目前最接近应用内部执行路径的证据，可用于：

- 请求总耗时。
- Provider 调用耗时。
- Tool 调用耗时。
- Parent/Child 关系。
- Critical Path。
- Error Span。
- 未观测时间区间。

### 2.2 Logs

Collector 当前只采集 aiops-rca-target Docker 日志目录，并附加：

~~~text
service.name = aiops-rca-target
deployment.environment.name = production
~~~

Logs 可用于：

- error / exception。
- timeout。
- retry。
- provider / tool 错误文本。
- 与 Investigation 时间窗口相关的运行时事件。

当前 Pi lifecycle telemetry 日志已经通过 `logTelemetryEvent()` 从对应 Span 注入 `traceId / spanId`，因此 `pi.agent.* / pi.model.* / pi.provider.* / pi.tool.*` 这类关键生命周期日志具备精确 Trace-Log 关联基础。

普通 Hono / Pino 应用日志目前不保证天然携带 Trace Context。后续应统一从当前 active span 提取 `traceId / spanId` 注入关键日志；在某条日志真实没有 Trace Context 时，只能使用 service + absolute time window + 事件语义做相关性判断，不能伪造精确 Trace-Log Join。

### 2.3 Metrics

当前 Prometheus 数据来自 Collector：

~~~text
host_metrics
docker_stats
~~~

包括主机 / 容器层面的 CPU、load、memory、paging、disk、filesystem、network 以及 Docker 指标。

因此首版 Metrics 主要用于：

- 主机资源饱和。
- 容器资源异常。
- CPU / 内存 / 网络 / 文件系统等基础设施异常。

当前不能把 Prometheus 证据描述成完整的应用 RED 指标。

例如：

~~~text
CPU 正常
~~~

最多能削弱“CPU 饱和导致慢”的假设，不能推出：

~~~text
应用性能正常
~~~

当前 `main` Runtime 必须以“能力发现/真实存在”为准消费 Prometheus，不得假设应用级指标已经存在。

Target 后续会补充应用级 Agent / Provider / Tool / Turn 指标，并通过 Metric Exemplar 关联 Trace；这些生产侧埋点属于 `target/production-baseline` 的独立规格，不在本 Spec 中实施。

因此 MetricsProvider 必须支持两种状态：

~~~text
当前：host/docker infrastructure metrics
未来：+ application/agent metrics + exemplars
~~~

当应用级 metric 或 exemplar 尚未出现时，Provider 应明确返回 capability / no-data 结果，而不是让 Agent 猜测指标名或伪造 trace 关联。

## 2.4 RCA Runtime 消费的跨信号关联契约

本节定义 `main` 分支需要消费的 telemetry contract，不规定 Target 如何实现。

RCA Runtime 按以下优先级使用跨信号关联：

~~~text
Trace  → traceId / spanId
Log    → 若真实存在，则使用 traceId / spanId
Metric → 若真实存在，则使用 Exemplar(traceId/spanId)
~~~

关联可信度：

~~~text
1. exact traceId + spanId
2. exact traceId
3. service + absolute time window + structured semantics
4. 仅时间重叠
~~~

第 1、2 类可作为精确跨信号关联；第 3、4 类只能作为候选相关性，不能自动升级为因果证明。

Provider 层要求：

- TempoProvider 保留 traceId / spanId / parentSpanId。
- LokiProvider 保留日志里真实存在的 traceId / spanId，并允许按 traceId 精确过滤；没有则如实为空。
- PrometheusProvider 在后端返回 exemplar 时保留其中真实 traceId / spanId；没有 exemplar 时不得伪造。
- Main Agent / Expert 必须区分“精确关联”和“仅时间相关”。

Target 如何生成日志 Trace Context、应用级 Metrics 与 Exemplar，不属于本 Spec。
## 3. 当前 RCA Runtime 问题

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

但调查启动与数据访问仍然带有 RCA100 数据集约束：

~~~text
start_rca_investigation(caseId)
→ RcaService.beginAgentic(caseId)
→ get_alert_context
→ RCA100Adapter
→ task.json / parquet
~~~

Trace / Log / Metrics Expert 的工具也仍围绕 RCA100 设计。

因此用户即使已经明确给出真实目标和时间范围，例如：

> 帮我分析一下 aiops-rca-target 最近 10 分钟的 Trace，看看请求耗时主要集中在哪些 Span 上。

Main Agent 仍可能要求 t039 这类 caseId。

这已经成为下一阶段的核心架构阻塞。

## 4. 最终目标架构

生产运行时目标：

~~~text
                         Investigation
                               │
                               ▼
                          Main Agent
                               │
             ┌─────────────────┼─────────────────┐
             ▼                 ▼                 ▼
        Trace Expert        Log Expert       Metrics Expert
             │                 │                 │
             ▼                 ▼                 ▼
       TraceProvider       LogProvider      MetricsProvider
             │                 │                 │
             ▼                 ▼                 ▼
           Tempo              Loki           Prometheus
~~~

核心原则：

1. Investigation 是唯一调查核心对象。
2. caseId 不再是生产领域模型中的调查身份。
3. Main Agent 面向“需要什么证据”，不面向数据集或后端产品。
4. Expert 按 modality 取证。
5. Provider 封装具体后端协议。
6. 后端 URL、认证、网络信息完全由 Server 管理。
7. Trace / Logs / Metrics 使用同一个固定 Investigation 时间窗口。
8. 真实可观测数据是生产 Runtime 的唯一证据来源。
9. RCA100 迁移完成后退出生产 Runtime。

## 5. 非目标

本轮不做：

- 不长期维护 RCA100 + Live 双轨。
- 不部署 Grafana。
- 不接 Alertmanager。
- 不做故障注入。
- 不实现任意 TraceQL / LogQL / PromQL 自由执行工具。
- 不做大规模前端 UI 重构。
- 不重写 Main Agent / Expert / Evidence 的职责边界。
- 不把 Tempo / Loki / Prometheus 原始大响应整体发送给模型。
- 不允许 Agent 指定任意 backend URL。
- 不因为 Metrics 已接入就宣称已有应用级 RED 指标。
- 不为了跨模态关联而伪造不存在的 traceId / spanId。

## 6. Investigation 领域模型

### 6.1 移除 caseId 作为核心身份

目标：

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

  // 现有 budget / interruption / recovery 字段继续保留
}
~~~

新调查不再要求：

~~~ts
caseId: string;
~~~

### 6.2 IncidentContext

把偏 RCA100 的 AlertContext 演进为通用 IncidentContext：

~~~ts
export interface IncidentContext {
  symptom: string;

  trigger:
    | { type: "manual" }
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
    container?: string;
  };
}
~~~

首版主要使用 manual。

以后 Alertmanager / Grafana Alert / 外部 API 只负责构造 IncidentContext，不改变调查主链。

### 6.3 InvestigationScope

~~~ts
export interface InvestigationScope {
  service?: string;
  operation?: string;
  entity?: string;
  container?: string;

  timeRange: TimeRange;

  candidateEntities: string[];
}
~~~

## 7. start_rca_investigation 新协议

不再接受 caseId。

~~~ts
interface StartRcaInvestigationInput {
  symptom: string;

  target: {
    service?: string;
    operation?: string;
    entity?: string;
    container?: string;
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

- service / entity / container 至少一个。
- absolute from/to 必须合法且 from <= to。
- lookback 建议限制 1～1440 分钟。
- forceNew 保持现有会话关联语义。
- 不允许因为缺少 caseId 而拒绝真实调查。

## 8. 相对时间冻结

用户说：

> 最近 10 分钟

Main Agent 不再先调用 utc_time 并自己计算。

推荐：

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

Server 在 start_rca_investigation 真正执行时读取一次当前时间 T：

~~~text
from = T - 10min
to = T
~~~

随后绝对窗口写入 Investigation。

之后：

~~~text
Trace Expert
Log Expert
Metrics Expert
~~~

全部默认使用同一个 from/to。

不能出现：

~~~text
Trace   08:36 ~ 08:46
Logs    08:38 ~ 08:48
Metrics 08:40 ~ 08:50
~~~

## 9. RCA Runtime 到 ECS Observability 的网络边界

Target 三条链路已验证可查询，不代表部署在其他环境的 RCA Runtime 已经具备访问权限。

在 Agent 接入之前必须从 RCA Runtime 实际部署环境执行连接 smoke test：

~~~text
RCA Runtime
├─ Tempo endpoint reachable
├─ Loki endpoint reachable
└─ Prometheus endpoint reachable
~~~

Server 配置：

~~~text
TEMPO_URL
LOKI_URL
PROMETHEUS_URL
~~~

可选：

~~~text
TEMPO_TENANT_ID
LOKI_TENANT_ID
~~~

安全约束：

- Agent 看不到上述 URL。
- Agent 不能修改上述 URL。
- Credential 不进入 Tool Result。
- 不允许为了 Railway / RCA Runtime 访问而把当前无认证 Tempo、Loki、Prometheus 直接裸暴露到公网。
- 若跨 ECS / Railway 网络访问，应通过受控反向代理、VPN、私网连接、Tunnel 或等价访问边界，并增加认证或来源限制。

第一个开发 smoke test 不是 LLM 调用，而是 Server 从真实运行环境分别完成一次受控查询。

## 10. Provider 能力边界

不建立一个包含所有 optional 方法的巨大 ObservabilityProvider。

按 modality 拆分。

### 10.1 TraceProvider

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

实现：

~~~text
TraceProvider
└─ TempoTraceProvider
~~~

### 10.2 LogProvider

~~~ts
interface LogProvider {
  searchLogs(
    query: LogSearchQuery,
    signal?: AbortSignal
  ): Promise<LogSearchResult>;
}
~~~

实现：

~~~text
LogProvider
└─ LokiLogProvider
~~~

第一版不让 Agent 任意写 LogQL。

### 10.3 MetricsProvider

~~~ts
interface MetricsProvider {
  discoverMetrics(
    query: MetricDiscoveryQuery,
    signal?: AbortSignal
  ): Promise<MetricDiscoveryResult>;

  queryMetrics(
    query: MetricQuery,
    signal?: AbortSignal
  ): Promise<MetricQueryResult>;
}
~~~

实现：

~~~text
MetricsProvider
└─ PrometheusMetricsProvider
~~~

第一版不让 Agent 任意写 PromQL。

discoverMetrics 的目的不是把整个 Prometheus catalog 全塞给模型，而是避免 Agent 猜 metric name。

## 11. ObservabilityToolRegistry 目标

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
  logProvider: new LokiLogProvider(...),
  metricsProvider: new PrometheusMetricsProvider(...)
})
~~~

迁移完成后：

- Registry 不再直接依赖 RCA100Adapter。
- Adapter 不再决定生产 telemetry 查询。
- Tool 层只依赖 Provider capability。

## 12. Agent 工具集

### Trace Expert

~~~text
search_traces
get_trace
~~~

### Log Expert

~~~text
search_logs
~~~

首版 search_logs 结构化参数建议：

~~~ts
interface LogSearchQuery {
  from: string;
  to: string;

  service?: string;
  container?: string;

  level?: string;
  keywords?: string[];

  limit?: number;
}
~~~

Provider 内部生成受控 LogQL。

返回：

- matched / returned。
- compact log entries。
- recurring patterns。
- error / timeout / retry count summary。
- truncated。
- rawRef。

### Metrics Expert

~~~text
discover_metrics
query_metrics
~~~

discover_metrics 先发现当前 Prometheus 中可用、与目标相关的 metric 名称。

query_metrics 使用受控结构化参数：

~~~ts
interface MetricQuery {
  from: string;
  to: string;

  metric: string;

  container?: string;
  labelFilters?: Record<string, string>;

  stepSeconds?: number;

  baselineFrom?: string;
  baselineTo?: string;
}
~~~

Provider 内部生成 PromQL。

首版 Tool Schema 应限制 labelFilters 数量和值长度，不能让模型构造任意查询文本。

## 13. Main Agent Overview

query_rca_overview 继续承担低成本候选发现，不读取大量原始数据。

### traces

~~~text
Main Agent
→ query_rca_overview(kind="traces")
→ TraceProvider.searchTraces()
→ Tempo
~~~

### logs

~~~text
Main Agent
→ query_rca_overview(kind="logs")
→ LogProvider.searchLogs()
→ Loki
~~~

只返回错误模式 / 关键词摘要和少量样本，不替代 Log Expert 深挖。

### metrics

~~~text
Main Agent
→ query_rca_overview(kind="metrics")
→ MetricsProvider
→ Prometheus
~~~

首版 overview 应针对当前已有 host/container metrics 做资源异常摘要，不把它包装成应用级 latency/error 监控。

Main Agent 不需要知道 Tempo、Loki、Prometheus 名字。

## 14. Tempo 接入

代码建议：

~~~text
apps/pi-chat/server/rca/observability/
└─ trace/
   ├─ types.ts
   ├─ provider.ts
   ├─ tempo-client.ts
   ├─ tempo-provider.ts
   ├─ trace-analysis.ts
   └─ tempo-provider.test.ts
~~~

TempoClient 负责：

- HTTP。
- timeout。
- 有限 retry。
- AbortSignal。
- tenant header。
- API error 分类。

首版：

~~~text
GET /api/search
GET /api/v2/traces/{traceId}
~~~

Agent 不直接生成 TraceQL。

## 15. search_traces

结构化查询：

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

TempoProvider 内部编译 TraceQL。

返回 compact result：

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

有限 search result 的 P99 是样本 P99，不能描述成系统整体 P99。

## 16. NormalizedTrace 与 TraceAnalyzer

Tempo 原始 OTel JSON 不直接进入 Agent。

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

TempoProvider：

~~~text
Tempo response
→ NormalizedTrace
~~~

TraceAnalyzer：

~~~text
buildSpanTree()
calculateCriticalPath()
calculateUnobservedGaps()
summarizeTrace()
~~~

## 17. Trace Gap 边界

不能：

~~~text
parentDuration
- child1Duration
- child2Duration
~~~

因为 child spans 可能并发。

必须：

~~~text
direct child intervals
→ interval union
→ covered intervals
→ parent uncovered intervals
~~~

Gap 只说明存在未观测区间。

不能仅凭 gap 推断：

- 服务内部阻塞。
- 网络慢。
- queueing。
- runtime pause。
- missing instrumentation。

## 18. Loki 接入

代码建议：

~~~text
apps/pi-chat/server/rca/observability/
└─ log/
   ├─ types.ts
   ├─ provider.ts
   ├─ loki-client.ts
   ├─ loki-provider.ts
   └─ loki-provider.test.ts
~~~

LokiProvider 负责：

- 将 service / container / level / keywords 转换为受控 LogQL。
- 把 Loki stream response 归一化为 bounded log entries。
- 对重复错误做有限聚合。
- 保留原始 timestamp。
- 返回 rawRef。
- 不把整个时间窗口日志全部塞给模型。

LokiProvider 必须保留日志中真实存在的 `traceId / spanId` 字段，并支持按 traceId 精确过滤关键 telemetry logs。

对于没有 Trace Context 的普通应用日志，仍按 service + time window + message semantics 查询；不能为统一格式而填充虚假 traceId。

## 19. Prometheus 接入

代码建议：

~~~text
apps/pi-chat/server/rca/observability/
└─ metrics/
   ├─ types.ts
   ├─ provider.ts
   ├─ prometheus-client.ts
   ├─ prometheus-provider.ts
   └─ prometheus-provider.test.ts
~~~

PrometheusProvider 负责：

- metric discovery。
- range query。
- label 过滤。
- baseline / incident 对比。
- bounded samples / aggregation。
- API error 分类。

Metrics Provider 的领域模型应能支持两类指标，但只能查询后端实际存在的能力：

~~~text
Infrastructure
├─ host CPU
├─ host load
├─ host memory
├─ paging
├─ disk
├─ filesystem
├─ network
└─ docker stats

Application / Agent
├─ agent run count / duration
├─ model turn count / duration
├─ provider request count / duration
└─ tool call count / duration
~~~

Metrics Expert 不能自行发明不存在的 metric 名称。

当 Prometheus 后端实际返回应用级 Histogram 和 exemplar 时，Provider 应保留 exemplar 中真实存在的 `traceId / spanId`，使 Main Agent / Metrics Expert 能从异常 Metric 下钻到代表性 Trace；若后端尚未提供，则显式降级为时间窗口相关分析。

## 20. 跨模态相关性

所有 Expert 共享 Investigation 的绝对窗口和目标。

相关性层级：

~~~text
Trace:
traceId + spanId + service + operation + timestamp

Logs:
优先 traceId + spanId
否则 service + timestamp + message semantics

Application Metrics:
聚合 label + timestamp
+ Exemplar(traceId/spanId)

Infrastructure Metrics:
host/container labels + timestamp
~~~

允许 Main Agent 得出：

> 慢 Trace 与同一时间窗口内的 CPU 饱和同时出现，因此 CPU 资源异常是需要继续验证的候选。

但不能仅凭“时间重叠”写成：

> CPU 已经导致该 Trace 变慢。

跨模态时间一致性是候选关联，不自动等于因果证明。

## 21. Tool Result 与 Context 控制

三个 Provider 都必须 bounded。

Trace：

- 最大 search result。
- 最大 spans。
- 最大 attributes。
- 最大属性值长度。
- truncated。

Logs：

- 最大 log entries。
- 最大 message 长度。
- 重复模式聚合。
- truncated。

Metrics：

- 最大 series。
- 最大 points。
- downsample / aggregation。
- truncated。

Tool Result 必须真实返回给 Agent，但不能把原始后端大响应无界塞入上下文。

## 22. Evidence / Observation

现有主链继续：

~~~text
ToolCall
→ Observation
→ Evidence
→ Finding
→ Hypothesis
→ RCA
~~~

Observation / Evidence 不再依赖 caseId 作为身份。

使用 investigationId 关联。

rawRef 形式：

~~~text
tempo://search/<query-hash>
tempo://trace/<trace-id>

loki://query/<query-hash>

prometheus://query/<query-hash>
~~~

rawRef 只用于可追溯定位，不能包含 Secret。

## 23. Provider 错误语义

三种后端失败不能统一退化为“没有证据”。

建议分类：

~~~text
cancelled
timeout
unavailable
unauthorized
invalid_query
not_found
invalid_response
~~~

语义：

- no matching data != backend unavailable。
- backend unavailable != system healthy。
- cancelled != failed。
- invalid query 应暴露给 Runtime 诊断，但不泄露敏感 URL。

Expert 在后端不可用时可 blocked / inconclusive，不能生成虚假无异常结论。

## 24. Retry / Cancel

可恢复错误最多重试 1～2 次：

- connection reset。
- timeout。
- 502。
- 503。
- 504。

不重试：

- 400。
- 401。
- 403。
- 参数校验失败。
- 编译后的查询非法。

现有 Investigation AbortSignal 必须一直传到：

~~~text
Tempo fetch
Loki fetch
Prometheus fetch
~~~

Pause / Cancel 后不能继续后台查询。

## 25. RCA100 Runtime 移除

迁移完成后，从生产 Runtime 删除或停止引用：

~~~text
RCA100Adapter
rcaCasesDir
task.json 启动逻辑
RCA100 parquet Trace 查询
RCA100 parquet Logs 查询
RCA100 parquet Metrics 查询
RCA100 parquet Events 查询
RCA100 topology 文件查询
caseId 校验
t039 运行时 Tool / Prompt 语义
get_trace_fields
get_log_fields
get_metric_catalog（RCA100 版本）
query_traces（RCA100 版本）
query_logs（RCA100 版本）
query_metrics（RCA100 版本）
query_events（RCA100 版本）
query_alerts（RCA100 版本）
~~~

不能机械删除文件。

其中通用算法应迁移保留，例如：

- percentile。
- interval union。
- critical path。
- evidence compact。
- causal reasoning。
- budget / recovery。
- ToolCall / Observation / Evidence 审计。

## 26. 历史 Investigation

不长期保留旧 RCA100 Runtime，只区分运行兼容与历史可读。

建议：

- 新 Investigation 不再写 caseId。
- 新 Runtime 不执行 RCA100 查询。
- 旧 Investigation 可以只读展示。
- Resume 旧 RCA100 Investigation 时明确 legacy / unsupported。
- 不为了 Resume t039 长期保留完整 RCA100 Adapter。

## 27. 更新后的实施顺序

### 阶段 0：RCA Runtime 网络连通性

从 main / Production Runtime 实际运行环境验证：

~~~text
Tempo
Loki
Prometheus
~~~

三个 endpoint 都能通过受控网络访问。

同时确认不能裸暴露无认证后端。

通过标准：

- Server 侧 health/smoke query 成功。
- Timeout / connection failure 行为清晰。
- Agent 尚不参与。

### 阶段 1：Investigation 去 caseId 化

- IncidentContext。
- 新 start_rca_investigation。
- Server lookback 冻结。
- Main Agent Prompt 去掉 RCA100 前提。
- 新 Observation / Evidence 关联 investigationId。

通过标准：

> “分析 aiops-rca-target 最近 10 分钟”能直接创建真实调查。

### 阶段 2：三种 Provider 接入

并行或按顺序完成：

~~~text
TraceProvider   → Tempo
LogProvider     → Loki
MetricsProvider → Prometheus
~~~

要求先做 Client / Provider 单测和真实 smoke test，再接 Agent Tool。

### 阶段 3：Expert Tool 切换

Trace Expert：

~~~text
search_traces
get_trace
~~~

Log Expert：

~~~text
search_logs
~~~

Metrics Expert：

~~~text
discover_metrics
query_metrics
~~~

原 RCA100 Tool 不再进入新 Expert Session。

### 阶段 4：Main Agent Overview 切换

query_rca_overview 的 traces / logs / metrics 全部路由真实 Provider。

Main Agent 可以基于同一 Investigation Window 做低成本三模态 coverage，再按 hypothesis dispatch 专家。

### 阶段 5：删除 RCA100 Runtime

- 删除生产依赖。
- 删除旧配置。
- 删除仅用于 RCA100 的 parquet runtime。
- 更新测试。
- 更新 Prompt。
- 更新 README / env。
- 历史调查只读。

### 阶段 6：真实多模态闭环验收

~~~text
Target
  ↓
Collector
  ├─ Tempo
  ├─ Loki
  └─ Prometheus
        ↓
RCA Runtime
        ↓
Main Agent
        ↓
Trace / Log / Metrics Experts
        ↓
Evidence
        ↓
RCA
~~~

通过后再开始故障注入：

~~~text
Provider Slow
Tool Timeout
Application Error
Resource Pressure
~~~

## 28. 验收场景

### 场景 A：Trace 分析

用户：

> 帮我分析一下 aiops-rca-target 最近 10 分钟的 Trace，看看请求耗时主要集中在哪些 Span 上。

要求：

- 不询问 caseId。
- 自动冻结时间窗口。
- 查询真实 Tempo。
- 搜索 Trace 后按需 get_trace。
- 返回 Critical Path / Error Span / Gap。
- 明确已观测与未观测边界。

### 场景 B：Logs 调查

用户：

> 看一下 aiops-rca-target 最近 10 分钟有没有 timeout、error 或 retry。

要求：

- 使用同样的 Investigation window。
- 查询真实 Loki。
- 返回 bounded 日志证据和重复模式。
- 没有匹配日志时明确“查询成功但无匹配”，而不是“Loki 不可用”。

### 场景 C：Metrics 调查

用户：

> 看一下这段时间机器或容器资源有没有异常。

要求：

- 查询真实 Prometheus。
- 使用当前真实 host/docker metrics。
- 能判断 CPU / memory / load / network 等资源异常候选。
- 不把基础设施指标误说成应用 latency/error 指标。

### 场景 D：多模态 RCA

用户：

> aiops-rca-target 最近明显变慢，帮我定位原因。

理想流程：

~~~text
Main Agent
→ 创建 Investigation
→ Trace overview
→ Logs overview
→ Metrics overview
→ 建立竞争假设
→ dispatch 有信息增益的 Expert
→ Evidence 支持 / 反证
→ RCA
~~~

不能变成机械地把三个后端全部全量扫描一次。

## 29. 当前已知限制

1. Pi lifecycle telemetry logs 当前已有 traceId / spanId；普通应用日志仍不保证有 Trace Context。
2. Prometheus 当前已具备 host/docker metrics；应用级 Agent / Provider / Tool Metrics 与 Exemplar 属于 Target 分支独立改造项，main Runtime 不应假设其已经存在。
3. Topology 尚无真实 Provider；不能继续偷偷使用 RCA100 topology。
4. 外部 Alert ingress 尚未接入，首版仍以 manual Investigation 为主。
5. Grafana 不是本轮 Agent 调查的依赖。

这些限制必须在 Agent Prompt / Tool Description 中表达，避免模型越界推断。

## 30. 审查重点

进入实现前确认：

1. Target Observability 三条 pipeline 视为已完成前置条件，不再重复建设。
2. 本轮 RCA Runtime 同时面向 Tempo / Loki / Prometheus，而不是只先接 Tempo。
3. 生产 Runtime 最终完全移除 RCA100。
4. Investigation 不再以 caseId 为核心字段。
5. AlertContext 演进为 IncidentContext。
6. lookback 由 Server 一次性冻结。
7. Trace / Log / Metrics 各自使用独立 Provider capability。
8. LLM 不直接自由编写 TraceQL / LogQL / PromQL。
9. main Runtime 只消费后端真实存在的 metric / log correlation 能力，不负责 Target 埋点实现。
10. LokiProvider / PrometheusProvider 必须保留真实 traceId/spanId 或 exemplar，并在缺失时诚实降级。
11. Main Agent 必须区分精确 trace 关联与 service/time 相关性。
12. RCA Runtime 与 ECS observability backend 先解决受控网络访问，再接 Agent。
13. 旧 RCA100 Investigation 只读，不保留完整旧 Runtime 用于 Resume。
