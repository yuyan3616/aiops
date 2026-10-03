# Target Observability v1

第一阶段只验证真实 Agent Trace，不部署 Tempo/Loki。

## 1. 创建内部 Docker 网络

```bash
docker network create aiops-observability 2>/dev/null || true
```

## 2. 启动 OpenTelemetry Collector

在仓库根目录执行：

```bash
docker rm -f otel-collector 2>/dev/null || true

docker run -d \
  --name otel-collector \
  --restart unless-stopped \
  --memory=128m \
  --network aiops-observability \
  -v "$PWD/deploy/observability/otel-collector.yaml:/etc/otelcol-contrib/config.yaml:ro" \
  otel/opentelemetry-collector-contrib:latest
```

Collector 仅加入内部 Docker 网络，不需要向公网暴露 4318。

## 3. Target 配置

在现有 `.env` 中加入：

```bash
OTEL_SERVICE_NAME=aiops-rca-target
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

重新构建镜像：

```bash
docker build -t aiops-rca-target:observability-v1 .
```

重新创建 Target 容器时加入同一网络：

```bash
docker rm -f aiops-rca-target 2>/dev/null || true

docker run -d \
  --name aiops-rca-target \
  --restart unless-stopped \
  --network aiops-observability \
  --env-file /opt/aiops-target/.env \
  -p 3000:3000 \
  -v /opt/aiops-target-data:/data \
  aiops-rca-target:observability-v1
```

## 4. 验证

打开页面发一条会触发工具的普通消息，例如：

```text
你好，现在几点钟？
```

查看 Target 的结构化日志：

```bash
docker logs --tail 200 aiops-rca-target | grep -E '"event":"pi\.(main_agent|provider|tool)'
```

查看 Collector 收到的 Trace：

```bash
docker logs --tail 300 otel-collector
```

预期能看到同一 trace 下的：

- `pi.main_agent.run`
- 一到多次 `pi.provider.request`
- `pi.tool.call`（例如 `utc_time`）

结构化日志同时携带 `traceId` / `spanId`，后续接 Loki/Tempo 时直接用于关联。

## 回滚

代码回滚到原始基线：

```bash
git checkout target/production-baseline
git pull
docker build -t aiops-rca-target:baseline .
```

然后按原来的启动命令重新创建 `aiops-rca-target` 即可。


## 5. 接入 Tempo

这一步只用于单机测试。Tempo 使用 monolithic 模式和本地磁盘，不需要 Kafka。

创建 Tempo 数据卷：

```bash
docker volume create tempo-data
```

启动 Tempo：

```bash
docker rm -f tempo 2>/dev/null || true

docker run -d \
  --name tempo \
  --restart unless-stopped \
  --network aiops-observability \
  --memory=320m \
  --memory-swap=384m \
  -p 127.0.0.1:3200:3200 \
  -v "$PWD/deploy/observability/tempo.yaml:/etc/tempo.yaml:ro" \
  -v tempo-data:/var/tempo \
  grafana/tempo:3.1.0 \
  -target=all \
  -config.file=/etc/tempo.yaml
```

检查 Tempo：

```bash
docker ps | grep tempo
docker logs --tail 100 tempo
curl -s http://127.0.0.1:3200/ready
```

Collector 配置已同时把 traces 转发到 `http://tempo:4318`，因此 Tempo 启动后需要重建 Collector：

```bash
docker rm -f otel-collector

docker run -d \
  --name otel-collector \
  --restart unless-stopped \
  --memory=128m \
  --network aiops-observability \
  -v "$PWD/deploy/observability/otel-collector.yaml:/etc/otelcol-contrib/config.yaml:ro" \
  otel/opentelemetry-collector-contrib:latest
```

然后在页面发一次 Agent 请求，再检查 Tempo 搜索 API：

```bash
curl -s "http://127.0.0.1:3200/api/search?limit=20"
```

如果要彻底清理本次 Tempo 测试：

```bash
docker rm -f tempo
docker volume rm tempo-data
```
