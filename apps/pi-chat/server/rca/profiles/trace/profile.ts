import type { ExpertProfile } from "../types";
import { briefSearchText, capFindingStrength, containsAny, loadProfileText, skill } from "../utils";

const criticalPath = skill(
  "critical-path",
  "关键路径分析",
  `用于定位端到端延迟。保留 parent-child 时间戳，识别真正具有因果意义的最长路径，把重叠 children 视为并发；比较 total duration 与已观测 child interval，报告出现 unexplained duration 的最小区段。绝不能仅凭 timing gap 推断内部 mechanism。`,
);
const latencyGap = skill(
  "latency-gap",
  "未观测延迟缺口",
  `当已观测 span 无法解释 total duration 时，定位 uncovered interval 位于 observed children 之前、之间还是之后。把 missing instrumentation、proxy/client wait、queueing、network delay、runtime pause、local computation 都作为替代解释。除非 evidence 能区分 mechanism，否则把结果表述为观测边界，不要直接下机制结论。`,
);
const traceComparison = skill(
  "trace-comparison",
  "Trace 对比分析",
  `尽量比较相同 service/operation。使用 distribution 与 path structure，不要依赖单个 exemplar。检查可疑 path 或 gap 是否也存在于 baseline 或 peer trace。incident 前就长期存在的模式会削弱 incident-specific causality，但不能因此证明健康。`,
);

export const traceProfile: ExpertProfile = {
  role: "trace",
  label: "Trace 调查",
  systemPrompt: loadProfileText(import.meta.url, "./SYSTEM.md"),
  tools: ["search_traces", "get_trace"],
  modalities: ["trace"],
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
