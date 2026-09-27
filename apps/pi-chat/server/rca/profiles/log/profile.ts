import type { ExpertProfile } from "../types";
import { briefSearchText, capFindingStrength, containsAny, loadProfileText, skill } from "../utils";

const signature = skill(
  "error-signature",
  "Error Signature Analysis",
  `Group errors by stable signature such as exception type, message pattern, error code, or stack origin. Prefer counts plus representative samples over raw dumps. Separate dominant incident signatures from rare unrelated noise and compare their frequency across the incident window.`,
);
const firstOccurrence = skill(
  "first-occurrence",
  "First Occurrence Analysis",
  `Find the earliest reliable occurrence in the requested window. If the first hit is at the window boundary, state that true onset may be earlier. Compare onset with alerts or changes only as temporal evidence.`,
);
const exceptionChain = skill(
  "exception-chain",
  "Exception Chain Analysis",
  `Follow nested causes to the deepest meaningful application or dependency error. Distinguish framework wrappers from the underlying exception. Do not invent source-code defects; suggest code investigation when logs cannot explain the mechanism.`,
);

export const logProfile: ExpertProfile = {
  role: "log",
  label: "log investigation",
  systemPrompt: loadProfileText(import.meta.url, "./SYSTEM.md"),
  tools: ["get_log_fields", "query_logs"],
  modalities: ["log"],
  maxToolCalls: 12,
  selectSkills: (brief) => {
    const text = briefSearchText(brief);
    const selected = [signature];
    if (containsAny(text, ["first", "onset", "when", "timeline", "首次", "最早", "何时", "时间", "开始"])) selected.push(firstOccurrence);
    if (containsAny(text, ["exception", "stack", "caused by", "error chain", "异常", "堆栈", "错误栈"])) selected.push(exceptionChain);
    return selected;
  },
  normalizeFinding: (finding) =>
    finding.strength === "strong" &&
    (finding.verdict === "supports" || finding.verdict === "contradicts")
      ? capFindingStrength(finding, "moderate")
      : finding,
};
