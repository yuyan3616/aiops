# Target Observability 三信号关联与应用指标规格 v3

状态：**Target 侧实现完成并通过仓库 CI；生产部署验收未执行；Exemplar 明确不可用。**  
目标分支：`target/production-baseline`。  
实施起点：`70cb7f744881073991f13935646f5e9c076df7d1`。  
公共合同：`docs/telemetry-contract-v1.md`，本轮**不改变其既有语义**。

## 1. 本轮结论

Target 侧已经完成以下能力：

- Agent / Model Turn / Provider Generation / Tool 的生命周期 Span。
- 生命周期日志，统一 `success / error / cancelled / incomplete` outcome。
- Counter / Histogram 应用指标，显式秒级 bucket。
- Metrics 通过 OTLP HTTP 发送到 Collector；Collector metrics pipeline 已加入 `otlp` receiver。
- Metric record/add 显式传入对应 Span Context，不依赖 ambient `context.active()`。
- provider/model/tool_name 有界 allowlist，未知值归 `other`。
- 多实例 Resource 支持 `service.instance.id`，优先 `OTEL_SERVICE_INSTANCE_ID`，否则使用容器 `HOSTNAME`。
- graceful shutdown：停止接收新 Agent 工作、等待/取消在途 Session、强制关闭残留 lifecycle、分别 flush/shutdown Trace 和 Metrics Provider。
- 正常、错误、取消、dangling、重复、乱序、并发、shutdown 等单元测试。

本轮明确**未完成**：

- Provider SDK 内部 retry attempt 的独立生命周期。
- Exemplar。
- 生产 Collector / Prometheus / Tempo / Loki 的端到端部署验收。

因此当前能力状态为：

| capability | 状态 | 说明 |
|---|---|---|
| tracing | available when configured | Trace endpoint 配置后启用 |
| applicationMetrics | available when configured | Metrics endpoint 配置后启用 |
| providerGenerationDuration | available | 覆盖流消费完成/失败/取消 |
| providerAttemptLifecycle | unavailable | Pi 0.86.1 扩展层看不到 provider-internal retry attempt |
| exemplars | unavailable | 锁定 OTel Metrics 路径真实 OTLP payload 无 exemplar |
| productionVerified | false | 本轮不部署生产 |

## 2. Pi 0.86.1 的真实 Provider 生命周期

锁文件实际解析 Pi `0.86.1`。

### 2.1 response-header latency

`before_provider_headers` 在顶层 Provider generation 发出前触发。  
`after_provider_response` 在 HTTP response 已收到、响应体流消费之前触发。

因此：

`before_provider_headers → after_provider_response`

只定义为 **response-header latency**，不能命名成完整 generation duration，也不能当作 first-token latency。

实现指标：

- OTel instrument：`pi_provider_response_header_duration`
- unit：`s`
- labels：`provider, model, status`
- status：仅对 header 阶段区分 `success/error`

### 2.2 完整 generation duration

Pi 0.86.1 的 `message_end` 在 Assistant 流完整消费并归一化为最终 AssistantMessage 后触发，能够表达：

- 正常流式完成。
- stream 读取失败。
- 用户取消，对应 `stopReason=aborted`。
- 请求在收到 response 前失败时的最终 error message。

因此 Target 的完整 generation lifecycle 为：

`before_provider_headers → message_end`

并在 `message_end` 前后保持同一个 Provider Span。

实现指标：

- `pi_provider_generations`
- `pi_provider_generation_duration`
- unit：Counter=`1`，Histogram=`s`
- labels：`provider, model, status`

这里的 generation 是**一次顶层 Pi model/provider 调用**，可能包含 Provider SDK 内部 retry；它不是 provider attempt。

### 2.3 为什么不能提供 provider-internal attempt

Pi Provider adapter 的 retry 发生在 Provider SDK/adapter 内部。扩展侧只有顶层：

- `before_provider_headers`
- `after_provider_response`
- `message_end`

没有带稳定 attempt identity 的 “attempt start / attempt end” 扩展事件。

因此本轮不能安全产生公共合同中的：

- `pi_provider_requests_total`
- `pi_provider_request_duration_seconds`

如果把一次 generation 猜成一个 attempt，会在内部 retry 时产生错误计数和错误耗时语义。本轮选择**不伪造**这两个合同指标。

Agent-level retry/recovery 重新进入模型调用时，会形成新的 generation；父 Agent 最终可成功，同时历史失败 generation 仍保留。

## 3. Model Turn 语义

`turn_start → turn_end` 是 Pi model turn lifecycle。

Pi 的 turn 包含 Assistant generation 后的工具执行阶段，因此：

`pi_model_turn_duration`

表示 **model turn duration，包含本 turn 内 Tool execution**，不是纯模型推理耗时。

不要使用 turn duration 代替 Provider generation duration。

## 4. 生命周期状态与关闭规则

统一应用 outcome：

- `success`
- `error`
- `cancelled`
- `incomplete`

OTel SpanStatus 映射：

- success → OK
- error → ERROR
- incomplete → ERROR
- cancelled → UNSET

Pino severity 与 lifecycleStatus 分离：

- success/cancelled → info
- incomplete → warn
- error → error

同一 lifecycle 只允许 completion 一次。关闭时先将 lifecycle 标记 closed，再写 Metric/Log/Span end。

Active lifecycle 保存开始时稳定身份：

- provider
- model
- toolName
- agentType
- turnIndex
- lifecycle identity
- 单调开始时间

duration 使用 `process.hrtime.bigint()` 差值，Metrics 记录秒。

### 4.1 Provider callback 排队

Provider hooks 没有 attempt/generation ID，因此使用事件顺序队列配对。

`message_end` 到达后，会清除该 generation 尚未匹配的 header 生命周期。依据 Pi 的真实调用顺序：如果 `after_provider_response` 存在，它一定发生在 body stream 完成和 `message_end` 之前。

这样可以避免“连接在 response 前失败”后留下 header tombstone，污染下一次 generation。

### 4.2 Tool

Tool 使用 `toolCallId` 作为稳定身份：

- 重复 start 不覆盖已有 Span。
- completion 后保留有界 tombstone，迟到 end 被忽略。
- dangling tool 在 turn/agent/shutdown 收尾时记 `incomplete`。
- toolName 使用 start 时保存的值，不使用迟到 callback 的可变值。

## 5. 应用指标

### 5.1 公共合同内

| Lifecycle | OTel instrument | 预期 Prometheus 名称* | Labels |
|---|---|---|---|
| Agent | `pi_agent_runs` | `pi_agent_runs_total` | agent_type,status |
| Agent duration | `pi_agent_run_duration` | `pi_agent_run_duration_seconds` | agent_type,status |
| Turn | `pi_model_turns` | `pi_model_turns_total` | provider,model,status |
| Turn duration | `pi_model_turn_duration` | `pi_model_turn_duration_seconds` | provider,model,status |
| Tool | `pi_tool_calls` | `pi_tool_calls_total` | tool_name,status |
| Tool duration | `pi_tool_call_duration` | `pi_tool_call_duration_seconds` | tool_name,status |

### 5.2 Target producer 扩展能力

| Lifecycle | OTel instrument | 预期 Prometheus 名称* | Labels |
|---|---|---|---|
| Provider generation | `pi_provider_generations` | `pi_provider_generations_total` | provider,model,status |
| Provider generation duration | `pi_provider_generation_duration` | `pi_provider_generation_duration_seconds` | provider,model,status |
| Provider response header | — | `pi_provider_response_header_duration_seconds` | provider,model,status |

* “预期 Prometheus 名称”基于 Collector Prometheus exporter 标准 type/unit suffix 翻译。本轮没有生产 Collector 运行权限，**必须在部署后读取真实 `/metrics` 再登记为 production-verified**。

Provider generation 指标当前不是 Telemetry Contract v1 中的公共 Provider request 指标。main 不应把它当作 attempt 数据。

## 6. Histogram buckets

秒级显式 boundaries：

- Tool：`0.01,0.05,0.1,0.25,0.5,1,2.5,5,10,30,60`
- Provider：`0.1,0.5,1,2.5,5,10,20,30,60,120,300`
- Agent / Turn：`0.1,0.5,1,2.5,5,10,30,60,120,300,600`

使用 MeterProvider Views 配置 explicit bucket histogram，不使用 OTel 默认数值边界。

## 7. Label 基数

Metric 标签不允许动态业务 ID、URL、用户输入、error message。

provider/model/tool_name 使用环境 allowlist：

- `OTEL_METRIC_PROVIDER_ALLOWLIST`，最多 8 项。
- `OTEL_METRIC_MODEL_ALLOWLIST`，最多 32 项。
- `OTEL_METRIC_TOOL_ALLOWLIST`，最多 64 项。

未配置或未命中的值统一为 `other`。

详细原值仍可存在于 Trace/Log，不进入 Metric label。

## 8. Context

Metric `add/record` 显式传入：

`trace.setSpan(ROOT_CONTEXT, lifecycleSpan)`

不依赖当前异步 callback 的 ambient context。

并发 Conversation 各自持有 extension 实例和 lifecycle Span，测试覆盖了不同 conversation 的 Context 不串号。

## 9. Exemplar 技术关卡

### 9.1 锁定实现版本

Target 当前锁定：

- `@opentelemetry/api 1.9.1`
- `@opentelemetry/sdk-metrics 2.10.0`
- `@opentelemetry/exporter-metrics-otlp-http 0.221.0`
- Trace SDK 维持现有 `2.11.0` 系列

选择 Metrics `0.221/2.10` 是为了与仓库既有 `0.221` OTLP exporter 代际保持一致，不为了 Exemplar 强行 fork/serializer。

### 9.2 真实 payload 验证

`exemplar-probe.test.ts` 使用：

1. sampled traceId/spanId Context；
2. real MeterProvider；
3. real Histogram；
4. real OTLPMetricExporter；
5. 本地真实 HTTP 接收端抓取 OTLP JSON payload。

CI 验证结果：

- payload 有 Histogram measurement。
- payload 没有 `exemplars` 字段。
- payload 没有所传 traceId。
- payload 没有所传 spanId。

此外 OTel JS 2.11.0 源码审查同样显示：SDK 有 exemplar reservoir/types，但正常 `MetricData.DataPoint` 与 OTLP metrics transformer 未将 exemplar 挂到导出 data point。

因此：

`exemplars=false`

这是明确的 unavailable，不是“可能可用”。

本轮不自制 OTLP serializer、不 fork exporter、不伪造 exemplar。

## 10. Collector / Prometheus

Collector metrics pipeline 已从：

`[host_metrics, docker_stats]`

扩展为：

`[otlp, host_metrics, docker_stats]`

保留原 host/docker 指标链路。

由于 producer 侧 Exemplar 已确认不可用，本轮**不为了形式验收开启 OpenMetrics / Prometheus exemplar-storage**。否则只能得到“后端支持 exemplar、但 producer 永远不产生”的假完整链路。

未来 Exemplar 恢复前必须重新验证实际部署版本：

- Collector image/version。
- prometheus exporter 是否支持 `enable_open_metrics: true`。
- Prometheus 实际启动 flags 是否含 `--enable-feature=exemplar-storage`。
- scrape Content-Type / format negotiation。
- `/api/v1/query_exemplars`。
- Tempo trace 保留。
- Loki 同 trace/span 生命周期日志。

当前仓库没有 Prometheus 容器启动命令/镜像版本，因此不能从 `prometheus.yaml` 推断 exemplar-storage 已开启。

## 11. Resource 与多实例

共享 Resource：

- `service.name`
- `service.version`
- `deployment.environment.name`
- 可用时 `service.instance.id`

`service.instance.id`：

1. 优先 `OTEL_SERVICE_INSTANCE_ID`；
2. 否则 `HOSTNAME`；
3. 都不存在时不伪造。

Collector → Prometheus 的最终 `job/instance/target_info` 映射仍需生产 `/metrics` 验收。

## 12. shutdown

进程关闭顺序：

1. `beginShutdown()` 停止接受新的 create/send Agent 工作并停止 Session sweeper。
2. HTTP server 停止接收新连接。
3. 对正在运行的 Pi Session 调用并 `await session.abort()`；Pi 0.86.1 的 abort 会等待 agent idle。
4. 在 `PI_CHAT_SHUTDOWN_TIMEOUT_MS` deadline 内等待 server + Session drain。
5. deadline 到达时将残留 telemetry lifecycle 强制以 `incomplete` 关闭。
6. Trace Provider 与 Metrics Provider 分别 `forceFlush()` / `shutdown()`；一个失败不会跳过另一个。
7. 退出进程。

SIGKILL 等不可拦截终止仍不能保证最终 export。

## 13. 测试与验证

仓库测试覆盖：

- 正常 generation。
- 慢 response headers。
- 慢 streaming。
- HTTP/header error 与 stream error outcome 分离。
- Agent-level retry 后成功。
- Provider 在 response 前失败。
- Tool error / timeout。
- cancel。
- dangling。
- duplicate start。
- late end。
- provider callback queue/tombstone。
- 并发 conversation Context。
- shutdown。
- Counter/Histogram completion 恰好一次。
- label allowlist / other。
- unit/bucket/instrument name。
- real OTLP payload Exemplar probe。

最终代码验证见 `docs/target-observability-validation.md`。

## 14. 公共 Contract 兼容性

`docs/telemetry-contract-v1.md` 本轮不修改。

已经实现的 Agent/Turn/Tool 指标保持 v1 语义。

v1 的 Provider request/attempt 指标仍为 **capability unavailable**，而不是改变为 generation 语义。

Target 新增 generation 指标属于生产者扩展；main 若未来需要消费，必须单独同步合同，至少新增：

- provider generation 的定义。
- generation vs provider-internal attempt 的区别。
- generation Counter/Histogram 名称。
- `providerGenerationLifecycle=true` / `providerAttemptLifecycle=false` capability。

在此之前 main 不应将 generation 指标映射成 v1 Provider request 指标。

## 15. 生产验收边界

本轮没有生产部署权限，也按要求不部署生产。

因此以下项目仍需上线后人工/自动验收：

- Collector 配置实际加载成功。
- OTLP Metrics 实际收到 Target 数据。
- Collector `/metrics` 的最终 metric names/type/unit/labels/buckets。
- 多实例 `job/instance` 映射。
- Prometheus scrape target 与 series。
- Tempo / Loki 对同一 lifecycle 的 trace/log 查询。
- retention、tenant、flags、镜像版本和卷权限。
- 如未来恢复 Exemplar：完整 payload → OpenMetrics → query_exemplars → Tempo → Loki 链路。

不能把本地/CI 验证写成生产已生效。
