# pi-lessons

基于 [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的 Pi Chat 学习项目，包含 React 前端和 Hono 服务端。

## 快速开始

```bash
pnpm install
cp apps/pi-chat/.env.example apps/pi-chat/.env
pnpm dev:pi-chat
```

服务默认监听 `http://127.0.0.1:4328`。

RCA100 t039 调查、数据隔离和评分说明见 [docs/rca-t039.md](docs/rca-t039.md)。

## 配置

`apps/pi-chat/.env` 可设置日志级别、监听地址和端口。模型与 Provider 凭据由本地 Pi 配置管理。

会话、记录和工作区数据默认保存在 `~/.pi/agent/pi-chat`，可通过 `PI_CHAT_ROOT_DIR` 修改。

将航班、12306 和酒店 MCP 配置写入 `~/.pi/agent/pi-chat/.mcp.json` 后，航班与酒店查询需要在 `apps/pi-chat/.env` 中设置 `VARIFLIGHT_API_KEY`、`DIDA_API_KEY`。

## 安全

不要提交 `.env`、API Key、会话记录或本机路径；提交配置示例时使用占位值。

## 许可

ISC

## Railway demo deployment

The repository includes a single-service Railway deployment for the Pi Chat RCA demo.

- The Docker image installs dependencies, downloads only the agent-facing RCA100 `t039` telemetry, and builds Pi Chat.
- Railway exposes the Vite preview server on `$PORT`.
- `/api` is proxied inside the container to the Hono backend on port `4328`.
- The public demo defaults to `RCA_AGENTIC_PLANNER=false`, so it works without a model API key while still showing the full investigation/tool/evidence stream.
- To enable the Pi coordinator planner later, set `RCA_AGENTIC_PLANNER=true` and configure `RCA_MODEL_PROVIDER` / `RCA_MODEL_ID` plus the provider credentials in Railway variables.

The deployment source should use branch `feat/pi-chat-rca` and the repository root, where `Dockerfile` and `railway.json` are located.
