import type { ExpertProfile } from "../types";
import { briefSearchText, capFindingStrength, containsAny, loadProfileText, skill } from "../utils";

const signature = skill(
  "error-signature",
  "错误特征分析",
  `按稳定 signature 对 error 分组，例如 exception type、message pattern、error code 或 stack origin。优先使用计数加代表性 sample，而不是 raw dump。区分 incident 的主导 signature 与少量无关噪声，并比较它们在 incident window 内的频率变化。`,
);
const firstOccurrence = skill(
  "first-occurrence",
  "首次出现时间分析",
  `在指定窗口内寻找最早的可靠 occurrence。如果第一次命中就在窗口边界，要说明真实 onset 可能更早。把 onset 与 alert/change 的对比仅作为 temporal evidence。`,
);
const exceptionChain = skill(
  "exception-chain",
  "异常链分析",
  `沿 nested cause 追到最深层、真正有意义的 application 或 dependency error。区分 framework wrapper 与 underlying exception。不要编造源码缺陷；当 log 无法解释 mechanism 时，应建议进一步做代码级调查。`,
);

export const logProfile: ExpertProfile = {
  role: "log",
  label: "Log 调查",
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
