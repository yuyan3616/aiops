# Telemetry Contract v1

状态：设计合同；实现与生产能力必须分别验收，不能由本文件推断已部署。
共同适用：main（消费）与 target/production-baseline（生产）。

## 1. 职责与版本

Target 负责产生 telemetry、SDK、Collector 和存储配置；main 负责查询、归一化、证据保存及 RCA 推理。本合同描述可见数据语义，不共享两边的实现。

两个分支均保存本文件相同版本。改变字段、单位、生命周期或关联含义时，两个分支分别提交同一合同更新；验收记录合同版本及各自 commit，不通过合并整个 Target 分支同步文档。

v1 的兼容新增字段允许消费者忽略。改变既有语义必须提升合同版本，并由 Provider 显式处理。Producer release 与 contractVersion 是不同概念；能力以实际查询结果和部署验收为准。

## 2. 身份与时间

- service 是稳定服务名；environment 是固定环境名。不同环境或 tenant 不得仅凭相同 traceId 自动合并。
- Trace ID 为 32 位十六进制，Span ID 为 16 位十六进制；归一化为小写，拒绝全零或非法值。日志缺失 ID 时保持缺失。
- 对外时间为 UTC RFC3339；原始纳秒 timestamp 以字符串保留，禁止先转 JS Number 丢精度。
- duration 对外分析使用毫秒，Prometheus duration 使用秒。字段必须明确单位。
- Span、Log event time、Metric sample/exemplar time、查询时间分别保存。export/scrape/ingestion 延迟不等于事件发生时间。
- instance、host、container 与 service 的映射必须有部署元数据依据；host CPU 不能未经映射标成某服务 CPU。
- resource service.name、deployment.environment.name 与 Loki/Prometheus 最终标签的映射，以锁定部署版本的实际输出登记；不能假设所有后端同名。

## 3. Tempo / Trace

必需：traceId、spanId、可选 parentSpanId、service、name/operation、start/end、duration、status（ok/error/unset）。可选：有界 attributes、links、resource identity。

Pi 生命周期：

| Span | 语义 |
|---|---|
| pi.agent.run | 一次 Agent 运行，从开始到真正 settled 或明确取消/强制关闭 |
| pi.model.turn | 一次 turn；必须明确是否包含工具执行，不能当作纯模型生成耗时 |
| pi.provider.request | 目标语义是一次 Provider attempt 的完整生成生命周期，覆盖流消费结束；现有 headers-only 实现不满足该目标 |
| pi.tool.call | 一次实际 tool execution，到成功、失败、取消或强制关闭 |

接入前必须登记 Provider 完成 hook 的可用性。若只能获取 HTTP response headers 时间，应使用单独 response-header 指标/属性，并标记 capability；不能把该耗时包装成完整 generation duration。

记录取消/forced_close 的 outcome/reason；OTel SpanStatus 与应用 outcome 不一一等价，取消不自动表示后端故障。

Trace completeness 至少区分：完整性未知、已截断、存在缺失 parent、存在未结束 span。未截断不保证完整。采样信息可用时保留；不可用时如实未知。

## 4. Loki / Logs

归一化字段：timestamp、service、severity、message；可选 event、lifecycleStatus、reason、traceId、spanId、container/instance。

- Docker envelope 与内部 Pino JSON 是两层。由 Target parser 或 Loki Provider 明确解析，不假定 body 字段已成为 Loki label。
- resource service.name 通常会转成后端标签；实际映射需登记。
- Pino numeric level 需映射 severity。lifecycleStatus=error 与日志 severity=info 可以同时成立，不能只靠 level=error 搜索失败生命周期。
- traceId/spanId 保留为内容或 structured metadata，禁止为了精确搜索把每个 traceId 建成高基数 stream label。
- 优先采用事件时间；缺失时使用 envelope 时间并注明来源。
- 无 Context 的日志允许缺失 ID；按 service/time/semantics 只能建立相关候选。

## 5. Prometheus / Metrics

v1 使用 Counter 与 classic explicit-bucket Histogram。部署需登记最终 metric name、type、unit、temporality、标签及 bucket。Counter 按累计语义消费，处理 reset；Histogram 分位数由桶估计，不等于原始请求精确分位数。

| 指标族 | 允许业务标签 |
|---|---|
| pi_agent_runs_total / pi_agent_run_duration_seconds | agent_type、status |
| pi_model_turns_total / pi_model_turn_duration_seconds | provider、model、status |
| pi_provider_requests_total / pi_provider_request_duration_seconds | provider、model、status |
| pi_tool_calls_total / pi_tool_call_duration_seconds | tool_name、status |

这些是 Prometheus 最终名字，OTel instrument 名称与 exporter 后缀策略必须实际验证，避免重复 _total/_seconds。

status 固定为 success/error/cancelled/incomplete；agent_type 固定角色枚举。provider/model/tool_name 来自有界注册表，未知值映射 other，详细原值放 Trace/Log。禁止把 URL、账号别名、用户输入或完整错误当 label。

禁止 traceId/spanId/conversationId/requestId/toolCallId。resource 与 exporter 自动标签也计入基数预算；不能把全部 Resource attributes 自动提升为 labels。service/environment/instance 的选择需保持多个生产者可区分，避免 series 合并；登记 job/instance/target_info 映射及 scrape 标签覆盖行为。

预算按所有维度组合 × instance × histogram bucket 展开计算，并检查实际 series 数。

## 6. Exemplar

归一化：seriesLabels、value、timestamp、真实 traceId、可选 spanId。Exemplar 是原始 measurement 的抽样关联，不代表聚合点、P99 或根因。

前置条件必须逐段验证：

1. 选定 SDK 实际采集并导出 exemplar，而非只有类型定义。
2. record/add 使用对应生命周期 Span Context。
3. OTLP payload 含 exemplar。
4. Collector exporter 保留 exemplar，classic histogram 走 OpenMetrics。
5. Prometheus 协商相应格式、启用 exemplar storage 且容量足够。
6. query_exemplars 可以查询；Trace 在 Tempo 保留范围内可解析。

普通 query_range 不返回 exemplars；main 必须独立进行有界 query_exemplars 查询。不能把聚合 PromQL 结果与单个 exemplar 一一对应；保留原始 series、sample time 和 value。

Exemplar 是抽样，不能要求每次 completion 必然存在。允许缺失、未采样 Trace、过期、后端不支持；这些不等于应用健康或关联失败。

## 7. 关联可信度与覆盖

精确 traceId/spanId 说明执行归属；service+time+semantics 只说明候选相关性。两者都不能自动证明机制或因果。

Provider 返回查询时间、实际窗口、截断/partial/warnings、已知采样和数据延迟。冻结 incident window 不冻结后端数据；晚到数据可使相同查询得到不同结果。

部署验收需登记：SDK/Collector/Tempo/Loki/Prometheus 版本与镜像、flags、export/scrape 间隔、retention、tenant 和安全网络范围。Secret 不进入合同、Prompt、Tool Result 或证据。

## 8. 合同验收

验证正常、HTTP error、流消费失败/慢流、Tool error/timeout、cancel、重复/强制 close。验证稳定 label 集、真实字段映射、缺失 Context 降级、Exemplar 抽样归属及 Trace 查找。

保存脱敏的输出样例和部署版本记录。main 可以先消费现有 host/docker metrics；应用指标或 Exemplar 未通过验收时明确 capability 不可用。
