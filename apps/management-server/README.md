# Management Server

Spring Boot 管理面服务。当前阶段只负责管理 API 与 Agent Runtime 调用边界，不承载 Pi Agent Runtime，也不直接访问 Pi Session / Investigation 文件。

## 技术栈

- JDK 21
- Spring Boot 3.5.16
- Spring MVC
- Maven

## 本地启动

先启动现有 Node/Pi Agent Server（默认端口 4328），再执行：

```bash
cd apps/management-server
mvn spring-boot:run
```

默认管理服务监听 `8080`。

可配置：

```bash
export MANAGEMENT_SERVER_PORT=8080
export AGENT_RUNTIME_BASE_URL=http://127.0.0.1:4328
export AGENT_RUNTIME_CONNECT_TIMEOUT=2s
export AGENT_RUNTIME_READ_TIMEOUT=30s
export AGENT_RUNTIME_EXECUTION_TOKEN=replace_with_the_same_runtime_service_token
export MANAGEMENT_DB_HOST=127.0.0.1
export MANAGEMENT_DB_PORT=3306
export MANAGEMENT_DB_NAME=management
export MANAGEMENT_DB_USERNAME=management
export MANAGEMENT_DB_PASSWORD=replace_me
export MANAGEMENT_API_TOKEN=replace_with_a_long_random_management_token
```

## 当前 API

```text
GET  /api/management/health
GET  /api/management/runtime/health
GET  /api/management/investigations/{investigationId}
POST /api/management/investigations/{investigationId}/cancel
```

所有管理面响应都会返回 `X-Request-ID`，调用 Node Runtime 时会继续透传该标识，方便跨服务排查。

设计边界见 `docs/spring-management-server-spec.md`；Task / Execution 的后续模型见 `docs/spring-management-task-execution-spec.md`。


## Runtime Execution 安全边界

会触发 Main Agent / LLM 调用的 Runtime Execution API 使用单独的服务间 token。Node 侧配置 `RCA_EXECUTION_API_TOKEN`，Spring 侧配置相同值到 `AGENT_RUNTIME_EXECUTION_TOKEN`。

未配置 token 时：

- Spring 的普通健康检查和 Investigation 查询仍可使用；
- Runtime Execution 创建/查询/取消不会退化成匿名调用，而是明确拒绝。

token 只通过环境变量提供，不提交到仓库。


## MySQL 持久化

管理面数据库只保存 `Task / ManagementExecution` 等平台元数据，不保存 Pi Session、Hypothesis、Evidence 或 Investigation 详情。

生产环境建议在 Railway 同一项目中使用独立 MySQL 服务，并通过 service reference 注入：

```text
MANAGEMENT_DB_HOST      -> <MySQL service>.MYSQLHOST
MANAGEMENT_DB_PORT      -> <MySQL service>.MYSQLPORT
MANAGEMENT_DB_NAME      -> <MySQL service>.MYSQLDATABASE
MANAGEMENT_DB_USERNAME  -> <MySQL service>.MYSQLUSER
MANAGEMENT_DB_PASSWORD  -> <MySQL service>.MYSQLPASSWORD
```

应用启动时由 Flyway 自动执行版本化迁移；`flyway.clean` 已禁用，生产环境不会通过应用执行清库操作。


## Task 管理 API

Task API 当前定位为平台内部接口，所有 `/api/management/tasks/**` 请求必须携带：

```http
Authorization: Bearer <MANAGEMENT_API_TOKEN>
```

未配置 token 时接口默认关闭，而不是匿名开放。

当前接口：

```text
POST /api/management/tasks
GET  /api/management/tasks/{taskId}
POST /api/management/tasks/{taskId}/execute
POST /api/management/tasks/{taskId}/sync
POST /api/management/tasks/{taskId}/cancel
```

语义约束：

- 创建 Task 必须带 `Idempotency-Key`；
- 首次创建返回 201，幂等重放返回 200 + `replayed=true`；
- 创建 Task 不会自动触发 LLM；
- `execute` 才会预留 ManagementExecution 并调用 Node Runtime；
- `sync` 只同步已有 Execution，不会隐式创建新的执行；
- Task API 响应不会暴露数据库 `row_version` 或 Idempotency-Key hash；
- `cancel` 对未 dispatch 的 CREATED 执行做纯本地取消；
- 对 `DISPATCHING/UNKNOWN` 且尚未拿到 Runtime Execution ID 的情况，会先利用稳定的 `management:MEXEC-...` 幂等键恢复/确认真实 Runtime Execution，再调用 Runtime cancel；
- 只有 Runtime 取消结果确认后，管理面才会落终态 CANCELLED，避免“数据库显示已取消但 Main Agent 仍运行”。


## Railway 健康检查

部署 Spring Management Server 时建议：

```text
Healthcheck Path: /actuator/health/readiness
```

探针语义：

- `/actuator/health/liveness`：只判断 Spring 进程是否存活，不依赖 MySQL；
- `/actuator/health/readiness`：包含 MySQL `db` health，数据库不可用时停止接收新流量；
- Node Agent Runtime 不纳入 Spring readiness，Runtime 短暂不可用会由 Task Execution 的 UNKNOWN/重试语义处理，不触发 Spring 容器重启。
