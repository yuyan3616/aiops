import type { ExpertProfile } from "../types";
import { briefSearchText, capFindingStrength, containsAny, loadProfileText, skill } from "../utils";

const dependency = skill(
  "dependency-path",
  "依赖路径分析",
  `判断 candidate entity 是否位于通往受影响 service 的合理路径上，并识别方向：upstream dependency、downstream callee、shared dependency 或 unrelated sibling。仅仅图上距离接近是弱 evidence，除非方向与已观察到的传播一致。`,
);
const change = skill(
  "change-correlation",
  "变更相关性分析",
  `比较 change time 与 symptom onset，并确认 changed entity 位于相关 dependency path。只有时间接近但路径无关时只能算线索；只有路径相关但时间不对齐，也不足以形成强 incident-specific claim。`,
);
const timeline = skill(
  "incident-timeline",
  "故障时间线",
  `按顺序整理 symptom onset、alert、deployment/config change、restart、scaling 和 recovery event。有精确 timestamp 时优先使用；如果 observation window 可能晚于 incident 起点，要标记 onset 不确定。`,
);

export const eventTopologyProfile: ExpertProfile = {
  role: "event-topology",
  label: "Event / Topology 调查",
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
