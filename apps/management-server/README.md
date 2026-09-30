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
```

## 当前 API

```text
GET  /api/management/health
GET  /api/management/investigations/{investigationId}
POST /api/management/investigations/{investigationId}/cancel
```

设计边界见 `docs/spring-management-server-spec.md`。
