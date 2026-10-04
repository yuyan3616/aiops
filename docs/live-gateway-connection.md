# Live 查询网关接入

本次消费端修复以用户确认已部署的 Target `f3fa1516b21a11023ee91cf12995844ced20826e` 为对接基线。Target 分支无需合并进 main。本文只描述接入配置，不代表网关或 Railway 已部署、真实 smoke 已通过。

## NGINX 与环境变量

可以使用三个子域名，也可以在同一个 HTTPS 域名下使用路径前缀：

```dotenv
TEMPO_BASE_URL=https://observe.example.com/tempo/
LOKI_BASE_URL=https://observe.example.com/loki/
PROMETHEUS_BASE_URL=https://observe.example.com/prometheus/
```

客户端保留 BASE_URL 的路径前缀。NGINX 应移除网关前缀后转发，不能要求客户端通过重定向跳到另一个地址：

| 网关请求示例 | 后端收到的路径 |
| --- | --- |
| `/tempo/api/search` | `/api/search` |
| `/tempo/api/v2/traces/<id>` | `/api/v2/traces/<id>` |
| `/loki/loki/api/v1/query_range` | `/loki/api/v1/query_range` |
| `/prometheus/api/v1/series` | `/api/v1/series` |
| `/prometheus/api/v1/metadata` | `/api/v1/metadata` |
| `/prometheus/api/v1/query_range` | `/api/v1/query_range` |

Loki 的网关前缀 `/loki/` 与后端自带的 `/loki/api/...` 是两层路径；不能在反向代理中重复删除。

若 NGINX 使用 Basic Auth，在 Railway 为每个 backend 分别配置：

```dotenv
TEMPO_BASIC_USERNAME=rca_reader
TEMPO_BASIC_PASSWORD=<网关密码>
LOKI_BASIC_USERNAME=rca_reader
LOKI_BASIC_PASSWORD=<网关密码>
PROMETHEUS_BASIC_USERNAME=rca_reader
PROMETHEUS_BASIC_PASSWORD=<网关密码>
```

也可使用已有的 `*_BEARER_TOKEN`。同一 backend 不同时配置 Basic 与 Bearer。密码不放 URL、仓库、Prompt 或用户聊天中。`*_TENANT_ID` 仅在对应后端实际启用 tenant 时设置；NGINX 登录账号不等于后端 tenant。

查询网关应限定所需只读路径；Target 本机后端查询端口可以继续绑定 `127.0.0.1`。消费端禁止 HTTP redirect，查询总 deadline 为15秒，含排队、读取和有限重试；代理超时应避免比这更早截断正常结果。

## 数据映射与验收

网关只提供连接，不能修正数据标签。现有 `LOKI_*_LABEL` / `PROMETHEUS_*_LABEL` 需要根据实际输出设置，不能把示例中的 service/environment/container 名称视为已验证映射。

接通后从实际 Railway Runtime 执行：

1. 记录 Tempo/Loki/Prometheus 版本、最终 label mapping 和 Target 版本。
2. 用已知服务、窗口和请求查询 Tempo search + get_trace，确认 v2 的 `trace.resourceSpans`、ID 和 partial 状态。
3. 查询 Loki 的失败 lifecycle 日志，核对 Pino level、lifecycleStatus、事件时间及 Trace/Span ID。
4. 发现真实 Counter/classic Histogram/Gauge；核对 Histogram family 与 `_bucket/_sum/_count`，再执行 rate/quantile/raw。
5. 验证错误认证、timeout、取消，以及一轮 Main + 三类 Expert 的完整取证流程。

仅有 HTTP 200 或 mock 成功不算上述验收通过。当前 Exemplar 与 provider attempt lifecycle 仍为不可用能力，不增加虚假的关联。无法访问服务器时将真实 smoke 保持 BLOCKED，记录原因。
