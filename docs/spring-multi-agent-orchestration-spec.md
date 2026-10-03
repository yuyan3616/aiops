# Spring 多 Agent 编排规格

> 状态：设计基线，尚未实施  
> 分支：`feat/spring-management-server`  
> 适用范围：Spring Management Plane 与 Node/Pi Agent Runtime 之间的多 Session RCA 编排  
> 上游设计依据：《RCA 智能体完整设计方案》中的 brief / findings / turn-state / 编排方契约  
> 目标：让 Main Agent 负责调查决策，让 Spring 负责跨 Session 的确定性调度、持久化、恢复和取消，让 Node/Pi 负责单个 Agent Session 的执行与 RCA 证据状态

---

## 1. 为什么需要修正当前边界

当前分支已经实现：

```text
Task
  ↓
ManagementExecution (MEXEC)
  ↓
Runtime Execution (EXEC)
  ↓
Dedicated Conversation
  ↓
Pi Main Agent
```

但当前 Node 的 `dispatch_investigations` 工具仍会直接调用 `RcaService.dispatchAgentic()`，并在 Node 进程内：

1. 创建 expert task；
2. 并行运行专家 Pi Session；
3. 等待专家完成；
4. 接收 finding；
5. 再把 findings 直接返回给 Main Agent。

这意味着当前实现仍然是：

```text
Spring：只管理最外层任务
Node：Main Agent + SubAgent 调度 + Session 执行 + findings 汇聚
```

而目标设计要求：

```text
Main Agent：决定查什么、派给谁、何时继续/收敛
Spring：创建/恢复 Session、提交 Prompt、调度 SubAgent、记录状态、搬运 findings
Node/Pi：执行一个 Agent Session、运行工具、维护 Investigation/Evidence
```

因此本规格对当前边界做一次明确修正。

---

## 2. 核心原则

### 2.1 一句话边界

> **LLM 决策，Spring 调度，Node 执行。**

### 2.2 Main Agent 是 Planner / Investigator

Main Agent 负责：

- 确认症状；
- 建立全景；
- 维护竞争假设；
- 判断还缺什么证据；
- 生成 brief；
- 决定应该派哪个角色；
- 收到 findings 后交叉核验；
- 决定是否新派、续查、等待、需要人工输入或收敛；
- 生成最终报告。

Main Agent **不负责**：

- 创建真实子 Session；
- 选择 Runtime 实例；
- 执行网络重试；
- 维护数据库事务；
- 处理 Spring 重启恢复；
- 直接等待多个远端 Session；
- 决定 HTTP 超时是否安全重试。

### 2.3 Spring 是 Scheduler / Coordinator

Spring 负责：

- Task / MEXEC 生命周期；
- Main Agent Session 的创建与恢复；
- Main Agent 每一轮 Prompt 的可靠提交；
- 解析 turn-state；
- 把 Main Agent 登记的 brief 落库；
- 创建/恢复 SubAgent Session；
- 并发调度同批互不依赖的子任务；
- 记录 SubTask / AgentRun / AgentTurn；
- 校验 findings 协议；
- 串行把 findings 回传 Main Session；
- blocked / resume；
- 格式修正回合；
- 崩溃恢复；
- 取消传播；
- 平台级预算硬限制；
- 审计、可观测性和幂等。

Spring **不负责**：

- 根据日志/Trace 自己判断根因；
- 根据 if/else 决定派哪个专业 Agent；
- 修改 Hypothesis；
- 伪造 Evidence；
- 自己完成 RCA 推理。

禁止出现：

```java
if (traceFailed) {
    dispatchLogAgent();
}
if (confidence < 0.8) {
    dispatchCodeAgent();
}
```

这类调查决策必须由 Main Agent 作出。

### 2.4 Node/Pi 是 Agent Execution Plane

Node/Pi 负责：

- Pi Session 创建、加载、回收；
- Model 调用；
- Tool Calling；
- 单个 Agent Session 的 Prompt 执行；
- Abort；
- Session 历史；
- RCA Investigation；
- Hypothesis / Evidence / Observation；
- Tool call 与 evidence 落盘；
- SubAgent 工具访问；
- Findings 的 Agent 侧结构化生成；
- report.json / report.md 生成；
- Runtime Event / SSE。

Node 不再负责 Spring-managed execution 下的跨 Session 调度策略。

---

## 3. 目标架构

```text
External / Alert Platform
          │
          ▼
┌───────────────────────────────────────────────┐
│ Spring Management Server                      │
│                                               │
│ Task / MEXEC                                  │
│ AgentRun / AgentTurn / SubTask                │
│ Durable Scheduler / Recovery / Cancel         │
└───────────────────┬───────────────────────────┘
                    │ service-token protected HTTP
                    ▼
┌───────────────────────────────────────────────┐
│ Node / Pi Runtime                             │
│                                               │
│ Agent Session Runtime API                     │
│ Conversation / Pi Session / Expert Runner     │
│ RCA Investigation / Evidence / Tools          │
└───────────────────────────────────────────────┘
```

一次完整 RCA：

```text
TASK-...
  │
  └── MEXEC-...
        │
        ├── ARUN-main
        │     ├── ATURN-initial
        │     │      ↓
        │     │   Main Agent
        │     │      ↓
        │     │   turnState=waiting_sub
        │     │
        │     ├───────────────┬────────────────┐
        │     │               │                │
        │     ▼               ▼                ▼
        │   MSUB-01         MSUB-02          MSUB-03
        │     │               │                │
        │   ARUN-log        ARUN-trace       ARUN-code
        │     │               │                │
        │   findings        findings         findings
        │     └───────────────┴────────────────┘
        │                     │
        │                     ▼
        │             Spring durable delivery
        │                     │
        ├── ATURN-finding-sub01
        ├── ATURN-finding-sub02
        ├── ATURN-finding-sub03
        │                     │
        │                     ▼
        │                 Main Agent
        │                     │
        │          waiting_sub / concluded
        │
        └── report.json / report.md
```

---

## 4. 对象所有权

| 对象 | 唯一事实源 | 说明 |
| --- | --- | --- |
| Task | Spring/MySQL | 平台意图 |
| ManagementExecution | Spring/MySQL | 一次平台执行尝试 |
| AgentRun | Spring/MySQL | 一个受管理 Agent Session 的生命周期 |
| AgentTurn | Spring/MySQL + Node Runtime 引用 | 一次 Prompt 执行/回合 |
| SubTask | Spring/MySQL | Main Agent 派出的一个逻辑 brief |
| Runtime Session | Node/Pi | 实际 Pi Session |
| Investigation | Node/Pi | RCA 内部调查事实 |
| Hypothesis | Node/Pi | Agent 推理状态 |
| Evidence / Observation | Node/Pi | 取证事实 |
| ToolCall | Node/Pi | 工具执行事实 |
| findings 原始产物 | Node/Pi Session output | 子 Agent 输出 |
| findings 管理快照/摘要 | Spring/MySQL | 编排与审计所需副本 |
| report.json / report.md | Node/Pi Session output | Main Agent 最终产物 |
| report 元数据/引用 | Spring/MySQL | 平台查询、审计 |

### 4.1 Investigation.expertTasks 的迁移语义

当前 Node `Investigation.expertTasks` 同时承担：

- Agent 可见的子调查历史；
- 调度状态；
- Session 执行状态。

外置调度后不能继续把它当成 Scheduler 的事实源。

目标语义：

> `management_subtask` 是调度事实源；`Investigation.expertTasks` 仅作为 Agent-facing projection / evidence projection。

Spring 不根据 Investigation.expertTasks 决定是否要再次调度；Node 也不得因为 projection 中存在 running task 就自行创建 Session。

---

## 5. ID 与层次

```text
TASK-<uuid>    平台 Task
MEXEC-<uuid>   Spring Management Execution
ARUN-<uuid>    Agent Session Run
ATURN-<uuid>   Agent Turn
MSUB-<uuid>    Spring SubTask row
sub-01         Main Agent 视角的 taskRef
EXEC-<uuid>    现有 Runtime Execution（迁移期保留）
INV-...        Node RCA Investigation
```

关系：

```text
Task 1:N MEXEC
MEXEC 1:N AgentRun
AgentRun 1:N AgentTurn
MEXEC 1:N SubTask
SubTask 1:1 logical taskRef
SubTask 0..1:1 active AgentRun
MEXEC 0..1:1 Investigation
```

Main Agent 是长 Session：

```text
一个 ARUN-main
  ├── initial turn
  ├── findings return turn
  ├── findings return turn
  ├── format repair turn
  └── ...
```

子 Agent 默认也是一个 SubTask 对应一个 AgentRun；blocked/resume 时继续使用原 AgentRun，不新建 Session。

---

## 6. Spring 数据模型

### 6.1 management_task

沿用现有表。

### 6.2 management_execution

沿用现有表，并建议 V2 增加：

```text
orchestration_mode      LEGACY_INLINE | SPRING_EXTERNAL
orchestration_phase     STARTING_MAIN | MAIN_RUNNING | WAITING_SUB |
                        SUB_RUNNING | RESUMING_MAIN | NEED_INPUT |
                        CONCLUDING | SETTLED
investigation_id
cancel_requested_at
policy_snapshot_json
```

`ExecutionStatus` 仍表达平台生命周期：

```text
CREATED
DISPATCHING
RUNNING
SUCCEEDED
FAILED
CANCELLED
UNKNOWN
```

`orchestration_phase` 不替代 status。

### 6.3 management_agent_run

建议表：

```sql
management_agent_run (
  id                    varchar(64) primary key,
  execution_id          varchar(64) not null,
  parent_run_id         varchar(64) null,
  kind                  varchar(16) not null,   -- MAIN / SUB
  role                  varchar(64) not null,
  task_ref              varchar(64) null,
  runtime_session_id    varchar(128) null,
  status                varchar(32) not null,
  current_turn_id       varchar(64) null,
  attempt               int not null,
  idempotency_key_hash  char(64) not null,
  last_error_code       varchar(64) null,
  last_error_message    varchar(1024) null,
  started_at            timestamp(6) null,
  finished_at           timestamp(6) null,
  row_version           bigint not null default 0,
  created_at            timestamp(6) not null,
  updated_at            timestamp(6) not null
)
```

AgentRunStatus：

```text
CREATED
DISPATCHING
RUNNING
WAITING_INPUT
SUCCEEDED
FAILED
CANCELLED
UNKNOWN
```

约束：

- 一个 MEXEC 只能有一个 active MAIN AgentRun；
- SUB AgentRun 必须绑定 taskRef；
- runtime_session_id 一旦绑定不得静默替换；
- UNKNOWN 不得直接新建第二个 Session。

### 6.4 management_agent_turn

需要 Turn 表，不能只记录 Session。

原因：Main Agent 是长 Session，会收到多次 Prompt；如果 Spring 在“findings 已回传但 HTTP ack 丢失”时重试，没有 Turn 级幂等就会把同一 findings 注入两次。

建议：

```sql
management_agent_turn (
  id                    varchar(64) primary key,
  agent_run_id          varchar(64) not null,
  sequence_no           int not null,
  kind                  varchar(32) not null,
  delivery_key          varchar(160) not null,
  runtime_turn_id       varchar(128) null,
  status                varchar(32) not null,
  protocol_state        varchar(32) null,
  final_text_hash       char(64) null,
  protocol_processed_at timestamp(6) null,
  last_error_code       varchar(64) null,
  last_error_message    varchar(1024) null,
  started_at            timestamp(6) null,
  finished_at           timestamp(6) null,
  row_version           bigint not null default 0,
  created_at            timestamp(6) not null,
  updated_at            timestamp(6) not null,

  unique(agent_run_id, sequence_no),
  unique(agent_run_id, delivery_key)
)
```

TurnKind：

```text
MAIN_INITIAL
MAIN_FINDINGS_RETURN
MAIN_FORMAT_REPAIR
SUB_INITIAL
SUB_RESUME
SUB_FORMAT_REPAIR
```

TurnStatus：

```text
CREATED
DISPATCHING
RUNNING
SUCCEEDED
FAILED
CANCELLED
UNKNOWN
```

稳定 delivery_key 示例：

```text
main:init
main:finding:sub-01:v1
main:finding:sub-02:v1
main:repair:<sourceTurnId>:1
sub:sub-01:init
sub:sub-01:resume:1
sub:sub-01:repair:<sourceTurnId>:1
```

### 6.5 management_subtask

```sql
management_subtask (
  id                    varchar(64) primary key,
  execution_id          varchar(64) not null,
  parent_agent_run_id   varchar(64) not null,
  task_ref              varchar(64) not null,
  role                  varchar(64) not null,
  batch_no              int not null,
  question              varchar(2000) not null,
  brief_json            json not null,
  status                varchar(32) not null,
  agent_run_id          varchar(64) null,
  resume_count          int not null default 0,
  finding_status        varchar(32) null,
  strength              varchar(32) null,
  findings_text         longtext null,
  findings_hash         char(64) null,
  evidence_ids_json     json null,
  tool_calls            int null,
  blocked_on            varchar(2000) null,
  completed_at          timestamp(6) null,
  row_version           bigint not null default 0,
  created_at            timestamp(6) not null,
  updated_at            timestamp(6) not null,

  unique(execution_id, task_ref)
)
```

SubTaskStatus：

```text
REQUESTED
QUEUED
DISPATCHING
RUNNING
BLOCKED
SUCCEEDED
FAILED
INCONCLUSIVE
CANCELLED
UNKNOWN
```

SubTask 是“查什么”，AgentRun 是“谁在哪个 Session 执行”。

---

## 7. Main Agent 回合协议

目标沿用：

```json
{
  "turnState": "waiting_sub | concluded | need_input",
  "pendingSubTasks": ["sub-02"],
  "dispatchedThisTurn": [
    {
      "taskRef": "sub-01",
      "role": "log-investigation",
      "question": "..."
    }
  ],
  "hypothesesSummary": "...",
  "note": "..."
}
```

Spring 只依赖最后一个结构化 turn-state 做调度，不解析自然语言决定下一步。

### 7.1 waiting_sub

Spring：

1. 锁定 Main AgentRun；
2. 校验该 Turn 尚未 protocol_processed；
3. 读取/获取完整 brief；
4. 在一个事务中 insert SubTask，唯一键为 `(execution_id, task_ref)`；
5. 校验 batch / total budget；
6. commit；
7. 异步调度 QUEUED SubTask；
8. 标记该 Main Turn 已处理。

如果 Spring 在第 4 步后崩溃，恢复 worker 能从 QUEUED SubTask 继续，不需要重新 Prompt Main Agent。

### 7.2 concluded

Spring：

1. 不再接受新 SubTask；
2. 若仍存在 running SubTask，进入“提前收敛取消”流程；
3. 通过 Node artifact API 获取 report.json / report.md；
4. 校验报告存在且 Investigation 关联一致；
5. MEXEC -> SUCCEEDED；
6. Task -> SUCCEEDED。

RCA classification 为 inconclusive 不等于执行失败。

### 7.3 need_input

MEXEC 保持 RUNNING，phase=NEED_INPUT。

Spring：

- 停止自动调度；
- 保存 Main Agent 请求的输入摘要；
- UI/平台展示待人工；
- 人工补充后创建新的 Main AgentTurn；
- 不创建新的 Main Session。

### 7.4 turn-state 非法

找不到 JSON block 或枚举非法：

- 不重复执行调查动作；
- 创建 `MAIN_FORMAT_REPAIR` Turn；
- Prompt 只要求重写本轮结束协议；
- delivery_key 固定；
- 最多 2 次；
- 两次仍失败 -> MEXEC FAILED，failureCode=MAIN_PROTOCOL_INVALID。

---

## 8. dispatch 工具的目标语义

当前：

```text
dispatch_investigations
  → RcaService.dispatchAgentic()
  → Node 创建并并发运行专家 Session
  → await findings
  → 返回 Main Agent
```

目标：

```text
dispatch_investigations
  → validate brief
  → 分配/校验 taskRef
  → 记录 dispatch artifact / projection
  → 返回 accepted
  → 不创建 Session
  → 不等待 findings
```

为减少 Prompt 和 UI 回归，迁移期可以保留当前复数工具名 `dispatch_investigations`，但 **SPRING_EXTERNAL 模式下语义必须是 register-only**。

Main Agent 在登记后输出：

```text
turnState=waiting_sub
```

### 8.1 双模式迁移

在重构完成前：

```text
LEGACY_INLINE
  → 现有 Web/直接会话
  → dispatch_investigations 继续 Node 内联执行

SPRING_EXTERNAL
  → Spring 创建的 MEXEC
  → dispatch_investigations 仅登记 brief
  → Spring 调度
```

只有 SPRING_EXTERNAL 稳定并完成回放后，才删除 LEGACY_INLINE。

这样 production 现有 `pi-chat-rca` 不需要一次性切换所有用户路径。

---

## 9. SubAgent 调度

### 9.1 一个 SubTask 的正常流程

```text
REQUESTED
  ↓ DB transaction
QUEUED
  ↓ Runtime create/recover Session
DISPATCHING
  ↓ submit SUB_INITIAL turn
RUNNING
  ↓ Node turn settled
SUCCEEDED / FAILED / INCONCLUSIVE / BLOCKED
```

### 9.2 同批并行

Main Agent 一轮可以登记多个互不依赖 brief。

Spring：

- 在同一事务中持久化本轮全部 SubTask；
- commit 后并行调度；
- 每个 SubTask 有独立状态；
- 一个失败不回滚其他成功任务；
- 同批最大并发由 policy snapshot 限制。

不把远程 Session HTTP 调用放进 DB transaction。

### 9.3 Role 注册表

Spring 不写死：

```text
if role == log ...
if role == trace ...
```

Spring 只消费角色注册表中的确定性配置：

- role；
- profile；
- workspace 类型；
- acceptsRefs；
- budget；
- timeout。

当前仓库已有 trace / metrics / log / event-topology；上游完整设计的一期角色为 log / trace / code。

本规格不擅自统一两份角色清单。目标实现必须先形成角色注册表，调度器只按注册表工作。

---

## 10. Findings 校验与回传

子 Agent 完成后，Spring 从 Node 获取 findings。

Spring 做结构校验：

- role；
- taskRef；
- status；
- strength；
- toolCalls；
- evidenceIds；
- blockedOn；
- suggestedFollowUps；
- 固定章节存在。

Spring 不判断 findings 的业务结论是否正确。

### 10.1 findings 不合格

创建 `SUB_FORMAT_REPAIR` Turn：

- 同一子 Session；
- 只要求按协议重写；
- 不重新执行工具；
- 最多 2 次。

仍不合格：

```text
SubTask -> FAILED
failureCode=FINDINGS_PROTOCOL_INVALID
```

### 10.2 findings 回传 Main

子任务终态落库后，在同一 DB transaction 中为 Main Agent 创建一个待执行 Turn：

```text
delivery_key = main:finding:<taskRef>:v<revision>
kind = MAIN_FINDINGS_RETURN
status = CREATED
```

然后 commit。

worker 串行提交 Main Turn。

这样可以保证：

> findings 已落库但 Spring 随即崩溃，也不会丢失回传动作。

### 10.3 多个 findings 同时完成

SubAgent 可以并行，Main Session 不能并行 Prompt。

因此：

- 多个 completed SubTask 可以同时落库；
- 对 Main Agent 的 delivery 必须序列化；
- `management_agent_run` 行锁分配 sequence_no；
- 同一 Main Session 同时最多一个 RUNNING Turn；
- 后续 findings Turn 保持 CREATED 等待。

---

## 11. blocked / resume

上游契约：

```text
SubAgent
  ↓
status=blocked
  ↓
findings + blockedOn
  ↓
Main Agent
  ↓
判断值不值得补查
```

如果 Main Agent 后续调用：

```text
resume_investigation(taskRef, supplement)
```

目标语义同样是 **register-only**。

Spring 看到 resume request 后：

1. 查 `management_subtask(execution_id, task_ref)`；
2. 必须 status=BLOCKED；
3. 必须已有 agent_run_id；
4. `resume_count < 1`；
5. 在原 Sub AgentRun 上创建 `SUB_RESUME` Turn；
6. 使用同一个 runtime_session_id；
7. 不创建新 Session；
8. resume_count + 1。

如果续查后再次 blocked：

```text
SubTask -> INCONCLUSIVE
```

不允许无限 resume。

如果 Main Agent补齐信息后决定“这是一个新问题”，则 dispatch 新 brief，创建新 taskRef，而不是 resume 原任务。

---

## 12. Node Runtime API 目标

Spring 不得直接使用 Pi SDK、SessionManager 或 sessionFile。

Node 需要提供受 service token 保护的稳定 Agent Runtime API。

### 12.1 创建/恢复 Agent Session

```http
POST /api/runtime/agent-sessions
Authorization: Bearer <service-token>
Idempotency-Key: <stable-session-key>
```

概念请求：

```json
{
  "kind": "MAIN | SUB",
  "role": "main-investigation",
  "orchestrationMode": "SPRING_EXTERNAL",
  "executionId": "MEXEC-...",
  "taskRef": null,
  "investigationId": null,
  "repositories": []
}
```

响应：

```json
{
  "runtimeSessionId": "...",
  "status": "ready"
}
```

SubAgent 的 repositories 不接受 Main Agent 提供任意 Git URL；必须由 Node/Spring 受控 service catalog 解析。

### 12.2 提交 Turn

```http
POST /api/runtime/agent-sessions/{sessionId}/turns
Idempotency-Key: <stable-delivery-key>
```

响应：

```json
{
  "runtimeTurnId": "...",
  "status": "accepted"
}
```

Runtime 必须先持久化 turn reservation，再追加 Prompt。

### 12.3 查询 Turn

```http
GET /api/runtime/agent-sessions/{sessionId}/turns/{runtimeTurnId}
```

返回：

- accepted/running/settled/failed/cancelled/unknown；
- final assistant text；
- linked investigationId；
- 不返回 raw COT。

### 12.4 获取协议产物

不开放任意文件路径读取。

提供受控 artifact API，例如：

```text
GET .../dispatches/{taskRef}
GET .../findings
GET .../report
```

Node 内部可以继续从 Session output 读取，但 Spring 只能访问明确 allowlist 的产物。

### 12.5 Abort

```http
POST /api/runtime/agent-sessions/{sessionId}/abort
```

Abort 必须幂等。

---

## 13. 当前 RuntimeExecution 的定位

现有 `EXEC-...` / `RuntimeExecutionService` 不删除，但职责收窄。

迁移期它负责：

- 为一个 Spring MEXEC 可靠启动 Main Agent Session；
- 兼容现有已实现幂等 reservation；
- 提供 main runtimeSessionId；
- 不再代表“整个多 Agent 调度器”。

长期可以：

1. 保留 EXEC 作为 Main AgentRun 的 Runtime-side reservation；或
2. 在 Agent Session Runtime API 稳定后废弃 EXEC 中间层。

这个决定在实现 Session API 后再评审，不在本规格阶段强行删除。

---

## 14. 幂等模型

不承诺分布式事务意义上的 exactly-once。

目标是：

> **at-least-once command + 持久化 idempotency reservation = effect-once side effect。**

### 14.1 Session key

```text
main session:
management:<MEXEC>:main

sub session:
management:<MEXEC>:sub:<taskRef>
```

### 14.2 Turn key

见 6.4 delivery_key。

### 14.3 Spring 写入顺序

禁止：

```text
HTTP Node
→ 成功
→ 才写 DB
```

必须：

```text
DB reservation
→ commit
→ HTTP Node with stable key
→ DB bind result
```

### 14.4 HTTP timeout

HTTP timeout != Node 没执行。

超时后：

```text
DISPATCHING/RUNNING
  ↓ timeout
UNKNOWN
  ↓
GET / query by stable idempotency/runtime id
  ↓
reconcile
```

禁止直接创建新 Session 或新 Turn。

---

## 15. 并发控制

### 15.1 同一个 MEXEC

任何修改 orchestration phase / current main run 的事务先锁 `management_execution`。

### 15.2 同一个 Main AgentRun

Main Session 同时最多执行一个 Turn。

创建 Main Turn：

1. `SELECT ... FOR UPDATE agent_run`；
2. 检查不存在 RUNNING/DISPATCHING Turn；
3. 分配 sequence_no；
4. insert CREATED Turn；
5. commit。

### 15.3 SubAgent

不同 SubTask 可并行。

同一 SubTask：

- 同时最多一个 active AgentRun；
- 同一 AgentRun 同时最多一个 active Turn；
- resume 必须复用原 Session。

### 15.4 迟到响应

所有 remote response 在更新前必须检查：

- execution 仍是 current execution；
- agent run 仍绑定该 runtime_session_id；
- turn 仍绑定该 runtime_turn_id；
- terminal 状态不可被非 terminal 反向覆盖。

旧 AgentRun 的迟到回包不得覆盖新 attempt。

---

## 16. Spring 崩溃恢复

Spring 启动后运行 reconciliation worker。

不需要 Kafka；第一版用 MySQL 持久状态作为 durable work queue。

### 窗口 A：AgentRun 已落库，Session 未创建

```text
AgentRun=CREATED
runtime_session_id=null
```

worker 用 stable session key 创建/恢复。

### 窗口 B：Session 已创建，Spring 未绑定

HTTP 结果不确定：

```text
AgentRun=UNKNOWN
```

通过 Runtime idempotency key 查询/重放 create，得到同一个 Session。

### 窗口 C：Turn 已落库，Prompt 未提交

```text
Turn=CREATED
```

worker 正常 dispatch。

### 窗口 D：Prompt 已接受，Spring 未收到 ack

```text
Turn=UNKNOWN
```

按 stable delivery_key 查询/重放，Runtime 返回同一个 runtimeTurnId。

### 窗口 E：Main Turn settled，Spring 未解析 turn-state

```text
Turn=SUCCEEDED
protocol_processed_at=null
```

recovery 直接处理已有 final text，不再次 Prompt Main Agent。

### 窗口 F：SubAgent 已完成，Spring 未保存 findings

查询 runtimeTurnId，重新拉 findings，校验后落库。

### 窗口 G：findings 已落库，尚未回传 Main

若没有对应 `MAIN_FINDINGS_RETURN` Turn，则在事务中补建；unique delivery_key 防重复。

### 窗口 H：Spring 在 Main findings Prompt 后重启

按 Main Turn delivery_key 对账，禁止重复注入同一 findings。

---

## 17. Node 重启恢复

Node 仍负责 Session Runtime 自身恢复。

Spring 不解释 sessionFile。

Spring 只消费 Runtime API 状态：

```text
ready / running / settled / failed / cancelled / unknown
```

如果 Runtime 能恢复固定 Session：

- 使用原 runtime_session_id；
- 不创建新 AgentRun。

如果 Runtime 明确声明 Session 不可恢复：

- AgentRun FAILED；
- 是否创建新 attempt 由 Spring 平台恢复策略决定；
- SubTask 的 logical taskRef 不因运行尝试失败而自动变化。

---

## 18. 取消传播

取消不是“改数据库状态”。

### 18.1 发起取消

事务内：

```text
MEXEC.cancel_requested_at = now
orchestration_phase = CANCELLING
```

之后停止：

- 新 SubTask dispatch；
- 新 findings delivery；
- resume；
- format repair。

### 18.2 远程取消顺序

建议：

1. Abort Main Agent active Turn / Session，阻止继续登记新任务；
2. 并发 Abort 全部 active Sub AgentRun；
3. cancel linked Investigation；
4. 查询/确认远端状态；
5. 全部确认后 MEXEC -> CANCELLED。

如果任何远端取消结果不确定：

```text
MEXEC 不得谎报 CANCELLED
保持 RUNNING/UNKNOWN + cancel_requested
继续 reconcile
```

### 18.3 cancel 与 conclude 竞态

锁定 MEXEC 后：

- 如果 SUCCEEDED 已先提交，cancel 是终态 no-op；
- 如果 cancel_requested 已先提交，后到的 concluded 不能再把 MEXEC 推成 SUCCEEDED；
- report 可以保留作审计，但平台执行最终按取消流程收敛。

---

## 19. Main 提前收敛与在途 SubTask

上游协议允许 Main Agent 在某些 findings 已足够时，不再依赖尚未完成的同批任务。

当 Main 返回 concluded 且还有 active SubTask：

1. Spring 校验 `pendingSubTasks`；
2. 把仍运行任务标记 cancel requested；
3. Abort 对应 Sub Agent Session；
4. 状态记为 CANCELLED_SUPERSEDED；
5. report unresolved 必须能解释未等待的调查项；
6. 不等待无关子任务继续消耗模型。

---

## 20. 预算与防发散

Main Agent Prompt 中仍有软预算纪律。

Spring 再提供硬预算。

MEXEC 创建时固化 `policy_snapshot_json`：

```json
{
  "maxSubTasks": 4,
  "maxBatches": 3,
  "maxConcurrentSubTasks": 3,
  "maxResumePerSubTask": 1,
  "maxFormatRepairPerTurn": 2
}
```

Spring 调度前校验。

### 20.1 与当前 Node Budget 的迁移

当前 Investigation 内已有 expert task budget / reserve / commit / release 语义。

外置调度后：

- tool/evidence 查询预算仍可保留在 Node；
- **跨 Session SubTask 调度预算以 Spring policy snapshot 为硬事实源**；
- Investigation 中对应预算仅做 Main Agent 可见 projection；
- 不能同时让 Spring 和 Node 各自独立消费一份 primary/recovery budget。

具体 budget ledger 迁移在实现阶段另写 migration note，禁止双写两套可独立变化的数字。

---

## 21. Security

### 21.1 Service auth

所有新的 Agent Session Runtime API：

```text
Spring
  ↓ Bearer service token
Node
```

默认 fail closed。

### 21.2 不信任 Main Agent 产生的调度参数

brief 来自模型，Spring/Node 必须验证：

- role 必须在 registry；
- question / expected 长度上限；
- refs key 必须在 acceptsRefs；
- batch 数量；
- time window；
- hypothesisIds；
- workspace/repository 只能由 service catalog 解析；
- 不接受 brief 中的任意 shell、URL、文件路径作为调度指令。

### 21.3 Artifact API

禁止 Spring 传：

```text
../../session.jsonl
任意 workspace path
```

只允许固定 artifact 类型。

### 21.4 Secrets

- Management API token；
- Spring→Runtime orchestration token；
- Provider API Key；

三者分离。

### 21.5 CoT

Spring 不持久化 raw chain-of-thought。

只记录：

- protocol state；
- brief；
- findings；
- status；
- tool/evidence 引用；
- final report；
- 可公开/可审计事件。

---

## 22. Observability

每个日志事件至少带：

```text
requestId
taskId
managementExecutionId
agentRunId
agentTurnId
taskRef
runtimeSessionId
runtimeTurnId
investigationId
```

重要状态变更记录结构化日志：

```text
subtask.requested
subtask.dispatched
subtask.completed
subtask.blocked
subtask.resumed
finding.delivered
main.turn.completed
execution.concluded
execution.cancel.requested
reconcile.performed
```

不要记录 Authorization 和完整敏感 Prompt。

---

## 23. UI 所能获得的真实结构

实现后 UI 可以直接展示：

```text
TASK-001
└─ MEXEC-001  RUNNING
   ├─ Main Agent                 waiting_sub
   │  ├─ Turn #1                succeeded
   │  └─ Turn #2                running
   │
   ├─ sub-01 Log                succeeded
   │  ├─ Session                ...
   │  ├─ Tool Calls             7
   │  └─ Strength               strong
   │
   ├─ sub-02 Trace              running
   │
   └─ sub-03 Code               pending
```

UI 状态来自 Spring 管理模型，不需要从自然语言或 Node SSE 猜“现在跑到哪一步”。

Evidence 内容仍从 Runtime/Investigation 获取。

---

## 24. 与当前代码的具体改造点

### 24.1 Node

当前：

```text
main-agent-tools.ts
dispatch_investigations
  → rcaService.dispatchAgentic()
  → PiExpertRunner.run()
```

目标拆分：

```text
dispatch_investigations (SPRING_EXTERNAL)
  → validate
  → register brief
  → return taskRef accepted

Runtime Agent Session API
  → create/recover Main/Sub Session
  → submit turn
  → get turn
  → abort
  → get dispatch/findings/report artifacts

RcaService
  → 继续维护 Investigation / Evidence
  → 提供 SubAgent 工具调用的 evidence recorder
  → 接受 findings projection
  → 不决定何时创建 SubAgent
```

### 24.2 Spring

新增建议包：

```text
orchestration/
├── MultiAgentOrchestrator
├── MainTurnProcessor
├── SubTaskScheduler
├── FindingDeliveryService
├── ReconciliationWorker
├── CancellationCoordinator
└── policy/

domain/
├── AgentRun
├── AgentTurn
└── InvestigationSubTask

repository/
├── AgentRunRepository
├── AgentTurnRepository
└── SubTaskRepository
```

现有 `TaskExecutionOrchestrator` 只负责 Task/MEXEC 外层生命周期，不继续膨胀成几千行多 Agent 调度器。

---

## 25. 实施顺序

### Phase 1：数据模型，不改 Agent 行为

- Flyway V2：
  - management_agent_run；
  - management_agent_turn；
  - management_subtask；
  - MEXEC orchestration 字段；
- Repository / domain；
- 行锁 / unique key；
- MySQL 集成测试。

验收：纯数据库状态机测试通过。

### Phase 2：Node Session Runtime Primitive

实现受保护 API：

- create/recover Session；
- submit idempotent Turn；
- query Turn；
- abort；
- controlled artifact read。

先不改 `dispatch_investigations`。

验收：

- 同 session key 并发只创建一个 Session；
- 同 delivery key 并发只提交一个 Prompt；
- HTTP ack 丢失重放不重复 Prompt；
- Node 重启后可对账。

### Phase 3：External orchestration mode

- Spring 创建 Main AgentRun；
- Main Session 标记 `SPRING_EXTERNAL`；
- `dispatch_investigations` 在该模式改成 register-only；
- Main turn-state 可被 Spring 获取；
- legacy Web Session 保持 inline。

验收：Main 能登记 brief，但 Node 不自行创建 Sub Session。

### Phase 4：Spring SubTask Scheduler

- Spring 落 SubTask；
- 并行创建 SubAgentRun；
- Node 单 Session 执行专家；
- findings 校验；
- durable delivery 回 Main；
- blocked/resume。

验收：至少一个多批次 RCA 回放跑通。

### Phase 5：恢复与取消

故障注入：

- Spring 在 Session create 前崩；
- create ack 丢失；
- Prompt ack 丢失；
- SubAgent 完成后 Spring 崩；
- findings 落库后 Spring 崩；
- Main 收到 findings 后 Spring 崩；
- execute/cancel 并发；
- conclude/cancel 并发；
- Node 重启。

每个场景必须证明不重复 Session、不重复 Prompt、不丢 findings。

### Phase 6：t039 端到端回放

验证：

```text
Task
→ MEXEC
→ Main AgentRun
→ waiting_sub
→ 多 SubTask
→ Sub AgentRun
→ findings
→ Main next turn
→ conclude
→ report
```

并核对 MySQL 中所有关系。

### Phase 7：production canary

- 只对 Spring-created Task 开启 SPRING_EXTERNAL；
- 现有 React → Node 会话继续 legacy；
- 观察稳定后再评估默认切换；
- 不在同一部署同时删除 legacy fallback。

---

## 26. 验收不变量

实现完成必须同时满足：

1. Main Agent 能决定派发，但不能直接创建 Sub Session；
2. Spring 能回答每个 SubTask 为什么创建、谁执行、哪个 Session、什么状态；
3. 同一 taskRef 不会因为重试创建两个逻辑 SubTask；
4. 同一 stable session key 不会创建两个 Runtime Session；
5. 同一 findings delivery 不会注入 Main 两次；
6. Spring 重启不丢在途 SubTask；
7. Node 重启不让 Spring盲目重建 Session；
8. blocked 只 resume 原 Session 一次；
9. SubAgents 永远不直接互相调用；
10. Main Session 的 Prompt 严格串行；
11. 子 Session 可以并行；
12. cancel 不谎报成功；
13. concluded 后不继续消耗无关 SubAgent；
14. Spring 不读取 sessionFile / JSONL；
15. Spring 不保存 raw COT；
16. Investigation/Evidence 仍由 Node/Pi 所有；
17. 调度事实只由 Spring/MySQL 所有；
18. legacy Web RCA 在迁移期间无回归。

---

## 27. 本规格明确不做

本轮设计不引入：

- Kafka；
- Redis；
- 分布式事务；
- Temporal / Conductor；
- Spring 内部 Agent 推理；
- Spring 直接操作 Pi SDK；
- Spring 直接访问 Node 文件目录；
- SubAgent 之间直接通信；
- 自动修复生产故障。

MySQL 状态行本身即可作为第一版 durable scheduler queue；只有未来吞吐、跨服务工作流或多集群需求证明必要时，再评估专用工作流/消息中间件。

---

## 28. 当前结论

当前已上线的 Spring + MySQL 基础设施继续保留，不需要回滚。

当前 `RuntimeExecutionService` 也继续保留，但暂不把 production Node 切到“Spring 已完全接管多 Agent 编排”的状态。

下一步开发基线是：

```text
先实现 Phase 1 数据模型
→ 再做 Node Session Runtime Primitive
→ 再切 SPRING_EXTERNAL register-only dispatch
→ 最后让 Spring 真正接管 Main/SubAgent 调度
```

在 Phase 3 之前，不修改现有 production Web RCA 的 SubAgent 调度语义。
