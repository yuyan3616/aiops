export function median(values: number[]): number {
  return quantile(values, 0.5);
}

export function quantile(values: number[], probability: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] ?? Number.NaN;
  const weight = position - lower;
  return (sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight;
}

export function robustZScore(baseline: number[], incidentMedian: number): number {
  const baselineMedian = median(baseline);
  const deviations = baseline.map((value) => Math.abs(value - baselineMedian));
  const mad = median(deviations);
  const scale = Math.max(mad * 1.4826, Math.abs(baselineMedian) * 0.05, 1e-9);
  return (incidentMedian - baselineMedian) / scale;
}

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : undefined;
  }
  return undefined;
}

export function safeRatio(numerator: number, denominator: number): number {
  const floor = Math.max(Math.abs(denominator), 1e-9);
  return numerator / floor;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
