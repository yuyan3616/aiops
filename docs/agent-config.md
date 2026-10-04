# Agent 配置加载与角色注册表

## 范围

配置源：[yuyan3616/aiops-agent-config](https://github.com/yuyan3616/aiops-agent-config)。第一阶段只迁移 Main/Trace/Metrics/Log 身份、SYSTEM.md、技能文档、工具允许列表；新增角色可以组合已实现的 Live 工具。没有新增配置微服务、数据库、Webhook 或管理后台。

注册表从配置构造专家 Profile；Evidence 模态由服务端按工具推导。专家总查询上限仍为 12，query_metrics 上限仍为 6；Finding 强度规则、submit_finding 协议、Budget v2、授权和取消不允许配置覆盖。event-topology 仅保留历史兼容 Profile，不可注册或派发。

## 加载

启动与每 60 秒后台轮询先解析目标 ref 的 commit SHA，再以该 SHA 读取 manifest 引用的全部文件，校验后原子启用。每个文件最多 64 KiB，整个配置包最多 512 KiB。只接受受控 JSON/Markdown 相对路径、已实现工具、已注册技能和已知字段。没有远程代码执行。

新调查持久化 agentConfigVersion；同一 Main 轮次及新建调查使用同一个快照，专家按调查的固定版本构造。Main 正在运行时后台更新不会改写其提示词；下一轮普通对话及终态追问可以使用最新版，运行中或 interrupted 调查的 Main 继续使用原版本。原调查证据及结论不受影响。终态会话明确新建调查时使用本轮选定的新版本。

已有 Live 调查缺少 agentConfigVersion 时使用随版默认快照，维持原三类专家能力。历史 RCA100 仍保持只读。本功能不改 schemaVersion/Budget ledger。

## 缓存与恢复

缓存保存在 PI_CHAT_ROOT_DIR/agent-config：每版本一个不可变 JSON 快照，active.json 为最近有效版本指针。完整写入版本缓存后才更新指针并在内存启用；缓存与加载结果深度冻结。启动优先恢复缓存，再尝试远程刷新；远程失败保留最近有效版本，没有有效缓存时使用 bundled 默认快照。

正在恢复的调查指定版本缺失或损坏时明确失败，不退回最新版。缓存不应手动清理仍被调查引用的版本。生产需将 PI_CHAT_ROOT_DIR 放在持久化卷中。

应用内 server/agent-config/bundled 是当前配置仓库的发布快照，用于未配置远程源或首次离线启动；日常编辑以配置仓库为准。需要升级离线默认值时，将已审查的配置仓库快照同步至 bundled 并随应用发布，不维护两套 Profile 代码。

## 配置 Railway

- AGENT_CONFIG_REPOSITORY：yuyan3616/aiops-agent-config。
- AGENT_CONFIG_REF：默认 main，可固定 tag/commit 用于受控发布。
- AGENT_CONFIG_GITHUB_TOKEN：私有仓库只读凭据，仅授予该仓库 Contents Read-only；直接填 Railway，不提交 Git。

首次接入环境变量需要部署/重启。以后配置提交默认一分钟内检查，新调查使用已成功加载的版本。启动日志输出实际版本；刷新失败只输出固定错误码，不输出凭据、HTTP 错误内容或提示词。

## 编辑与验证

配置文件说明及新增角色示例见配置仓库 README。在 apps/pi-chat 中执行 pnpm agent-config:validate /path/to/aiops-agent-config，验证路径、角色、工具、技能及包大小。服务端加载时使用相同校验器。

验证覆盖无效配置拒绝、原版本固定、跨重启离线缓存、版本缺失拒绝、新注册角色派发及中文展示、原有三类专家的技能选择与 Finding 校验。这里只做确定性运行时验证，不把模拟模型执行当成真实 LLM 效果验证。
