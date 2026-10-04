# Live Observability RCA 迁移规格 v2

状态：main 消费端迁移已在开发分支实现并通过 mock/fixture CI；真实跨云只读 smoke 因网络不可达 blocked，尚未部署生产。
目标分支：main。实际开发基线：8ae4b77a4845b17902e48d3ea5b4af69d13e8516。
Target 当前已部署基线：f3fa1516b21a11023ee91cf12995844ced20826e；公共合同以 [Telemetry Contract v1](telemetry-contract-v1.md) 为准。

## 0. 本次实现状态（2026-10-04）

开发分支：`feat/live-observability-main`。

已完成：

- 新 Investigation 使用冻结的 `IncidentContext`，保留 `schemaVersion: 2`，新增 `formatVersion: 3` 与 `source.kind=live`；
- 生产 Registry 切换为 Tempo / Loki / Prometheus 三个小 Provider，模型不接触 URL / DSL / tenant / credential；
- HTTP Client 覆盖可取消排队、fetch、body、retry/backoff、15s deadline、最多一次 transient retry、4 MiB 流式 body 上限；
- Live ToolCall 成功后先写不可变 Evidence snapshot，再在一次 Budget v2 状态提交中完成 ToolCall completion + Observation；
- legacy RCA100 Investigation 由 Service 层统一拒绝写入并返回 `legacy_read_only`；
- Trace / Log / Metrics Expert、Main Agent、Conversation context、visualization 和生产启动路径已切换；
- Docker / Railway 生产启动不再下载 t039，不再配置 `RCA100_CASES_DIR`；
- 启动恢复会补齐 interrupted 状态、缺失 JSONL/UI event projection、Live report 与 visualization；
- Target 当前 `exemplars=false`、provider attempt lifecycle 不可用，main capability 明确返回 false，不把 provider generation 映射成 attempt。

仍 blocked：

- Railway → 阿里云 ECS 的真实只读 smoke。Tempo/Loki/Prometheus 查询端口目前只绑定 ECS `127.0.0.1`，没有可供 Railway 使用的安全跨云入口。本次实现未修改安全组、未裸开放公网端口。

验证记录见 [Live Investigation Validation](live-investigation-validation.md)。

## 1. 目标、前提与职责

生产最终仅保留 Live Observability：Tempo / Loki / Prometheus → Provider → Tool → Observation / Evidence → Expert / Main Agent → RCA。

Target 三条存储查询链路已验证，是现有前提；不代表 RCA Runtime 的部署环境已具备网络权限，也不代表应用指标、完整 Provider generation Span 或 Exemplar 已实现。

本规格只指导消费端。Target SDK、埋点、Collector 与存储配置见 Target 分支独立 Spec。公共数据语义见 [Telemetry Contract v1](telemetry-contract-v1.md)。

不长期维护 RCA100 + Live 双 Runtime；不重写现有 Budget v2、Expert Runner、Hypothesis、事件机制；不开放自由 TraceQL/LogQL/PromQL、任意 backend URL；首版不新增 Alertmanager、真实 Event/Topology Provider 或可恢复的用户 Pause。

## 2. 当前真实实现与改动边界

| 位置 | 当前行为 | 迁移要求 |
|---|---|---|
| index.ts / config.ts | 创建 RCA100Adapter，读取 RCA100_CASES_DIR | 注入三种 Provider；删除生产数据集配置 |
| main-agent-tools.ts | start 要求 t数字 caseId；overview 无 logs | 新入口、logs overview、更新所有 Schema |
| service.ts beginAgentic | 查询 get_alert_context 后创建调查 | Server 直接构造 IncidentContext，不伪造告警工具调用 |
| tools.ts | Registry 直接依赖 Adapter，所有工具要求 caseId | 显式工具元数据与 Provider capability |
| pi-expert.ts | 使用 RcaTask.alert，并覆盖 caseId | 使用通用执行上下文，Server 约束查询范围 |
| profiles/* | 工具白名单与 Event/Topology 角色写死 | 同步切换工具、角色、modalities、预算与 Prompt |
| conversation/* / chat-events / visualization | 通过 investigationId 关联，仍展示 caseId | 保留关联机制，适配展示与历史读取 |
| repository.ts / events.ts | 原子快照与独立 JSONL；事件追加失败被吞 | 声明事实来源，增加投影补齐策略 |

ToolCallRecord / InvestigationEvent 已不以 caseId 为身份。避免为去掉 caseId 而重新设计这些对象。

## 3. 版本与历史兼容（P0）

必须区分持久化格式、Budget 协议和数据来源。

第一阶段保留现有 schemaVersion: 2 的执行语义，新增 formatVersion: 3、source: { kind: "live", contractVersion: "1" }。实现前补充字段验证；不能仅把 schemaVersion 改成 3，因为现有大量 schemaVersion === 2 判断会绕过锁、预算与晚到结果保护。

如后续统一版本，必须先将所有 v2 分支替换为显式 Budget/执行能力判断，并覆盖回归测试。formatVersion 不承担 Budget capability 判断。

新调查不写 caseId，使用 context。旧文件不批量改写；读取层将旧 caseId/alertContext 解释为 legacy RCA100，保留原字段及历史证据。

旧调查仅允许读取、报告、历史解释及不触发新取证的展示。Service 层统一拒绝 Resume、Overview、Dispatch、Hypothesis mutation、Conclude 等调查写入，返回 legacy_read_only。不是仅隐藏前端按钮。

启动恢复仍可修复旧 running 状态，但不声明 resumable:true；来源判断不能只看 schemaVersion。禁止为历史解释重新加载 task.json/parquet。

## 4. 领域模型与权威字段

~~~ts
interface IncidentContext {
  symptom: string;
  trigger: { type: "manual" } | { type: "alert"; eventId?: string; title?: string; source?: string } | { type: "api"; source?: string };
  window: TimeRange;
  target: { service?: string; operation?: string; entity?: string; environment?: string; region?: string; container?: string };
}
interface InvestigationScope {
  candidateEntities: string[];
  // 经显式记录的范围扩展；不能覆盖原始 context。
  extensions?: Array<{ target?: Record<string, string>; window?: TimeRange; reason: string; createdAt: string }>;
}
~~~

context 是不可变触发事实、目标和 incident window 的唯一权威来源。Investigation.symptom 如保留，仅由 context 派生。scope 不重复保存独立可写的 incident window/target。

保留现有 status、tasks、calls、observations、evidence、hypotheses、rounds、interventions、Budget ledger 与 recovery。新 Observation/Evidence 使用 investigationId；局部 C/O/E 编号继续在调查锁内生成。

manual symptom 与 user intervention 是用户上下文，不是 telemetry Evidence。创建调查不消耗一次虚假的查询，也不创建假的 alert Observation。

## 5. 新入口、Conversation 与时间冻结

start_rca_investigation 输入：symptom、target、window、可选 forceNew。window 为 absolute(from,to) 或 lookback(minutes)。

Server 验证：至少 service/entity/container 一项；字符串长度、UTC 时间、from<to、最大 24h；lookback 1～1440 分钟。Server 在创建操作中读取一次 T，冻结 from/to；不要求模型调用 utc_time 计算。

ConversationRecord.activeInvestigationId / investigationIds 保持现有机制。running 不可被 forceNew 隐式替换；终态或 legacy 只有显式新调查请求才能替换。创建使用稳定 operationId/输入 hash 做去重，重放不能重新冻结窗口；创建与会话关联之间的失败应可恢复，不自动创建重复调查。

查询窗口规则：

- incident：固定 context.window，专家默认使用。
- baseline：显式比较窗口，验证时间合法、与 incident 不重叠；不是健康真值。
- expanded：有理由的查询扩展，由 Server 校验、记录，最多 24h；不修改 incident。

Server 覆盖默认目标与窗口，验证允许的范围扩展；不能靠 Prompt 或对象 spread 顺序保证。Evidence.timeRange 写实际 query window，包含 baseline/expanded 引用，不能统一写 incident window。

冻结时间不冻结数据；查询结果必须保存 retrievedAt 和证据快照，晚到数据不能覆写旧证据。

## 6. 网络、安全与部署

在实际 Production RCA Runtime 环境先验证三个 endpoint 的受控查询、认证、tenant、timeout、cancel。Server 配置 `TEMPO_BASE_URL` / `LOKI_BASE_URL` / `PROMETHEUS_BASE_URL` 与可选 tenant/auth，模型不能修改或看到 credential。

跨 Railway/ECS 使用私网、VPN、受认证代理或 Tunnel 等访问边界。禁止裸暴露当前无认证后端。redirect 不能逃出受控 endpoint；查询/错误脱敏。tenant/backend identity 由 Server 固定，记录别名而非 Secret。

首版明确单写者：同一 Investigation 只能由一个 Runtime 进程修改。现有锁、queue、semaphore 不提供跨进程保护；多副本共享存储前需独立设计 lease/CAS 等控制。

## 7. Provider 与统一结果合同

保留按模态独立的 TraceProvider(searchTraces/getTrace)、LogProvider(searchLogs)、MetricsProvider(discoverMetrics/queryMetrics)。Client 管 HTTP/timeout/retry/Abort，Provider 管协议编译与归一化，Registry 管授权/范围/审计。

每个方法要求传入执行 AbortSignal；后台管理查询使用独立且有 deadline 的 Signal。

统一结果：status(success/no_data/partial/unsupported)、实际 query、retrievedAt、bounded data、warnings、truncationReasons、snapshotRef、backendAlias、contractVersion。失败使用 typed error，不包装成 no_data。

error 分类：cancelled、timeout、unavailable、unauthorized、invalid_query、not_found、invalid_response、rate_limited、storage_error。记录 retryable 与脱敏诊断。

available capability 由配置和真实能力决定；不能声明六种模态均可用。缺失应用指标/Exemplar 返回 capability 不可用，不猜指标。

## 8. Trace 查询与分析

Trace Expert 仅 search_traces / get_trace；参数由 Server 编译，使用锁定 Tempo 版本的 /api/search 与 /api/v2/traces/{traceId}，先验证响应 schema。

search 参数：受控 target/window、operation、status、minDurationMs、limit、可选 baseline。返回 sampleCount/sampleStats，不能把有限搜索样本 P99 描述成系统 P99。说明搜索采样和排序偏差；未知总体匹配数不编造 matched。

NormalizedTrace 保留 ID、parent、service、时间、status、有界 attributes、completeness/warnings。完整性未知与截断区分。get_trace 校验 ID 和结果 scope；不能通过任意 traceId 绕过环境/tenant/目标授权。

TraceAnalyzer 对 direct child intervals 做裁剪和 union，计算未覆盖区间；不得直接减去 child duration。缺失 parent、重叠、时钟偏差、未结束 span、截断都要报告。截断 trace 不能宣称完整 critical path。

Gap 是观测边界，不证明网络、排队或 runtime pause。当前 Target Provider headers-only span 未完成修复前，只能解释 response-header 时间，不能据此认定完整模型生成耗时。

## 9. Logs 查询

Log Expert 仅 search_logs。结构化参数包含 scope/window、severity、lifecycleStatus、event、keywords、traceId、spanId、limit、明确 mode(anomaly/all/custom)。遗漏 keywords 不等于全日志查询。

按合同解析 Docker/Pino，正确映射 service_name、numeric level 与 lifecycle status。ID 精确过滤走内容/structured metadata，不建高基数 stream label。无 Context 如实缺失。

模式计数与摘要必须标明基于完整后端聚合还是有界返回样本；未知 matched 不编造。保留 timestamp 来源、实际过滤条件和截断说明。

## 10. Metrics 查询与 Exemplar

Metrics Expert 仅 discover_metrics / query_metrics。discovery 限定目标和窗口，返回真实名称、type、unit、允许 labels、支持操作；不全量枚举 catalog。

query 使用结构化 operation(raw/rate/increase/quantile)、metric、labelFilters、aggregation/groupBy、window、stepSeconds、可选 baseline。各操作必须匹配类型，quantile 验证 0～1；限定标签名/数量/长度与聚合维度，拒绝任意 PromQL。当前 Target 已确认 `exemplars=false`，因此首版工具 Schema 不暴露 includeExemplars。

Counter 处理 reset；Histogram 计算 rate(bucket) 和 quantile；Gauge 用峰值/持续时间等适用摘要。不把累计 Counter 或 bucket count 当普通温度式序列比较。step 由 Server 根据 points 上限调整并回显，不隐藏改变分辨率。

CPU 正常只能削弱 CPU 饱和假设，不能证明应用健康；service 与 host/container 的归属需有元数据映射。

Exemplar 能力当前明确为 unsupported/capability=false；只有 Target 后续合同和真实数据链路明确启用后，才增加独立的有界 `/api/v1/query_exemplars`，且不得把聚合 P99 点绑定成单一 Trace。

## 11. 工具、Profile 与 Main Overview

Registry 注入三个 Provider；显式定义每个工具的 modality、schema、capability、budget。未知工具拒绝，删除默认 topology fallback。

同步修改 OBSERVABILITY_TOOL_NAMES、compactToolResultForAgent、toolModality、Profile tools/modalities/toolBudgets、expert Prompt、Main Prompt、dispatch schema、Conversation context、聊天事件及 visualization。

新 dispatch 仅 trace/log/metrics；没有真实 Provider 的 event-topology 不进入新 Session，历史类型仍可读。删除生产 get_alert_context/schema/parquet/events/alerts/topology 工具路径。

query_rca_overview 仅 traces/logs/metrics，使用同一 Provider 和更小结果上限。Main 不需要知道具体后端产品。旧 `screen_rca_candidates` 已从 Main Agent 工具面删除；候选覆盖通过 `discover_metrics/query_metrics` 的显式 scoped target 完成。无结构/应用指标能力时明确 unsupported，不能偷偷读取 RCA100 或用 host CPU 冒充各服务请求指标。

专家仍不能决定最终 RCA，Evidence/Finding/Hypothesis/Conclusion 因果门槛保留。精确关联也只证明执行归属，不能自动升级为因果。

## 12. 并发、取消、Recovery 与 Budget

保留 updateV2/withInvestigationLock、dispatch operation 去重、reservation ledger、每调查 3/全局 9 runtime slots、晚到结果检查。I/O 不放调查锁内；锁内只提交状态和 Budget。

Provider 增加每后端全局并发限制（初始 4），排队可取消；限制同专家并行查询，不能把一个 Agent task 的槽位误当全部 fetch 的限流。

cancel/intervention 必须独立于存储成功发出 abort：持久化失败路径仍停止子 Session、排队、fetch/body、retry/backoff；存储错误如实返回并保留诊断。提交时检查 Signal、调查/任务状态及 generation，晚到结果不被接受。

保持 slot 到底层 Promise/finally 真正 settled 才释放；不用 Promise.race 伪装底层停止。客户端 abort 不保证远端计算立即停止，仍设置 backend timeout。

Cancel 是不可恢复终态；首版不新增用户 Pause。restart interrupted 的 Live 调查可恢复，旧调查只读。恢复保留已完成证据，不自动全量重查。

transport retry 最多一次，仅对明确 transient reset/502/503/504 或 deadline 尚允许的超时；取消不 retry，400/401/403/非法参数不 retry。429 只在有限 Retry-After/deadline 内允许。一次逻辑 ToolCall 只消费一次 tool-execution safety budget。当前 Target/provider 没有可靠 attempt lifecycle，因此不伪造 attempt telemetry；transport retry 仅保留在 Client 内部的有限控制。

Expert Recovery 与 transport retry 分开：延续现有 Primary/Recovery policy，仅明确 transient、无已完成取证工作的专家失败按既有规则申请恢复；不要因为后端失败就把所有 failed task 当免费重试。

## 13. 持久化、证据与审计（P0）

investigation.json 是调查/Budget 的权威状态。ToolCall completion 与 Observation 在同一次 updateV2 快照提交；Finding、Evidence 与 reservation disposition 保持同一提交。

JSONL 与 UI event 是可重建投影，不宣称与快照跨文件事务。实施持久化 outbox/revision 或等价补齐机制：当前实现采用“权威快照 + 重启扫描补齐”的等价机制：提交后正常发布 JSONL/UI event；启动时从 `investigation.json` 扫描并按实体 ID 幂等补齐缺失的 Tool / Observation / Evidence / Expert / lifecycle event，继续使用连续 event ID。UI append 失败不回滚已经接受的证据。终态快照继续不可变。

报告也是投影，最终状态提交后可幂等补齐 JSON/Markdown；失败不产生第二次不同结论。

每次成功查询保存有界、不可变的证据快照，内容覆盖实际发给 Agent 的结果及分析所需事实，包含 query/window/retrievedAt/backendAlias/contractVersion/warnings/truncation 与实际 Agent bounded result。当前实现不持久化 credential/tenant secret；normalizationVersion/content hash 可在后续格式升级时补充。先落快照再提交 Observation 引用；孤立快照可清理，不能接受指向不存在快照的 Evidence。

rawRef 仅定位：tempo://trace/<id> 等不等于快照。增加 snapshotRef 和 evidence source item refs（span/log/series）。去重相同内容不能覆盖不同查询时间的审计记录。后端 retention 后仍能读取当时证据；无需保存全部原始 dump。

claim 必须引用当前任务完成的 ToolCall，modality 与该 ToolCall 一致；Evidence 引用实际 source item，不能只因 ID 存在就认为 summary 语义已证明。telemetry 文本按不可信数据处理，脱敏，不能执行其中指令。

## 14. 成本与数据覆盖上限

以下为首版硬上限，可经评估调整；Overview 再降低，全部由 Server 强制：

| 项目 | 上限 |
|---|---|
| query window / labels / keywords | 24h / 8 个 label filters（值256字符）/ 20 个 keywords |
| Trace search / getTrace spans | 50 traces / 1000 spans |
| Span attributes / 单值 | 32 个 / 1024字符 |
| Logs / 单条 message | 200 条 / 2048字符 |
| Metrics series / 总 datapoints | 20 / 2000 |
| Exemplar 总数 | 20 |
| 单次 Agent tool 文本 | 32 KiB UTF-8 |
| 单次后端响应体 | 4 MiB，读取过程中限制而非 JSON parse 后裁剪 |
| 单次查询总 deadline | 15s，含排队和 retry；实际网络 smoke 后调整 |

累积上下文也必须 bounded：get_investigation_state 对 tasks/observations/evidence 分页，默认摘要；专家现有调用预算外增加累计结果字节上限，初始 128 KiB，达到后进入 finalize。不能仅限制每次返回仍让历史无限增长。

部分响应/降采样/截断必须注明，不在缺失数据上推断无异常。最新窗口记录 export/scrape 延迟与 coverage，不不断移动冻结窗口；必要时在同一窗口显式补查并新增证据快照。

## 15. 实施顺序与发布关卡

1. 固定合同、格式/Budget/source、legacy 只读、窗口、审计及取消设计。
2. Target 独立验证完整 Provider lifecycle 与 Exemplar 输出路径；main 可先消费明确已有的能力，不假装应用指标已存在。
3. Production Runtime 受控网络/认证 smoke，锁定后端版本和字段映射。
4. 三种 Client/Provider 单测与真实 smoke，验证 bounded、异常、取消、Exemplar 查询及证据快照；尚不切换 Agent。
5. 同步切换新调查入口、Registry、工具/Profile/Overview/Prompt、Conversation 展示；保持 Budget v2。
6. 验证并发、intervention、cancel、storage failure、restart、投影补齐、历史只读与上下文上限。
7. 删除生产 RCA100Adapter/parquet/rcaCasesDir、旧配置、启动下载路径和 Prompt；保留历史读取与独立离线评估需要的隔离代码，不进入生产 import graph。
8. 多模态闭环通过后上线；再进行 Provider Slow、Tool timeout、Application Error、Resource Pressure 故障验证。

开发过程可有未发布中间提交，但生产切换必须原子完成入口和工具路由，不能让新 Live Investigation 临时回退到 RCA100。回滚按发布版本处理，不构建永久双 Runtime。

## 16. 必须通过的验收

- 最近10分钟直接创建 Live Investigation；重放不重复创建/冻结，所有查询默认同窗。
- Trace/Log/Metrics 均查询真实后端；no_data、partial、unsupported、unavailable 区分。
- 并行专家/同调查工具返回乱序时，ID、状态、Budget 与证据引用正确。
- intervention/cancel 发生于排队、fetch、body、retry、commit 前后；没有晚到 Evidence，没有泄漏 slot；存储失败仍 abort。
- 进程在快照、journal、event、report 之间退出，重启可修复投影而不重复消费预算。
- 旧 v2 RCA100 调查只读，不可 resume/dispatch/conclude；报告和追问可用。
- Counter reset、Histogram quantile、Gauge、series映射与单位正确；当前 Exemplar capability=false 且不伪造关联。
- headers-only、截断Trace、未知采样/最新未到数据不被当完整证据；gap/时间重叠/CPU正常不升级为因果。
- Secret 与恶意 telemetry 指令不进入执行路径；response与累积上下文上限有效。
- 新格式仍走 Budget v2、终态保护、generation 检查；单写者部署约束被确认。

HTTP /api/rca 是外部接入预留边界，保持薄 Service adapter；当前已有读取/取消路由，不声称已经提供告警创建入口，也不删除它。
