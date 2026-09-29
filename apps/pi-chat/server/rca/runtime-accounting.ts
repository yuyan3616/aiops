import type { AssistantMessage } from "@earendil-works/pi-ai";

import type { AgentUsage } from "./types";

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** One instance per Expert run. Only finalized Assistant messages are passed in. */
export class AgentUsageAccumulator {
  private readonly totals: AgentUsage = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    contextTokens: 0,
  };

  record(message: AssistantMessage): void {
    const usage = message.usage;
    this.totals.turns++;
    this.totals.inputTokens += count(usage.input);
    this.totals.outputTokens += count(usage.output);
    this.totals.cacheReadTokens += count(usage.cacheRead);
    this.totals.cacheWriteTokens += count(usage.cacheWrite);
    const total =
      count(usage.totalTokens) ||
      count(usage.input) + count(usage.output) + count(usage.cacheRead) + count(usage.cacheWrite);
    this.totals.totalTokens += total;
    if (message.stopReason !== "error" && message.stopReason !== "aborted" && total > 0) {
      this.totals.contextTokens = total;
    }
    const cost = count(usage.cost?.total);
    if (cost > 0) this.totals.cost = (this.totals.cost ?? 0) + cost;
  }

  snapshot(): AgentUsage {
    return { ...this.totals };
  }
}

/** Scrub persisted/UI error summaries. Raw provider payloads must not be published. */
export function safeRuntimeDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "Unknown runtime error");
  return raw
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(
      /(["']?(?:api[_-]?key|authorization|access[_-]?token|secret|password)["']?\s*[=:]\s*["']?)[^\s,"'&}]+/gi,
      "$1[REDACTED]",
    )
    .replace(/([?&](?:api[_-]?key|access[_-]?token|secret|password)=)[^&\s]+/gi, "$1[REDACTED]")
    .slice(0, 500);
}
