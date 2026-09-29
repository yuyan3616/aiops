import type { AgentExpertFinding, ExpertKind, InvestigationBrief } from "../types";
import { eventTopologyProfile } from "./event-topology/profile";
import { logProfile } from "./log/profile";
import { metricsProfile } from "./metrics/profile";
import { traceProfile } from "./trace/profile";
import type { ExpertProfile } from "./types";
import { loadProfileText } from "./utils";

const commonContract = loadProfileText(import.meta.url, "./common/INVESTIGATION_CONTRACT.md");

const profiles: Record<ExpertKind, ExpertProfile> = {
  trace: traceProfile,
  metrics: metricsProfile,
  log: logProfile,
  "event-topology": eventTopologyProfile,
};

export function getExpertProfile(role: ExpertKind): ExpertProfile {
  return profiles[role];
}

export function listExpertProfiles(): ExpertProfile[] {
  return Object.values(profiles);
}

function findingContract(profile: ExpertProfile): string {
  return `## Runtime 约束

允许使用的 evidence modality：${profile.modalities.join(", ")}。
调查工具调用上限：${profile.maxToolCalls}。

调查阶段只负责有边界地取证。Runtime 进入 Finalize Phase 后，会把 active tools 切换为唯一的协议工具 submit_finding。

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

不要用普通 assistant 文本代替 submit_finding。`;
}

export function buildExpertSystemPrompt(profile: ExpertProfile, brief: InvestigationBrief): string {
  const skills = profile.selectSkills(brief);
  const skillSections = skills.length
    ? skills.map((entry) => `## 已加载专家技能：${entry.title} [${entry.id}]\n\n${entry.content}`).join("\n\n")
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
