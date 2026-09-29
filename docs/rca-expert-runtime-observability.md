# RCA Expert Runtime 可观测性与终止语义 v2

## 范围与现状

在现有 Pi Embedded AgentSession、RcaService、Budget V2 和 Evidence Pipeline 上，为每次 Expert 执行记录模型用量与运行终态，并在 Expert 卡片显示摘要。保持现有调度、Prompt、工具白名单、Semaphore、Hypothesis、Evidence 和预算规则不变。

目前 `PiExpertRunner` 的成功结果只有 `finding/sessionId/diagnostics`，失败通过 `PiExpertRunError` 或普通异常抛出。Budget V2 只将可验证的 provider 瞬时失败、无已完成工作且已启动的 Primary 设为 `recoveryEligible`；重启恢复在 Repository 中发生，可能没有 Runner 结果。本次不能用泛化的 `provider_error` 代替现有预算分类。

## 契约

```ts
interface AgentUsage {
  turns: number;                 // 收到 message_end 的 Assistant 响应次数，包括有 usage 的错误响应
  inputTokens: number;           // Pi usage.input 累计
  outputTokens: number;          // Pi usage.output 累计，已包含 reasoning
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;           // 每条消息的 usage.totalTokens 累计
  contextTokens: number;         // 最近一条有效 Assistant 响应的 usage.totalTokens，非精确最终上下文
  cost?: number;                 // Pi 报告的估算美元费用；无法确认价格时省略
}

type AgentTerminationReason =
  | "completed" | "aborted" | "provider_error"
  | "invalid_output" | "tool_error" | "runtime_error";

interface AgentTermination {
  reason: AgentTerminationReason;
  detail?: string;              // 清洗后、限长的公开排障摘要
}

interface ExpertRunResult {
  sessionId: string;
  finding?: AgentExpertFinding;
  usage: AgentUsage;
  diagnostics: AgentRunDiagnostics;
  termination: AgentTermination;
}
```

`finding.status=failed` 是业务 Finding，不等于 Runtime 失败；合法 Finding 对应 `termination.reason=completed`。没有合法 Finding 时 `finding` 可缺失。历史 ExpertTask 的新增 `usage/termination` 为 optional，重启中断不得伪造 usage。

## 用量采集

- 每次 `run()` 创建独立 accumulator。只从 `message_end` 的 Assistant `message.usage` 采集；忽略流式 delta、ToolResult 的 usage，避免重复计算。覆盖多轮工具调用、Pi 内部重试和 JSON Repair Pass。
- 优先累加每条消息的 `usage.totalTokens`；若缺失，使用 `input + output + cacheRead + cacheWrite`。不要以 `input + output` 代替总量。`contextTokens` 用最后一条正常响应的 `totalTokens`，不是累计值或已完成 Session 的精确上下文占用。
- `cost` 只在 Pi 返回正的估算费用时累计并显示；零值可能表示未定价，UI 隐藏。没有公开价格表推算，也不把估算值称为实际账单。
- 若某次请求未返回 usage，只能记录已报告的部分用量。`turns` 是收到完成 Assistant 消息的次数，不保证等于 Provider 请求数或计费请求数；UI 明示这一口径。

## 终止与 Budget 边界

Runner 观察 `message_end` 的 `stopReason/errorMessage` 以及 `prompt()` 异常：合法 Finding 完成、Abort、Provider 失败、Repair 后仍无效输出、无法继续的工具异常、本地 Runtime 异常。单次可恢复工具错误只留在 ToolCallRecord；其后形成合法 Finding 仍算 completed。Abort 到达后完成的模型消息可以保留已报告用量，但 Service 最终以 Investigation 取消/替换状态裁决 Task；终态只写一次。

Runner 仅报告执行事实，Service 同时写 Task 终态、Finding、Usage、Diagnostics、Termination 和现有预算分类。`termination.reason=provider_error` 本身**不**意味着可 Recovery；原有 `providerTransient` 判据仍由 Service 消费，结合已启动、Primary、无 completed Tool/Observation 等条件决定 `terminationReason=provider_transient_error`、`recoveryEligible` 与 Ledger disposition。保留旧 `terminationReason` 的写入和历史读取，因它是预算/中断分类，不与新 Runtime 字段同义。Service 在 Semaphore 等待阶段的取消或启动前错误，以及 Repository 的 `service_restart`，可以没有 Runner Result 或 Usage。

## 持久化、投影与展示

与 Task 终态同一次保存，Usage 不建 Event Ledger。Main Agent 的 `compactInvestigation()` 仅保留 Task status、finding 与 termination.reason 等推理相关信息，去掉当前完整的 diagnostics；API 的完整 Investigation 仍保留 Runtime 数据。Pi Chat UI 经由 `expert.completed` → `RcaChatEventMapper` → `agent.completed` → `AgentThreadRun` 展示，历史事件重放和刷新必须一致。旧事件/旧 Task 缺字段时隐藏用量，旧终止说明可回退至 `terminationReason`。

卡片只显示有值的轮次、Token、工具数；详情显示各 Token 桶、最近响应上下文、工具/扫描/内存、终止原因、Repair 状态。没有可靠运行开始时间时不显示 duration。错误 detail、diagnostics.failureDetail、失败 Finding summary 和事件输出须经过同一清洗边界，避免凭截断长度泄露凭据。

## 验证

覆盖单轮、多轮工具、Repair 成功/失败、Provider 抛错与消息错误、Abort 竞态、工具失败后成功、不可恢复工具错误、并发 accumulator 隔离、Budget V2 Provider 瞬时故障 Recovery 保持原规则、重启无伪造 usage、历史 Task/API/UI 重放以及 Main Agent 不接收完整诊断字段。核对 t039 回放时关注预算和 Finding 行为没有变化。

本次 Usage 仅做 Accounting，Termination 仅描述 Runtime 事实，Budget 继续控制策略。不增加 Token/Cost Budget 或模型配置。
