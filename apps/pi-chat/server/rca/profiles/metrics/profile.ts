import type { ExpertProfile } from "../types";
import { briefSearchText, capFindingStrength, containsAny, loadProfileText, skill } from "../utils";

const baseline = skill(
  "baseline-validation",
  "Baseline Validation",
  `Treat baseline as a comparison candidate, not healthy truth. If incident/baseline is near 1, check whether baseline was already abnormal using peers, an earlier window, or surrounding trend. Do not reject a hypothesis solely because baseline and incident are equally bad.`,
);
const peer = skill(
  "peer-comparison",
  "Peer Comparison",
  `Compare the same metric across genuinely comparable services, hosts, pods, or operations. A deviation from healthy peers can expose baseline contamination. State when the peer group is heterogeneous or weak.`,
);
const saturation = skill(
  "saturation-analysis",
  "Saturation Analysis",
  `For CPU, memory, thread, connection, queue, or pool hypotheses, look for sustained pressure and align it with latency/error timing. Distinguish capacity pressure from demand increase. High utilization alone does not establish exhaustion; prefer multiple mutually consistent signals.`,
);

export const metricsProfile: ExpertProfile = {
  role: "metrics",
  label: "metrics investigation",
  systemPrompt: loadProfileText(import.meta.url, "./SYSTEM.md"),
  tools: ["get_metric_catalog", "query_metrics"],
  modalities: ["metric"],
  maxToolCalls: 12,
  toolBudgets: { query_metrics: 6 },
  selectSkills: (brief) => {
    const text = briefSearchText(brief);
    const selected = [baseline, peer];
    if (containsAny(text, ["cpu", "memory", "thread", "pool", "queue", "connection", "resource", "saturation", "资源", "饱和", "连接池", "线程", "队列"])) {
      selected.push(saturation);
    }
    return selected;
  },
  normalizeFinding: (finding) =>
    finding.strength === "strong" && finding.evidenceClaims.length < 2
      ? capFindingStrength(finding, "moderate")
      : finding,
};
