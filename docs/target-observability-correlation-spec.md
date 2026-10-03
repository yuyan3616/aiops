# Target Observability 三信号关联与应用指标规格 v2

状态：根据源码审查修订；生命周期和 Exemplar 技术关卡通过后实施应用指标。
目标分支：target/production-baseline。审查代码基线：5955790345ae10396bdcf6d21af86a25b67b3a14。
基础设施基线：f2c9746c7211fbc6b4ab9bf756a03f89c40965a4。

## 1. 目标与边界

Target → OTel Collector → Tempo / Loki / Prometheus 三条真实链路已部署可查询。当前指标为 host/docker，应用指标与 Exemplar 尚待实现。

本分支负责 telemetry 生产、Trace Context、生命周期日志、应用指标、SDK、Collector、后端配置和部署验证；不修改 main 的 Provider、Investigation、Evidence 或 RCA 推理。

消费方只依赖 [Telemetry Contract v1](telemetry-contract-v1.md)。合同在两分支保持同版本/相同内容，分别提交，不合并整个 Target 分支来同步合同。

沿用现有 lifecycle extension，但先修复真实语义和异常边界，不直接往现有 close 回调机械添加 Counter/Histogram。

## 2. 当前源码事实与阻塞项

| 源码 | 当前事实 | 必须处理 |
|---|---|---|
| telemetry.ts | NodeTracerProvider + Trace exporter，没有 Metrics SDK | 增加经验证的指标输出路径 |
| pi-tracing-extension.ts parentContext | startSpan 使用显式 parent，不会自动激活新 Span | record/add 显式绑定对应 Context |
| before_provider_headers / after_provider_response | 收到 HTTP response 后、流消费前关闭 Span | 完整 generation 与 response-header 时间拆分 |
| closeTurn / closeAgent | dangling child 标 ERROR 后，parent 仍可能 OK | 明确 outcome/attempt/error 传播规则 |
| toolSpans.set | 重复 start 可覆盖旧 Span | 幂等或明确结束旧生命周期，避免泄漏 |
| closeDanglingTools | 没有保存 toolName | ActiveLifecycle 保存稳定 label 与身份 |
| assistantMessageHasError | 无明确 aborted 分支 | 区分 cancel 与 error |
| logTelemetryEvent | 所有 lifecycle 使用 logger.info | severity 与 lifecycleStatus 分开消费 |
| Collector | metrics 不含 otlp，prometheus 未开 OpenMetrics | 按验证结果调整 |
| extension.test.ts | 仅检查 hook 注册 | 增加实际状态/测量/异常验证 |

这些是当前源码边界，不因三条链路能查询而视为已解决。

## 3. P0 技术验证：Exemplar 可实现性

当前 Trace SDK 为 2.11.0 系列，尚未安装 Metrics SDK。审查 OTel JS v2.11.0 发现 exemplar types/reservoir 不等于正常 Metrics 数据点与 OTLP exporter 已接通。不能承诺添加 MeterProvider + context.with 即自动成功。

进入主实现前固定候选 SDK/Exporter 版本，并用最小真实程序验证：一个 Span 下记录 Histogram，检查导出的 OTLP payload 是否存在真实 traceId/spanId exemplar。类型存在、单测 mock 或 Collector 能看到 metric 都不足以通过。

选择顺序：

1. 首选实际已支持 exemplar 全路径的兼容 SDK/Exporter 版本，锁定并通过真实输出验证。
2. 若没有合适版本，可以采用独立的、明确支持 exemplar 的指标输出方案，但需额外评审 Collector 接入路径和公共合同兼容性。
3. 不自制未经审查的 OTLP serializer 或深度 fork 来假装实现成功。

若技术关卡未通过，普通应用指标可以先提供，capability 标明 exemplars=false；Exemplar 功能继续 blocked，不能宣称三信号精确关联全部完成。main 应诚实降级，不受阻于当前 host/docker 能力。

本规格的最终验收仍要求一条真实可用 Exemplar 路径，具体路线在验证记录中确定，不预先承诺未验证依赖。

参考源码：[OTel v2.11.0 MetricData](https://github.com/open-telemetry/opentelemetry-js/blob/v2.11.0/packages/sdk-metrics/src/export/MetricData.ts)、[OTLP metrics transformation](https://github.com/open-telemetry/opentelemetry-js/blob/v2.11.0/experimental/packages/otlp-transformer/src/metrics/internal.ts)。

## 4. 生命周期与 Provider 耗时语义（P0）

Pi v0.86.1 after_provider_response 在 response 收到后、stream body 消费前触发。当前 Span 无法代表完整 Provider generation；慢 token streaming 和 stream error 可能发生于当前 Span 结束后。

完整 generation 目标：一次实际 Provider attempt 从请求发出到流消费完成、失败或取消。retry 每个 attempt 分别记录；model turn 与 attempt 计数不能混为一谈。

实现前检查锁定 Pi 版本提供的 stream/attempt completion hook；优先使用扩展生命周期，必要时在 Target 的受控 Provider 调用封装处记录，不能凭 turn_end 推断多个 attempt 的结束。不得为观测能力改动 main RCA 推理。

若只有 headers hook：

- 保留 response-header latency 作为单独命名指标/属性。
- 不把它写成 pi_provider_request_duration_seconds 的完整 generation 耗时。
- 标明 providerGenerationDuration=false；Provider Slow 实验尚不能完整验收。

pi.model.turn 必须明确是否包含 Tool 执行，不能替代纯模型时长。first token 如有真实 hook 可后续增加；response headers 不等于 first token。

参考：[Pi v0.86.1 after_provider_response](https://github.com/earendil-works/pi/blob/v0.86.1/packages/coding-agent/docs/extensions.md)。

## 5. 生命周期状态与幂等关闭

建议 ActiveLifecycle 至少保存：span、单调开始时间、identity/attemptId、provider/model/toolName/agentType、generation、closed、outcome、reason、hadChildError。

以稳定 identity 管理 lifecycle；同一次 completion 只有一个 close owner，先标记 closed/移除 active 再产生 completion signals。迟到 callback 不能关闭另一轮的新 Span。重复 start 同 ID 必须去重或明确强制关闭旧状态，不能直接覆盖 Map。

status 固定：success/error/cancelled/incomplete。reason 放有界枚举或 Trace/Log，不放任意字符串 label。

- HTTP >=400 表示该 HTTP attempt 失败，不自动代表整次 Agent 失败。
- stream 失败必须影响对应 generation attempt，不能因 headers=200 标 success。
- Tool error/timeout 与 cancel 分开。
- dangling close 为 incomplete；不能默认为正常完成。
- turn/agent 收尾时先关闭所有 dangling 子生命周期，即使中间 turn 已不存在也不能遗留 provider/tool。
- 父 outcome 由明确生命周期结果决定；子尝试失败后成功重试允许父 success，另保留 hadChildError/失败 attempt。
- 没有恢复且 forced close 时父 outcome 不得仍是 success。
- Agent cancellation 明确 cancelled，OTel SpanStatus 映射按合同定义，取消不自动表示后端故障。

Trace status、Log lifecycleStatus、Metric status 从同一 completion 结构派生；不要求父子都使用相同 status。

duration 使用单调时间差，按秒 record，Span/log 时间仍使用真实 UTC。Date.now 的时钟跳变不能产生负 duration。

只记录 completion Counter 的定义是 completed attempts/runs/turns/calls；未完成工作不算 success。需要 starts/in-flight 时另建指标，不能在 start 与 close 对同一 Counter 各加一次。

telemetry 失败不能使业务请求失败，也不能阻止其他关闭步骤；有界诊断与 drop/failure 记录必须可查，不在错误循环中无限打印。

## 6. Context、日志与埋点入口

pi-tracing-extension 是主要生命周期协调入口。新增 pi-runtime-metrics.ts 集中创建 instruments/record；Provider stream completion 可使用受控 Target 封装，必须共用 lifecycle close owner，避免两处重复记录。

parentContext 只设置 parent。每次 record/add 显式在对应 Span 的 context.with(trace.setSpan(...)) 中执行，或使用经验证的显式 Context 参数；不要依赖回调的 ambient context，也不要全局 enter 一个跨并发请求的 Span。

completion metric 在 Span end 前记录，保留实际 sampled Context；Context 正确只是 Exemplar 的必要条件之一。

现有 logTelemetryEvent 显式接收 Span 的行为保留。普通 Hono/Pino 日志有 active Span 时可注入真实 ID；无 Span 时保持缺失，不生成假 ID。

Pino level 与 lifecycleStatus 不混用。Collector 目前只解析 Docker envelope；需要明确由 parser 或消费者解析内部 JSON。traceId/spanId 放内容/structured metadata，不能变成高基数 Loki stream labels。timestamp、numeric severity、service/container 映射按公共合同登记。

## 7. 首版应用指标

| 生命周期 | Counter 最终名 | Histogram 最终名 | 标签 |
|---|---|---|---|
| Agent | pi_agent_runs_total | pi_agent_run_duration_seconds | agent_type,status |
| Turn | pi_model_turns_total | pi_model_turn_duration_seconds | provider,model,status |
| Provider attempt | pi_provider_requests_total | pi_provider_request_duration_seconds | provider,model,status |
| Tool | pi_tool_calls_total | pi_tool_call_duration_seconds | tool_name,status |

OTel instrument 名称与 exporter 后缀转换需实际验证；unit=s，不能产生 _seconds_seconds 或重复 _total。首版明确使用 cumulative Counter/classic explicit-bucket Histogram，记录 type/unit/temporality。

可选 agent active runs 用 UpDownCounter，begin/end 恰好配对，取消和 forced close 也减一；不混入 completion Counter。

## 8. Histogram、样本量与默认边界

不能直接沿用 OTel JS 2.11.0 默认 [0,5,10,25,...10000] 数值边界记录秒级时长；unit=s 不会自动缩放边界。

首版建议有限秒级 boundaries：

- Tool：0.01,0.05,0.1,0.25,0.5,1,2.5,5,10,30,60。
- Provider：0.1,0.5,1,2.5,5,10,20,30,60,120,300。
- Agent/Turn：0.1,0.5,1,2.5,5,10,30,60,120,300,600。

使用 SDK advice/View 等锁定版本支持的配置，实际检查 exported buckets。依据测量范围可调整，不以默认值为验收依据。

P50/P95/P99 为 Histogram 估计，必须配合窗口 count 和 rate；单个慢样本不保证低流量窗口 P95/P99 有稳定结论。

## 9. Label 与 Resource 基数控制（P0）

允许标签必须同时满足有界取值：

- agent_type 固定角色枚举；当前 extension 只安装于 Conversation Main，不能声称已覆盖所有 Expert。
- status 固定四值。
- provider 使用注册表稳定 provider 类型，禁止 baseURL/账号别名/动态 ID。
- model 使用有界允许集，未知映射 other；不得自动收集用户所有自定义 model ID。
- tool_name 使用有界工具注册表，MCP 动态工具也需要配额，未知映射 other；原名放 Trace/Log。

初始每进程允许 provider<=8、model<=32、tool_name<=64；部署可配置较小集合，超限归 other 并产出有界诊断。不能仅限制值长度来控制基数。

禁止 traceId/spanId/conversationId/requestId/toolCallId、用户输入、完整错误、URL、账号标识。Resource 也需 allowlist；不要全部转换为 labels。container.image.name 当前会随镜像变化，需评估保留或改为有界部署身份，不直接加入所有应用指标。

service/environment/instance 要保证生产者可区分，记录 exporter job/instance/target_info 与 scrape 标签实际映射，防止多实例累计指标合并。不要用 release SHA 作为每个指标标签；可用于 resource/target_info 的受控诊断并评估 churn。

定义指标族 series 预算，包含 histogram buckets 和 exporter 自动标签。验收对照允许集与实际 /metrics、TSDB series，不能只看代码字段列表。

## 10. Telemetry 模块与配置

默认目标为 NodeTracerProvider + MeterProvider/PeriodicExportingMetricReader/OTLPMetricExporter；实际须服从第3节可实现性验证，不预设该组合自动具备 Exemplar。

共享 service.name/service.version/deployment.environment.name Resource；实例身份及资源提升规则遵循合同。

支持 OTEL_EXPORTER_OTLP_ENDPOINT，以及独立 TRACES_ENDPOINT/METRICS_ENDPOINT；基础 endpoint 拼接 /v1/traces 与 /v1/metrics，信号 endpoint 覆盖使用完整地址。trace-only、metrics-only、两者同时及禁用均需验证，不因缺少 Trace endpoint 就禁用已配置 Metrics。

仪器初始化一次，启动幂等；增加 SDK/Exporter 依赖后锁定兼容版本和 pnpm-lock。全局注册失败需明确处理，不能用 no-op 假装 metric 已产出。

export interval 初始15s，timeout 初始5s并可配置；记录采集延迟。Exporter 的失败不会改变业务 outcome。

## 11. Collector / Prometheus 与版本验收

首选 OTLP 路线通过后：metrics receivers 增加 otlp，保留 host_metrics/docker_stats。每种信号只有一个权威生产路径，防止同一指标同时经 OTLP 和 scrape 重复摄取。

必须验证：

- Collector prometheus exporter enable_open_metrics:true（具体配置按锁定版本）。
- Prometheus scrape 格式协商，exemplar-storage feature 与容量、实际 query_exemplars。
- 全链路 exemplar 在 payload/export/scrape/query 逐段可见。
- 经典 Histogram exemplar 支持；不未经验证切到 native histogram。
- Collector、Tempo、Loki、Prometheus 镜像版本/启动命令/flags、retention 和卷写入权限记录入部署验收。

Prometheus flags 可能在容器启动命令，而非 prometheus.yaml。允许修改部署配置，不能把“不动 Prometheus”列为预设限制。版本不确定时不照搬最新 README 配置。

Collector traces 当前 debug exporter 为 detailed，生产默认关闭或降低，诊断时显式启用。增加内存/queue/drop监控和有限成本预算；持久化 file log offset 不等于所有 pipeline 都有持久化可靠投递。

继续使用受控网络与认证边界，不为了 main 查询裸暴露后端。Docker socket 权限和单机本地存储故障域写入部署记录，不扩展权限来掩盖采集失败。

## 12. shutdown 与运行期关闭

当前 ConversationService.close 仅停 sweep timer；HTTP server close 和 telemetry shutdown 不代表后台 Agent 已结束。

Target 需明确顺序：停止接收新工作 → 通知/取消或等待在途 lifecycle → 幂等关闭残留 lifecycle → 最后 export/flush → shutdown Trace/Metric providers → 退出。

长连接/SSE 不可无限阻止关闭；设置整体 shutdown deadline，deadline 内优先收尾，超时注明 dropped/incomplete。Trace/Metric shutdown 分别捕获错误，一个失败不能跳过另一个。SIGKILL 无法保证最终 export，不能承诺每次运行都有 completion。

必要时调整 Target lifecycle/shutdown glue；不改 RCA 规划、预算或证据语义。若需触及继承来的 conversation/service，仅限等待/取消/释放资源的 shutdown 接口并说明原因。

## 13. 文件范围

必须检查/修改：telemetry.ts、pi-tracing-extension.ts、对应 tests、package.json、.env.example、pnpm-lock、Collector 配置。

建议新增：pi-runtime-metrics.ts 与 tests；最小 Exemplar 技术验证程序/部署验收记录；跨文件复用时才增加 telemetry-context helper。

按真实需要修改：Target bootstrap/index/shutdown glue、Provider lifecycle 封装、Prometheus 启动/scrape配置、Loki日志解析。必须说明具体能力缺口，不预设只有少数文件可动。

不修改：main Provider/Agent Tool/Investigation/Evidence/推理方案。Target 中继承来的 RCA 源码不是本轮新增推理工作范围。

## 14. 实施顺序

1. 固定公共合同、真实 lifecycle 语义和状态枚举。
2. 最小程序确认选定版本 Exemplar 输出，确定 SDK/exporter 路线。
3. 修复 Provider 完整流时长、close 幂等/晚到 callback、cancel/forced close 状态。
4. 集中定义 Counter/Histogram、显式 Context、bucket 和 label allowlist。
5. 接入 Collector/Prometheus，锁定镜像/flags，验证最终 names/labels/exemplars。
6. 验证 shutdown、异常生命周期、输出成本和真实三信号关联。
7. 发布 capability/版本验收记录给 main，未完成能力明确 unavailable。

允许普通应用指标先发布，但不能把 Exemplar 或完整 Provider generation 标成已完成；main 不等待不存在的能力。

## 15. 验收与测试

必要场景：正常请求、慢 headers、慢 streaming、HTTP error、stream error、retry成功、Tool error/timeout、cancel、dangling/重复/乱序close、新 agent_start 强制结束旧run、shutdown。

验证每个实际 lifecycle：completion Counter +1、Histogram count+1、duration单位正确、同一 close 不重复记录、标签来自开始时身份，迟到callback不关闭新attempt，全部active引用清空。

验证 Context：并行不同 conversation/span 不串号；record时正确Context；真实SDK导出，而非仅 mock断言context.with被调用。

Exemplar验收：payload有ID → OpenMetrics有ID → Prometheus query_exemplars可查 → Tempo存在对应Span → Loki生命周期日志同ID。使用少量隔离样本控制抽样条件，不能要求生产每次请求都必有Exemplar；允许无采样/retention过期并解释。

Provider Slow 用足够窗口样本和合理bucket验证完整生成duration分布；若仅headers能力，慢stream测试必须明确不能通过完整generation验收。

Trace/Log/Metric对同一次completion outcome一致；父Agent在retry后成功时可以success，但failed attempt仍可查。日志level不被当作lifecycleStatus。

部署验收包含collector/prometheus版本和flags、scrape/export间隔、单位/类型/name映射、label实际集合与series预算、禁用场景、shutdown export失败降级。

## 16. 后续优先级

P0：生命周期真实语义、幂等关闭、显式Context、Exemplar路线、单位/buckets、label基数、部署能力验证。

P1：Node runtime heap/GC/event-loop lag，帮助区分runtime pause；Collector数据丢失/queue监控，稳定shutdown。

P1/P2：HTTP RED（按调查需求），用稳定route template，区分普通HTTP与SSE连接，不使用完整URL label；first-token指标需要真实hook后再加。

这些后续项不改变main查询与RCA职责，也不把时间相关或Exemplar归属升级为根因证明。
