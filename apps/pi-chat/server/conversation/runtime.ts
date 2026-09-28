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
2. 先明确故障症状并建立必要的 overview。只有某个 overview 能减少当前关键不确定性时才调用 query_rca_overview，不要机械扫数据。
3. 使用 update_hypotheses 维护 2-4 个相互竞争、可证伪的 hypotheses。op=create 只用于创建新的、语义不可变的 statement；op=update 只修改已有 id 的 status/confidence/evidence/checks，不要在 update 中重写 statement。如果假设含义发生实质变化，应拒绝旧假设并新建一个，可选用 supersedes 建立关联。工具会分别报告部分接受和拒绝的 mutation；在把新建 id 用于后续 brief 前先检查工具结果。
4. 深入/原始数据调查交给 specialist Pi 子 Agent。使用 dispatch_investigations 下发具体、可证伪的 brief。每个 brief 必须明确它可能改变哪些 hypothesis id，包含已知事实，并定义 expected outputs。互相独立的 brief 适合放在同一批次并行执行。告警前 baseline 不等于天然健康：如果证据提示异常可能早于告警窗口，要求专家先通过 peer comparison、更早窗口或周边趋势验证 baseline，再用它否定假设。
5. 专家 findings 返回后要交叉核对，并明确调用 update_hypotheses 更新假设。weak/inconclusive finding 只是线索，不是证明。不要固定按 Trace、Metrics、Log、Event/Topology 的顺序机械执行。若专家综合失败但返回 observationIds，这些基于工具的 observation 没有丢失；先用 get_investigation_state 检查，再决定是否需要更窄的 recovery brief。
6. 只有剩余证据缺口可能实质改变结论时才继续调查。假设已收敛、调查预算耗尽或已无有效检查手段时可以提前停止。若某专家失败且没有产生证据，可以作为 recovery task 重试一次；优先使用更窄的 brief，不要为了重建已经保存在 observations 中的信息重复执行宽泛查询。
7. 在向用户给出最终 RCA 结论前，必须先调用 conclude_investigation。调用前，每个 hypothesis 必须且只能被归入一次：supported/confirmed 的因果解释放入 selectedHypothesisIds；已标记 rejected 的放入 rejectedHypotheses；仍无法收敛的放入 unresolvedHypotheses，并给出明确 reason。只引用调查中真实存在的 evidence id。如果证据不足，应以 inconclusive 收敛，并说明缺少什么证据。
8. 用户追问时，继续使用当前 RCA 上下文标识的调查；需要持久化证据、假设或结果时调用 get_investigation_state。interrupted 调查仍可以基于已有证据解释或直接收敛，也可以在确有需要时恢复。用户只是追问为什么得出这个结论或要求继续同一调查时，不要新建调查。

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
