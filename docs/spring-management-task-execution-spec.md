# Spring 管理面 Task / Execution 模型设计

> 本文是 `spring-management-server-spec.md` 的第二阶段细化。目标不是把 Node/Pi 的 Investigation 搬进 Java，而是定义 Spring 真正拥有的数据模型。

## 1. 为什么需要 Task / Execution

如果 Spring 只代理 `/api/rca`，它只是 HTTP 转发层，没有形成真正的管理面。管理侧真正需要管理的是：谁发起任务、任务来自哪里、一次任务尝试执行了几次、每次执行绑定了哪个 Runtime、对应哪个 Investigation、请求是否重复，以及 Runtime 超时或重启后如何解释状态。

因此定义三层：

    Task（平台意图）
      ├── Execution #1（一次运行尝试）
      │      └── Investigation A（Agent 内部调查）
      └── Execution #2（重试/重新执行）
             └── Investigation B

## 2. 对象所有权

### Task —— Spring 所有

Task 表示“平台希望完成的一件 RCA 工作”。建议字段：taskId、source、sourceRef、title、caseId/alertRef、createdBy、status、currentExecutionId、idempotencyKey、createdAt、updatedAt。

Task 不保存 hypothesis、evidence、toolCall 等 Agent 内部状态。

### Execution —— Spring 所有

Execution 表示 Task 的一次实际运行尝试。建议字段：executionId、taskId、attempt、runtime、runtimeRequestId、investigationId、status、startedAt、finishedAt、failureCode、failureMessage。

Execution 只引用 Investigation ID，不复制 Investigation 内容。

### Investigation —— Node/Pi 所有

Investigation 继续保存 hypothesis、observation、evidence、expert task、tool call、budget ledger、RCA result、report 和 Agent 生命周期状态。Spring 不直接修改这些字段。

## 3. ID 与关系

建议：Task 使用 `TASK-<uuid>`，Execution 使用 `EXEC-<uuid>`，Investigation 继续使用 `INV-...`。

关系：Task 1:N Execution；Execution 0..1:1 Investigation。Execution 在 Runtime 请求真正被接受前，investigationId 允许为空。

## 4. 状态机

TaskStatus：PENDING、RUNNING、SUCCEEDED、FAILED、CANCELLED。

ExecutionStatus：CREATED、DISPATCHING、RUNNING、SUCCEEDED、FAILED、CANCELLED、UNKNOWN。

UNKNOWN 很重要：Spring 对 Node 发起创建类请求后发生网络超时，并不能证明 Node 没有执行请求。此时不得直接标记 FAILED 并立即重试，否则可能产生重复 Investigation。

## 5. Investigation 状态映射原则

Spring 可以做只读映射，但不能反向覆盖 Runtime。

| Runtime Investigation | Execution |
| --- | --- |
| running | RUNNING |
| interrupted | FAILED 或等待恢复策略 |
| cancelled | CANCELLED |
| completed + confirmed/probable/inconclusive | SUCCEEDED |

`probable` / `inconclusive` 是 RCA 结论质量，不等于平台执行失败。HTTP 查询失败也不应直接改变持久状态。状态映射应集中在 mapper 中，不散落在 Controller。

## 6. 创建任务时的幂等

未来 Spring 接受告警平台请求时，应支持 `Idempotency-Key`。数据库必须对可重放请求建立唯一约束，例如 `(source, idempotency_key) UNIQUE`。

同一幂等键重复提交时：已创建 Task 就返回已有 Task；已进入执行不得再次触发 Runtime；上一次状态为 UNKNOWN 时先查询/对账，不立即重试。

不能只靠 JVM 内的 ConcurrentHashMap 做幂等，因为服务重启后会失效。

## 7. Request ID 与 Idempotency Key

未来所有会创建 Agent 状态的写请求都应携带：

- `X-Request-ID`：链路追踪，一次 HTTP 调用一个；
- `X-Idempotency-Key`：业务去重，同一个逻辑创建请求保持稳定。

两者不能混为一个字段。

## 8. 为什么当前不实现 POST /api/management/tasks → RCA

当前 Node 的 `RcaService.beginAgentic()` 只负责初始化 Investigation 和加载 alert context。真正的 Main Agent 调查循环仍然由 Conversation / Pi Main Agent 触发并驱动。

如果 Spring 现在直接调用 beginAgentic，会出现：Spring 创建 Investigation → 只加载 alert context → 没有 Main Agent 持续推进。

因此在 Runtime 侧形成明确的“外部执行入口”前，Spring 不伪造 Task 创建能力。

下一阶段 Runtime 应先提供真正的执行契约，例如：

    POST /internal/rca/executions
        ↓
    Runtime 创建 execution context
        ↓
    启动 Main Agent 调查
        ↓
    返回 investigationId / runtimeExecutionId

该入口必须复用现有 Main Agent 机制，而不是创建第二套 orchestrator。

## 9. 数据库边界

引入数据库后，Spring 保存 management_task 与 management_execution；不保存 hypothesis、evidence、observation、tool_call、budget_ledger，这些仍属于 Runtime。

建议表：

management_task：id、source、source_ref、case_id、title、status、current_execution_id、idempotency_key、created_at、updated_at。

management_execution：id、task_id、attempt、runtime_request_id、investigation_id、status、failure_code、failure_message、started_at、finished_at、created_at、updated_at。

## 10. 并发与事务

创建 Execution 时，在数据库事务内：锁定 Task → 检查活动 Execution → 创建 Execution(CREATED) → 更新 currentExecutionId → 提交事务；事务外再调用 Runtime。

不要把远程 HTTP 调用放进数据库事务，否则慢调用会长期占用数据库连接和锁。

推荐模式：

    DB Transaction: reserve execution + commit
        ↓
    HTTP Runtime
        ↓
    DB Transaction: bind investigation + update status

## 11. 崩溃窗口

窗口 A：Execution 已落库、Spring 还没调用 Runtime 就崩溃。Execution 保持 CREATED/DISPATCHING，可由恢复任务识别。

窗口 B：Runtime 已创建 Investigation、HTTP 响应返回前 Spring 崩溃。这是最危险的窗口。解决依赖 Runtime 对 idempotencyKey 的持久化支持。Spring 重试时 Runtime 必须返回第一次创建的 execution/investigation，而不是再创建一个。

因此真正实现 Task 创建 API 前，必须先补 Runtime 幂等协议。

## 12. 当前迭代结论

本轮 Spring 继续完成管理面基础设施：Request ID、Runtime health、Runtime Client 错误边界、中文设计意图注释、Task / Execution 领域规格。

暂不实现假的内存 TaskRepository，也暂不为了展示 Controller 而制造不可恢复的 Task 数据。

下一步进入持久化实现前，需要先确定 MySQL 表结构、持久层选型、Runtime 外部执行入口以及创建请求的持久化幂等协议。


## 13. 持久层实施决策

当前实现采用：

- MySQL；
- MyBatis-Plus 3.5.16；
- Flyway 管理 DDL；
- domain model 与 persistence entity 分离；
- `row_version` 乐观锁；
- reserve Execution 时对 Task 使用 `SELECT ... FOR UPDATE`。

管理面 Execution ID 使用 `MEXEC-<uuid>`，Node Runtime Execution 继续使用 `EXEC-<uuid>`，避免日志和排障时混淆两类执行 ID。

幂等键不以原文入库。Spring 仅保存 `SHA-256(idempotencyKey)`，并通过 `(source, idempotency_key_hash)` 唯一约束保证跨进程、跨重启幂等。

数据库事务边界保持：

```text
transaction A:
  create/reuse Task
  reserve ManagementExecution
  commit

outside transaction:
  call Node Runtime Execution API

transaction B:
  bind runtimeExecutionId / investigationId
  update status
  commit
```

远程 HTTP 调用不得进入数据库事务。


## 14. Task HTTP API

当前管理面开放以下平台内部接口：

```text
POST /api/management/tasks
GET  /api/management/tasks/{taskId}
POST /api/management/tasks/{taskId}/execute
POST /api/management/tasks/{taskId}/sync
```

所有 Task API 使用独立的 `MANAGEMENT_API_TOKEN` 进行 Bearer 鉴权。该 token 与 Node Runtime 的 `AGENT_RUNTIME_EXECUTION_TOKEN` 不同，避免一个凭证同时拥有“进入 Spring 管理面”和“直接调用 Agent Runtime”两种权限。

创建与执行分离：

```text
POST /tasks
  -> 幂等落库，不调用模型

POST /tasks/{id}/execute
  -> reserve MEXEC
  -> transaction commit
  -> 调 Node Runtime
  -> transaction bind result
```

`sync` 是纯对账操作。如果 Task 没有 currentExecution，则直接返回当前 Task，不得为了同步而隐式创建 Execution。

API View 与 Domain/Persistence Entity 分离；对外不返回 `idempotency_key_hash`、`row_version` 等内部字段。

### 取消暂缓开放

取消的危险窗口：

```text
MEXEC = DISPATCHING/UNKNOWN
Spring 尚未拿到 runtimeExecutionId
Node 可能已经启动 Main Agent
```

此时直接把 MySQL 状态改成 CANCELLED 会造成“管理面显示已取消，但 Runtime 仍运行”。因此取消接口必须先完成：使用 `management:<MEXEC-id>` 幂等重放/对账 -> 获得真实 Runtime Execution -> Runtime cancel -> 再提交管理面 CANCELLED。实现前不开放表面 cancel API。
