import { createWriteStream } from "node:fs";
import { access, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const CASE_FILES = [
  "task.json",
  "metrics.parquet",
  "logs.parquet",
  "traces.parquet",
  "events.parquet",
  "alerts.parquet",
  "topology.json",
];
const BASE_URL =
  process.env.RCA100_BASE_URL ??
  "https://aiops-benchmark.oss-cn-hongkong.aliyuncs.com/rca/rca100/v1.1";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const taskId = arg("--case", "t039");
if (!/^t\d{3}$/.test(taskId)) throw new Error(`Invalid --case value: ${taskId}`);
const dataDir = resolve(process.env.RCA100_DATA_DIR ?? join(process.cwd(), "data", "rca100"));
const root = join(dataDir, "cases", taskId);
await mkdir(root, { recursive: true });

async function valid(path, file) {
  try {
    await access(path);
    const info = await stat(path);
    if (!info.isFile() || !info.size) return false;
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
    if (file.endsWith(".json")) JSON.parse(await readFile(path, "utf8"));
    return true;
  } catch {
    return false;
  }
}

async function download(url, target) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }
  await mkdir(dirname(target), { recursive: true });
  const partial = `${target}.part`;
  await rm(partial, { force: true });
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

for (const file of CASE_FILES) {
  const target = join(root, file);
  if (await valid(target, file)) {
    console.log(`✓ ${file} already present`);
    continue;
  }
  process.stdout.write(`↓ ${file} ... `);
  await download(`${BASE_URL.replace(/\/$/, "")}/cases/${taskId}/${file}`, target);
  if (!(await valid(target, file))) throw new Error(`Validation failed: ${target}`);
  const sizeMb = ((await stat(target)).size / 1024 / 1024).toFixed(1);
  console.log(`${sizeMb} MB`);
}
console.log(`RCA100 ${taskId} ready at ${root}`);
