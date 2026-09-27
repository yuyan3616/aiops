import type { ExpertProfile } from "../types";
import { briefSearchText, capFindingStrength, containsAny, loadProfileText, skill } from "../utils";

const dependency = skill(
  "dependency-path",
  "Dependency Path Analysis",
  `Determine whether the candidate entity lies on a plausible path to the affected service and identify direction: upstream dependency, downstream callee, shared dependency, or unrelated sibling. Mere graph proximity is weak unless direction fits observed propagation.`,
);
const change = skill(
  "change-correlation",
  "Change Correlation",
  `Compare change time with symptom onset and verify the changed entity lies on a relevant dependency path. Time proximity without path relevance is only a lead; path relevance without temporal alignment is also insufficient for a strong incident-specific claim.`,
);
const timeline = skill(
  "incident-timeline",
  "Incident Timeline",
  `Order symptom onset, alerts, deployments/config changes, restarts, scaling, and recovery events. Use exact timestamps when available and mark uncertain onset when the observation window may start after the incident.`,
);

export const eventTopologyProfile: ExpertProfile = {
  role: "event-topology",
  label: "event and topology investigation",
  systemPrompt: loadProfileText(import.meta.url, "./SYSTEM.md"),
  tools: ["get_service_dependencies", "get_topology", "query_events", "query_alerts"],
  modalities: ["event", "topology", "alert"],
  maxToolCalls: 12,
  selectSkills: (brief) => {
    const text = briefSearchText(brief);
    const selected = [dependency];
    if (containsAny(text, ["deploy", "deployment", "change", "config", "release", "restart", "变更", "发布", "配置", "重启"])) selected.push(change);
    if (containsAny(text, ["timeline", "time", "onset", "before", "after", "时间", "先后", "首次", "发生"])) selected.push(timeline);
    return selected;
  },
  normalizeFinding: (finding) => {
    if (finding.strength !== "strong") return finding;
    const modalities = new Set(finding.evidenceClaims.map((claim) => claim.modality));
    return modalities.has("event") && modalities.has("topology")
      ? finding
      : capFindingStrength(finding, "moderate");
  },
};
