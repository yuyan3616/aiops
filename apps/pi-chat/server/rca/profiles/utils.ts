import type { AgentExpertFinding, FindingStrength, InvestigationBrief } from "../types";

const strengthRank: Record<FindingStrength, number> = {
  inconclusive: 0,
  weak: 1,
  moderate: 2,
  strong: 3,
};

export function briefSearchText(brief: InvestigationBrief): string {
  return [
    brief.question,
    brief.context.alertSummary,
    brief.context.service ?? "",
    ...brief.context.knownFacts,
    ...brief.expected,
    brief.notInScope ?? "",
    JSON.stringify(brief.context.refs ?? {}),
  ]
    .join("\n")
    .toLowerCase();
}

export function capFindingStrength(
  finding: AgentExpertFinding,
  maximum: FindingStrength,
): AgentExpertFinding {
  return strengthRank[finding.strength] <= strengthRank[maximum]
    ? finding
    : { ...finding, strength: maximum };
}
