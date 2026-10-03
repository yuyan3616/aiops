# Live Investigation 与 Tempo 接入规格

状态：待审查（仅方案，尚未实现）
目标分支：main

## 1. 目标

当前 RCA 主链已经是 Conversation → Main Agent → Investigation → Expert → Evidence → RCA，但调查启动仍被 RCA100 caseId 绑定。

本规格把 Investigation 与 Dataset Case 解耦，使同一套 RCA 主链同时支持：

- Dataset：RCA100，例如 t039；
- Live：真实服务，例如 aiops-rca-target，首版 Trace 后端为 Tempo。

核心原则：

- Investigation 是核心对象，caseId 只是 RCA100 数据源参数；
- Live 调查不能因为没有 caseId 而拒绝；
- Main Agent 面向 Trace / Log / Metrics / Event 能力，不面向具体后端产品；
- RCA100 现有 query_traces 与评测链保持兼容。

## 2. InvestigationSource

新增：

~~~ts
type InvestigationSource =
  | {
      kind: "dataset";
      dataset: "rca100";
      caseId: string;
    }
  | {
      kind: "live";
      environment?: string;
    };
~~~

新建 Investigation 保存 source。

现有 caseId 降级为兼容字段，仅 Dataset 依赖。读取历史记录时，如果 source 缺失但 caseId 存在，运行时视为 RCA100 Dataset。

本次不引入 schemaVersion=3，避免现有 V2 预算、恢复和事件日志分支产生无关回归。

## 3. 启动协议

start_rca_investigation 改为 Dataset / Live 双入口。

Dataset：

~~~json
{
  "source": {
    "kind": "dataset",
    "dataset": "rca100",
    "caseId": "t039"
  }
}
~~~

Live：

~~~json
{
  "source": {
    "kind": "live"
  },
  "symptom": "aiops-rca-target 请求耗时分析",
  "scope": {
    "service": "aiops-rca-target"
  },
  "window": {
    "kind": "lookback",
    "minutes": 10
  }
}
~~~

约束：

- Dataset caseId 继续校验 tNNN；
- Live 至少提供 service 或 entity；
- Live 不要求 caseId；
- 支持 absolute window 和 lookback window；
- forceNew 保持现有语义。

## 4. 相对时间冻结

“最近 10 分钟”不再要求 Main Agent 自己先获取 UTC 时间再计算。

Server 在 start_rca_investigation 执行时读取一次当前时间 T：

~~~text
from = T - 10min
to = T
~~~

随后把绝对时间写入 Investigation。

Trace / Log / Metrics / Event 后续都使用同一固定窗口，不能各自在不同时间重新解释“最近 10 分钟”。

## 5. Main Agent 行为

Main Agent 从“case 驱动”改成“Investigation 驱动”。

规则：

1. telemetry 取证仍必须绑定 Investigation；
2. 有同目标活动调查时优先复用；
3. 用户明确给出 t039 时建立 Dataset Investigation；
4. 用户给出真实 service/entity 和时间范围时建立 Live Investigation；
5. Live 调查不得索要 caseId；
6. 只有真正缺少目标或时间信息时才追问。

例如用户说：

> 帮我分析一下 aiops-rca-target 最近 10 分钟的 Trace，看看请求耗时主要集中在哪些 Span 上。

应直接建立 Live Investigation，而不是要求 t039。

## 6. 数据源抽象

不建立一个包含大量可选方法的通用 ObservabilityProvider。

首版只定义：

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

以后分别增加 LokiLogProvider、PrometheusMetricsProvider。

Agent 不自行选择底层数据源。Service / Runtime 根据 InvestigationSource 路由。

## 7. ObservabilityToolRegistry

现状：

~~~ts
new ObservabilityToolRegistry(
  new RCA100Adapter(...)
)
~~~

目标为增量扩展：

~~~ts
new ObservabilityToolRegistry({
  rca100: new RCA100Adapter(...),
  traceProvider: new TempoTraceProvider(...)
})
~~~

RCA100Adapter 和 query_traces 保留，不为 Tempo 重写现有 adapter。

## 8. Trace Expert 工具

Dataset：

~~~text
get_trace_fields
get_service_dependencies
query_traces
~~~

Live：

~~~text
search_traces
get_trace
~~~

同一 Expert Session 不同时暴露两套 Trace 查询工具。

Trace Profile 根据 InvestigationSource 动态选择工具集。

## 9. Tempo 模块

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

TempoClient 负责请求、超时、有限重试、AbortSignal 和 API 错误转换。

首版只需要 Tempo Search 和按 traceId 获取 Trace 两类能力，不依赖 Grafana。

## 10. search_traces

第一版 Agent 不自由编写任意 TraceQL。

使用结构化参数：

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

TempoProvider 内部生成查询。

返回摘要而不是原始响应，并明确 sampleStats 是有限搜索样本统计，不代表全量系统分位数。

## 11. get_trace 与 NormalizedTrace

Tempo 原始 Trace 先归一化：

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

trace-analysis.ts 负责 Span Tree、Critical Path、Gap 和 Summary。

Gap 必须基于 child interval union 计算，不能简单用 parentDuration 减所有 child duration，因为 child 可能并发。

Gap 只表示未观测区间，不能直接推断内部阻塞、网络等待或其他机制。

## 12. Evidence

继续复用现有链路：

~~~text
ToolCall
→ Observation
→ Evidence
→ Finding
→ Hypothesis / Conclusion
~~~

Live Trace modality 仍为 trace。

Investigation 只保存 traceId、query、compact summary、rawRef 和 evidence facts，不保存完整 OTel Trace。

## 13. Main Agent Overview

query_rca_overview(kind="traces") 保持低成本发现语义。

Dataset 路由到现有 RCA100 query_traces。

Live 路由到 Tempo search_traces。

需要单条 Trace 的 Span Tree、Critical Path 和 Gap 时，再 dispatch Trace Expert，并由 Expert 使用 get_trace。

## 14. 兼容性

必须保持：

- t039 等 RCA100 调查正常；
- RCA100 AlertContext 继续来自 task.json；
- query_traces 保持当前 parquet 实现；
- Budget、Pause、Resume、Cancel、Recovery、SSE、Event Log 语义不变；
- 历史 source 缺失 Investigation 可以恢复；
- 不删除现有稳定 adapter 逻辑。

## 15. 实施顺序

### 阶段一：Investigation 与 caseId 解耦

新增 InvestigationSource、双入口 start 工具和 Server lookback 时间冻结。

预期：真实 service + 时间范围足以创建 Live Investigation。

### 阶段二：Tempo Trace Provider

实现 TraceProvider、TempoTraceProvider、NormalizedTrace、search_traces、get_trace，以及取消、超时和结果限制。

预期：能够查询 aiops-rca-target 的真实 Tempo Trace。

### 阶段三：Source-aware Trace Expert

Dataset 使用旧工具；Live 使用新工具；复用现有 Evidence 链。

预期：Trace Expert 完成“搜索 → 下钻 → Finding”。

### 阶段四：真实闭环验证

~~~text
ECS Target
→ OTel Collector
→ Tempo
→ Live Investigation
→ Trace Expert
→ RCA Evidence
~~~

故障注入在该闭环稳定后另做。

## 16. 验收

Live 输入：

> 帮我分析一下 aiops-rca-target 最近 10 分钟的 Trace。

要求：

- 不询问 caseId；
- 创建 source.kind=live；
- Server 固定绝对时间窗口；
- 刷新或重启后 source 和窗口可恢复；
- 能 search_traces 并 get_trace；
- 能输出主要已观测耗时、Critical Path、Error Span、未观测 Gap；
- 后端查询失败不能被解释成“系统没有异常”；
- Pause / Cancel 后正在执行的查询被中止。

Dataset 输入：

> 调查 t039。

要求现有 RCA100 主链无非预期回归。

## 17. 后续扩展

完成后，Loki / Prometheus 只新增能力，不再修改 Investigation 身份模型：

~~~text
Live Investigation
├─ TraceProvider → Tempo
├─ LogProvider → Loki
└─ MetricsProvider → Prometheus
~~~

未来 Alertmanager 通过现有 /api/rca 边界创建 Live Investigation，Main Agent / Expert / Evidence 主链保持不变。

## 18. 审查重点

1. InvestigationSource 是否作为 Dataset / Live 统一入口；
2. caseId 是否降级为 RCA100 专属兼容字段；
3. lookback 是否由 Server 启动时冻结；
4. Live Trace 首版是否只提供 search_traces / get_trace；
5. 是否由 TempoProvider 内部生成 TraceQL；
6. Dataset / Live Trace Expert 是否使用不同工具集；
7. 本轮是否只接 Tempo；
8. source 是否作为现有 V2 的兼容扩展。
