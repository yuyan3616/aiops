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

Execution 不复制 Investigation 内容。进入 Spring 外置多 Agent 编排后，Execution 下还会拥有 AgentRun / AgentTurn / SubTask 等**调度元数据**；Hypothesis / Evidence / ToolCall 仍然不搬入 Spring。

### Investigation —— Node/Pi 所有

Investigation 继续保存 hypothesis、observation、evidence、expert task、tool call、budget ledger、RCA result、report 和 Agent 生命周期状态。Spring 不直接修改这些字段。

## 3. ID 与关系

建议：Task 使用 `TASK-<uuid>`，Spring Management Execution 使用 `MEXEC-<uuid>`，Node Runtime Execution 使用 `EXEC-<uuid>`，Investigation 继续使用 `INV-...`。

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

未来 Spring 接受告警平台请求时，应支持 `Idempotency-Key`。数据库必须对可重放请求建立唯一约束，例如 `(source, idempotency_key_hash) UNIQUE`；原始 Idempotency-Key 仅用于计算 SHA-256，不入库。

同一幂等键重复提交时：已创建 Task 就返回已有 Task；已进入执行不得再次触发 Runtime；上一次状态为 UNKNOWN 时先查询/对账，不立即重试。

不能只靠 JVM 内的 ConcurrentHashMap 做幂等，因为服务重启后会失效。

## 7. Request ID 与 Idempotency Key

未来所有会创建 Agent 状态的写请求都应携带：

- `X-Request-ID`：链路追踪，一次 HTTP 调用一个；
- `X-Idempotency-Key`：业务去重，同一个逻辑创建请求保持稳定。

两者不能混为一个字段。

## 8. Runtime 外部执行入口

现有 Runtime Execution API 继续用于可靠启动/恢复 Main Agent Session，但它不再被定义为“完整多 Agent 调度器”。

目标链路：

    Spring MEXEC
        ↓
    Runtime Execution / Main Agent Session reservation
        ↓
    Pi Main Agent
        ↓
    brief + turn-state
        ↓
    Spring Multi-Agent Orchestrator
        ↓
    Sub Agent Session(s)
        ↓
    findings
        ↓
    Spring durable delivery
        ↓
    Main Agent next turn

Spring 不直接调用 `RcaService.beginAgentic()`；Investigation 仍由 Node/Pi 所有。跨 Session 调度、SubTask 状态、findings 回传、blocked/resume 和恢复归 Spring。完整设计见 [Spring 多 Agent 编排规格](spring-multi-agent-orchestration-spec.md)。

## 9. 数据库边界

V1 已由 Spring 保存 management_task 与 management_execution。进入外置多 Agent 编排后，V2 再增加 management_agent_run、management_agent_turn、management_subtask；Spring 仍不保存 hypothesis、原始 evidence、observation、tool_call，这些属于 Runtime。

建议表：

management_task：id、source、source_ref、case_id、title、status、current_execution_id、idempotency_key_hash、row_version、created_at、updated_at。

management_execution：id、task_id、attempt、runtime_request_id、investigation_id、status、failure_code、failure_message、started_at、finished_at、row_version、created_at、updated_at。

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

该风险已经通过 Runtime Execution reservation、稳定 Idempotency-Key 和 Session marker 恢复机制处理。

## 12. 当前实现状态

当前已经具备：

- MySQL + Flyway + MyBatis-Plus 持久层；
- Task / ManagementExecution 数据模型；
- 数据库级幂等约束；
- Task 行锁 + row_version 乐观锁；
- 两段数据库事务与事务外 Runtime HTTP 调用；
- Runtime Execution 幂等协议；
- 创建、查询、执行、同步与安全取消 Task API；
- Management API Token 与 Runtime Execution Token 双重服务边界；
- 真实 MySQL 8.4 CI 集成测试。


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
POST /api/management/tasks/{taskId}/cancel
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

### 安全取消

取消覆盖三类路径：

```text
PENDING / 无 Execution
  -> 纯本地取消 Task

CREATED / 尚未 dispatch
  -> 持锁本地取消 MEXEC + Task

DISPATCHING / UNKNOWN / RUNNING
  -> 若缺 runtimeExecutionId，先使用 management:<MEXEC-id> 幂等重放恢复 Runtime Execution
  -> 调 Runtime cancel
  -> 根据 Runtime 返回状态提交管理面终态
```

任何远程结果不确定的取消都会保持 UNKNOWN，而不会谎报 CANCELLED。execute 与 cancel 的并发竞态通过持锁状态检查处理：如果 cancel 先把 Execution 推入终态，后续 execute 在真正调用 Runtime 前会再次检查终态并停止。


## 15. MEXEC 下的多 Agent 调度模型

Task / Execution 仍是平台最外层模型，但 MEXEC 内部增加：

```text
MEXEC
  ├── Main AgentRun
  │     └── 多个 AgentTurn
  └── SubTask 1..N
        └── Sub AgentRun
              └── 初始/续查 AgentTurn
```

SubTask 表示“查什么”，AgentRun 表示“哪个 Session 执行”，AgentTurn 表示“这次向 Session 提交了哪一个 Prompt”。

这样可以独立处理：

- Main 长会话多轮 findings 回传；
- 子 Agent 并发；
- Prompt ack 丢失后的幂等对账；
- blocked/resume 复用原 Session；
- Spring 重启恢复；
- cancel/conclude 竞态。

详细字段、状态机、锁和恢复窗口以 [Spring 多 Agent 编排规格](spring-multi-agent-orchestration-spec.md) 为准。
