import type { ObservabilityToolName } from "../tools";
import type {
  AgentExpertFinding,
  EvidenceModality,
  ExpertKind,
  InvestigationBrief,
} from "../types";

export interface ExpertSkill {
  id: string;
  title: string;
  content: string;
}

export interface ExpertProfile {
  role: ExpertKind;
  label: string;
  systemPrompt: string;
  tools: readonly ObservabilityToolName[];
  modalities: readonly EvidenceModality[];
  maxToolCalls: number;
  toolBudgets?: Partial<Record<ObservabilityToolName, number>>;
  selectSkills: (brief: InvestigationBrief) => ExpertSkill[];
  normalizeFinding: (finding: AgentExpertFinding) => AgentExpertFinding;
}
