# Runtime Execution API 设计

> 目标：让 Spring Management Server 可以启动完整 RCA，同时继续复用现有 Conversation + Pi Main Agent 链路。

## 1. 设计原则

外部执行入口不能直接调用 `RcaService.beginAgentic()`。该方法只初始化 Investigation；完整调查仍依赖 Main Agent 调用 RCA tools。

因此 Runtime Execution 的执行单元定义为一个“受管理的 Conversation Session”：

```text
Management Task
    ↓
Runtime Execution
    ↓
Dedicated Conversation
    ↓
Pi Main Agent
    ↓
start_rca_investigation
    ↓
Hypothesis / Expert / Evidence / Conclusion
```

这意味着外部入口复用当前已经验证的 Main Agent，而不是另建 orchestrator。

## 2. API

### 创建或获取执行

```http
POST /api/rca/executions
X-Request-ID: <trace id>
Idempotency-Key: <stable business key>
Content-Type: application/json

{
  "caseId": "t039"
}
```

响应：

```json
{
  "runtimeExecutionId": "EXEC-...",
  "conversationId": "...",
  "investigationId": null,
  "status": "accepted",
  "replayed": false
}
```

同一 Idempotency-Key 重放时返回同一个 runtimeExecutionId，并设置 `replayed=true`。

### 查询执行

```http
GET /api/rca/executions/{runtimeExecutionId}
```

响应只给执行摘要，不复制 Evidence/Hypothesis。

### 取消执行

```http
POST /api/rca/executions/{runtimeExecutionId}/cancel
```

取消顺序：

1. 若已经关联 Investigation，取消 RCA；
2. Abort Main Agent Conversation；
3. Execution 状态映射为 cancelled。

## 3. Runtime Execution 状态

```text
reserved
dispatching
running
settled
failed
cancelled
unknown
```

- reserved：幂等记录已持久化，还未确认 Prompt 被提交；
- dispatching：正在将稳定的执行 Prompt 交给 Main Agent；
- running：Main Agent 或 Investigation 正在运行；
- settled：Main Agent 已结束；最终 RCA 质量看 Investigation.rootCause.status；
- failed：明确的本地失败；
- cancelled：明确取消；
- unknown：无法确认远端/Session 是否接受执行。

## 4. 幂等记录必须先于副作用

错误顺序：

```text
创建 Conversation
→ 启动 Main Agent
→ 最后才写 idempotency record
```

如果进程在第二步后崩溃，重试会创建第二次执行。

正确顺序：

```text
持久化 reservation
→ 确定 runtimeExecutionId / conversationId
→ 创建/恢复固定 Conversation
→ 提交稳定 Execution Prompt
→ 更新 execution record
```

runtimeExecutionId 和 conversationId 在 reservation 时就固定，重试不能重新生成。

## 5. Stable Execution Prompt

外部执行使用稳定 Prompt，并包含 runtimeExecutionId 标识：

```text
[RUNTIME_EXECUTION EXEC-xxx]
请对 RCA case t039 发起并完成一次完整根因调查。
必须使用当前 Main Agent 的 RCA tools 驱动 Investigation，并在证据允许时调用 conclude_investigation 收敛。
```

该标识用于崩溃恢复时识别 Prompt 是否已经进入 Session 历史。

它不是业务数据事实源，仅是 Session 侧的去重辅助标识。

## 6. 进程崩溃窗口

### A. reservation 后、创建 Conversation 前崩溃

重试读取同一个 reservation，使用固定 conversationId 继续创建/恢复即可，不产生第二个 execution。

### B. Conversation 创建后、Prompt 前崩溃

重试发现 Session 内不存在 execution marker，提交 Prompt。

### C. Prompt 已进入 Session、execution record 尚未更新时崩溃

重试先检查 Session 历史中的 execution marker。存在则不得再次 prompt，只修复 execution record。

### D. Main Agent 正在运行时重启

沿用现有 Conversation / Investigation 恢复语义。若 Investigation 已进入 running 并因重启被标记 interrupted，Execution 查询应反映该事实；是否自动 resume 由后续恢复策略决定，不在 HTTP handler 中隐式执行。

## 7. 并发

同一个 Idempotency-Key 的并发创建必须单飞。

第一阶段单实例 Runtime 可以使用：

- 持久化 reservation 作为跨重启事实源；
- 进程内 keyed lock 解决同实例并发。

在 Runtime 扩展成多副本前，必须升级为数据库唯一约束或共享存储上的原子 compare-and-set。不能把进程内 Map 描述成多实例安全。

## 8. 持久化

Runtime Execution 是 Runtime 自己的协议状态，不属于 Spring Task 数据库，也不属于 Investigation。

建议目录：

```text
<PI_CHAT_ROOT_DIR>/rca-executions/
  <sha256(idempotency-key)>.json
```

记录：

```json
{
  "runtimeExecutionId": "EXEC-...",
  "idempotencyKeyHash": "...",
  "caseId": "t039",
  "conversationId": "...",
  "status": "reserved",
  "createdAt": "...",
  "updatedAt": "...",
  "investigationId": null,
  "lastError": null
}
```

默认不落盘原始 Idempotency-Key，只保存 hash，降低外部业务标识泄漏风险。

## 9. Spring 的职责

Spring Task/Execution 与 Runtime Execution 的关系：

```text
management_execution.runtime_request_id
        ↓
Runtime runtimeExecutionId
        ↓
Conversation
        ↓
Investigation
```

Spring 不根据本地状态猜 Investigation ID；由 Runtime Execution 查询返回关联关系。

## 10. 第一版验收

真正开放创建接口前必须具备：

- 同一 Idempotency-Key 返回相同 runtimeExecutionId；
- caseId 与已存在幂等记录冲突时拒绝；
- reservation 先持久化；
- execution marker 可识别；
- 并发单飞测试；
- 重放不重复 prompt 的测试；
- Runtime 重启后 reservation 可恢复；
- 不修改 Main Agent RCA 编排逻辑。
