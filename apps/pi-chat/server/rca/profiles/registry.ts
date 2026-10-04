import { agentConfigStore } from "../../agent-config/store";
import type { ObservabilityToolName } from "../tools";
import type { AgentExpertFinding, ExpertKind, InvestigationBrief } from "../types";
import type { EvidenceModality } from "../types";
import { eventTopologyProfile } from "./event-topology/profile";
import type { ExpertProfile } from "./types";
import { loadProfileText, briefSearchText, capFindingStrength } from "./utils";

const commonContract = loadProfileText(import.meta.url, "./common/INVESTIGATION_CONTRACT.md");

export function getExpertProfile(role: ExpertKind, version?: string): ExpertProfile {
  const bundle = agentConfigStore.get(version);
  const configured = bundle.roles[role];
  // Historical compatibility only; production dispatch never accepts this profile.
  if (!configured && role === "event-topology" && !version) return eventTopologyProfile;
  if (!configured || configured.kind !== "expert") throw new Error("config_unknown_expert");
  const tools = configured.tools as ObservabilityToolName[];
  const modalities = [
    ...new Set(
      tools.map((tool): EvidenceModality =>
        tool === "search_logs"
          ? "log"
          : tool === "discover_metrics" || tool === "query_metrics"
            ? "metric"
            : "trace",
      ),
    ),
  ];
  return {
    role,
    label: configured.name,
    systemPrompt: configured.systemPrompt,
    tools,
    modalities,
    maxToolCalls: 12,
    ...(tools.includes("query_metrics") ? { toolBudgets: { query_metrics: 6 } } : {}),
    selectSkills: (brief) =>
      configured.skills
        .filter((entry) => {
          if (!entry.keywords && !entry.baseline) return true;
          return (
            Boolean(entry.baseline && brief.context.baselineWindow) ||
            Boolean(
              entry.keywords?.some((term) => briefSearchText(brief).includes(term.toLowerCase())),
            )
          );
        })
        .map((entry) => bundle.skills[entry.id]!),
    normalizeFinding: (finding) => {
      if (modalities.length === 1 && modalities[0] === "trace") {
        return finding.candidateMechanism && finding.evidenceClaims.length < 2
          ? capFindingStrength(finding, "moderate")
          : finding;
      }
      if (modalities.length === 1 && modalities[0] === "log") {
        return finding.verdict === "supports" || finding.verdict === "contradicts"
          ? capFindingStrength(finding, "moderate")
          : finding;
      }
      return finding.evidenceClaims.length < 2 ? capFindingStrength(finding, "moderate") : finding;
    },
  };
}

export function listExpertProfiles(version?: string): ExpertProfile[] {
  const bundle = agentConfigStore.get(version);
  return Object.values(bundle.roles)
    .filter((role) => role.kind === "expert")
    .map((role) => getExpertProfile(role.id, bundle.version));
}

function findingContract(profile: ExpertProfile): string {
  return `## Runtime 约束

允许使用的 evidence modality：${profile.modalities.join(", ")}。
调查工具调用上限：${profile.maxToolCalls}。

调查阶段只负责有边界地取证。Runtime 进入 Finalize Phase 后，会把 active tools 切换为唯一的协议工具 submit_finding。

以下是字段说明，不是可直接提交的示例；枚举中只选择一个值，引用必须替换为真实工具返回，未知的可选字段省略。
submit_finding 的参数结构：
{
  "status": "succeeded|failed|inconclusive|blocked",
  "strength": "strong|moderate|weak|inconclusive",
  "verdict": "supports|contradicts|no-signal|mixed|inconclusive",
  "summary": "简洁的调查结论",
  "conclusions": ["1-5 条对当前 brief 的直接回答"],
  "evidenceClaims": [
    {
      "toolCallId": "当前 Session 内真实工具调用返回的 Cxx",
      "sourceItems": ["从该 toolCallId 返回的 sourceItems 中选择的原值"],
      "modality": "一个允许的 modality",
      "entity": "可选 entity",
      "summary": "该工具结果能够建立什么事实",
      "supports": ["brief 中的 hypothesis id"],
      "contradicts": ["brief 中的 hypothesis id"]
    }
  ],
  "candidateEntities": ["可选的收敛候选 entity"],
  "candidateMechanism": "可选 mechanism",
  "suggestedFollowUps": ["只填写超出当前 evidence 范围的后续建议"],
  "blockedOn": "仅当 status=blocked 时填写"
}

有返回事实的 claim 必须填写对应查询快照的 sourceItems；不能从另一调用复制，也不能自行构造引用。查询无数据时不得伪造 sourceItems；无法建立任何事实时 evidenceClaims 可以为空。
候选实体与机制只在有证据时填写；succeeded 表示完成了 brief，不代表发现故障。无信号、数据不足和工具不可用应分别说明，不能统一写为“健康”。建议后续调查时说明它能解决哪个关键缺口，不要求 Main 执行所有建议。
不要用普通 assistant 文本代替 submit_finding。`;
}

export function buildExpertSystemPrompt(profile: ExpertProfile, brief: InvestigationBrief): string {
  const skills = profile.selectSkills(brief);
  const skillSections = skills.length
    ? skills
        .map((entry) => `## 已加载专家技能：${entry.title} [${entry.id}]\n\n${entry.content}`)
        .join("\n\n")
    : "## 已加载专家技能\n\n当前 brief 未选择额外专家技能。";

  return [
    commonContract,
    `# 当前激活的专家 Profile：${profile.label}`,
    profile.systemPrompt,
    skillSections,
    findingContract(profile),
  ].join("\n\n");
}

export function normalizeFindingForProfile(
  profile: ExpertProfile,
  finding: AgentExpertFinding,
): AgentExpertFinding {
  return profile.normalizeFinding(finding);
}
