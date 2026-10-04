# Target Observability 验证记录

日期：2026-10-03；生产运行补充验证：2026-10-04
分支：`target/production-baseline`
实施起点：`70cb7f744881073991f13935646f5e9c076df7d1`

## 1. 验证环境

使用仓库 `.github/workflows/pi-chat-ci.yml`：

- Node.js 22.19.0
- pnpm 11.22.0
- `pnpm install --frozen-lockfile`
- `pnpm --filter pi-chat typecheck`
- `pnpm --filter pi-chat lint`
- `pnpm --filter pi-chat test`
- `pnpm --filter pi-chat build`

临时 Draft PR #24 已关闭且未合并。修正前 CI 与本轮验证分开登记，不把旧 CI 成功当作新代码通过。

## 2. 已通过 CI

修正前代码 SHA `eab69889ab64d948a562385cbaca5fc5cb050698`：

- GitHub Actions workflow：`pi-chat-ci`
- run number：367
- run id：37129662107
- conclusion：success

该运行包括：

- frozen-lockfile install：success
- typecheck：success
- lint：success
- unit tests：success
- build：success

### 本轮边界修正验证

本轮基于以上 SHA 修正：cache warming veto、重复 Provider start 的保守降级、父级 incomplete 传播、host dispose 清理、shutdown 准入与共同 deadline，以及 generation Span 合同命名。

新增回归覆盖：真实 TracerProvider 并发父子关系、dangling 父级状态、缺失 Provider end 后下一 turn、host dispose 幂等及迟到 callback、失败 Log/Metric 的 Span 收尾、初始化/标题准备期间 shutdown、冷初始化不阻塞已有会话取消、await abort、hung drain/exporter 与异常 drain 收尾。

本轮本地验证环境：Node.js 24.19.0，pnpm 11.25.0。已通过：

- `pnpm install --frozen-lockfile`（锁文件无变化）。
- typecheck。
- lint（无 error，保留仓库原有 warning）。
- unit tests：116 项，114 passed，2 skipped，0 failed；跳过的是缺少本地 RCA100 t039 数据的集成用例，与本轮 Target 修正无关。
- build。
- 真实 OTLP Exemplar probe 仍确认 `exemplars=false`。

工作流新增 Target 分支 push 触发，无需重新打开临时 PR。首轮边界修正 SHA `78f51450a937a45675ce85ec9f1e37eae030e828` 已通过远程 CI #368（run id `37132093075`），包括 frozen install、typecheck、lint、unit tests 和 build。

最终追加修正 SHA `833958e461eaf9f46f62383fbf71bc7d9276a743` 补充“冷初始化不延迟已有会话 abort”和 abort 提前拒绝的处理；远程 CI #369（run id `37132410652`）全部成功，包含 frozen install、typecheck、lint、unit tests、build。

[实现代码 CI #369](https://github.com/yuyan3616/aiops/actions/runs/37132410652)。实现代码验证完成；后续生产运行补充验证见第 6 节。

## 3. Exemplar 真实验证

测试文件：

`apps/pi-chat/server/observability/exemplar-probe.test.ts`

使用真实：

- MeterProvider
- Explicit Bucket Histogram
- sampled SpanContext
- OTLPMetricExporter
- HTTP OTLP payload

验证步骤：

1. 构造固定合法 traceId/spanId，并设置 sampled TraceFlags。
2. 在该 Context 下 `histogram.record(..., context)`。
3. `forceFlush()`。
4. 本地 HTTP Server 捕获 exporter 发出的真实 OTLP JSON。
5. 检查 payload。

结果：

- payload 中存在 Histogram measurement。
- 不存在 `exemplars` 字段。
- 不存在测试 traceId。
- 不存在测试 spanId。

结论：当前锁定 OTel Metrics 路径不能输出可供 Collector/Prometheus 使用的真实 Exemplar，能力状态为 `exemplars=false`。

## 4. Pi lifecycle 验证

基于锁定 Pi 0.86.1 源码和扩展类型确认：

- `after_provider_response` 是 response 收到、body stream 消费前事件。
- `message_end` 是完整 Assistant stream 归一化完成后的消息结束事件。
- cache warmer 会复用 before_provider_headers；本轮通过 cache_warming_decision=stop 在请求前 veto。
- Provider SDK 内部 retry 没有暴露稳定 attempt start/end identity 给 coding-agent extension。

因此实现：

- response-header latency：`before_provider_headers → after_provider_response`
- provider generation Span：`pi.provider.generation`，不占用 v1 attempt 名称。
- provider generation duration：`before_provider_headers → message_end`
- provider-internal attempt lifecycle：unavailable

## 5. 单元测试覆盖

新增/扩展测试包含：

- 正常 completion。
- 慢 headers / 慢 streaming。
- stream error。
- response 前失败。
- Agent retry 后成功。
- cancel。
- Tool success/error/timeout。
- duplicate Tool start。
- dangling Tool/Provider。
- late callback。
- shutdown forced close。
- completion exactly once。
- 显式 Metric Context。
- 秒级 bucket。
- 有界 labels。
- 多实例 resource identity。
- 并发 Conversation Context 隔离。
- Exemplar real OTLP payload。

## 6. ECS 实际部署与运行验证（2026-10-04）

运行时实现 SHA：

`f3fa1516b21a11023ee91cf12995844ced20826e`

该实现已部署到阿里云 ECS。其后的 README / validation / spec 文档提交不改变运行时代码，也不等价于再次部署。

当前实际部署拓扑：

```text
Alibaba Cloud ECS
├─ aiops-rca-target
├─ otel-collector
├─ tempo
├─ loki
└─ prometheus
```

本次实际运行观察确认：

- Target 启动日志出现 `OpenTelemetry tracing started`。
- Target 启动日志出现 `OpenTelemetry metrics started`。
- capability state 显示 `tracing=true`、`metrics=true`。
- `providerGenerationLifecycle=true`。
- `providerAttemptLifecycle=false`。
- `exemplars=false`。
- Collector 使用包含 `otlp, host_metrics, docker_stats` 的 metrics pipeline。
- 触发真实 `utc_time` Tool 调用后，Collector `:9464/metrics` 已观察到真实应用指标，包括：
  - `pi_provider_response_header_duration_seconds_*`
  - `pi_tool_call_duration_seconds_*`
  - `pi_tool_calls_total`
- 实际 label 已观察到 `provider="packy"`、`model="deepseek-flash"`、`tool_name="utc_time"`、`status="success"`。
- 既有部署已验证 Tempo Trace 写入/查询、Loki Target 日志写入/查询以及 Log ↔ Trace 的 traceId 关联。
- 既有部署已验证 Host / Docker Metrics 经 Collector 进入 Prometheus。

因此当前可以确认：

| 链路 | 状态 |
|---|---|
| Target → OTLP Trace → Collector → Tempo | 已实际验证 |
| Target stdout → Collector → Loki | 已实际验证 |
| Trace ↔ Log traceId 关联 | 已实际验证 |
| Target → OTLP Application Metrics → Collector `:9464` | 已实际验证 |
| Host / Docker Metrics → Collector → Prometheus | 已实际验证 |
| Application Metrics → Prometheus 查询 | 尚需补一次部署后查询验收 |
| 同一次真实调用的 Tempo + Loki + Prometheus 三后端关联 | 尚未完成 |
| Railway main → ECS Observability Backend 跨云查询 | 当前 blocked |

Target 启动早期曾出现 Vite 代理访问 `127.0.0.1:4328` 的短暂 `ECONNREFUSED`，随后 Pi Chat API 正常监听且 Telemetry 正常启动。当前将其记录为启动顺序竞态，不视为持续运行故障；若后续持续出现再单独处理。

### 6.1 当前网络边界

Tempo / Loki / Prometheus 查询端口当前只绑定 ECS 本机：

```text
Tempo       127.0.0.1:3200
Loki        127.0.0.1:3100
Prometheus  127.0.0.1:9090
```

Railway 上的 main RCA Runtime 与 ECS 不在同一网络，因此目前不能直接进行真实跨云 smoke。

这不是 Provider 代码失败，而是明确的网络可达性阻塞。

在建立受控的 HTTPS + Auth 查询入口前，不应为了验收直接裸开放：

- 3100
- 3200
- 9090
- 4318
- 9464

### 6.2 尚未完成的生产验收

以下能力仍不能宣称完成：

- 部署后从 Prometheus API 查询 Target `pi_*` application metrics，并核对最终 series / labels。
- 对同一次真实 Agent / Tool / Provider 调用完成 Tempo + Loki + Prometheus 三后端关联验收。
- Railway main 通过受控网络入口真实查询 Tempo / Loki / Prometheus。
- 多 Target 实例的 `service.instance.id` / Prometheus `instance` 区分验证。
- retention、volume、长期运行丢弃率和资源压力验证。
- Provider SDK 内部 attempt lifecycle；当前明确 unavailable。
- Exemplar；当前明确 unavailable，而不是待配置能力。

## 7. 后续验收清单

下一阶段至少完成：

1. 为 Railway → ECS Observability Backend 建立受控的 HTTPS + Auth 查询入口；不要裸开放后端端口。
2. 在 Railway 配置外部化的 Tempo / Loki / Prometheus Base URL 与认证信息。
3. 从 Prometheus API 查询 Target application metrics，记录真实 metric names、series、labels、bucket/count/sum。
4. 发起一组已知 Agent / Tool / Provider 请求，用同一请求完成 Tempo、Loki、Prometheus 三后端关联验证。
5. 如进入多实例部署，再验证 `service.instance.id` 与 Prometheus instance 映射。
6. 继续记录 Collector / Prometheus / Tempo / Loki 的实际版本、启动参数、retention 和卷配置。
7. Exemplar 保持 unavailable；只有未来 producer OTLP payload probe 首先出现真实 exemplar 后，才重新开启后端 exemplar 验证。

不能把 CI success、进程启动成功或 mock 查询成功写成上述真实跨云验收已完成。
