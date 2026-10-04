# Live Investigation Validation

日期：2026-10-04  
目标分支：`main`  
开发分支：`feat/live-observability-main`

## Baseline

- 实际 main 基线：`8ae4b77a4845b17902e48d3ea5b4af69d13e8516`
- Target 当前已部署版本：`f3fa1516b21a11023ee91cf12995844ced20826e`
- Target 已确认能力：
  - Trace / Logs / Metrics 基础链路存在
  - provider generation 与 response-header latency 分开
  - `exemplars=false`
  - provider attempt lifecycle 不可用
  - generation 不映射为 attempt

## Production path

新 Investigation 的生产路径：

```text
IncidentContext
  -> Main Agent / Expert
  -> ObservabilityToolRegistry
  -> TraceProvider / LogProvider / MetricsProvider
  -> LiveHttpClient
  -> Tempo / Loki / Prometheus
  -> immutable Evidence snapshot
  -> ToolCall + Observation atomic Budget-v2 commit
  -> Evidence / Hypothesis / Conclusion
```

不存在 Live failure/no_data → RCA100 fallback。

生产启动路径已移除：

- `index.ts` 中的 `RCA100Adapter` 构造
- `config.ts` 中的 `RCA100_CASES_DIR`
- Docker build 的 `rca:fetch:t039`
- Railway 启动脚本的 `RCA100_CASES_DIR`
- Main/Expert 的 RCA100 `caseId` 查询合同
- 生产 Registry 的 parquet / alerts / events / topology 查询工具

RCA100 adapter、parquet helper、t039 下载和 scorer 现已彻底删除，专属依赖与离线测试一并移除。历史文件不改写，历史 Session/报告仍可读；关联旧调查的会话发送消息返回 HTTP 409 / legacy_read_only，且不会启动模型或查询。请新建 Live 会话进行排障。

## Persistence and compatibility

新 Investigation：

- `schemaVersion: 2`：继续表示 Budget v2 / generation / terminal protection 能力
- `formatVersion: 3`
- `source.kind: live`
- `source.contractVersion: 1`
- `context: IncidentContext`

Legacy RCA100 Investigation：

- 保持原 JSON 字段，不批量改写
- 读取 / 历史展示 / 报告可用
- Service 层写操作统一拒绝 `legacy_read_only`
- 启动可把旧 running 状态修复成 interrupted，但不会声明 resumable

## Live HTTP validation

专项测试覆盖：

- 每后端并发 queue 的 AbortSignal
- fetch abort
- body stream abort
- retry/backoff abort
- 401/403 不重试
- transient network reset 最多重试一次
- deadline → typed `timeout`
- 4 MiB body 上限在读取/Content-Length 阶段拒绝
- credential 不进入模型参数
- endpoint 固定于 Server 配置

默认：

- query deadline：15s
- backend body：4 MiB
- backend concurrency：4
- transient retry：最多 1 次

## Provider validation

### Tempo

覆盖：

- `search_traces` 结构化参数 → Server TraceQL
- Tempo search 返回 hex traceId；trace-by-id JSON 的 protobuf bytes/base64 traceId/spanId 兼容归一到 canonical hex
- `get_trace` 使用冻结 query window 的 `start/end` 约束
- <= 50 trace sample
- partial / truncation 显式返回
- `get_trace` 只接受本 Investigation 已由 `search_traces` 返回的 traceId
- span normalization / completeness 标记
- 未知总体 matched 不编造

### Loki

覆盖：

- `search_logs`
- mode anomaly / all / custom
- <= 200 records
- message <= 2048
- no_data 与失败分离
- trace/span ID 归一化
- telemetry message 中的 token/secret 脱敏
- “ignore previous instructions”等文本保留为不可信数据，不获得执行权限

### Prometheus

覆盖：

- `discover_metrics` 后才能 `query_metrics`
- Counter → `rate/increase`，reset-aware
- classic Histogram → bucket rate + `histogram_quantile`
- Gauge → raw/aggregation，不套 Counter reset 语义
- unit / labels 保留
- <= 20 series / <= 2000 datapoints
- step 自动上调时返回 partial/warning
- `exemplars=false`，不暴露假的 exemplar capability

## Investigation / Runtime validation

覆盖：

- lookback 创建只冻结一次
- operationId + request hash 创建重放
- 进程重启后创建重放仍返回同一 Investigation
- Budget v2 Primary / Recovery disposition
- reservation ledger
- generation fence
- per-investigation 3 / global 9 runtime slots
- 同 dispatch operation 去重
- 多 Expert 并行与乱序 settlement
- user intervention steering
- Cancel 终态覆盖晚到 completion
- failed atomic intent save 不启动 Specialist、不消费 reservation
- restart reconciliation 不重跑已中断 Session
- completed tool work 后的 provider failure 仍正确 commit Primary
- Expert 累积 Tool result 128 KiB 后进入 finalize
- 单次 Agent Tool result <= 32 KiB

## Evidence and projection validation

成功 Live ToolCall：

1. Server 先写有界、不可变的 `evidence-snapshots/Cxx.json`
2. 再在一次 `updateV2` 中提交：
   - ToolCall terminal status
   - `snapshotRef`
   - resultStatus
   - Observation
   - Budget safety state
3. Expert finding 接受时 Evidence 必须引用完成的当前任务 ToolCall，并继承 snapshotRef/rawRef

启动恢复：

- running Investigation → interrupted
- 缺失 Tool / Observation / Evidence / Expert / lifecycle JSONL event → 从权威 snapshot 幂等补齐
- 缺失 Live final-report JSON/Markdown → 幂等重建
- visualization 继续使用现有 pending recovery

终态 Investigation 不为了确认投影而重新写成另一个结论。

## Secret / prompt injection validation

- Authorization / Bearer / Basic password / tenant 来自 Server 环境变量
- 模型 Schema 不包含 endpoint / tenant / credentials / TraceQL / LogQL / PromQL
- URL 中禁止内嵌 username/password
- telemetry 中 token/secret 在进入 Tool Result / snapshot 前脱敏
- Main / Expert prompt 明确 telemetry 是不可信数据
- Target provider generation 不解释成 attempt

## CI

要求执行：

```bash
pnpm --filter pi-chat typecheck
pnpm --filter pi-chat lint
pnpm --filter pi-chat test
pnpm --filter pi-chat build
```

最终 CI run / head SHA 在完成最后一次代码与文档提交后回填。

## Real backend smoke

**BLOCKED（不是失败，也不是已通过）。**

原因：

- Target / OTel Collector / Tempo / Loki / Prometheus 位于阿里云 ECS
- main RCA Runtime 位于 Railway
- Tempo / Loki / Prometheus 查询端口当前只绑定 ECS `127.0.0.1`
- 当前没有 Railway 可访问的私网、VPN、受认证反向代理或 Tunnel endpoint
- 本次迁移没有权限也不会为验收修改 ECS 安全组或裸开放无认证公网端口

因此：

- mock / fixture 成功不冒充真实 backend smoke
- CI 成功不冒充生产验收
- 在后续提供安全跨云 endpoint + auth 后，应从 Railway 运行环境执行只读 smoke：
  - Tempo search + get trace
  - Loki bounded query
  - Prometheus series/metadata/query_range
  - timeout / unauthorized / cancellation
  - label mapping 与 contractVersion 核对

## Deployment status

- 未修改 `target/production-baseline`
- 未合并 `main`
- 未部署 Railway production
- 未修改 ECS 安全组 / Nginx / Tempo / Loki / Prometheus 监听地址


## PR #25 审查修复验证（2026-10-04）

本轮基于 `fe39b9b05c9efc5f2dc6894a5a6b0bb177fc2d76` 修复，用户确认的待观测 Target 为 `f3fa1516b21a11023ee91cf12995844ced20826e`。

新增验证使用后端协议结构的 fixture 和本机真实 HTTP 请求；没有从 ECS 读取生产样例，不声称实际标签映射已验收。

- Tempo v2 外层 `trace.resourceSpans`、backend partial、原始纳秒时间。
- Trace direct-child interval 裁剪及 union；重叠 children 不重复扣除，gap 不推断机制，不宣称完整 critical path。
- Classic Histogram 系列名与 family metadata 映射；无 classic bucket 的 Histogram 不声明 quantile 能力。
- Loki 有限后端样本在本地结构化过滤后为空仍标记 partial。
- 错误响应 envelope 不伪装 no_data。
- Expert baseline Evidence 使用实际查询窗口，拒绝错误 modality、不存在的 sourceItems 或缺少具体事实引用的 claim。
- 只在 snapshot + ToolCall 提交后授权 Trace/Metric；存储失败不授权；恢复从完成快照重建授权。
- 主 Agent 历史状态 offset 分页；专家最终文本32KiB与累计128KiB上限。
- 快照 fsync 后原子发布且禁止覆盖，保存 normalizationVersion 与 result SHA-256。
- 重启从权威状态补齐 tool-calls.jsonl，恢复幂等。
- 本机 HTTP Server 验证网关路径前缀与 Basic Auth；认证值不进入结果。

本地最终检查：Typecheck PASS；Lint PASS（0 error，保留原有 warning）；Unit tests 100 total / 99 passed / 0 failed / 1 skipped；Build PASS（原有 bundle size warning）。唯一 skipped 是无 RCA100 benchmark fixture 的离线测试。

本轮远程 CI 在 push 后单独核实；先前 #402/#403 不能代表本轮修复通过。

真实 Railway → NGINX → ECS smoke 仍为 BLOCKED，等待用户部署网关和配置认证。接入步骤见 [Live 查询网关接入](live-gateway-connection.md)。本轮没有合并 main、没有部署 Railway、没有修改 Target/ECS/NGINX。


## RCA100 能力移除（2026-10-04）

用户确认不再维护数据集能力：删除 adapter、parquet helper、t039 下载脚本、离线评分入口及专属依赖；移除仅用于这些能力的类型、持久化方法和测试。旧记录字段只供历史展示保留，不迁移或删除已有 Session/Investigation 文件。

关联历史调查的 Session 消息入口直接返回 HTTP 409、`legacy_read_only` 与中文停用提示，在加载模型、执行 Prompt 或写入用户消息之前拒绝。新排障请创建 Live 会话。现有历史消息、Evidence 与报告读取继续保留；通用恢复测试仍验证旧记录报告卡及报告下载。

本轮本地验证：Typecheck PASS；Lint PASS（保留原有 warnings）；Build PASS；98 tests / 98 passed / 0 failed / 0 skipped。新增服务端消息入口与 HTTP 提示测试，验证无模型初始化。真实 Railway→网关→ECS smoke 仍待网关部署。
