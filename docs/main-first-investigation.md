# Main 优先取证与按需专业调查

## 行为

每个会话由 Main 处理。普通知识问答不创建 Investigation；用户请求排障时创建 Live Investigation，由 Main 直接进行有界取证。只有存在明确证据缺口，需要独立上下文、多轮专项分析或已实现的专门能力时，才创建独立专家 Session。

数据源类型不决定 Agent 数量。简单问题可以由 Main 查询日志、指标和单条 Trace，维护假设并直接结案。专家任务为零是正常状态，Evidence 仍可引用并进入报告。专家数量不代表证据来源数量或置信度。

## 工具

- `query_rca_overview`：保留现有名称以兼容历史配置；Main 直接查询有界日志、Trace 样本、发现/查询指标。logs 的 `logTraceId` 用于关联查询。
- `read_rca_trace`：读取本调查已成功搜索并持久化授权的 Trace，返回有界 span 与耗时分析、Evidence ID、ToolCall 和 snapshotRef。默认冻结 incident 窗口。
- 假设更新与结案沿用既有工具。直查走同一 Provider、预算、安全上限、快照、Observation/Evidence、取消和终态保护；不创建 Expert Task，不消费专家 Primary/Recovery 名额。

未授权 Trace ID 仍会被拒绝。查询 DSL、endpoint、凭据不会进入模型工具参数。数据不可达或未埋点时，换用相同数据源的专家不能补出证据。

## 专业调查选择

角色 JSON 在原格式上增加可选的 `capability`、`useWhen`、`notFor`，兼容旧版本。注册表把能力和场景注入 Main；名称与工具列表不足以成为派发理由。

Main 在 brief 的已有 knownFacts 中说明已查事实、缺口和委托原因，在 question/expected 中说明具体可证伪问题及其对假设的影响。没有新增审批服务、路由 Agent、固定查询次数或阶段状态机。服务端仍校验角色、假设、预算和授权，语义上的派发必要性由提示词指导，不能靠非空字段保证。

Trace/Log/Metrics 专家保留用于复杂专项工作。源码、数据库、消息队列和变更分析尚未接入对应工具与权限，不能只增加配置就使用。当前编排方是 RcaService，无需迁移至 Spring Boot。

## 配置发布与验证

身份和规则只在 aiops-agent-config 维护。先部署支持新工具/角色字段的 Runtime，再发布配置；旧 Runtime 会拒绝未知字段并保留最近有效版本。正在执行的调查继续使用其固定配置，新调查才采用新策略。

验证包含真实 Provider 归一和记录链路上的 Main 搜索→授权 Trace 读取→Evidence→零专家结案→报告，以及未授权读取拒绝、终态拒绝、日志关联参数隔离、角色字段校验和旧配置兼容。确定性测试验证能力与协议；模型是否减少无意义委托仍需真实会话回放观察，不能将测试通过等同于 LLM 行为评估。
