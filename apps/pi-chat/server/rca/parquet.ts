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

export interface ParquetRuntimeDiagnostics {
  activeScans: number;
  maxConcurrentScans: number;
  totalScans: number;
  batchesRead: number;
  rowsScanned: number;
  rssPeakBytes: number;
  heapUsedPeakBytes: number;
  heapTotalPeakBytes: number;
  externalPeakBytes: number;
  arrayBuffersPeakBytes: number;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

class Semaphore {
  private active = 0;
  private readonly max: number;
  private readonly queue: Waiter[] = [];

  constructor(max: number) {
    this.max = Math.max(1, max);
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    throwIfCancelled(signal);
    if (this.active < this.max) {
      this.active++;
      return () => this.release();
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new DOMException("Investigation cancelled", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    while (this.queue.length > 0 && this.active < this.max) {
      const waiter = this.queue.shift()!;
      if (waiter.signal?.aborted) {
        waiter.onAbort && waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.reject(new DOMException("Investigation cancelled", "AbortError"));
        continue;
      }
      waiter.onAbort && waiter.signal?.removeEventListener("abort", waiter.onAbort);
      this.active++;
      waiter.resolve(() => this.release());
      break;
    }
  }
}

function envInteger(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const globalScanSemaphore = new Semaphore(
  envInteger("RCA_MAX_CONCURRENT_PARQUET_SCANS", 2),
);
const pathScanSemaphores = new Map<string, Semaphore>();
const runtimeDiagnostics: ParquetRuntimeDiagnostics = {
  activeScans: 0,
  maxConcurrentScans: 0,
  totalScans: 0,
  batchesRead: 0,
  rowsScanned: 0,
  rssPeakBytes: 0,
  heapUsedPeakBytes: 0,
  heapTotalPeakBytes: 0,
  externalPeakBytes: 0,
  arrayBuffersPeakBytes: 0,
};

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Investigation cancelled", "AbortError");
  }
}

function sampleMemory(): void {
  const memory = process.memoryUsage();
  runtimeDiagnostics.rssPeakBytes = Math.max(runtimeDiagnostics.rssPeakBytes, memory.rss);
  runtimeDiagnostics.heapUsedPeakBytes = Math.max(
    runtimeDiagnostics.heapUsedPeakBytes,
    memory.heapUsed,
  );
  runtimeDiagnostics.heapTotalPeakBytes = Math.max(
    runtimeDiagnostics.heapTotalPeakBytes,
    memory.heapTotal,
  );
  runtimeDiagnostics.externalPeakBytes = Math.max(
    runtimeDiagnostics.externalPeakBytes,
    memory.external,
  );
  runtimeDiagnostics.arrayBuffersPeakBytes = Math.max(
    runtimeDiagnostics.arrayBuffersPeakBytes,
    memory.arrayBuffers,
  );
}

async function acquireScan(path: string, signal?: AbortSignal): Promise<() => void> {
  const resolvedPath = resolve(path);
  const pathSemaphore = pathScanSemaphores.get(resolvedPath) ?? new Semaphore(1);
  pathScanSemaphores.set(resolvedPath, pathSemaphore);

  // Acquire the per-file mutex first so same-file waiters do not consume the
  // scarce global scan slots while queued.
  const releasePath = await pathSemaphore.acquire(signal);
  try {
    const releaseGlobal = await globalScanSemaphore.acquire(signal);
    runtimeDiagnostics.activeScans++;
    runtimeDiagnostics.totalScans++;
    runtimeDiagnostics.maxConcurrentScans = Math.max(
      runtimeDiagnostics.maxConcurrentScans,
      runtimeDiagnostics.activeScans,
    );
    sampleMemory();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      runtimeDiagnostics.activeScans = Math.max(0, runtimeDiagnostics.activeScans - 1);
      sampleMemory();
      releaseGlobal();
      releasePath();
    };
  } catch (error) {
    releasePath();
    throw error;
  }
}

export function getParquetRuntimeDiagnostics(): ParquetRuntimeDiagnostics {
  sampleMemory();
  return { ...runtimeDiagnostics };
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
  const releaseScan = await acquireScan(path, signal);
  try {
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
      runtimeDiagnostics.batchesRead++;
      runtimeDiagnostics.rowsScanned += rows.length;
      sampleMemory();
      throwIfCancelled(signal);
      await onBatch(rows);
      sampleMemory();
      throwIfCancelled(signal);
    }
    return totalRows;
  } finally {
    releaseScan();
  }
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
