export function normalizeConversationIds(value: unknown, limit = 100): string[] {
  if (!Array.isArray(value)) {
    throw new Error("ids should be an array of conversation ids");
  }
  if (
    value.length === 0 ||
    value.length > limit ||
    value.some((id) => typeof id !== "string" || id.trim().length === 0)
  ) {
    throw new Error(`ids should contain between 1 and ${limit} valid conversation ids`);
  }
  return [...new Set((value as string[]).map((id) => id.trim()))];
}
