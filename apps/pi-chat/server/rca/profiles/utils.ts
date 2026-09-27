import { readFileSync } from "node:fs";

import type { AgentExpertFinding, FindingStrength, InvestigationBrief } from "../types";
import type { ExpertSkill } from "./types";

const strengthRank: Record<FindingStrength, number> = {
  inconclusive: 0,
  weak: 1,
  moderate: 2,
  strong: 3,
};

export function loadProfileText(importMetaUrl: string, relativePath: string): string {
  return readFileSync(new URL(relativePath, importMetaUrl), "utf8").trim();
}

export function skill(id: string, title: string, content: string): ExpertSkill {
  return { id, title, content };
}

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

export function containsAny(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(term.toLowerCase()));
}

export function capFindingStrength(
  finding: AgentExpertFinding,
  maximum: FindingStrength,
): AgentExpertFinding {
  return strengthRank[finding.strength] <= strengthRank[maximum]
    ? finding
    : { ...finding, strength: maximum };
}
