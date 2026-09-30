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
