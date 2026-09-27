import { resolve } from "node:path";

import {
  asyncBufferFromFile,
  parquetMetadataAsync,
  parquetReadObjects,
  type FileMetaData,
} from "hyparquet";
import { compressors } from "hyparquet-compressors";

import type { SchemaField } from "./types";

export type ParquetRow = Record<string, unknown>;

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Investigation cancelled", "AbortError");
  }
}

export async function readParquetRows(path: string, columns?: string[]): Promise<ParquetRow[]> {
  const file = await asyncBufferFromFile(resolve(path));
  const rows = await parquetReadObjects({
    file,
    compressors,
    ...(columns ? { columns } : {}),
  });
  return rows as ParquetRow[];
}

export async function readParquetRowsBatched(
  path: string,
  columns: string[],
  onBatch: (rows: ParquetRow[]) => void | Promise<void>,
  batchSize = 20_000,
  signal?: AbortSignal,
): Promise<number> {
  throwIfCancelled(signal);
  const file = await asyncBufferFromFile(resolve(path));
  throwIfCancelled(signal);
  const metadata = await parquetMetadataAsync(file);
  throwIfCancelled(signal);
  const totalRows = Number(metadata.num_rows);
  for (let rowStart = 0; rowStart < totalRows; rowStart += batchSize) {
    throwIfCancelled(signal);
    const rowEnd = Math.min(totalRows, rowStart + batchSize);
    const rows = (await parquetReadObjects({
      file,
      compressors,
      columns,
      rowStart,
      rowEnd,
    })) as ParquetRow[];
    throwIfCancelled(signal);
    await onBatch(rows);
    throwIfCancelled(signal);
  }
  return totalRows;
}

export async function readParquetMetadata(path: string): Promise<FileMetaData> {
  const file = await asyncBufferFromFile(resolve(path));
  return parquetMetadataAsync(file);
}

export function metadataFields(metadata: FileMetaData): SchemaField[] {
  return metadata.schema.slice(1).map((field) => ({
    name: field.name,
    type:
      field.logical_type !== undefined
        ? JSON.stringify(jsonSafe(field.logical_type))
        : String(field.type ?? "group"),
  }));
}

export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, jsonSafe(nested)]),
    );
  }
  return value;
}

export function epochToIso(value: unknown, unit: "ms" | "us" | "ns"): string | undefined {
  try {
    const raw = typeof value === "bigint" ? value : BigInt(String(value));
    const divisor = unit === "ns" ? 1_000_000n : unit === "us" ? 1_000n : 1n;
    const milliseconds = Number(raw / divisor);
    if (!Number.isFinite(milliseconds)) return undefined;
    return new Date(milliseconds).toISOString();
  } catch {
    return undefined;
  }
}

export function timestampMs(value: unknown, unit?: "ms" | "us" | "ns"): number | undefined {
  if (unit) {
    const iso = epochToIso(value, unit);
    return iso ? Date.parse(iso) : undefined;
  }
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
