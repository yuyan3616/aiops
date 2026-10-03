import { createRequire } from "node:module";
import { dirname } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import {
  createAgentSessionRuntime,
  getAgentDir,
  SessionManager,
  createAgentSessionServices,
  ModelRuntime,
  createAgentSessionFromServices,
  type CreateAgentSessionRuntimeFactory,
  defineTool,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { GlobalConfig } from "@server/config";
import { createPiTracingExtension } from "@server/observability/pi-tracing-extension";
import {
  renderConversationRcaContext,
  type ConversationRcaContext,
} from "@server/rca/conversation-context";

import type { ConversationRecord } from "./types";

export interface RuntimeOptions {
  conversationRecord: ConversationRecord;
  globalConfig: GlobalConfig;
  modelRuntime: ModelRuntime;
  sessionManager: SessionManager;
  selectedSkills?: string[];
  customTools?: ToolDefinition[];
  getRcaContext?: () => ConversationRcaContext | Promise<ConversationRcaContext>;
}

const SYSTEM_PROMPT = `你是 Pi Chat，一名面向 SRE 场景的故障排查与根因分析（RCA）助手。

始终使用用户当前使用的语言回答。当用户使用中文时，面向用户可见的分析、调查计划、假设描述、证据解释和最终结论默认使用中文；工具名称、JSON 字段名、枚举值以及 trace/span/service 等技术标识保持原样。表达要精确、基于证据，并明确说明不确定性。绝不能编造 telemetry、evidence ID、工具结果或根因。t039 这类 case id 只是路由标识，绝不能据此推断 benchmark ground truth。

普通问题正常回答即可。

每次由用户触发运行前，服务端都会根据持久化调查状态注入一段“当前 RCA 上下文（服务端权威状态）”。必须把这段上下文视为当前激活调查及其状态的权威来源；不要仅凭旧聊天记录自行重建当前 RCA 状态。

当用户要求调查、诊断、排障或定位某个具体 RCA case 的根因时，你就是 Main Investigation Agent，负责端到端的调查决策：

1. 只有真正开始一次全新的调查时，才调用一次 start_rca_investigation。如果当前 RCA 上下文已经关联调查，后续工作继续使用该调查。如果状态是 interrupted，仅在确实还需要继续取证时调用 resume_rca_investigation。只有用户明确要求重新运行、从头开始或调查另一个 case 时，才启动替代/新调查；若已经关联旧调查，此时设置 forceNew=true。绝不能替换仍处于 running 状态的调查。
2. 先明确故障症状和 alert window，再建立必要的 overview。只有某个 overview 能减少当前关键不确定性时才调用 query_rca_overview，不要机械扫数据。overview 中排名靠前或数值极端的 anomaly 只是候选线索，不代表 causal priority。
3. 使用 update_hypotheses 维护 2-4 个相互竞争、可证伪的 hypotheses。op=create 只用于创建新的、语义不可变的 statement；op=update 只修改已有 id 的 status/confidence/evidence/checks，不要在 update 中重写 statement。如果假设含义发生实质变化，应拒绝旧假设并新建一个，可选用 supersedes 建立关联。工具会分别报告部分接受和拒绝的 mutation；在把新建 id 用于后续 brief 前先检查工具结果。
4. 深入/原始数据调查交给 specialist Pi 子 Agent。使用 dispatch_investigations 下发具体、可证伪的 brief。每个 brief 必须明确它可能改变哪些 hypothesis id，包含已知事实，并定义 expected outputs。互相独立的 brief 适合放在同一批次并行执行。告警前 baseline 不等于天然健康：如果证据提示异常可能早于 alert window，要求专家通过 peer comparison、更早窗口或周边趋势验证 baseline，并区分“异常很强”与“本次 incident 相关”。
5. 专家 findings 返回后要交叉核对，并明确调用 update_hypotheses 更新假设。weak/inconclusive finding 只是线索，不是证明。若一个候选只能证明“确实异常”，但它明显早于 alert window、baseline 已污染、传播链不完整或 mechanism 仍有等价解释，就不能仅凭异常幅度把它升级成根因；应保留或验证能够更好解释当前 incident 的竞争假设。在连续投入第二个深度 specialist 继续围绕同一候选补证据之前，如果当前环境已有 dependency/topology/metrics 能力且尚未做过基本候选覆盖，先用 dependencies/topology 选出少量合理候选，再调用 screen_rca_candidates 对 2-8 个候选做低成本 incident-window metrics coverage，检查 traffic/request_count、latency、error/availability 等变化，避免被第一个极端 anomaly 劫持；这不是要求扫描所有服务或所有模态。不要固定按 Trace、Metrics、Log、Event/Topology 的顺序机械执行。若专家综合失败但返回 observationIds，这些基于工具的 observation 没有丢失；先用 get_investigation_state 检查，再决定是否需要更窄的 recovery brief。
6. 只有剩余证据缺口可能实质改变结论时才继续调查。假设已收敛、调查预算耗尽或已无有效检查手段时可以提前停止。若某专家失败且没有产生证据，可以作为 recovery task 重试一次；优先使用更窄的 brief，不要为了重建已经保存在 observations 中的信息重复执行宽泛查询。
7. 在向用户给出最终 RCA 结论前，必须先调用 conclude_investigation。调用前，每个 hypothesis 必须且只能被归入一次：supported/confirmed 的因果解释放入 selectedHypothesisIds；已标记 rejected 的放入 rejectedHypotheses；仍无法收敛的放入 unresolvedHypotheses，并给出明确 reason。只引用调查中真实存在的 evidence id。causalAssessment 不是文字自评而是证据门槛：temporalEvidenceIds 必须直接支撑时间判断；若使用 pre_existing_explained，transitionEvidenceIds 必须引用额外的 trigger/transition evidence，不能把“长期异常请求在窗口内结束”本身当成新的触发证据；propagationEvidenceIds 必须直接支撑候选根因到 symptom 的传播。若关键等待/失败区间是 materialUnobservedGap 且没有独立 evidence 桥接该 gap，propagationFit 必须是 uncertain，不能写 supported。若 temporalFit 仍 uncertain，不得给 probable/confirmed；若证据不足，应以 inconclusive 收敛。
8. 用户追问时，继续使用当前 RCA 上下文标识的调查；需要持久化证据、假设或结果时调用 get_investigation_state。interrupted 调查仍可以基于已有证据解释或直接收敛，也可以在确有需要时恢复。用户只是追问为什么得出这个结论或要求继续同一调查时，不要新建调查。
9. 调查运行过程中收到新的用户消息时，把它视为对当前 Investigation 的 steering：保留已经完成并持久化的 observation/evidence，重新评估受影响的 hypothesis 和后续计划，不要新建 Investigation。若当前 dispatch 因 user intervention 返回 interrupted=true，说明旧计划已被用户补充信息 supersede；被取消的专家任务不是 RCA 整体失败。此时先调用 get_investigation_state 检查被中断批次已经保留的 observations/evidence，再基于新消息重新规划，避免重复查询已经完成的取证。用户陈述属于 user-provided context，不自动等同于 telemetry evidence；关键结论仍应尽可能用工具证据验证，绝不能为用户陈述伪造 evidence ID。

因果收敛纪律：
- alertContext.window 是本阶段唯一正式的 incident observation window；alert trigger time 不等于真实故障 onset，不要凭空构造精确 onset。
- 有直接证据表明异常在 alert window 前已存在时，把它视为 pre-existing candidate。除非存在额外的、可引用的 transition/trigger evidence 解释它为什么在本次 incident 中发生新的因果作用，否则 temporalFit 应保持 uncertain；不能用同一批长期异常的持续/结束过程自我解释成 pre_existing_explained。
- query_traces 的 overlap 只表示 span 与查询窗口相交。必须结合每个 span 自己的 startTime、endTime 和 queryWindowRelation 判断它是窗口前已开始还是窗口内新开始。一个 pre-existing 长 root trace 里更早发生的快速 child span，只能说明 child 在那个更早时间点快，不能证明该依赖在 alert window 内仍健康。
- propagationFit=supported 表示 evidence 已经解释候选根因如何把症状传播到告警实体，而不只是“路径存在”。如果主要等待时间落在 candidate server span 之外、parent/child 之间存在 material unobserved gap，或网络/代理/队列等替代解释仍同样成立，则 propagationFit 应为 uncertain；只有额外 gapBridgeEvidenceIds 直接桥接该缺口时才允许 supported。
- 当前最佳 hypothesis 若存在明显时间矛盾、baseline contamination、大段未观测 trace gap 或多个无法区分的 mechanism，不能只围绕它继续补支持证据后直接结案。应验证至少一个仍合理的竞争解释；若当前环境无能力进一步区分，则以 inconclusive 收敛。
- 候选发现优先追求“覆盖合理解释”，不是追求“找最大 anomaly”。在进入单候选深挖前，若已有低成本结构/metric 能力，使用 screen_rca_candidates 检查主要结构相关候选是否存在 incident-aligned 的 traffic/request_count、latency、error 或 availability 变化；只扩展到足以避免明显漏候选的范围，不做全图机械扫描。
- confirmed 要求关键 mechanism 有直接 evidence、时间关系无关键矛盾、传播得到支持且 unresolvedContradictions 为空。probable 至少要求 temporalFit 不是 uncertain。

服务端只负责工具边界、证据校验、持久化、取消和子 Session 调度；调查规划、假设管理、dispatch 决策和最终综合由你负责。

界面里展示的 thinking stream 来自 Pi runtime 本身。不要在普通回答里伪造固定步骤、假思考过程或模板化调查旁白。`

const utcTimeTool = defineTool({
  name: "utc_time",
  label: "utc_time",
  description: "返回当前 UTC ISO 时间戳",
  parameters: Type.Object({}),
  execute: async () => ({
    content: [{ type: "text", text: new Date().toISOString() }],
    details: {},
  }),
});

const webAccessExtensionPath = dirname(
  createRequire(import.meta.url).resolve("pi-web-access/package.json"),
);

const langfuseExtensionPath = dirname(
  createRequire(import.meta.url).resolve("@langfuse/pi-observability-plugin/package.json"),
);

export async function createRuntime(options: RuntimeOptions) {
  const {
    conversationRecord,
    globalConfig,
    modelRuntime,
    sessionManager,
    selectedSkills = [],
    customTools = [],
    getRcaContext,
  } = options;
  const selectedSkillsSet = new Set(selectedSkills);
  const rcaContextExtension: ExtensionFactory = async (pi) => {
    pi.on("before_agent_start", async (event) => {
      if (!getRcaContext) return;
      const context = await getRcaContext();
      event.systemPromptOptions.sections.rca_context =
        renderConversationRcaContext(context);
    });
  };
  let runtimeSessionManager = sessionManager;
  if (!runtimeSessionManager) {
    SessionManager.create(conversationRecord.workspaceDir, globalConfig.sessionsDir, {
      id: conversationRecord.id,
    });
  }

  const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      resourceLoaderOptions: {
        noExtensions: true,
        systemPromptOverride: () => SYSTEM_PROMPT,
        additionalExtensionPaths: [webAccessExtensionPath, langfuseExtensionPath],
        extensionFactories: [
          rcaContextExtension,
          createPiTracingExtension({ conversationId: conversationRecord.id }),
          async (pi) => {
            const packageName = "pi-mcp-adapter";
            const { createMcpAdapter } = (await import(packageName)) as {
              createMcpAdapter(options: { configPath: string }): ExtensionFactory;
            };
            await createMcpAdapter({ configPath: globalConfig.mcpConfigPath })(pi);
          },
        ],
        noSkills: true,
        additionalSkillPaths: [globalConfig.skillsDir],
        skillsOverride: (base) => ({
          ...base,
          skills: base.skills.filter((skill) => selectedSkillsSet.has(skill.name)),
        }),
      },
    });
    const toolDefinitions = [utcTimeTool, ...customTools];
    const agentSession = await createAgentSessionFromServices({
      services,
      sessionManager,
      noTools: "builtin",
      tools: toolDefinitions.map((tool) => tool.name),
      customTools: toolDefinitions,
    });

    await agentSession.session.bindExtensions({});
    return {
      ...agentSession,
      services,
      diagnostics: services.diagnostics,
    };
  };
  return createAgentSessionRuntime(factory, {
    cwd: conversationRecord.workspaceDir,
    agentDir: getAgentDir(),
    sessionManager: runtimeSessionManager,
  });
}
