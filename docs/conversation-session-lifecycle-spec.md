# Conversation Session 生命周期治理规格

状态：待审查（仅方案，尚未实现）  
范围：`apps/pi-chat/server/conversation/` 的单进程 `ConversationService`  
目标：同一会话只初始化一个可用 Runtime；空闲 Runtime 可安全释放并从持久化 Session 恢复。

## 1. 现状与问题

`ConversationService` 使用 `managedSessions: Map<conversationId, ManagedSession>` 保存已创建的 Pi Runtime。`ensureManagedSession()` 在 `repository.get()` 与 `createRuntime()` 等异步步骤之前只检查这个 Map，而 `createManagedSession()` 完成后才写入。冷会话的并发请求可能各自初始化 Runtime，后完成者覆盖前完成者。Skills 变化时的 `release → update → create` 也有并发窗口。覆盖后，仍在执行的旧 Runtime 可能失去 Map 引用，影响事件、停止操作和资源释放。

历史会话已按需加载；本规格不改变这一点。当前 `ttlMs = 30_000` 没有形成回收机制，已加载 Runtime 通常保持在 Map 中直至删除或进程退出。`EventChannel` 独立保存在 `channels`，其事件数组目前持续增长，SSE 客户端可能长期持有订阅。

这些是代码路径上可成立的风险；尚未用生产指标证明竞态发生频率或内存收益大小。实施时应记录初始化次数、回收次数、常驻会话数、恢复耗时和进程内存。

## 2. 目标与非目标

### 目标

1. 同一 `conversationId` 的冷初始化与 Skills 重建串行化；成功后所有兼容调用获得同一实例，失败后可以重试。
2. 删除与初始化不能交错产生“已删除记录又被挂回 Map”的 Runtime。
3. 空闲期仅释放不在执行、无人使用的 Pi Runtime；Conversation Record、Session File 和 Investigation 持久化状态保留。
4. 已连接 SSE 的页面在 Runtime 回收和恢复后仍能收到新事件。
5. 配置变更、取消、调查运行、页面刷新和服务重启保持现有可观察语义。

### 非目标

- 不重写 Pi Agent、RCA orchestrator、Investigation 持久化或 HTTP/SSE 协议。
- 不实现跨进程锁。本规格的 Map 和串行化只在单个 `ConversationService` 实例内有效；若多个 Railway 实例共享 Session 文件，须另行设计所有权和共享存储并发控制。
- 不把现有的 30 秒 `ttlMs` 直接解释为 Runtime 空闲 TTL。
- 不在此次改动中无条件截断 `EventChannel` 的事件历史；回放窗口和重连协议需要单独定义。

## 3. 生命周期与不变量

内部阶段为 `cold → initializing → ready/running → idle → evicted(cold)`；`initializing` 和 `evicted` 不必成为对外 `RuntimeStatus`。失败回到 `cold`，Skills 重建从非忙的旧 Runtime 过渡到新 Runtime。

必须保持以下不变量：

- 每个 ID 最多有一个**可对外使用**的 ManagedSession；任何初始化中的实例都不能被其他请求当作 ready 使用。
- 初始化、Skills 重建、删除对同一 ID 排他。初始化中的请求按完成顺序重新检查持久化记录与所需 Skills，不能让较早的旧配置覆盖较新的重建结果。
- 在运行、停止、压缩、`session.isStreaming` 或仍有操作持有 Runtime 时，不得释放或重建该 Runtime。
- `dispose()`、事件取消订阅和 Map 删除针对同一实例，只有 Map 仍指向该实例时才删除；避免迟到的清理删掉新实例。
- Runtime 回收不删除持久化会话，不切断已有 SSE 订阅；显式删除 Conversation 才结束相应 Channel 生命周期。

## 4. 阶段一：按 ID 初始化去重

在 `ConversationService` 增加每 ID 的初始化/变更协调器。最小实现可用 `Map<string, Promise<ManagedSession>>` 管理冷初始化；由于 Skills 重建和删除也修改同一资源，最终实现须通过同一 ID 的串行入口处理这些操作，不能只保护冷路径。

### 4.1 冷初始化

1. 先查已管理实例；满足 Skills 要求则返回。
2. 若同一 ID 已在初始化，等待其 Promise；完成后重新检查实例和请求所需 Skills，而不是盲目返回一个不匹配的结果。
3. 无初始化时，同步登记 in-flight Promise，然后读取 Record、打开或创建 SessionManager、创建 Runtime、绑定订阅，最后发布为当前实例。登记到第一次 `await` 之间不得留下可重入窗口。
4. Promise 成功、失败均在 `finally` 清除占位；清理时校验 Map 中的 Promise 仍为当前 Promise。创建失败时对已经分配的订阅和 Runtime 做部分清理，不发布半成品。
5. 同一个初始化错误可以传播给共同等待的调用者；后续新请求能重新尝试。

### 4.2 Skills 重建与删除

- Skills 不变时复用实例；不同时，在同一 ID 的排他操作中检查忙碌和使用者，再更新持久化配置、释放旧实例、创建新实例。明确失败后的可恢复状态：保留旧实例或让下次从持久化配置恢复，不能留下 Map 指向已 dispose 的实例。
- 删除先阻止新的初始化和使用，等待已开始的初始化/记录写入完成，再检查是否忙碌、释放实例并删除文件。若忙碌，维持原有拒绝删除语义。删除结束后新请求必须得到“会话不存在”，不能由迟到的初始化重新挂回。
- `createConversation()` 生成新 ID 后直接创建 Runtime，但也应纳入相同的发布/删除约束；不要留下旁路。

实现形式可选每 ID promise 队列或显式状态机。无论采用哪一种，不在持锁期间等待需要再次取得同一锁的回调；为检查 race 编写可控屏障测试。

## 5. 阶段二：Runtime 空闲回收

### 5.1 活跃定义

给运行时缓存记录 `lastAccessAt` 与正在使用 Runtime 的操作数（或等价租约）。`ensureManagedSession()` 成功取得实例时 touch；`send`、`snapshot`、`getConfig`、`updateConfig`、`abort` 等需要在实际使用期间持有租约，不能只在进入方法时 touch。`send()` 将 prompt 交给后台后，运行租约保持到 prompt 真正 settle；不能依赖尚未到达的 `agent_start` 事件。现有 `isBusy()` 判断仍是第二道保护；`abort()` 设置 `ready` 不等于底层执行已经 settle。

首次参数建议 `idleTtlMs = 10 分钟`、`sweepIntervalMs = 60 秒`，通过配置可调。计时从最后一次实际使用完成或最近一次 touch 开始；不使用现有 `ttlMs = 30_000`。定时器使用 `unref()`，服务关闭时停止。

### 5.2 扫描与释放

每轮扫描 Map 的当前实例；满足空闲时在同一 ID 的排他入口内重新检查：Map 身份未变、无 in-flight 初始化/变更、无租约、`isBusy()` 为 false、已超过 TTL。随后取消订阅、dispose Runtime、清理仅属于该实例的性能追踪，并从 Map 删除。释放若抛错，应记录诊断并保证 Map 不指向已 dispose 实例；下一轮可重试尚未完成的清理。

进行中的 RCA Expert 子任务若与主 Session 生命周期独立，不能仅凭主 Session 的 status 判断安全：要确认主 Agent 的 dispatch/prompt 已 settle，且持久化中的后台任务不会通过被释放的回调继续发事件。该条件由运行租约或明确的后台工作标记覆盖。

再次访问通过现有 `sessionFile` 恢复。回收之后 `list()` 可显示 `cold`，`snapshot()` 再次加载时返回正常状态；不删除 Investigation 数据。

## 6. SSE / EventChannel 生命周期

Runtime 回收使用保留 Channel 的释放路径。新 Runtime 必须从 `getEventChannel(id)` 拿到原 Channel；当前连接、`streamId` 和事件序号因此连续，后续事件仍送到旧订阅者。显式删除 Conversation 可关闭/删除 Channel，但应先定义删除时 SSE 连接如何结束，避免悬挂订阅。

仅保留 Channel 会留下独立的内存增长：当前 `EventChannel.events` 无界。首版先观测 Channel 数、订阅数和累计事件量；可在独立改动中定义有界 replay buffer、Last-Event-ID 超出窗口时的 snapshot 重同步协议，以及无订阅 Channel 的清理策略。不得为回收 Runtime 而直接删除仍被订阅的 Channel，也不得未经协议设计直接裁剪事件。

## 7. 验收与测试

### 阶段一

- 并发请求冷加载同一 ID，`createRuntime` 仅一次，调用者取得相同实例；不同 ID 可并行。
- 初始化失败时共同等待者收到错误；下一次请求成功重试，无 rejected Promise 残留。
- 并发冷加载、不同 Skills 的 `send`、`snapshot/getConfig`、删除交错时，没有孤儿 Runtime、覆盖、已删除会话复活或对已 dispose 实例的使用。
- Skills 重建失败、忙碌时重建和删除，状态及持久化记录可恢复。

### 阶段二

- 长时间运行的 prompt/RCA 即使超过 TTL 也不回收；真正 settle 并空闲后才回收。
- 扫描与新请求竞争时只释放旧实例或跳过，不释放正在被使用的实例。
- 已连接 SSE 的页面经历回收、重新发消息，继续收到同一 Channel 上的事件；刷新和重连可从 snapshot 恢复。
- 回收后再次访问恢复历史消息、配置及 RCA 上下文；文件不丢失。删除仍能清理 Runtime 和记录。
- 记录 `managedSessions.size`、`channels.size`、init/join/failure、eviction/skip、恢复耗时与进程 RSS；以实际数据调整 TTL，不能把预期内存收益当作已验证结果。

## 8. 改动范围与实施顺序

| 阶段 | 主要文件 | 风险与收益 |
| --- | --- | --- |
| 1. 初始化与变更串行化 | `conversation/service.ts`，相关并发测试 | 改动局部，消除重复 Runtime 和覆盖竞态；重点验证 Skills/删除交错。 |
| 2. 空闲回收与租约 | `conversation/service.ts`、`conversation/types.ts`，生命周期测试 | 内存收益取决于真实负载；重点验证后台运行、SSE、恢复。 |
| 后续 Channel 内存治理 | `conversation/channel.ts`、SSE 重连协议和测试 | 解决无界回放缓存，需先约定超出窗口的重同步。 |

两阶段分别提交和验证，不改 RCA 主链路。先完成阶段一并观察初始化指标，再实现阶段二，按真实内存与冷启动数据调整 TTL。
