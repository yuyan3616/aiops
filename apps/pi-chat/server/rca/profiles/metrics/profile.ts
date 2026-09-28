import type { ExpertProfile } from "../types";
import { briefSearchText, capFindingStrength, containsAny, loadProfileText, skill } from "../utils";

const baseline = skill(
  "baseline-validation",
  "Baseline 有效性验证",
  `把 baseline 当作比较候选，而不是健康真值。如果 incident/baseline 接近 1，应通过 peer、更早窗口或周边 trend 检查 baseline 是否早已异常。不能只因为 baseline 和 incident 一样差就否定 hypothesis。`,
);
const peer = skill(
  "peer-comparison",
  "Peer 对比",
  `在真正可比的 service、host、pod 或 operation 之间比较同一 metric。相对健康 peer 的偏离可以暴露 baseline contamination；如果 peer group 异质或可信度弱，要明确说明。`,
);
const saturation = skill(
  "saturation-analysis",
  "资源饱和分析",
  `对于 CPU、memory、thread、connection、queue 或 pool 类 hypothesis，寻找持续 pressure，并与 latency/error 的时间变化对齐。区分 capacity pressure 与 demand increase。单独的高 utilization 不能证明资源耗尽，优先寻找多个相互一致的 signal。`,
);

export const metricsProfile: ExpertProfile = {
  role: "metrics",
  label: "Metrics 调查",
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
