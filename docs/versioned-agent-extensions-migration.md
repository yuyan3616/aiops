# Agent Profile 与版本化工具 Extension 迁移方案

状态：待用户审查；本轮仅核查与写方案，未实现、未部署。日期：2026-10-04。

## 1. 目标与结论

让 aiops-agent-config 同时维护角色身份、SYSTEM.md、Skill、工具允许列表，以及工具注册、参数 Schema 和 execute 入口。已有宿主能力范围内的工具调整，通过发布一个配置 commit 生效，无需修改或重启主应用；新增数据源或宿主业务能力仍需要应用发布。

建议采用 **预构建、自包含 ESM + Pi 内联 ExtensionFactory + 窄宿主接口**。每个调查固定配置 commit；代码与提示词一起缓存。已有 Session 不做执行闭包热替换，Main 在下一轮空闲边界按版本重建运行实例。Provider、Budget、证据、事件和持久化继续留在主应用。

这是工具层独立化，首批不迁出全部 Adapter，不重写 orchestration，不迁移 Spring Boot，不增加管理后台、沙箱平台或代码/数据库/MQ 数据源。

## 2. 本轮核查事实

### 2.1 基线与核查限制

| 项目 | 2026-10-04 核查结果 |
| --- | --- |
| aiops/main | c1eb277156ae2fa6121006ac42ebd37ff485bc00，与交接一致 |
| aiops-agent-config/main | 013e27faf865a0cc38a6f99fc4075e220679d1b9，与交接一致 |
| Production health | status=ok；agentConfiguration.state=ready；版本为上述配置 SHA |
| Pi 实际锁定版本 | 根 pnpm-lock.yaml 中 pi-coding-agent / pi-ai / pi-agent-core 均为 0.86.1 |
| 开发约束 | 已读主仓库根 AGENTS.md；配置仓库递归目录中无 AGENTS.md |
| 工作区 | 新工作区原先只有上传文档；Git clone 因代理缺少认证失败，改用 GitHub 连接读取固定 SHA 文件及递归树 |
| 验证范围 | 没有完整安装 node_modules、运行本地回归测试或执行真实 LLM 调查；健康接口不证明完整排障闭环 |

本地 aiops 目录是审查用文件快照，不是完整 checkout，不把它描述为可直接构建的完整工作树。文档通过 GitHub 连接写入基于最新 main 的独立方案分支，不改 main 或生产。

已核对原《RCA智能体完整设计方案》的 Main、通用机制、角色注册与 10.2 配置目录设计。保留其“Profile 内有可执行 Extension”的方向，但使用现有 agents/ 目录，避免无收益改名。原设计的 Main 仅概览、强制多角色、Spring、自由 TraceQL、notes.md 权威状态、全量原始 dump、同参永久复用等不照搬；以当前 Live 合同与用户最新 Main 优先要求为准。

### 2.2 现状定位

以下 server 路径均相对 apps/pi-chat。

| 内容 | 当前实现 | 迁移意义 |
| --- | --- | --- |
| 角色 / Prompt / Skill | server/agent-config/store.ts 从独立仓库加载 | 已独立 |
| 配置格式 | manifest.schemaVersion=1；仅 JSON/Markdown；64 KiB/文件、512 KiB/包、128 文件 | 尚不能加载代码 |
| 缓存 | 每版本 JSON 快照 + active.json；校验后原子启用 | 要扩展为可重启恢复的代码包 |
| Main 工具 | server/rca/main-agent-tools.ts 的 8 个 defineTool；runtime.ts 的 utc_time | 名称、说明、Schema、execute 仍在主仓库 |
| Expert 工具 | server/rca/tools.ts 的 createPiTools，5 个 defineTool | 允许列表可配置不等于工具独立 |
| Finding 协议工具 | server/rca/pi-expert.ts 的 submit_finding 定义与执行 | 工具面可迁，最终接受权留宿主 |
| Main 版本切换 | main-extension.ts 每轮 before_agent_start 改 Prompt、setActiveTools | 不会替换已注册的执行闭包 |
| Main 生命周期 | conversation/service.ts 已有 Session 锁、空闲判断、SessionManager 与 EventChannel 复用逻辑 | 可局部扩展，不另造运行系统 |
| 专家生命周期 | pi-expert.ts 创建独立 Session，按调查 agentConfigVersion 读 Profile | 可直接按固定版本注入工厂 |
| 事实链 | RcaService.invokeRecordedToolV2 → Registry.prepare/execute → 快照、Observation、Evidence | 必须保持为宿主受控链路 |

固定协议版本仍为 Investigation schemaVersion=2、formatVersion=3、Budget v2。

## 3. 首批范围与最终归属

| 迁入配置仓库 | 主应用保留 |
| --- | --- |
| Main 9 个工具（含 utc_time）的名称、label、description、Schema、execute | 调查创建/恢复/更新/委托/结案的业务校验与幂等 |
| Expert 5 个查询工具的注册、Schema、execute | Provider 接口、后端 Client、查询编译、授权、安全上限 |
| submit_finding 的注册、模型参数 Schema、execute 转交 | Finalize phase、Finding 领域校验、来源与引用校验、接受与终止判定 |
| 参数到领域输入的适配、模型输出的工具层呈现 | 权威快照、引用 ID、预算、取消、generation fence、终态保护 |
| 共用工具呈现和 Schema 的源码模块 | Session/model 凭据、事件投影与 UI 订阅 |

不在宿主保留同名 ToolDefinition、模型说明或 Pi 参数 Schema 副本。宿主仍必须独立验证业务输入；Pi Schema 是模型调用界面，不是服务端授权边界。工具呈现可以变化，但不能丢掉用于审计的 toolCallId/sourceItems/snapshotRef，不能改写实际 query 或把失败包装为 no_data。

Trace / metric 工具名在宿主中作为能力标识保留合理；不要为了消除所有同名字符串破坏现有 ToolCall 或授权合同。

## 4. 最小包格式与加载方式

### 4.1 manifest v2

保留 roles、skills，新增 hostApiVersion、extensions；角色新增 extensions 引用列表。工具 tools 继续是每角色的明确允许列表。示意结构如下，字段名是本方案提议，尚未实现：

```json
{
  "schemaVersion": 2,
  "hostApiVersion": "1",
  "roles": ["agents/main/agent.json", "agents/trace/agent.json", "agents/log/agent.json", "agents/metrics/agent.json"],
  "skills": {},
  "extensions": {
    "rca-main-tools": {"entry": "dist/rca-main-tools.mjs", "sha256": "<生成时填写>"},
    "rca-trace-tools": {"entry": "dist/rca-trace-tools.mjs", "sha256": "<生成时填写>"},
    "rca-log-tools": {"entry": "dist/rca-log-tools.mjs", "sha256": "<生成时填写>"},
    "rca-metrics-tools": {"entry": "dist/rca-metrics-tools.mjs", "sha256": "<生成时填写>"},
    "rca-finding": {"entry": "dist/rca-finding.mjs", "sha256": "<生成时填写>"}
  }
}
```

Main 引用 rca-main-tools；每个专家引用其查询模块与 rca-finding。共享源码放 shared/extensions/rca-common/；源码位于 agents/<role>/extensions/，构建成 dist 的单文件 ESM。此处 skills 空对象只是缩略示例；实际包保留全部现有技能。

源码、构建产物、manifest 哈希必须在同一配置 commit，CI 重新构建并检查产物无差异；不提交依赖目录。运行时只拉 manifest 引用的 JSON/Markdown 与 dist 模块，不执行远端 package.json、安装脚本或构建命令。

### 4.2 为什么选预构建 ESM

0.86.1 官方版本源码确认：

- ExtensionFactory 类型为 (pi: ExtensionAPI) => void | Promise<void>。
- DefaultResourceLoader 支持 extensionFactories；加载器通过 loadExtensionFromFactory 初始化并提交注册。
- registerTool 支持名称、参数 Schema 与 execute；原生工具集合使用 Map，同名可能覆盖，宿主必须提前查重。
- Extension 初始化错误会进入 errors/diagnostics；不能只看到 reload 返回就认定加载成功。
- Tool.execute 的第三参数是 AbortSignal，迁移时必须传递到受控宿主执行。

选择模块导出 createExtension({ sdk, host })，每次 Session 创建返回新的 ExtensionFactory，由宿主注入 Type、defineTool 等固定 SDK 对象及会话宿主能力，再加入 extensionFactories。不依赖版本目录外的 node_modules 解析，不用最新 SDK API，也不顺手升级 Pi。

第一版产物必须自包含：不含相对 import、bare import、URL import、动态 import、require。共享源码和相对依赖在构建时全部打入入口，运行时依赖闭包就是 manifest 中列出的入口文件；SDK 由宿主注入。CI 与宿主用语法解析检查模块依赖，不能用正则冒充闭包验证。若需增加解析器，仅允许宿主锁定的构建依赖，不动态下载。未来多文件包另行扩展格式。

模块顶层无 I/O、副作用、Session 可变状态；工厂只注册工具，不创建 timer/socket/进程。Session 状态在工厂或宿主上下文中创建。第一版仅提供工具注册所需 API，注册后集合冻结，不允许运行期追加工具、改模型或接管生命周期。这个限制是接口约束，不是安全沙箱。

来源：
[0.86.1 Extension types](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/extensions/types.ts)；
[ResourceLoader](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/resource-loader.ts)；
[Loader](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/extensions/loader.ts)；
[SDK 文档](https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/docs/sdk.md)。

本轮核实的是 lockfile 和相同版本官方源码，未声称已经检查生产 node_modules 内容。实现前在完整 checkout 执行 frozen-lockfile 安装，核对实际导出类型，并用最小 Main/Expert Session 测试证明注入、生效、绑定和 dispose 行为。

## 5. 宿主接口 v1

提供按会话创建的 MainHost 与 ExpertHost，不暴露原始 RcaService、Registry、Repository、Provider、凭据或任意 execute(method,args)。

| 接口组 | 明确能力 | 宿主职责 |
| --- | --- | --- |
| Main | now、start、resume、overview、readTrace、updateHypotheses、dispatch、readState、conclude | 复用现有 Service；绑定 conversationId、operationId、模型、配置版本，串行化现有需要串行的修改，发布投影与会话关联 |
| Expert | searchTraces、getTrace、searchLogs、discoverMetrics、queryMetrics | 内部进入当前 context.invoke / invokeRecordedToolV2；保持每工具调用数、结果字节上限与故障分类 |
| Finding | submitFinding | Finalize-only；领域字段、modality、hypothesis、当前任务工具来源和 sourceItems 校验；成功才 terminate |
| 注册与结果 | registerTool 的受控适配、受限结果包装 | 查重、允许列表、执行阶段、信号与有界结果检查 |

Extension.execute 负责参数适配并调用一个对应宿主能力，宿主不返回预制 ToolDefinition。参数适配中的 logTraceId、metricOperation、refs 等既有语义保持不变。Host 返回稳定领域结果，由 Extension 生成 content/details，外层宿主确保最终文本仍在字节上限内、审计字段仍可追溯。

每个宿主操作接收执行 Signal；与调查/任务的取消信号合并。中断时底层 Promise 真正 settled 后才释放槽位。任务预算与阶段检查在实际能力调用处强制，不能只包住外层 execute 而允许一次工具内部无限多次查询。协议提交不消费调查预算，但非 Finalize 调用一律拒绝。

Main 绑定当前轮已选定的版本；涉及已有 running/interrupted 调查的写操作核对该调查固定版本，不能从工具参数传入另一个配置版本。主应用已有的操作幂等、事件映射、标题更新回调仍由宿主管理。

工具查重覆盖：同一模块重复、多个模块冲突、与 utc_time/协议工具/应用插件工具冲突。允许跨角色使用同名公共工具，因为不同 Session 独立。全部角色允许列表必须能对应实际注册集合；未允许工具既不启用，也不能通过宿主内部调用绕过。get_trace/search_traces、query_metrics/discover_metrics 的发现依赖由宿主继续验证。

新增已有能力的工具组合或呈现无需应用发布；要求宿主 v2 或全新 Provider 的包被拒绝并保留最近有效版本。

## 6. 缓存、原子激活与离线恢复

缓存位于既有持久化 agent-config 目录，新增 versions/<40位SHA>/，包含全部引用文件、模块、文件哈希索引及完成标记。原有 <SHA>.json v1 快照保留。每包版本目录不可变，禁止覆盖。

加载顺序：

1. 把仓库 ref 解析成一个 commit，后续文件全按该 commit 读取。
2. 拉入独立 staging 目录；拒绝 URL、绝对路径、..、符号链接、大小超限、缺文件、未知字段。
3. 校验格式/host API/哈希，解析依赖闭包，导入模块并对每角色做无 I/O 注册预检；验证 Schema 对象、execute 函数、角色工具集合与名称冲突。
4. 同一版本不同内容拒绝；预检完整通过后将 staging 原子 rename 为最终版本目录。
5. 原子替换 active.json，最后切换内存 active。失败保留旧 active；残留 staging 不作为有效缓存。
6. 创建真实 Session 时仍核对绑定错误与 diagnostics，不能忽略 Extension 初始化错误。

建议代码包限制为 128 文件、每模块 256 KiB、整包 2 MiB；JSON/Markdown 单文件仍 64 KiB；限制按解码后 UTF-8 字节计算，并保持 HTTP 响应体上限。首批不设置自动版本清理，避免误删仍被调查引用的旧代码。内存模块按最终绝对版本路径缓存；共享模块对象不存 Session 状态。

重启时重新校验磁盘包及 host API，再导入固定代码。远端不可达时使用已校验的 active 与固定版本目录。固定版本缺失/损坏/不兼容明确失败，历史阅读仍可用；不改用 latest、不从用户消息中获取下载地址。

“可加载”只证明格式与注册有效，不证明业务正确或可安全执行。预检不调用 Provider，不修改调查。

## 7. Main 长会话与版本选择

在 prompt 接受阶段、Session 锁内选择并冻结一份执行版本，before_agent_start 只使用已冻结值，不能再次读取 global current 造成代码与 Prompt 不一致。

| 场景 | 本轮版本 |
| --- | --- |
| 普通新轮次，没有活动 Live 调查 | 当前有效包 |
| running/interrupted Live 调查 | 调查固定版本 |
| 终态调查追问 | 当前 Main 配置；证据与历史结论保持原始版本 |
| streaming steering、队列中的当前执行 | 保持当前执行版本，不重建 |
| 本轮中新建调查 | 保存本轮固定版本；即使后台刷新也不变 |
| 固定版本丢失 | 明确错误；只读历史继续可用 |

给 ManagedSession 增加内部 executionVersion（旧格式则为 profileVersion + extensionVersion）；不改变 Conversation ID、Pi Session ID 和调查 schema。

下一轮 idle 时版本有变化，先校验并构造候选 Runtime，再切换 managed runtime。复用原 SessionManager、EventChannel、持久化聊天与外部 RCA 投影；保留用户选择的 model/thinking 等现有会话设置。只在本轮未被 acquire、无 streaming/compaction/queued continuation、无待完成写入时切换；同一 SessionManager 不允许两个 Runtime 同时 prompt。

构造失败返回明确错误，不用旧实现配新 Prompt 继续执行。成功后解绑旧订阅、dispose 旧 Session、绑定新 Session，确保只有一个订阅；保留 title generation、pending title refinement 和性能状态。当前 release 会删除 pendingTitleRefinements，不能直接复用而丢状态，应增加局部替换路径。

刷新期间不推送 UI 的“新会话”、不清空历史、不打断 dispatch。版本选择和 acquire/prompt 必须在同一受保护入口完成，避免并发 prompt 与切换竞态。若专家仍运行，保持其调查版本；后台刷新不会重建专家。

## 8. v1 旧配置迁移与固定版本

旧配置没有可执行代码。删除内置工具后，仅“仍能解析 v1 JSON”不足以继续旧调查，不能暗中借最新版工具。

采用一次性、显式的 **旧 Profile SHA → 兼容 Extension 包 SHA** 绑定：

- 首个 v2 包提供与当前行为等价的工具实现；迁移前枚举所有 running/interrupted Live 调查及其已固定配置缓存，生成明确旧 SHA 清单。
- 未固定版本的旧 Live 先按现有 resolveAgentConfigVersion 规则固定当时有效 v1 Profile，再建立映射；legacy RCA100 不进入迁移。
- 绑定文件存入持久化目录，记录旧 Profile SHA、兼容代码包 SHA、工具集合与迁移时间；原子写入，不覆盖已存在不同映射。迁移命令由开发/运维运行，不向模型开放。
- 旧 Prompt、Skill、允许列表仍来自旧 Profile；工具代码来自明确绑定的兼容包。原 agentConfigVersion 不改写，调查 schemaVersion/formatVersion 不升级；工具审计可附加可选执行版本信息，旧读取兼容。
- 两份内容都必须完整缓存；重启离线可恢复。缺映射报 config_legacy_extension_binding_missing，不能自动匹配 active 包。
- 切换后的新调查使用 v2 单一 SHA。v1 仅用于已明确绑定的历史恢复；不允许继续发布新的 v1 配置作为生产 active。
- 兼容包不可删除；未来宿主 API 升级也要维持其兼容性或明确阻止恢复。

这是有边界的旧格式桥接，没有在主仓库保留工具定义副本，也不制造永久的两套生产工具路径。若实际没有旧活动调查，清单可以为空；仍需覆盖测试，不能靠“估计没人用”删除恢复能力。

## 9. 代码信任边界

同进程 ESM 拥有服务进程的 OS 权限，可能访问文件、网络和环境变量。传入小 Host 对象、禁用 imports 或模块哈希都不构成安全沙箱，无法防御受信任仓库恶意作者。

仅加载固定的用户控制私有仓库及已解析 commit；GitHub 凭据仍只读 Contents，模型不能选择仓库/ref/path。配置仓库有可执行代码后，其写权限应按应用源码权限管理。模型生成的代码、用户上传模块、Telemetry 内容都不能进入此加载路径。

不把模型 API Key、Provider URL/auth、tenant、token 放入包、Prompt、返回值或文档。受控接口与校验用于防止误用和协议破坏；本次不承诺阻止恶意同进程模块窃取进程凭据。如未来接受第三方不可信 Extension，必须另立进程隔离方案。

## 10. 修改文件清单

| 仓库/路径 | 计划改动 |
| --- | --- |
| aiops: server/agent-config/store.ts | manifest v2、完整代码缓存、预检、原子激活、旧缓存与显式绑定读取 |
| aiops: server/agent-config/extension-loader.ts（新增） | 固定版本导入、闭包/注册校验、ExtensionFactory 构造 |
| aiops: server/agent-config/host-api.ts（新增） | v1 宿主类型、Main/Expert 受控适配与业务能力绑定 |
| aiops: server/agent-config/main-extension.ts | 使用本轮冻结配置，保持 context 注入，避免二次选版本 |
| aiops: server/conversation/runtime.ts、service.ts、types.ts | 按版本加载工厂，idle 替换 runtime，保留 SessionManager/订阅/设置 |
| aiops: server/rca/main-agent-tools.ts | 迁出 ToolDefinition；必要呈现迁出，宿主业务适配移入 host-api 后删除旧文件 |
| aiops: server/rca/tools.ts | 删除 createPiTools；保留 Provider Registry、prepare/execute、能力标识与硬限制 |
| aiops: server/rca/pi-expert.ts | 按调查包加载工厂；保留预算/Finalize/来源校验/接受/取消，移除协议工具定义 |
| aiops: server/rca/profiles/registry.ts | 由已验证工具能力确定 modalities，保持宿主 Finding 强度门槛 |
| aiops: server/agent-config/validate.ts、相关 tests、docs/agent-config.md | 统一校验候选组合、补回归、更新接入文档 |
| config: manifest.json、agents/*/agent.json | v2 与模块引用，现有 roles/skills 不改职责 |
| config: agents/*/extensions/、shared/extensions/rca-common/、dist/*.mjs | 单一来源工具实现、共用 Schema、构建输出 |
| config: package.json、锁文件、构建/校验 CI、README.md | 固定开发依赖、产物一致性、宿主兼容与信任边界说明 |

service.ts、repository.ts、events.ts、budget.ts、types.ts 仅按实际必要增补适配/可选审计字段，不重写稳定实现。MCP/web/观测插件仍为应用级固定集成，不宣称它们已经由该配置仓库管理；角色允许列表继续限制模型可见工具。

## 11. 实施与发布顺序

1. 用户审查本方案；本轮不修改运行代码。
2. 主仓库和配置仓库基于最新 main 建对应 feat/versioned-agent-extensions 分支。先完成 SDK 安装版最小验证，再落宿主与加载器。
3. 对现有工具做行为等价迁移，两个仓库用具体候选 SHA 联合验证；不同时改调查策略或参数协议。
4. 首次上线支持 v1 + v2 的过渡 Runtime，旧内置工具仅在尚未切换期间存在，不向生产加载未经验证的候选包。
5. 在持久化目录完整缓存兼容包、生成旧 SHA 绑定；随后发布并激活 v2 配置。验证新调查和旧固定调查恢复。
6. 发布清理 Runtime，删除主仓库工具定义，仍保留 v1 显式桥接读取；迁移完成不得长期维护两份定义。
7. 生产 smoke：Main 搜索/授权 Trace/真实 Evidence/零专家结案；一个确有必要的专业调查/submit_finding；取消、重启与旧固定版本恢复。

首次切换可用 AGENT_CONFIG_REF 暂时固定旧 SHA，避免包先于 Runtime 生效；最终恢复 main 自动刷新。旧 Runtime 遇 v2 应拒绝并保留旧缓存，但不能把这一行为当成正常发布顺序。

回滚先将配置固定到与回滚 Runtime 兼容的明确 SHA，再回滚 Runtime；保留全部新旧代码缓存。已存在 v2 固定调查时，不能直接回滚到完全不支持 v2 的旧 Runtime并宣称可恢复，应使用支持两个格式的过渡版本。配置回滚只影响后续新执行，不能改正在运行调查的固定版本。

## 12. 验收关卡

| 类别 | 必须通过 |
| --- | --- |
| 包格式 | 缺文件/哈希错误/路径逃逸/import 闭包缺失/体积超限/host API 不兼容拒绝；保留最近有效版本 |
| 真正独立 | 主仓库无上述生产工具 ToolDefinition/Schema 副本；仅改配置包 execute，下一轮调用能观察新实现 |
| 注册 | 重名拒绝、未允许工具拒绝、工厂错误阻止激活、无 I/O 预检不修改调查 |
| 版本 | 后台刷新不影响运行调查/专家；新调查使用新包；同轮创建固定同一 SHA |
| Main 长会话 | idle 后工具实现/Prompt 一起切换；历史、Session ID、model/thinking、订阅、标题任务不丢失 |
| 并发 | steering/队列/compaction/两个并发 prompt 不发生执行中替换或重复订阅 |
| 离线恢复 | 远端断网与进程重启可恢复旧固定模块；缓存缺失明确失败，无 latest 回退 |
| v1 桥接 | 明确绑定可离线恢复；无映射/映射冲突拒绝；原 Profile 与调查版本未改写 |
| 权限/证据 | 未授权 Trace/指标拒绝；快照、ToolCall、Observation、Evidence、Finding 引用链保持 |
| 生命周期 | 取消排队/fetch/body/retry/commit 无 late Evidence、槽位泄漏、错误免费恢复或终态回写 |
| 调查行为 | Main 零专家结案；按需专家与 Finalize-only submit_finding；历史 RCA100 只读 |
| 发布 | 两仓库候选组合通过必要 typecheck、lint、test、build；真实生产 smoke 与构建结果分开记录 |

测试优先扩展 store/availability、conversation session-lifecycle、pi-expert、agentic-service、live-review-regression、budget-v2，增加最小 extension-loader 和版本切换测试。实际 LLM 的无意义派发率继续用真实会话回放观察，不能用确定性测试替代。
