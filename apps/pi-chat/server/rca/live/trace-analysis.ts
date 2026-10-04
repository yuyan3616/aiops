import type { LiveTrace } from "./types";

/** Uncovered time is an instrumentation boundary, not proof of a mechanism. */
export function analyzeTrace(trace: LiveTrace) {
  const warnings = new Set<string>();
  const intervals = trace.spans.flatMap((parent) => {
    if (!parent.startTimeUnixNano || !parent.endTimeUnixNano) return [];
    const start = BigInt(parent.startTimeUnixNano);
    const end = BigInt(parent.endTimeUnixNano);
    if (end <= start) {
      warnings.add("invalid_or_unfinished_span_interval");
      return [];
    }
    const children = trace.spans.filter((span) => span.parentSpanId === parent.spanId);
    const ranges: Array<[bigint, bigint]> = [];
    for (const child of children) {
      if (!child.startTimeUnixNano || !child.endTimeUnixNano) {
        warnings.add("unfinished_child_interval");
        continue;
      }
      const childStart = BigInt(child.startTimeUnixNano);
      const childEnd = BigInt(child.endTimeUnixNano);
      if (childEnd <= childStart) {
        warnings.add("invalid_child_interval");
        continue;
      }
      if (childStart < start || childEnd > end)
        warnings.add("child_outside_parent_clock_or_instrumentation_boundary");
      const clippedStart = childStart > start ? childStart : start;
      const clippedEnd = childEnd < end ? childEnd : end;
      if (clippedEnd > clippedStart) ranges.push([clippedStart, clippedEnd]);
    }
    ranges.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const merged: Array<[bigint, bigint]> = [];
    for (const range of ranges) {
      const previous = merged.at(-1);
      if (previous && range[0] <= previous[1]) {
        if (range[1] > previous[1]) previous[1] = range[1];
      } else merged.push([...range]);
    }
    const uncovered: Array<{ fromOffsetMs: number; toOffsetMs: number }> = [];
    let cursor = start;
    let covered = 0n;
    for (const [from, to] of merged) {
      if (from > cursor)
        uncovered.push({
          fromOffsetMs: Number(cursor - start) / 1e6,
          toOffsetMs: Number(from - start) / 1e6,
        });
      covered += to - from;
      cursor = to;
    }
    if (cursor < end)
      uncovered.push({
        fromOffsetMs: Number(cursor - start) / 1e6,
        toOffsetMs: Number(end - start) / 1e6,
      });
    return [
      {
        spanId: parent.spanId,
        directChildCount: children.length,
        coveredChildDurationMs: Number(covered) / 1e6,
        uncoveredDurationMs: Number(end - start - covered) / 1e6,
        uncoveredIntervals: uncovered.slice(0, 20),
        intervalsTruncated: uncovered.length > 20,
      },
    ];
  });
  if (trace.completeness.missingParents) warnings.add("missing_parent");
  if (trace.completeness.truncated) warnings.add("truncated_trace");
  return {
    completeness: trace.completeness.state,
    completeCriticalPath: false,
    interpretation:
      "Direct-child interval union only. Uncovered time does not identify network, queueing, local work, or runtime pause.",
    intervals,
    warnings: [...warnings],
  };
}
