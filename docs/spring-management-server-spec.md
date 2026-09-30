# Spring Management Server 设计规格

> 状态：第一阶段实施基线  
> 分支：`feat/spring-management-server`  
> Java：JDK 21  
> Spring Boot：3.5.16  
> Web：Spring MVC（`spring-boot-starter-web`）

## 1. 背景与目标

当前 AIOps RCA Workspace 的 Node.js 服务同时承担两类职责：

1. **Agent Execution Plane**：Pi Session、Main Agent、Expert Agent、Tool Calling、流式事件、Abort / Steer / Resume。
2. **Management Plane**：HTTP 入口、调查查询/取消、未来告警平台接入，以及后续可能出现的用户、权限、任务、LLM 配置与平台治理能力。

随着平台能力增长，两类职责继续堆在同一个 Node 进程会放大运行时耦合。第一阶段新增一个 Spring Boot 管理服务，建立清晰边界，但**不重写现有 Pi Agent Runtime，也不迁移当前稳定的 RCA 状态机和文件持久化**。

本阶段目标是：

- 在同一 Monorepo 中新增独立的 Spring Boot 服务；
- 采用传统 Spring MVC / Controller-Service-Client 分层；
- 把 Spring 定位为 Control / Management Plane；
- 通过稳定 HTTP 协议调用现有 Node Agent Runtime；
- 先打通可验证的最小链路，再逐步迁移真正属于管理面的能力。

## 2. 非目标

第一阶段明确不做：

- 不用 Java 重写 Pi Session、Main Agent、Expert Agent 或 Tool Calling；
- 不让 Spring 读取或修改 Pi `sessionFile`；
- 不让 Spring 直接读取或修改 `RCA_INVESTIGATIONS_DIR` 下的 JSON / JSONL；
- 不把 Investigation 状态机复制一份到 Java；
- 不引入 Kafka、Redis、注册中心或分布式事务；
- 不改变现有 Web 前端调用链；
- 不删除或改变现有 `/api/rca` 外部接口语义；
- 不在第一阶段引入 MySQL 作为 Investigation 的第二事实源。

## 3. 总体架构

```text
                  ┌─────────────────────┐
                  │       React Web     │
                  └──────────┬──────────┘
                             │
                    当前链路 │
                             ▼
                  ┌─────────────────────┐
                  │ Node.js Agent Server│
                  │ Hono + Pi Runtime   │
                  └─────────────────────┘

        新增 Management Plane（第一阶段不替换 Web 链路）

External / Admin / Alert Platform
              │
              ▼
┌──────────────────────────────────────┐
│ Spring Boot Management Server        │
│                                      │
│ Controller → Service → RuntimeClient │
└──────────────────┬───────────────────┘
                   │ HTTP
                   ▼
┌──────────────────────────────────────┐
│ Node.js Agent Server                 │
│ /api/rca                             │
│                                      │
│ RcaService → InvestigationRepository │
│ Pi Main/Expert Sessions + Tools      │
└──────────────────────────────────────┘
```

核心原则：

> **Spring 管“平台如何管理一次执行”，Node/Pi 管“Agent 如何完成一次执行”。**

## 4. 职责边界

### 4.1 Spring Management Server 负责

第一阶段：

- 提供管理侧 HTTP API；
- 校验管理侧请求参数；
- 统一调用 Agent Runtime；
- 对 Runtime 的 HTTP 错误做管理侧异常映射；
- 健康检查；
- 暴露 Runtime 连通性所需配置；
- 为后续 Task / User / Auth / LLM Config / Alert Integration 保留分层位置。

后续阶段可逐步迁入：

- 用户与权限；
- 平台级 Agent / LLM 配置；
- 告警接入与任务创建；
- Task / Execution 元数据；
- 审计；
- 配额；
- 调度；
- 多 Runtime 节点治理。

### 4.2 Node.js + Pi Agent Server 继续负责

- Conversation Runtime；
- Pi Session 创建、恢复与回收；
- Main Agent 调度；
- Expert Agent Session；
- Tool Calling；
- Hypothesis / Evidence / Observation；
- Investigation 状态机；
- Budget / Reserve / Commit / Release；
- Pause / Resume / Cancel / Steer 的 Agent 生命周期语义；
- Investigation 文件持久化；
- SSE / Runtime Event；
- RCA 报告生成；
- Visualization 生成。

### 4.3 禁止跨越的边界

Spring **不得**：

- 直接操作 Node 的 SessionManager；
- 直接改写 `sessionFile`；
- 直接写 `investigation.json`、`events.jsonl`、`tool-calls.jsonl`；
- 根据数据库记录自行推断 Agent 最终状态并覆盖 Runtime 状态；
- 在 Node 返回失败后伪造“成功”状态。

Node Runtime 的 Investigation 状态仍然是第一阶段的事实来源。

## 5. 为什么复用 /api/rca

当前 Node 服务已经明确将 `/api/rca` 定义为：

- Alertmanager / Grafana / 自定义告警平台的稳定 HTTP 边界；
- 外部系统查询、取消 Investigation 的入口；
- HTTP Handler 保持薄层，真正逻辑进入 `RcaService`。

因此第一阶段 Spring 不新增一套侵入 Pi 内部的私有协议，而是优先复用该边界。

第一阶段调用关系：

| Spring API | Node Runtime API | 行为 |
| --- | --- | --- |
| `GET /api/management/investigations/{id}` | `GET /api/rca/investigations/{id}` | 查询调查 |
| `POST /api/management/investigations/{id}/cancel` | `POST /api/rca/investigations/{id}/cancel` | 取消调查 |
| `GET /api/management/health` | 无 | Spring 自身健康检查 |

后续如果 Spring 成为真正的平台入口，可以在不破坏 Agent Runtime 的前提下扩展内部 Runtime API。

## 6. 分层结构

```text
apps/management-server/
├── pom.xml
└── src/
    ├── main/java/com/piops/management/
    │   ├── ManagementServerApplication.java
    │   ├── controller/
    │   │   ├── HealthController.java
    │   │   └── InvestigationController.java
    │   ├── service/
    │   │   ├── InvestigationService.java
    │   │   └── impl/InvestigationServiceImpl.java
    │   ├── client/
    │   │   ├── AgentRuntimeClient.java
    │   │   └── HttpAgentRuntimeClient.java
    │   ├── config/
    │   │   └── AgentRuntimeProperties.java
    │   ├── common/
    │   │   └── ApiResponse.java
    │   └── exception/
    │       ├── GlobalExceptionHandler.java
    │       └── RuntimeClientException.java
    └── resources/
        └── application.yml
```

约束：

- Controller 不写 Runtime HTTP 调用；
- Service 不依赖 Node/Pi SDK；
- Runtime HTTP 细节只存在于 `client`；
- 后续如果 HTTP 改为 MQ/RPC，Service 接口尽量保持稳定。

## 7. 技术选型

### JDK 21

选择 JDK 21：

- LTS；
- 对传统 Spring 后端生态成熟；
- 满足当前服务需求，不为了新语法追高版本。

### Spring Boot 3.5.16

第一阶段固定 Spring Boot 3.5.16，而不是直接升级 4.x。

原因：

- 当前目标是建立管理面边界，而不是同时承担 Spring 4 / Framework 7 的迁移变量；
- 3.5.16 可运行于 Java 21；
- 后续升级 Boot 4 应作为独立技术升级处理。

### Spring MVC

使用 `spring-boot-starter-web`：

- Controller / Service 结构直观；
- 当前 Management Plane 主要是普通 REST 管理请求；
- 不因为 Node 侧存在 SSE 就强制引入 WebFlux；
- 后续若存在大量流式代理需求，再单独评估。

### HTTP Client

使用 Spring `RestClient`。

第一阶段调用是同步的管理请求，避免为简单代理引入额外异步模型。必须设置连接/读取超时，不允许无限等待。

## 8. API 与错误语义

Spring 对外统一返回管理侧 Envelope：

```json
{
  "success": true,
  "data": {}
}
```

失败：

```json
{
  "success": false,
  "error": {
    "code": "AGENT_RUNTIME_UNAVAILABLE",
    "message": "Agent runtime request failed"
  }
}
```

原则：

- 不把 Node 堆栈直接返回给调用方；
- HTTP 4xx/5xx 不吞掉；
- Runtime 不可达与业务失败要区分；
- 第一阶段不过度设计错误码枚举，只建立稳定形状。

## 9. 配置

`application.yml`：

```yaml
server:
  port: ${MANAGEMENT_SERVER_PORT:8080}

agent-runtime:
  base-url: ${AGENT_RUNTIME_BASE_URL:http://127.0.0.1:4328}
  connect-timeout: ${AGENT_RUNTIME_CONNECT_TIMEOUT:2s}
  read-timeout: ${AGENT_RUNTIME_READ_TIMEOUT:30s}
```

禁止：

- 在配置中硬编码生产域名；
- 在仓库提交 API Key；
- Spring 直接共享 Node 本地持久化目录。

## 10. 数据所有权

第一阶段不引入 MySQL，避免出现两个 Investigation 事实源。

```text
Investigation / Evidence / Hypothesis / Agent Runtime State
                       │
                       ▼
                  Node Runtime
                 （唯一事实源）
```

未来引入 MySQL 时，优先保存**管理元数据**：

- task_id；
- user_id；
- runtime_execution_id / investigation_id；
- requested_at；
- tenant / source；
- platform-level status mirror；
- audit metadata。

其中 Runtime 状态镜像只能用于查询和治理，不能反向覆盖 Agent 内部状态。

## 11. 一致性与失败处理

### Spring 调 Node 超时

- 返回明确的 Runtime unavailable / timeout 错误；
- 不假定请求一定没有在 Node 执行；
- 对未来“创建任务”类写操作必须增加 requestId / idempotency key。

### Node 重启

继续由 Node 当前恢复机制负责：

- running Investigation → interrupted；
- tool / expert task 做对应恢复收敛；
- Spring 不复制该恢复逻辑。

### Spring 重启

第一阶段 Spring 无状态，重启不影响 Agent Runtime。

## 12. 安全边界

第一阶段即使暂未启用认证，也需要保证结构上可加入：

```text
External Request
      ↓
Authentication / Authorization
      ↓
Controller
      ↓
Service
      ↓
AgentRuntimeClient
```

未来 Runtime 内部接口应使用服务间鉴权，不能因为部署在同一平台就默认可信。

## 13. 第一阶段实施范围

本分支实施：

1. 新增 `apps/management-server`；
2. JDK 21 + Maven + Spring Boot 3.5.16；
3. Spring MVC；
4. 健康检查；
5. `AgentRuntimeClient` 抽象；
6. 查询 Investigation；
7. 取消 Investigation；
8. Runtime HTTP 超时与异常转换；
9. 基础单元测试；
10. 不改现有 React → Node 调用链。

验收链路：

```text
GET /api/management/investigations/{id}
                ↓
InvestigationController
                ↓
InvestigationService
                ↓
AgentRuntimeClient
                ↓
GET Node /api/rca/investigations/{id}
```

## 14. 后续迁移顺序

建议严格按下列顺序演进：

1. **Runtime Client 边界**：先稳定 Spring → Node；
2. **Task / Execution 元数据**：Spring 建自己的管理模型；
3. **告警平台接入**：由 Spring 创建和管理平台任务；
4. **用户 / Auth / LLM Config**；
5. **数据库与审计**；
6. **调度 / MQ**（确实出现需求后再引入）；
7. Web 是否切到 Spring Gateway/Management API，单独评估。

不建议先迁 Conversation / Pi Session，因为它们与当前 Runtime 强耦合且已经有成熟生命周期处理。

## 15. 验收原则

第一阶段完成后必须满足：

- Node/Pi 原有行为无回归；
- Spring 不依赖任何 Pi SDK；
- Spring 不访问 Agent 本地文件；
- Controller / Service / Client 边界清晰；
- Runtime URL 和超时可配置；
- Runtime 异常不会变成空响应；
- 新服务可独立启动和构建；
- 删除 Spring 服务不会影响原有 Pi Chat 的运行。


## 16. 第二阶段补充：Task / Execution

Spring 后续真正拥有的领域对象不是 Investigation，而是 Task 与 Execution。

关系固定为：

```text
Task（平台意图）
  └── Execution（一次运行尝试）
         └── Investigation（Agent Runtime 内部调查）
```

完整状态机、幂等、事务和崩溃窗口见 [Task / Execution 模型设计](spring-management-task-execution-spec.md)。

特别注意：当前 `RcaService.beginAgentic()` 只初始化 Investigation 和告警上下文，真正的持续调查仍由 Conversation / Pi Main Agent 驱动。因此在 Runtime 提供完整“外部执行入口”之前，不应为了 API 完整度直接实现 `POST /api/management/tasks` 并调用 `beginAgentic()`，否则会创建没人继续推进的半成品 Investigation。

## 17. Request ID

管理面统一接受并返回 `X-Request-ID`：

- 上游传入合法值时沿用；
- 未传或格式不安全时由 Spring 生成；
- Spring 调 Node Runtime 时继续透传；
- 请求结束后清理 ThreadLocal，避免 Tomcat 工作线程复用造成上下文串线。

`X-Request-ID` 只用于链路追踪，不承担业务幂等职责。未来创建 Task / Execution 时另行使用持久化的 Idempotency Key。

## 18. 健康检查语义

区分两个健康接口：

| API | 含义 |
| --- | --- |
| `GET /api/management/health` | Spring Management Server 自身可服务 |
| `GET /api/management/runtime/health` | Spring 能否通过配置的 Runtime 地址访问 Node Agent Server |

Runtime health 失败不能直接推断某个 Investigation 已失败；它只代表当前调用时刻的连通性。

## 19. Spring Boot 版本说明

当前实现继续固定 Spring Boot 3.5.16 + JDK 21，以保持本阶段变量可控。Spring Boot 3.5.16 可以运行于 Java 21，但 3.5.16 已是 3.5.x 最后一个 OSS 版本。

因此：

- 本分支不同时执行 Spring Boot 4.x 升级；
- 合并管理面基础结构后，应单独建立升级任务评估 Spring Boot 4.x；
- 新增第三方依赖时要同时核对 Boot 3.5 与未来 Boot 4 的兼容性，避免形成迁移阻塞。
