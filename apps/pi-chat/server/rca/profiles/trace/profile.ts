import type { ExpertProfile } from "../types";
import { briefSearchText, capFindingStrength, containsAny, loadProfileText, skill } from "../utils";

const criticalPath = skill(
  "critical-path",
  "Critical Path Analysis",
  `Use when locating end-to-end latency. Preserve parent-child timestamps, identify the causally relevant longest path, treat overlapping children as concurrent, compare total duration with observed child intervals, and report the smallest segment where unexplained duration appears. Never infer an internal mechanism from a timing gap alone.`,
);
const latencyGap = skill(
  "latency-gap",
  "Unobserved Latency Gap",
  `When observed spans do not explain total duration, locate whether the uncovered interval is before, between, or after observed children. Consider missing instrumentation, proxy/client wait, queueing, network delay, runtime pause, and local computation as alternatives. Phrase the result as an observation boundary unless evidence distinguishes the mechanism.`,
);
const traceComparison = skill(
  "trace-comparison",
  "Trace Comparison",
  `Compare the same service/operation when possible. Use distributions and path structure rather than one exemplar. Check whether the suspicious path or gap also exists in baseline or peer traces. A persistent pre-incident pattern weakens incident-specific causality but does not prove health.`,
);

export const traceProfile: ExpertProfile = {
  role: "trace",
  label: "trace investigation",
  systemPrompt: loadProfileText(import.meta.url, "./SYSTEM.md"),
  tools: ["get_trace_fields", "get_service_dependencies", "query_traces"],
  modalities: ["trace", "topology"],
  maxToolCalls: 12,
  selectSkills: (brief) => {
    const text = briefSearchText(brief);
    const selected = [criticalPath];
    if (containsAny(text, ["gap", "unexplained", "unobserved", "missing span", "wait", "时间缺口", "未解释", "未观测", "等待"])) {
      selected.push(latencyGap);
    }
    if (brief.context.baselineWindow || containsAny(text, ["baseline", "peer", "compare", "comparison", "基线", "对比", "同类"])) {
      selected.push(traceComparison);
    }
    return selected;
  },
  normalizeFinding: (finding) =>
    finding.strength === "strong" &&
    finding.candidateMechanism &&
    finding.evidenceClaims.length < 2
      ? capFindingStrength(finding, "moderate")
      : finding,
};
