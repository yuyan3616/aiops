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
  return `## Runtime constraints

Allowed evidence modalities: ${profile.modalities.join(", ")}.
Maximum specialist tool calls: ${profile.maxToolCalls}.

Return exactly this JSON shape:
{
  "status": "succeeded|failed|inconclusive|blocked",
  "strength": "strong|moderate|weak|inconclusive",
  "verdict": "supports|contradicts|no-signal|mixed|inconclusive",
  "summary": "concise finding",
  "conclusions": ["1-5 direct answers to the brief"],
  "evidenceClaims": [
    {
      "toolCallId": "Cxx returned by a real tool call",
      "modality": "one allowed modality",
      "entity": "optional entity",
      "summary": "what this tool result establishes",
      "supports": ["hypothesis ids from the brief"],
      "contradicts": ["hypothesis ids from the brief"]
    }
  ],
  "candidateEntities": ["optional narrowed entities"],
  "candidateMechanism": "optional mechanism",
  "suggestedFollowUps": ["only follow-ups outside your current evidence"],
  "blockedOn": "only when status=blocked"
}`;
}

export function buildExpertSystemPrompt(profile: ExpertProfile, brief: InvestigationBrief): string {
  const skills = profile.selectSkills(brief);
  const skillSections = skills.length
    ? skills.map((entry) => `## Loaded specialist skill: ${entry.title} [${entry.id}]\n\n${entry.content}`).join("\n\n")
    : "## Loaded specialist skills\n\nNo additional specialist skill was selected for this brief.";

  return [
    commonContract,
    `# Active specialist profile: ${profile.label}`,
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
