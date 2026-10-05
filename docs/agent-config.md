# 版本化 Agent 配置与工具扩展

配置源为 [aiops-agent-config](https://github.com/yuyan3616/aiops-agent-config)。配置版本始终使用完整 Git commit SHA。一个版本同时绑定角色 JSON、SYSTEM.md、技能、工具 Schema、说明和执行适配器；调查的 agentConfigVersion 固定这整套内容。

## 分工与执行

schemaVersion 2 的 manifest 声明 hostApiVersion: "1"、扩展 entry/SHA256，角色声明 extensions 和 tools。配置仓库提前构建单文件 .mjs；生产不运行 npm install 或构建。模块只导出 createExtension({sdk, host})，返回 Pi ExtensionFactory。sdk 注入当前安装版本的 Type、defineTool 和只读 limits。Main 与 Expert 的实际注册通过 ResourceLoader.extensionFactories 完成，应用中不再保留同名工具 Schema 或备用实现。Pi SDK 保持 0.86.1。

Host 保留 Service、Provider、鉴权、Budget v2、持久化、取消、并发与原始记录链。每个角色只获得允许的宿主操作；扩展仍需注册其允许列表中的全部工具，专家还需注册 submit_finding。Query 阶段宿主拒绝 Finding，Finalize 阶段关闭查询，保持同一 Session。Finding 的领域校验、toolCallId、来源快照、模态和假设检查继续由应用执行。

这是受信任仓库代码执行，不是沙箱。AST 检查和 hash 检查防止误打包、导入依赖和包损坏，不把有执行权限的仓库变成不受信任代码隔离环境。扩展须经过代码审查，禁止顶层副作用、外部依赖、网络和文件 I/O。敏感数据源访问只经 Host。

## 加载、固定与缓存

启动及每 60 秒轮询先解析 ref 的 SHA，再从该 SHA 获取整个包。v2 最多 128 个文件、总计 2 MiB；.mjs 每个最多 256 KiB，JSON/Markdown 每个最多 64 KiB。v1 仍采用旧格式及 512 KiB 上限。检查路径、文件类型、hash、hostApiVersion、角色契约、重复注册、Schema、缺失工具及工厂初始化；预检失败保留最近有效版本。

持久化目录为 PI_CHAT_ROOT_DIR/agent-config。<SHA>.json 保存完整源快照，versions/<SHA>/ 保存可执行文件与 complete.json；完整目录原子落盘后才更新 active.json。启动从磁盘再次检查完整性及模块；缺失或损坏版本明确失败，不回退到最新版。生产目录须在持久化卷上，不自动清理仍被历史调查引用的版本。

Main 创建 Runtime 时一次选定配置版本。运行中、interrupted 调查继续使用原版本；普通对话及终态追问在下一次空闲轮次可切换新版本。切换复用 SessionManager、消息 channel、model、thinking 以及会话记录，先成功初始化候选 Runtime 再释放旧 Runtime。流式输出、待处理延续或持有执行 lease 时不切换。宿主拒绝工具版本与进行中调查不一致的操作。

已有 Live 调查没有 agentConfigVersion 时在继续执行前固定一次当前版本。RCA100 保持只读；调查 schemaVersion 2、formatVersion 3、Budget v2 不变。

## v1 恢复迁移

历史 v1 Profile 没有代码引用，不能自动拼接当前扩展。操作员需预热经过审查的 v2 commit，并建立不可变的旧 SHA → 兼容扩展 SHA 映射。旧版本提示词、技能和工具允许列表仍来自旧 Profile，只借用映射后的扩展实现。映射记录在 legacy-bindings.json；已经绑定的版本不能改绑。

在 apps/pi-chat 执行：

```bash
pnpm agent-config:migrate /persistent/pi-chat/agent-config /path/to/committed-aiops-agent-config OLD_SHA_1,OLD_SHA_2
```

checkout 必须有完整 commit SHA 且工作区干净；命令检查所有旧角色和工具的兼容性，预热新代码包并记录映射，不修改 active 指针。此命令只供操作员使用，不向 Agent 暴露。未绑定的 v1 仍可读取，但执行会明确报错。

## 配置与验证

环境变量保持 AGENT_CONFIG_REPOSITORY、AGENT_CONFIG_REF、AGENT_CONFIG_GITHUB_TOKEN；私有仓库使用仅该仓库 Contents Read-only 凭据。受控发布建议先固定候选 commit，预热、执行旧版迁移、验证新旧调查恢复，再切换配置 ref。主应用回滚前应确认旧二进制能读取当前活动配置，必要时恢复 v1 active 指针；新产生的 v2 调查须由兼容应用继续执行。

在配置仓库运行 pnpm install --frozen-lockfile、pnpm run build:check；应用目录运行：

```bash
pnpm agent-config:validate /path/to/aiops-agent-config
AGENT_CONFIG_TEST_DIRECTORY=/path/to/aiops-agent-config pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

联合测试直接读取候选配置仓库，覆盖真实 Main/Expert 注册、零专家调查、Query/Finalize 和 Finding；模型输出为确定性模拟，不代替真实 LLM Live 回放。其余测试覆盖缓存离线恢复、坏包保留、显式旧版映射、空闲切换失败保留旧会话及繁忙拒绝切换。代码开发完成后的生产验收还需真实 LLM、SSE、暂停/恢复与进程重启回放。
