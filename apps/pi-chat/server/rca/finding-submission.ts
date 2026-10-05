import type { AgentExpertFinding } from "./types";

// Domain validation remains authoritative even when a trusted Extension changes its model schema.
export function validateFindingSubmission(input: Record<string, unknown>): AgentExpertFinding {
  const fail = () => {
    throw new Error("finding_invalid_submission");
  };
  const text = (value: unknown, max: number): value is string =>
    typeof value === "string" && value.trim().length > 0 && value.length <= max;
  const list = (value: unknown, max: number, length: number): value is string[] =>
    Array.isArray(value) && value.length <= max && value.every((x) => text(x, length));
  if (
    !["succeeded", "failed", "inconclusive", "blocked"].includes(String(input.status)) ||
    !["strong", "moderate", "weak", "inconclusive"].includes(String(input.strength)) ||
    !["supports", "contradicts", "no-signal", "mixed", "inconclusive"].includes(
      String(input.verdict),
    ) ||
    !text(input.summary, 1500) ||
    !list(input.conclusions, 5, 1000) ||
    !list(input.candidateEntities, 20, 200) ||
    !list(input.suggestedFollowUps, 10, 1000) ||
    !Array.isArray(input.evidenceClaims) ||
    input.evidenceClaims.length > 20
  )
    fail();
  if (input.candidateMechanism !== undefined && !text(input.candidateMechanism, 1000)) fail();
  if (input.blockedOn !== undefined && !text(input.blockedOn, 1000)) fail();
  for (const raw of input.evidenceClaims as unknown[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail();
    const claim = raw as Record<string, unknown>;
    if (
      !text(claim.toolCallId, 64) ||
      !text(claim.summary, 1000) ||
      !["trace", "log", "metric", "event", "alert", "topology"].includes(String(claim.modality)) ||
      !list(claim.supports, 20, 64) ||
      !list(claim.contradicts, 20, 64) ||
      (claim.sourceItems !== undefined && !list(claim.sourceItems, 20, 256)) ||
      (claim.entity !== undefined && !text(claim.entity, 200))
    )
      fail();
  }
  return input as unknown as AgentExpertFinding;
}
