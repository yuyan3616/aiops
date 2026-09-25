import { createWriteStream } from "node:fs";
import { access, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { T039_FALLBACK_TASK } from "./fallback";
import {
  RCA100_CASE_FILES,
  type Rca100CaseDescriptor,
  type Rca100CaseFile,
  type Rca100CasePaths,
  type Rca100Task,
  type Rca100Topology,
} from "./schema";

const DATASET_REVISION = "v1.1";
const DEFAULT_BASE_URL = `https://aiops-benchmark.oss-cn-hongkong.aliyuncs.com/rca/rca100/${DATASET_REVISION}`;
const TASK_ID_PATTERN = /^t\d{3}$/;

function defaultDataDir() {
  return resolve(process.env.RCA100_DATA_DIR?.trim() || join(process.cwd(), "data", "rca100"));
}

function envBoolean(name: string, fallback: boolean) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return !["0", "false", "no", "off"].includes(value);
}

export class Rca100Repository {
  readonly dataDir: string;
  readonly baseUrl: string;
  readonly autoDownload: boolean;
  private readonly downloads = new Map<string, Promise<void>>();

  constructor(options: { dataDir?: string; baseUrl?: string; autoDownload?: boolean } = {}) {
    this.dataDir = resolve(options.dataDir ?? defaultDataDir());
    this.baseUrl = (options.baseUrl ?? process.env.RCA100_BASE_URL?.trim() ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.autoDownload = options.autoDownload ?? envBoolean("RCA100_AUTO_DOWNLOAD", true);
  }

  casePaths(taskId: string): Rca100CasePaths {
    this.assertTaskId(taskId);
    const root = join(this.dataDir, "cases", taskId);
    return {
      taskId,
      root,
      task: join(root, "task.json"),
      metrics: join(root, "metrics.parquet"),
      logs: join(root, "logs.parquet"),
      traces: join(root, "traces.parquet"),
      events: join(root, "events.parquet"),
      alerts: join(root, "alerts.parquet"),
      topology: join(root, "topology.json"),
    };
  }

  fallbackTask(taskId: string): Rca100Task {
    this.assertTaskId(taskId);
    if (taskId === "t039") return structuredClone(T039_FALLBACK_TASK);
    throw new Error(`No bundled metadata is available for RCA100 ${taskId}. Download the case first.`);
  }

  async isCaseReady(taskId: string) {
    const paths = this.casePaths(taskId);
    return this.hasAllCaseFiles(paths);
  }

  async getTask(taskId: string, options: { ensure?: boolean } = {}): Promise<Rca100Task> {
    const paths = this.casePaths(taskId);
    if (options.ensure) await this.ensureCase(taskId);
    try {
      return await this.readJson<Rca100Task>(paths.task);
    } catch (error) {
      if (taskId === "t039") return this.fallbackTask(taskId);
      throw error;
    }
  }

  async openCase(taskId: string): Promise<Rca100CaseDescriptor> {
    await this.ensureCase(taskId);
    const paths = this.casePaths(taskId);
    return { task: await this.readJson<Rca100Task>(paths.task), paths };
  }

  async loadTopology(taskId: string): Promise<Rca100Topology> {
    const descriptor = await this.openCase(taskId);
    const value = await this.readJson<Rca100Topology>(descriptor.paths.topology);
    if (!Array.isArray(value.entities) || !Array.isArray(value.edges)) {
      throw new Error(`Invalid RCA100 topology for ${taskId}: entities/edges are required.`);
    }
    return value;
  }

  async ensureCase(taskId: string): Promise<void> {
    this.assertTaskId(taskId);
    const paths = this.casePaths(taskId);
    if (await this.hasAllCaseFiles(paths)) return;
    if (!this.autoDownload) {
      throw new Error(
        `RCA100 ${taskId} is not downloaded. Run \"npm run rca100:download -- --case ${taskId}\" or set RCA100_AUTO_DOWNLOAD=true.`,
      );
    }

    let pending = this.downloads.get(taskId);
    if (!pending) {
      pending = this.downloadCase(taskId).finally(() => this.downloads.delete(taskId));
      this.downloads.set(taskId, pending);
    }
    await pending;
  }

  async downloadCase(taskId: string, onFile?: (file: Rca100CaseFile) => void): Promise<void> {
    this.assertTaskId(taskId);
    const root = this.casePaths(taskId).root;
    await mkdir(root, { recursive: true });
    for (const file of RCA100_CASE_FILES) {
      const target = join(root, file);
      if (await this.isValidFile(target, file)) continue;
      onFile?.(file);
      await this.download(`${this.baseUrl}/cases/${taskId}/${file}`, target);
      if (!(await this.isValidFile(target, file))) {
        await rm(target, { force: true });
        throw new Error(`Downloaded RCA100 file failed validation: ${taskId}/${file}`);
      }
    }
  }

  private async hasAllCaseFiles(paths: Rca100CasePaths) {
    const files: Array<[string, Rca100CaseFile]> = [
      [paths.task, "task.json"],
      [paths.metrics, "metrics.parquet"],
      [paths.logs, "logs.parquet"],
      [paths.traces, "traces.parquet"],
      [paths.events, "events.parquet"],
      [paths.alerts, "alerts.parquet"],
      [paths.topology, "topology.json"],
    ];
    const checks = await Promise.all(files.map(([path, file]) => this.isValidFile(path, file)));
    return checks.every(Boolean);
  }

  private async isValidFile(path: string, file: Rca100CaseFile) {
    try {
      await access(path);
      const info = await stat(path);
      if (!info.isFile() || info.size === 0) return false;
      if (file.endsWith(".parquet")) {
        if (info.size < 8) return false;
        const handle = await open(path, "r");
        try {
          const head = Buffer.alloc(4);
          const tail = Buffer.alloc(4);
          await handle.read(head, 0, 4, 0);
          await handle.read(tail, 0, 4, info.size - 4);
          return head.toString("ascii") === "PAR1" && tail.toString("ascii") === "PAR1";
        } finally {
          await handle.close();
        }
      }
      if (file.endsWith(".json")) {
        JSON.parse(await readFile(path, "utf8"));
      }
      return true;
    } catch {
      return false;
    }
  }

  private async download(url: string, target: string) {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
    }
    await mkdir(dirname(target), { recursive: true });
    const partial = `${target}.part`;
    await rm(partial, { force: true });
    try {
      const body = Readable.fromWeb(response.body as any);
      await pipeline(body, createWriteStream(partial));
      await rename(partial, target);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }

  private async readJson<T>(path: string): Promise<T> {
    return JSON.parse(await readFile(path, "utf8")) as T;
  }

  private assertTaskId(taskId: string) {
    if (!TASK_ID_PATTERN.test(taskId)) throw new Error(`Invalid RCA100 task id: ${taskId}`);
  }
}
