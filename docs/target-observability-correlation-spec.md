# Target Observability 三信号关联与应用指标规格

状态：待审查（仅指导 target/production-baseline，不修改 main RCA Runtime）
目标分支：target/production-baseline
当前基线 HEAD：f2c9746c7211fbc6b4ab9bf756a03f89c40965a4

## 1. 目标

当前 Target 已经完成：

~~~text
Target
  ↓
OTel Collector
  ├─ Trace   → Tempo
  ├─ Logs    → Loki
  └─ Metrics → Prometheus
~~~

三条链路均已真实部署并验证可查询。

本规格只负责完善 Target 自身 telemetry 质量，使 Trace / Log / Metric 能围绕同一请求建立可靠关联，并补齐 RCA 所需的应用级 Agent / Provider / Tool 指标。

本规格不修改 main 分支的 RCA Investigation、Agent Tool、Provider 查询实现。

## 2. 核心关联原则

三种信号使用同一套 Trace Context，但不能使用相同的数据模型。

~~~text
Trace  → traceId / spanId 原生身份
Log    → 关键日志显式携带 traceId / spanId
Metric → Exemplar(traceId / spanId)
~~~

目标：

~~~text
                         traceId = abc123
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
           Tempo            Loki           Prometheus
           Trace            Log             Metric
              │               │                │
        traceId=abc123   traceId=abc123    exemplar
        spanId=def456    spanId=def456     trace_id=abc123
                                           span_id=def456
~~~

禁止把 traceId / spanId 直接作为 Prometheus label。

## 3. 当前代码基础

现有：

~~~text
apps/pi-chat/server/telemetry.ts
apps/pi-chat/server/observability/pi-tracing-extension.ts
~~~

已经实现：

- NodeTracerProvider。
- OTLP Trace Export。
- pi.agent.run。
- pi.model.turn。
- pi.provider.request。
- pi.tool.call。
- 生命周期 Pino telemetry log。
- logTelemetryEvent() 自动把对应 Span 的 traceId / spanId 写入关键生命周期日志。

因此本轮不重新设计生命周期埋点，而是在现有 lifecycle close/start 节点上增加 Metrics。

## 4. 第一阶段应用指标

第一阶段只补 RCA 最需要的指标。

### Agent

~~~text
pi_agent_runs_total
pi_agent_run_duration_seconds
~~~

允许 labels：

~~~text
agent_type
status
~~~

可选：

~~~text
pi_agent_active_runs
~~~

### Model Turn

~~~text
pi_model_turns_total
pi_model_turn_duration_seconds
~~~

允许 labels：

~~~text
provider
model
status
~~~

### Provider

~~~text
pi_provider_requests_total
pi_provider_request_duration_seconds
~~~

允许 labels：

~~~text
provider
model
status
~~~

这是 Provider Slow 实验的核心指标。

### Tool

~~~text
pi_tool_calls_total
pi_tool_call_duration_seconds
~~~

允许 labels：

~~~text
tool_name
status
~~~

这是 Tool Timeout / Tool Error 实验的核心指标。

## 5. Metric 类型

Count 使用 Counter。

Duration 使用 Histogram。

不要只记录 average duration。

Histogram 需要支持 Prometheus 计算：

~~~text
P50
P90
P95
P99
~~~

第一版 bucket 可以使用 OTel SDK 合理默认值；如后续发现 Pi Provider 的秒级耗时分布不适合默认 bucket，再单独调优，不在本轮过度设计。

## 6. Label 基数约束

允许低基数维度：

~~~text
agent_type
provider
model
tool_name
status
~~~

禁止：

~~~text
traceId
spanId
conversationId
toolCallId
requestId
完整 error message
任意用户输入
~~~

原因：这些字段几乎每次请求都不同，会造成 Prometheus time-series cardinality 爆炸。

## 7. Exemplar

Metric 与单次 Trace 的精确关联使用 Exemplar。

例如：

~~~text
pi_provider_request_duration_seconds{
  provider="packy",
  model="...",
  status="success"
}
        │
        └─ exemplar:
           trace_id="abc123"
           span_id="provider001"
~~~

要求：

1. Histogram / Counter observation 发生在对应 Span 的 active context 下。
2. 不能只保存 Span 对象后在无 active context 的位置调用 record()，然后假设 SDK 会自动关联。
3. 如当前 lifecycle callback 中 active context 不可靠，应使用 context.with(trace.setSpan(...)) 或等价方式执行 metric record。
4. 实际验收必须确认 Prometheus 侧可以看到真实 exemplar trace_id / span_id。

## 8. 日志 Trace Context

现有 Pi lifecycle telemetry log 已经通过 logTelemetryEvent() 带：

~~~text
traceId
spanId
~~~

必须保留该行为。

对于普通 Hono / Pino 日志：

- 如果日志发生在 active span 内，建议通过统一 helper 自动注入当前 traceId / spanId。
- 如果没有 active span，允许不带 Trace Context。
- 绝不能生成假的 traceId / spanId 只为格式统一。

第一阶段优先保证 Pi Agent / Provider / Tool 的关键 lifecycle log，不要求一次性改造所有普通日志。

## 9. Telemetry 模块调整

当前 telemetry.ts 只有 Trace Provider。

目标：

~~~text
Telemetry Runtime
├─ NodeTracerProvider
│  └─ OTLPTraceExporter
└─ MeterProvider
   └─ PeriodicExportingMetricReader
      └─ OTLPMetricExporter
~~~

Trace 与 Metric 应共享一致的 Resource：

~~~text
service.name
service.version
deployment.environment.name
~~~

Endpoint 约定：

~~~text
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
~~~

并支持可选覆盖：

~~~text
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
~~~

shutdownTelemetry() 必须同时正确关闭 Trace Provider 与 Meter Provider。

## 10. Metrics 封装

建议新增：

~~~text
apps/pi-chat/server/observability/pi-runtime-metrics.ts
~~~

集中创建和记录：

~~~text
Counter
Histogram
UpDownCounter（如启用 active runs）
~~~

pi-tracing-extension.ts 只负责在正确生命周期点调用，例如：

~~~text
closeProvider()
├─ finish Trace Span
├─ write lifecycle Log
└─ record Provider Metric

closeTool()
├─ finish Trace Span
├─ write lifecycle Log
└─ record Tool Metric
~~~

避免把 instrument 定义散落到各生命周期回调里。

## 11. Collector 调整

当前 metrics pipeline：

~~~text
host_metrics
docker_stats
→ prometheus exporter
~~~

Target 应用 Metrics 接入后需要：

~~~text
otlp
host_metrics
docker_stats
→ prometheus exporter
~~~

即 Collector metrics pipeline 必须同时接收 Target 发来的 OTLP Metrics。

Prometheus exporter 需要使用能够保留 Exemplar 的输出方式。若当前 Collector 版本需要 OpenMetrics 开关，则启用对应配置；最终以实际部署版本验证结果为准。

不能只验证：

~~~text
Prometheus 能看到 metric
~~~

必须验证：

~~~text
Prometheus 能看到 metric
+
对应 observation 的 exemplar 中包含真实 trace_id / span_id
~~~

## 12. 文件改动范围

### 必须修改

~~~text
apps/pi-chat/server/telemetry.ts
apps/pi-chat/server/observability/pi-tracing-extension.ts
apps/pi-chat/server/telemetry.test.ts
apps/pi-chat/server/observability/pi-tracing-extension.test.ts
apps/pi-chat/package.json
apps/pi-chat/.env.example
deploy/observability/otel-collector.yaml
pnpm-lock.yaml
~~~

### 建议新增

~~~text
apps/pi-chat/server/observability/pi-runtime-metrics.ts
apps/pi-chat/server/observability/pi-runtime-metrics.test.ts
~~~

### 可选新增

~~~text
apps/pi-chat/server/observability/telemetry-context.ts
~~~

仅当 Trace Context 提取 / context.with 逻辑开始被 Metrics 与普通 Logger 多处复用时新增；不要为了抽象而抽象。

### 第一阶段不动

~~~text
deploy/observability/tempo.yaml
deploy/observability/loki.yaml
deploy/observability/prometheus.yaml

apps/pi-chat/server/rca/*
apps/pi-chat/src/*
apps/pi-chat/server/conversation/service.ts
~~~

若实际实现发现 Prometheus scrape 配置确实需要变更，再单独说明原因，不预设必须修改。

## 13. 生命周期异常边界

必须覆盖正常与异常关闭。

### Provider

- after_provider_response 正常完成。
- HTTP status >= 400。
- Provider span 被 turn close 强制收尾。
- 重复 close 不得重复记录 Counter / Histogram。

### Tool

- tool_execution_end success。
- tool_execution_end error。
- dangling tool 被 closeDanglingTools() 强制收尾。
- 同一个 toolCallId 只记录一次 completion metric。

### Turn

- normal turn_end。
- assistant error。
- dangling provider/tool 导致 turn error。

### Agent

- normal agent_settled。
- child turn error。
- 新 agent_start 前旧 agent span 被强制 close。

Trace / Log / Metric 三种信号对同一次 lifecycle completion 的 status 必须保持一致。

## 14. 验收

### Provider 正常请求

同一次 Provider 请求应能查到：

~~~text
Tempo:
traceId=abc
span=pi.provider.request

Loki:
event=pi.provider.request.completed
traceId=abc
spanId=<same provider span>

Prometheus:
pi_provider_request_duration_seconds
exemplar.trace_id=abc
exemplar.span_id=<same provider span>
~~~

### Tool 正常调用

同理验证：

~~~text
pi.tool.call
pi.tool.call.completed
pi_tool_call_duration_seconds exemplar
~~~

### Provider Slow

人工制造慢 Provider 后：

- Histogram P95/P99 上升。
- 慢 observation 有 exemplar。
- exemplar traceId 能在 Tempo 找到真实慢 Trace。
- 同 traceId 在 Loki 能找到对应 lifecycle log。

### Error

Provider / Tool error 时：

- Trace Span status=ERROR。
- Log status=error。
- Metric status=error。
- 三者 Trace Context 一致。

## 15. 第二阶段候选

不纳入第一提交：

~~~text
HTTP RED Metrics
├─ request count
├─ request duration
└─ active requests

Node.js Runtime Metrics
├─ heap
├─ GC
└─ event loop lag
~~~

优先先把 Agent / Provider / Tool / Turn 三信号关联做正确，再扩大指标面。

## 16. 与 main 分支的边界

本分支只负责“生产 telemetry”。

最终向 main RCA Runtime 提供的数据契约：

~~~text
Tempo:
traceId / spanId / parentSpanId + spans

Loki:
关键 telemetry logs 中真实 traceId / spanId

Prometheus:
低基数 Application Metrics
+ exemplar(traceId/spanId)
+ 已有 host/docker metrics
~~~

main 分支负责：

~~~text
Provider 查询
Agent Tool
Investigation
Evidence
跨模态推理
RCA
~~~

两边不互相混入实现细节。
