# RCA Investigation Budget 重构规格

状态：Review resolved / 开发契约（Budget v2 整体切换前须完成第 21、22 节验收）
范围：Pi Ops RCA Main Agent / RcaService / Expert Task 生命周期 / Investigation 持久化  
目标版本：Budget v2

## 1. 背景

当前 RCA 调查预算主要依赖 `expertTasks.length`、`failed + 0 evidence`、按 role 推断 recovery 等规则组合实现。

现有规则大致为：

- 单批最多 3 个 Specialist Task；
- “有效 Task”最多 4 个；
- 历史物理 Task 总数最多 6 个；
- Specialist 内部 `maxToolCalls` 通常为 12；
- Metrics 额外限制 `query_metrics <= 6`；
- 查询结果还有 topN / limit / compact context 等数据预算。

这套机制能阻止无限派发，但暴露了一个根本问题：

> Task 历史记录与预算消费被混为一谈。

例如 t039 调查中，失败且未形成 Evidence 的 Task 虽然从“有效 Task”口径中释放，却仍永久占据 `expertTasks.length`，导致后续合法的 recovery + primary dispatch 被 `totalAfterDispatch > 6` 拒绝。

此外，当前实现还有以下边界风险：

- recovery 通过“历史上同 role 曾失败”推断，无法明确关联被恢复的 Task；
- `completed + 0 evidence`、`cancelled`、`failed + partial observation` 的预算语义不清晰；
- 用户 steering 导致的 superseded Task 可能继续污染有效预算；
- 并发 dispatch / cancel / conclude / expert completion 之间可能出现竞态；
- Repository 的 write queue 只能保证磁盘写入顺序，不能保证业务上的 read-check-write 原子性；
- 服务重启可能发生在 reserve / task create / task complete / budget commit 任意窗口；
- 如果只持久化 `budget.used` 数字，崩溃后可能出现 Task 状态与预算数字不一致；
- Main Agent overview / candidate coverage 等查询未纳入统一的 Operational Safety 视角。

因此本次不继续给旧计数器补条件，而是重新定义 Budget Domain Model。

---

## 2. 目标

本次重构要实现：

1. **Task History 与 Budget Ledger 解耦**
   - `expertTasks[]` 只表示“发生过什么”；
   - Budget Ledger 表示“预算实际如何消费”。

2. **Primary / Recovery 显式分类**
   - Primary 表示正式调查尝试；
   - Recovery 表示针对明确失败 Task 的容错重试；
   - Recovery 必须显式引用 `recoveryOfTaskId`。

3. **Reserve / Commit / Release 生命周期**
   - dispatch 前先 reserve；
   - 正常完成后 commit；
   - 某些取消/外部故障场景 release。

4. **Budget Event 作为预算事实源**
   - Budget 由 `investigation.json` 内不可变的 `budgetLedger` fold 得到；
   - Task intent/terminal 与对应 Budget Event 在同一次原子 JSON 替换中持久化；
   - `events.jsonl` 继续只用于 UI/SSE 通知，不参与预算回放；Snapshot 只作 projection/cache。

5. **并发与竞态安全**
   - 同一 Investigation 的预算和 Task 状态修改必须经过同一 Service 级锁；
   - Batch dispatch 必须 all-or-nothing；
   - terminal transition 必须 first-wins；
   - Runtime concurrency 与 Semantic Budget 分离。

6. **崩溃恢复可确定**
   - 任意 crash window 都能通过事件回放 + reconciliation 收敛到唯一状态；
   - 不通过直接改数字修复账本。

7. **保留现有产品语义**
   - Main Agent 决定“查什么”；
   - Server 决定“最多查多少”；
   - Specialist 继续只负责专项取证；
   - 不改变 Evidence / Hypothesis / RCA Report 的职责边界。

---

## 3. 非目标

本次不做：

- 不重写 Main Agent orchestration；
- 不替换 Pi Agent runtime；
- 不修改现有 Expert Profile 的核心工具策略；
- 不引入数据库或分布式锁；
- 不支持多 Railway Replica 对同一 Investigation 并发写；
- 不把 Hypothesis 2~4 立即改成硬上限；
- 不改变现有 `/api/rca` 外部接口定位；
- 不以 UI 展示预算为本次完成条件。

---

## 4. 核心术语

### 4.1 Primary Task

正常的 Specialist 调查任务。

Primary Budget 的含义不是“产出 Evidence 的 Task 数”，而是：

> 已经获得公平执行机会并完成一次正式调查尝试的 Task 数。

因此以下情况通常都会消费 Primary：

- finding=succeeded；
- finding=inconclusive；
- finding=blocked（数据或能力边界导致）；
- 正常完成但没有被接受的 Evidence；
- 已经完成实质取证后最终输出格式失败。

### 4.2 Recovery Task

只用于恢复一个明确的 execution failure。

必须满足：

- `budgetClass = recovery`；
- 存在 `recoveryOfTaskId`；
- 原 Task 当前 `recoveryEligible = true`；
- 原 Task 的 executionStatus 必须是 `failed`；
- 同一个失败 Task 不能被无限重复 Recovery。

### 4.3 Semantic Budget

用于约束调查策略：

- Primary Limit；
- Recovery Limit。

### 4.4 Runtime Concurrency

用于约束此刻真正仍在运行的 Specialist 数量。

它与 Semantic Budget 完全独立。

即使一个 user-superseded Task 在语义预算上已经 release，只要其 Promise / Pi Session / Tool 仍未真正退出，它仍占 Runtime Slot。

### 4.5 Operational Safety Ceiling

最终资源熔断器，不参与“调查策略预算”的含义。

用于防止：

- 高频 steering；
- 重复 retry；
- 恶意或异常 Main Agent 循环；
- 大量 superseded Task；
- Main Agent overview / candidate coverage 绕开 Specialist Budget。

Safety Ceiling 触发时应该明确返回“运行安全上限”，不能伪装成 Primary/Recovery Budget exhausted。

---

## 5. 设计不变量

以下规则视为实现完成的硬约束：

1. 同一个 Budget Reservation 只能终结为 `committed` 或 `released`，且只能一次。
2. 同一个 dispatch operation 不能重复创建 Task 或重复消费预算。
3. Batch dispatch 要么全部 reserve 成功，要么一个 Task 都不启动。
4. Recovery 必须显式引用一个 failed Task。
5. `inconclusive` / `blocked` 不可因为“结论不理想”获得 Recovery。
6. Failure classification 由 Server 决定，不能由 LLM 自报。
7. 用户 supersede 不消费 Primary，但旧 Task 真正退出前不释放 Runtime Slot。
8. `budgetLedger` 是预算事实源；同一次原子快照同时保存 Task 决议和 Ledger，projection 不能覆盖 Ledger 事实。
9. Crash 发生在 reserve / start / complete / commit 任一位置，都必须可 reconciliation。
10. dispatch、Tool/Observation/Evidence 接受、steering、conclude、cancel、task completion 经过同一 Investigation Lock；持久化决议 first-wins，迟到结果受 Task generation fencing。
11. 当前部署模型必须保持单 writer process；多实例不承诺一致性。
12. 历史 Investigation 必须可读取，不要求迁移旧数据后才能启动服务。
13. 已启动的 Agent 不得从 HTTP/Agent 重试或服务重启被隐式重新启动；Safety 对已启动工作不退款。
14. 相同 dispatchOperationId 绑定相同请求摘要；不同摘要必须报冲突。

---

## 6. Domain Model

### 6.1 Budget Policy

第一版沿用当前主要语义：

```ts
interface InvestigationBudgetPolicy {
  primaryLimit: number;      // default 4
  recoveryLimit: number;     // default 2
  maxParallelTasks: number;  // default 3

  safety: {
    maxTaskIntents: number;   // pending 也计，防止反复 steer 积累无界历史
    maxStartedTasks: number;
    maxUnderlyingToolCalls: number;
    maxMainAgentTurns?: number; // 仅在 Main Agent 调用入口可以可靠计量时启用
  };
}
```

说明：

- `primaryLimit=4`、`recoveryLimit=2`、`maxParallelTasks=3` 延续当前产品设计；
- Safety Ceiling 与语义预算解耦；
- Safety 默认值必须集中配置，不散落在 Service；
- Safety 数字需要通过 t039、steering、失败恢复回放校准，不应从“4+2”机械推导。
- 第一版 Policy 以 `maxTaskIntents=32`、`maxStartedTasks=16`、`maxUnderlyingToolCalls=100` 起步，保留单独的运行指标与调整记录；批量预留时先核对 Task intent 上限，即使尚未启动也不得无限创建。
- `maxStartedTasks` 至少允许 t039 的 7 次 Task 启动；全 Investigation 与进程级并发边界均须验证。

### 6.2 ExpertTask

建议在兼容现有字段的前提下增加：

```ts
type TaskBudgetClass = "primary" | "recovery";

type TaskExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

type TaskTerminationReason =
  | "model_error"
  | "invalid_output"
  | "tool_runtime_error"
  | "provider_transient_error"
  | "service_restart"
  | "user_superseded"
  | "investigation_cancelled"
  | "unknown";

interface ExpertTask {
  // existing fields...

  budgetClass: TaskBudgetClass;
  budgetReservationId: string;
  recoveryOfTaskId?: string;
  dispatchOperationId: string;
  taskGeneration: number;

  terminationReason?: TaskTerminationReason;
  recoveryEligible?: boolean;
}
```

说明：

- 第一版可以继续沿用当前 `status` 字段，避免大范围协议迁移；
- `executionStatus` 的概念必须在 Domain 中明确，即使代码暂时复用 `status`；
- `finding.status` 与 Task execution status 不能混为一谈。
- Recovery 来源必须是未被使用过的、服务端判定 eligible 的失败 Primary；Recovery 本身不可成为 Recovery 来源。

---

## 7. Budget Ledger

### 7.1 物理持久化边界

第一版选定**单个原子 JSON 文档**，不以两个文件组成事务：

- `investigation.json` 同时保存 Task History、不可变 `budgetLedger[]`、operation index 所需字段和可选 projection；
- 同一 Service Lock 内完成内存决议，并通过临时文件写入、flush、rename 原子替换整个文档；写入失败则不得启动 Session 或对外确认成功；
- dispatch reservation 与全部 pending Task 属于**同一次保存**，Task terminal、server classification、Budget commit/release 和接受的 Evidence 属于**同一次保存**；
- `events.jsonl` 是 SSE/UI 投影，不是 Budget Ledger，投影失败可重建/重发，不能回滚已确认的领域决议；
- 不把 `budgetLedger` 从 `investigation.json` 中提取到独立文件，除非以后迁移到提供事务的存储。

这使原 Draft 的“reservation 已落盘但 Task 未创建”及“Task terminal 已落盘但 Budget event 未落盘”在**新数据**上成为不可能的持久化状态。进程内尚未保存的更改不算已接受；保存成功但应答丢失用 operationId 重放查询。

### 7.2 Event 类型

预算事件必须携带稳定 reservationId：

```ts
type BudgetClass = "primary" | "recovery";

interface BudgetReservedEvent {
  type: "budget.reserved";
  reservationId: string;
  dispatchOperationId: string;
  taskId: string;
  budgetClass: BudgetClass;
  amount: 1;
  requestHash: string;
  recoveryOfTaskId?: string;
}

interface BudgetCommittedEvent {
  type: "budget.committed";
  reservationId: string;
  taskId: string;
  budgetClass: BudgetClass;
  reason: string;
}

interface BudgetReleasedEvent {
  type: "budget.released";
  reservationId: string;
  taskId: string;
  budgetClass: BudgetClass;
  reason: string;
}

interface SafetyConsumedEvent {
  type: "safety.consumed";
  executionId: string; // Task intent / start / underlying Tool start 的稳定 ID
  resource: "task_intent" | "started_task" | "tool_execution";
}
```

`budget.reserved` 的 Task intent、terminal event 的 Task/finding/Evidence 决议，与事件在同一 `investigation.json` 版本中保存。`dispatchOperationId` 关联整批 Task，`requestHash` 绑定 canonical briefs；同 ID 不同 hash 为冲突。Safety 按实际启动前的决议累计，即使之后失败、取消、steer 也不退款。

### 7.3 Fold 规则

Budget Projection 只能通过 Ledger fold 得出：

```text
reserved -> +reserved
committed -> -reserved +used
released  -> -reserved
```

非法状态：

- committed reservation 再 release；
- released reservation 再 commit；
- 不存在 reservation 直接 commit；
- 同一 reservation 重复 reserve。

完全相同的事件重放必须幂等 no-op，不得重复计数；同一 ID 的 class/task/operation/disposition 不一致必须 fail closed 并报警，而非静默忽略。每条 Ledger event 有单调序号和稳定业务 ID，回放验证顺序、Task 引用和投影一致性。

### 7.4 Snapshot

`investigation.json` 可以额外保留：

```ts
budgetProjection?: {
  primary: { used: number; reserved: number; limit: number };
  recovery: { used: number; reserved: number; limit: number };
  runningTasks: number;
  maxParallelTasks: number;
};
```

但它只是：

- UI / Main Agent 快速读取；
- 调试便利；
- 启动优化。

如果 Snapshot 与 Ledger 不一致，Ledger 胜出并重建 Projection。

---

## 8. Failure Classification

### 8.1 原则

不能再使用：

```text
failed + evidenceIds.length === 0
```

作为 Recovery 的唯一判断。

`evidenceIds.length === 0` 不代表没有完成实际调查，因为：

- Tool 成功会形成 Observation；
- Evidence 只有在 finding claim 被接受后才形成；
- Agent 可能完成多个 Tool Call 后在最终 JSON 输出失败。

### 8.2 Primary disposition

Server 根据执行事实计算：

```ts
type PrimaryDisposition =
  | "commit"
  | "release_recovery_allowed"
  | "release_no_recovery";
```

建议第一版规则：

| 场景 | Primary | Recovery |
|---|---|---|
| 正常 succeeded | commit | no |
| 正常 inconclusive | commit | no |
| 正常 blocked | commit | no |
| 正常完成但 0 Evidence | commit | no |
| invalid_output（包括 0 Tool） | commit | no |
| LLM finding.status=failed | commit | no |
| 可验证的 provider 瞬时失败，尚无 completed Tool/Observation | release | yes |
| 可验证的 tool infrastructure failure，尚无 completed Tool/Observation | release | yes |
| service restart 且已完成 Tool/Observation | commit | no |
| service restart 且无已完成工作 | release | yes（仍计 Safety） |
| user superseded | release | no |
| investigation cancelled | release | no |
| unknown | 默认 commit 或 fail-closed，不免费 Recovery |

原则：

> Recovery eligibility 使用 allowlist；默认 false。

只依据 `PiExpertRunError.failureReason=model_error` 不足以证明 provider transient；无法识别异常来源时按 unknown 处理。已开始但未能持久化完成的工具仍计 Safety；不能据 0 Evidence、0 completed Observation 推断物理成本为 0。相同目标通过新 Primary 绕开 Recovery 必须受 operation/lineage 防重和 Safety Ceiling 约束；同一 failure 只能授予一次 replacement entitlement。

### 8.3 Recovery disposition

Recovery 一旦真正启动，原则上会消费 Recovery Budget：

- 成功：commit；
- execution failure：commit；
- invalid output：commit；
- user superseded：release；
- whole investigation cancelled：release。

Recovery 永不产生新的 recoveryEligible；原 Task 的 eligibility 在 reserve Recovery 时原子消费，不等运行结束再消费。

这样避免 Recovery 自己形成无限免费重试。

---

## 9. 并发模型

### 9.1 Service 级 Investigation Lock

新增 keyed mutex：

```ts
withInvestigationLock(investigationId, operation)
```

以下操作必须经过该锁：

- dispatch reserve；
- Task terminal transition；
- Budget commit/release；
- user intervention 对 Task 的 supersede；
- investigation cancel；
- conclude；
- restart reconciliation；
- recovery eligibility 消费。
- ToolCall/Observation/Evidence 接受与 ID 分配；
- Investigation/Task generation 校验；
- Safety 消耗决议。

现有：

- Main Agent `serializeMutation`；
- Repository `saveQueue`；
- EventBus `publishQueue`

均继续保留，但不能替代 Domain Lock。

职责：

- `serializeMutation`：约束单个 Main Agent Tool 实例；
- `withInvestigationLock`：保证 Investigation 业务原子性；
- `saveQueue`：只保证磁盘写顺序，保存输入必须是不可变快照，不能传递随后仍被修改的对象；
- `publishQueue`：只保证 UI 事件 append / projection 顺序，不参与 Budget 事实判定。

### 9.2 Batch Dispatch

在锁内完成：

```text
load/fold budget
-> validate entire batch
-> validate recovery references
-> validate safety ceiling
-> allocate taskIds/reservationIds
-> 在单次原子 investigation.json 替换中保存 reservation + 全部 pending Task intent
-> unlock
-> acquire runtime slots
-> 锁内确认未取消、记录不可退款的 Safety start 与 running 状态
-> start Pi sessions
```

任何一个 brief 不合法，整批不启动。

### 9.3 Dispatch 幂等

每次 Main Agent `dispatch_investigations` 必须有稳定：

```text
dispatchOperationId
```

可由 Main Agent toolCallId 派生，但还必须覆盖 HTTP 重试与 Main Agent Session 重建；相同 ID 须携带 canonical requestHash。不同 hash 一律冲突。

同一个 operationId 重放时：

- 返回第一次创建的 Task 集合；
- 不再次 reserve；
- 不再次启动同一 Task。

如果第一次调用仍运行，重放返回 operation/Task 当前状态或等待同一个 Promise；不得返回一个假装已完成的 finding。恢复后的 pending/running 历史 Task 不自动重启。

---

## 10. Runtime Concurrency

Runtime Concurrency 与 Budget 分离。

实现上使用 per-Investigation semaphore：

```text
maxParallelTasks = 3
```

Task 获取 runtime slot 后才能真正启动 Pi Session。

Task 在以下条件全部满足后才释放 Runtime Slot：

- Expert run Promise settled；
- Pi Session disposed；
- 相关 Tool execution 不再 active；
- Service 已完成 terminal reconciliation。

用户 steering：

```text
semantic reservation release
!=
runtime slot release
```

旧 Agent 仍在退出时，新 Agent 必须等待 semaphore。

这样避免“旧 3 个正在 abort + 新 3 个已经启动”的瞬时 6 并发。

---

## 11. Operational Safety Ceiling

为了防止 Semantic Budget 被 steering/retry 绕过，需要独立 Safety Ledger/Counter。

至少统计：

- 已创建 Task intent 总数（包括未拿到 Runtime Slot 就被 steer/cancel 的 pending Task）；
- started Specialist Task 总数；
- underlying observability Tool execution 总数；
- Main Agent overview；
- candidate coverage 内部真实 query 次数；
- Specialist tool calls。

Safety Ceiling：

- 不因 user superseded 自动归零；
- 不因 Primary release 自动归零；
- 只在新 Investigation 创建时重置。

触发时返回独立错误：

```text
Investigation operational safety limit reached
```

不能返回“Primary Budget exhausted”。

第一版 Safety 默认值在开发前由回放测试确定，并放在单一 Policy 常量中；禁止散落 magic number。

---

## 12. Task Completion 与用户中断竞态

规则：

> 谁先在 Investigation Lock 内写入 terminal 决议，谁赢。

Steering 生效点是锁内持久化 Task generation/`user_superseded` 决议，**不是**用户消息到达、`session.prompt(...steer)` 返回或 AbortSignal 触发。锁外的 Agent/Tool 完成后，必须先核对 generation 与 Investigation 状态，过期结果不可产生新的 Observation/Evidence、Task 成功事件或预算处置。

### Task completion first

```text
task -> completed
budget -> committed
unlock
user steer arrives
-> task already terminal
-> no cancel
```

### User supersede first

```text
lock
task -> cancel_requested / user_superseded
budget -> released
unlock
abort signal
later model result arrives
-> terminal already decided
-> cannot become completed or append accepted Evidence
```

注意：

- 语义 budget 可先 release；
- runtime slot 必须等 run 真正 settled 后释放。

---

## 13. Cancel / Conclude 安全边界

### 13.1 Terminal first-wins

Investigation：

```text
completed | inconclusive | failed | cancelled
```

一旦进入 terminal，后续 terminal transition 只能 no-op / reject。

### 13.2 Conclude 前置条件

`conclude_investigation` 在 lock 内至少检查：

- 无 running/pending Specialist；
- 无 active budget reservation；
- 无 active dispatch；
- Investigation 仍是 running；旧 interrupted Investigation 保留 legacy conclude 行为（第 19 节）；
- causal/evidence validation 仍通过现有规则。

如果还有 Task 正在退出，不允许 conclude。

### 13.3 Cancel

Cancel：

- 在 lock 内标记 Investigation cancelling/terminal intent；
- 释放尚未完成的 Semantic reservation；
- 发送 abort；
- 在锁内持久化 cancelled terminal 决议并 fencing 所有 active Task；
- 等 activeOperations / runtime slots settle 后再清理运行资源（等待可有超时和告警，但不得提前释放 slot）。

避免 cancelled Investigation 后又写入新的 Evidence/Task terminal 状态。

---

## 14. Crash Recovery / Reconciliation

启动恢复不能只做当前：

```text
running -> interrupted
```

还需要 Ledger fold/reconciliation。新格式的 Task/Budget 决议在同一次原子 JSON 替换中持久化，恢复只能看到完整的旧版本或完整的新版本；不得尝试凭 UI `events.jsonl` 填账。

至少覆盖：

### Window A：save 前崩溃

```text
内存中生成 reservation + Task intent
原子 save 尚未成功
crash
```

恢复：

- 磁盘上两者都不存在；重放相同 operationId 可正常首次执行；不得已启动 Pi Session。

### Window B：pending/running 决议已持久化

```text
reservation + pending/running Task 同时落盘
Agent 尚未完成
crash
```

恢复：

- Task -> failed/interruptedByRestart；
- 根据已持久化的 ToolCall/Observation 和服务端分类，Primary commit 或 release；
- 根据 allowlist 设置 recoveryEligible；
- 在同一次原子保存中写 Task terminal + Budget terminal event；已开始的 Task 不自动重启。

### Window C：terminal 决议已持久化，应答/通知未送达

```text
Task terminal + Budget terminal event + accepted Evidence 已一起落盘
UI event 或 HTTP response 尚未送达
crash
```

恢复：

- 直接 fold 已持久化 Ledger；相同 operationId 返回既有结果；必要时重新投影 UI 通知；不得再次调用 Expert。

### Window D：保存后 projection 过期

```text
Ledger 已落盘
可选 budgetProjection 过期
crash
```

恢复：

- Ledger fold 得出正确值；
- 重建 Snapshot。

---

## 15. Event Log 工程边界

`events.jsonl` 不承载 Budget 事实，但现有 SSE/UI 读取仍需加强：

1. 每个 Investigation 只有一个 event writer；
2. append 顺序由统一 queue 保证；
3. 最后一条 crash-corrupted JSON line 不得导致整个 Investigation 无法恢复；
4. 不允许静默忽略中间损坏记录；
5. 对无法解析的尾部记录进行 quarantine / warning；
6. event id / reservation id 必须稳定且可判重。

只可容忍最后一条未完整写入、未以换行终止的尾记录；先隔离/截断尾部再继续 append，不能让下一条粘在坏记录后。中间坏行、冲突重复与序号缺失 fail closed。Budget Ledger 位于原子 JSON 快照，不依赖该文件的尾部修复。

`investigation.json` Snapshot 建议改为原子替换：

```text
write temp
-> flush/close（包括需要的文件/目录持久化边界）
-> rename
```

防止进程崩溃留下半个 JSON。

---

## 16. 单实例约束

当前所有：

- keyed mutex；
- mutationQueue；
- saveQueue；
- EventBus queue；

都是进程内同步。

因此 Budget v2 的明确部署前提：

> 同一个持久化目录只能由一个 Pi Ops writer process 写入。

单实例还不等于持久化。当前 Docker 默认将调查目录置于 `/tmp/pi-chat/data/rca/investigations`，仓库配置不能证明 Railway 生产已挂载持久卷。上线前必须实际验证同一 writer、持久卷路径、重部署后的数据保留，以及进程重启恢复；否则 Budget v2 不允许声称 crash-safe。

未来如果需要多个 Replica / HA：

- Budget Ledger 和 Investigation state 应迁移到具备事务和锁语义的数据层；
- 不在本次用文件锁模拟分布式事务。

---

## 17. Main Agent 可见 Budget

`get_investigation_state` 和 `dispatch_investigations` 返回 Budget Projection：

```json
{
  "budget": {
    "primary": {
      "used": 3,
      "reserved": 0,
      "limit": 4,
      "remaining": 1
    },
    "recovery": {
      "used": 1,
      "reserved": 0,
      "limit": 2,
      "remaining": 1
    },
    "runtime": {
      "running": 0,
      "limit": 3
    },
    "safety": {
      "startedTasks": 5,
      "toolExecutions": 23
    }
  }
}
```

Main Agent Prompt 不再猜“是否快没预算”，而是根据 projection 选择最有信息增益的下一步。

---

## 18. Hypothesis Budget

本次不加 `hypotheses.length <= 4` 硬限制。

原因：

- rejected / superseded 假设属于历史；
- 历史总数超过 4 是合理的。

后续如需要约束，应该约束：

```text
active hypotheses <= 4
```

Active 定义：

- possible；
- investigating；
- supported。

而 rejected / superseded 不计。

---

## 19. 历史数据兼容

旧 Investigation 没有：

- `budgetClass`；
- `reservationId`；
- `recoveryOfTaskId`；
- Budget Ledger。

兼容原则：

1. 旧 terminal Investigation 继续只读，不强制回填 Ledger；
2. 旧 interrupted/running Investigation 如需 resume，整个 Investigation 固定使用 legacy budget 路径直至 terminal；不混用 v1 Task 与 v2 Ledger；
3. 新建 Investigation 必须完全使用 Budget v2；
4. 不允许启动时批量重写全部历史 JSON。

用显式 schemaVersion 选择路径；旧 terminal 仍只读。已有 interrupted Investigation 可从持久化 Evidence 直接 conclude，保留这一现有行为，不施加 v2 的 running-only 前置条件。

---

## 20. 测试矩阵

### 20.1 正常预算

- 4 个 Primary 正常完成；
- 第 5 个 Primary 被拒；
- 单批 3 个允许，4 个拒绝；
- inconclusive 消费 Primary；
- blocked 消费 Primary；
- completed + 0 evidence 消费 Primary。

### 20.2 Recovery

- provider 瞬时失败、无实际工作 -> Primary release + recoveryEligible；
- Recovery 显式引用 failed Task；
- Recovery 成功后 Recovery used +1；
- Recovery 自身失败仍 consume Recovery；
- 同一个 failed Task 不允许重复成功 recovery；
- 同一 failure 的 Recovery eligibility 在 reserve 时即消费；Recovery 失败不能继续链式 Recovery；
- 同 operationId 不同 briefs/requestHash 报冲突；
- inconclusive 不允许 recovery；
- blocked 不允许 recovery；
- role 相同但 unrelated Task 不会被误判 recovery。

### 20.3 Partial Work

- invalid JSON + 已有 observations -> Primary commit；
- model_error + 已完成 tool calls -> 不免费释放；
- 0 Evidence 但有 Observation -> 不按“无工作”处理。

### 20.4 Steering

- 3 个 Primary running 时 user supersede；
- Semantic reservation release；
- Runtime Slot 在旧 Agent settled 前不释放；
- 新 dispatch 不超过 runtime semaphore；
- superseded Task 历史保留；
- Safety Ceiling 继续累计。

### 20.5 并发

- 两个并发 dispatch 争最后 1 个 Primary；
- 只能一个 reserve 成功；
- dispatch 与 cancel 并发；
- dispatch 与 conclude 并发；
- completion 与 steering 并发；
- completion 与 cancel 并发；
- terminal first-wins。
- 迟到工具结果不能在 supersede/cancel 后追加 accepted Observation/Evidence；
- 同一 investigation 的不同 Main Agent Tool 实例和直接 Service 入口并发争最后一个名额；

### 20.6 幂等

- 同 dispatchOperationId 重放；
- 同 reservation commit 两次；
- 同 reservation release 两次；
- commit 后 release；
- release 后 commit；
- HTTP / Agent retry 不重复消费预算。

### 20.7 Crash Recovery

分别在以下点模拟 crash：

- reserve 后；
- task persist 后；
- agent start 后；
- task complete 后；
- budget commit 后；
- snapshot write 前后。

重启后必须满足：

- Budget Projection 唯一；
- 原子 JSON 保存前/后 crash 不产生 Budget/Task 半决议；
- 无永久 orphan reservation；
- 无重复 commit；
- Task 历史不丢；
- 可恢复 Task eligibility 正确。

### 20.8 t039 回归

至少回放已暴露的路径：

```text
T01 trace primary -> completed
T02 metrics primary -> completed
T03 log primary -> execution failure
T04 log recovery(T03) -> completed
T05 event-topology primary -> execution failure
Round 3:
  event-topology recovery(T05)
  + metrics narrow primary
```

预期（先用持久化 Tool/Observation 与真实失败原因判定 T03/T05 是否 eligible）：

- 不再因为历史 `expertTasks.length=5` 直接拒绝；若 T03/T05 已完成实质工作而 Primary 用尽，则应明确拒绝新 Primary，不能为让用例通过而误分类；
- 是否允许由 Primary / Recovery / Runtime / Safety 四个独立 projection 决定；
- 错误提示能指出具体耗尽的 budget class。

---

## 21. 实施步骤

### Phase 1：Domain Model + 原子持久化

- 新增 Budget policy / event / projection 类型；
- 新增 Task budget metadata；
- 实现 Ledger fold；
- Ledger 与 Task intent/terminal 同置于 `investigation.json`，原子替换；固定 v1/v2 schema 路由；
- 写点 crash/failpoint 和幂等单测先于生产切换；
- 保持旧 dispatch 行为不切换；
- 补 fold / idempotency 单测。

### Phase 2：Domain Lock + Runtime/Safety 基础

- 引入 per-Investigation keyed mutex；
- 所有 Task/Evidence/Tool 与 terminal 入口纳入相同串行边界；
- 加 per-Investigation runtime slot、进程级防护及 started Task/underlying Tool Safety 计数；
- 重启 reconciliation 和写入失败测试；
- 保持旧 dispatch 语义，尚不释放 Primary；

### Phase 3：原子 Batch Dispatch + 幂等

- dispatch 改为 batch reservation + pending Task 原子保存；
- 引入 dispatchOperationId；
- 绑定 requestHash，重复调用返回原 Task，不重新启动；
- 整批预算、Recovery 引用和 Safety 校验；
- 此时仍不得单独上线 Budget v2 开关。

### Phase 4：Failure Classification + Recovery + Steering

- 删除按 role 猜 recovery；
- 加 `recoveryOfTaskId`；
- Server 计算 recovery eligibility；
- Primary/Recovery 终态与 Task/Evidence 同次原子保存；
- generation fencing、steering/cancel/conclude first-wins；
- 补 partial observation / invalid output 测试。

### Phase 5：兼容与生产切换

- legacy 调查保持 legacy 路径，新 Investigation 才启用 v2；
- t039 与并发、写点崩溃、重启、Railway 持久卷验收通过；
- Runtime/Safety/分类/恢复整体就绪后一次性切换 v2 dispatch。

### Phase 6：Main Agent Projection / UI Event 加固

- 修复 `events.jsonl` 尾部记录恢复，不用它决定预算；
- state / dispatch 返回 budget projection；
- Prompt 使用剩余预算做调查决策。

---

## 22. 验收标准

Budget v2 完成后必须满足：

- t039 已知预算错误不再复现；
- failed/superseded/restart 不再通过 `expertTasks.length` 污染语义预算；
- Recovery 有明确来源 Task；
- Main Agent 无法把 inconclusive 当失败无限重试；
- 并发 dispatch 不会 oversubscribe；
- steering 不会造成瞬时超过 maxParallel 的子 Agent；
- 服务重启不会留下永久 reservation；
- 重放同一 dispatch / commit / release 不重复扣预算；
- Budget exhausted 错误能明确指出 Primary、Recovery、Runtime 或 Safety 哪一层耗尽；
- 旧 Investigation 可读取；
- 新 Investigation 的 Budget 状态能仅通过 Ledger 重建；
- Typecheck / lint / unit tests / build 通过；
- Railway 单实例重启回归通过。

---

## 23. 需要审查时重点挑战的问题

审查者应重点检查：

1. Primary release/commit 的失败分类是否存在免费刷预算路径；
2. Recovery eligibility 是否过宽；
3. Batch reserve 是否真的 all-or-nothing；
4. Service lock 是否覆盖所有 mutation 入口；
5. Runtime Slot 与 Semantic Budget 是否仍有混淆；
6. Event Ledger 是否存在双写不一致；
7. Crash reconciliation 是否能处理“Task terminal 已落盘但 budget terminal event 未落盘”；
8. user superseded 是否可能无限绕过 Safety Ceiling；
9. Main Agent overview 是否绕过全局资源约束；
10. 多实例假设是否被明确限制；
11. legacy Investigation 是否会被新 schema 破坏；
12. 是否有为了预算重构而无必要重写稳定 RCA orchestration 的风险。

---

## 24. 结论

Budget v2 的核心不是把 `4/6` 改成另一组数字，而是建立三个独立层次：

```text
Task History
  = 发生过什么

Semantic Budget
  = 还能做多少有意义的调查 / Recovery

Runtime Safety
  = 此刻和整个 Investigation 最多允许消耗多少系统资源
```

预算事实由 Ledger 事件产生，Task 与 Budget 通过显式 reservation / recoveryOfTaskId 关联，所有关键状态变化经过同一 Investigation Lock。

只有做到这一步，failed、inconclusive、user steering、cancel、restart、partial observation、并发 dispatch 等边界才能用同一套模型解释，而不是继续给旧计数器叠加特殊条件。
