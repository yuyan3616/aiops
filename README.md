# AIOps RCA Agent

基于 **Pi Agent** 构建的多智能体根因分析（RCA）工作台。

它不是一个独立的“RCA 脚本”或固定流程编排器，而是把 RCA 能力直接集成进正常的 Pi 对话运行时：**Main Agent 负责提出与维护可证伪假设，并按需调度 Trace、Metrics、Log、Event / Topology 专家 Agent 收集证据，最终收敛根因。**

> 在线 Demo：`https://pi-chat-rca-production.up.railway.app`

## 核心能力

- **Hypothesis-driven RCA**：围绕可证伪假设推进调查，而不是一次性生成结论。
- **Multi-Agent Investigation**：Main Agent 按调查需要调度 Trace、Metrics、Log、Event / Topology 专家 Session。
- **Evidence-oriented Reasoning**：工具结果被沉淀为 Observation / Evidence，并通过 `rawRef` 保留完整可追溯数据。
- **原生 Pi 推理流**：Main Agent 与 Specialist Agent 都使用真实 Pi Session，不存在独立 deterministic RCA planner。
- **调查生命周期管理**：支持运行、取消、中断恢复、历史持久化与后续追问。
- **对话式 RCA UI**：思考、工具、专家子任务、证据和最终结论统一呈现在会话时间线中。
- **RCA100 t039 Demo**：仓库提供真实 t039 遥测数据的可复现下载与独立评分流程。
- **CI/CD**：GitHub Actions 完成 Typecheck、Lint、Unit Test、Build，通过后由 Railway 部署 `main`。

## 架构

```text
User
  |
  v
Pi Main Agent
  |
  +-- RCA Main Agent Tools
  |     |
  |     +-- overview / bounded queries
  |     +-- hypothesis lifecycle
  |     +-- specialist dispatch
  |     +-- investigation state
  |     +-- conclusion
  |
  +-- Pi Specialist Sessions
        |
        +-- Trace Agent
        +-- Metrics Agent
        +-- Log Agent
        +-- Event / Topology Agent
               |
               v
        Observability Tools
               |
               v
          RCA100Adapter
               |
               +-- Observation
               +-- Evidence
               +-- rawRef

completed investigation
        |
        v
 independent evaluator
        ^
        |
    Ground Truth
```

Main Agent 是唯一的调查协调者。它负责：

1. 建立调查；
2. 创建候选假设；
3. 决定下一步需要什么证据；
4. 调度专家 Agent；
5. 根据证据支持、削弱或排除假设；
6. 对剩余假设做最终收敛；
7. 持久化 RCA 结论。

## RCA 调查流程

```text
告警 / 用户问题
      |
      v
建立候选假设
      |
      v
选择下一步验证方向
      |
      +----> Trace Agent
      +----> Metrics Agent
      +----> Log Agent
      +----> Event / Topology Agent
      |
      v
Observation / Evidence
      |
      v
更新假设状态
      |
      +----> supported
      +----> rejected
      +----> unresolved
      |
      v
根因收敛与最终报告
```

## 项目结构

```text
.
├── apps/pi-chat/
│   ├── src/                       # React 前端
│   │   ├── components/            # 对话、Agent、工具、侧边栏等 UI
│   │   └── hooks/                 # 流式会话状态
│   ├── server/
│   │   ├── conversation/          # Pi 会话运行时与持久化
│   │   ├── rca/
│   │   │   ├── profiles/          # Trace / Metrics / Log / Event-Topology 专家 Profile
│   │   │   ├── adapter.ts         # RCA100 数据适配
│   │   │   ├── main-agent-tools.ts
│   │   │   ├── pi-expert.ts       # Specialist Pi Session
│   │   │   ├── repository.ts      # Investigation 持久化
│   │   │   ├── service.ts         # RCA 生命周期
│   │   │   └── tools.ts           # Observability 工具
│   │   └── routes/
│   └── scripts/
├── docs/
│   └── rca-t039.md                # t039 调查、数据隔离与评分说明
├── Dockerfile
├── railway.json
└── .github/workflows/pi-chat-ci.yml
```

## 技术栈

- **Agent Runtime**：Pi Agent Core / Pi Coding Agent
- **Frontend**：React 19、TypeScript、Vite
- **Backend**：Hono、Node.js
- **RCA Data**：Parquet / hyparquet
- **UI**：Radix UI、Lucide
- **Observability（可选）**：Langfuse Pi Observability Plugin
- **Package Manager**：pnpm
- **CI**：GitHub Actions
- **Deployment**：Docker + Railway

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 准备环境变量

```bash
cp apps/pi-chat/.env.example apps/pi-chat/.env
```

最常用的本地配置：

```env
LOG_LEVEL=info
PI_CHAT_HOST=127.0.0.1
PI_CHAT_PORT=4328

RCA100_CASES_DIR=/absolute/path/to/RCA100/cases
RCA_INVESTIGATIONS_DIR=/absolute/path/to/pi-chat-rca-investigations
RCA_DEFAULT_CASE_ID=t039
```

模型与 Provider 凭据由 Pi 本地配置管理。不要把 API Key、真实 `.env`、会话记录或本机敏感路径提交到仓库。

### 3. 启动

```bash
pnpm dev:pi-chat
```

默认服务地址：

```text
http://127.0.0.1:4328
```

## RCA100 t039 Demo

仓库不会直接提交 RCA100 的大体积 Parquet 数据，而是提供可复现下载脚本。

```bash
cd apps/pi-chat
pnpm rca:fetch:t039
```

数据会写入：

```text
apps/pi-chat/.rca-data/cases/t039/
```

随后设置：

```bash
RCA100_CASES_DIR=$PWD/.rca-data/cases
```

正常启动 Pi Chat 后，可以直接在对话中提问，例如：

```text
帮我排查 t039 的根因
```

或：

```text
checkout 为什么突然变慢？
```

Main Agent 会自行决定何时进入 RCA 调查，并使用 RCA 工具和专家 Session 推进验证。

完整说明见：

- [RCA100 t039 investigation](docs/rca-t039.md)

## 调查持久化

每次 Investigation 会持久化假设、工具调用、Observation、Evidence、专家任务、诊断信息和最终报告。

典型产物包括：

```text
investigation.json
tool-calls.jsonl
events.jsonl
final-report.json
evaluation.json   # 仅评分后生成
```

完整原始证据不会直接倾倒进模型上下文；大结果会先压缩，完整数据仍通过 `rawRef` 保持可追溯。

如果进程在调查过程中重启，活动中的 Investigation 会被标记为 `interrupted`，Main Agent 可以基于已持久化证据继续处理，而不是把它永久视为失败。

## 独立评分

Ground Truth 不会暴露给 Agent Runtime。

评分使用独立 CLI，并且只有 evaluator 进程读取 `RCA100_ANSWER_KEY_DIR`：

```bash
RCA100_ANSWER_KEY_DIR=/absolute/path/to/RCA100/answer_key \
RCA_INVESTIGATIONS_DIR=./data/rca/investigations \
pnpm --filter pi-chat rca:evaluate INV-...
```

不要在 Agent Runtime 中配置 `RCA100_ANSWER_KEY_DIR`。

## 开发与验证

```bash
pnpm --filter pi-chat typecheck
pnpm --filter pi-chat lint
pnpm --filter pi-chat test
pnpm --filter pi-chat build
```

GitHub Actions 会在 `main` 上执行同一组验证：

```text
push / merge to main
        |
        v
GitHub Actions
        |
        +-- Install
        +-- Typecheck
        +-- Lint
        +-- Unit tests
        +-- Build
        |
        v
Railway deployment
        |
        v
Production
```

## Railway 部署

仓库根目录已经包含：

- `Dockerfile`
- `railway.json`

Railway 当前从 `main` 分支构建，使用根目录 Dockerfile。应用对外运行在 Railway 分配的 `$PORT`，内部 Hono API 使用独立端口，并由前端服务代理 `/api` 请求。

调查数据目录建议挂载持久化 Volume，避免服务重启后丢失 Investigation 记录。

## 当前定位

这是一个面向 **AIOps / Root Cause Analysis** 场景的工程原型与演示项目。

当前重点不是把 RCA 做成固定 Workflow，而是验证一种更 Agentic 的排障方式：

> 让 Main Agent 持有调查目标、假设与决策权，让不同 Observability 专家负责取证，再通过证据驱动的多轮证伪完成根因收敛。

## License

ISC
