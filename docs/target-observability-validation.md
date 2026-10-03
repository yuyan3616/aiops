# Target Observability 验证记录

日期：2026-10-03
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

随后补充“冷初始化不延迟已有会话 abort”和 abort 提前拒绝的处理，本地验证如上；这次追加修正的远程 CI 待提交后单独核查。生产验收仍未执行。

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

## 6. 未执行的生产验收

本轮按要求不部署生产，因此未声称以下能力已生效：

- ECS/生产 Collector 配置 reload/start 成功。
- Collector 实际版本及 Prometheus exporter 配置兼容性。
- Prometheus 启动 flags。
- OpenMetrics format negotiation。
- exemplar storage。
- `query_exemplars`。
- 生产最终 metric names / job / instance / target_info。
- Tempo / Loki / Prometheus 三后端同一次真实生产调用的关联。
- 生产 retention、volume、权限和丢弃率。

## 7. 生产上线验收清单

部署后至少执行：

1. 记录 Collector / Prometheus / Tempo / Loki build/version 和容器启动命令。
2. 验证 Collector 已加载 `metrics.receivers: [otlp, host_metrics, docker_stats]`。
3. 在 Target 发起一组已知 Agent / Tool / Provider 请求。
4. 查看 Collector `:9464/metrics`，记录最终应用 metric name/type/unit/labels/buckets。
5. 验证不同 Target 实例具有可区分 `instance`。
6. Prometheus 查询 Counter、Histogram bucket/count/sum。
7. 用 Trace ID 在 Tempo 查询对应 Span。
8. 用同 Trace/Span ID 在 Loki 查询 lifecycle log。
9. Exemplar 保持 unavailable；除非未来 SDK payload probe 首先通过，否则不要开启“已支持”声明。
