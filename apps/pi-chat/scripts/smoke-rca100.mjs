import { access, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { DuckDBInstance } from "@duckdb/node-api";

const PARQUET_FILES = ["metrics.parquet", "logs.parquet", "traces.parquet", "events.parquet", "alerts.parquet"];

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const taskId = arg("--case", "t039");
if (!/^t\d{3}$/.test(taskId)) throw new Error(`Invalid --case value: ${taskId}`);
const dataDir = resolve(process.env.RCA100_DATA_DIR ?? join(process.cwd(), "data", "rca100"));
const root = join(dataDir, "cases", taskId);

const required = ["task.json", ...PARQUET_FILES, "topology.json"];
for (const file of required) {
  const path = join(root, file);
  await access(path).catch(() => {
    throw new Error(`Missing ${path}. Run npm run rca100:download -- --case ${taskId} first.`);
  });
  const info = await stat(path);
  if (!info.isFile() || info.size === 0) throw new Error(`Invalid empty file: ${path}`);
}

const task = JSON.parse(await readFile(join(root, "task.json"), "utf8"));
const topology = JSON.parse(await readFile(join(root, "topology.json"), "utf8"));
console.log(`RCA100 ${taskId}: ${task.alert_title}`);
console.log(`window: ${task.alert_window?.start} -> ${task.alert_window?.end}`);
console.log(`topology: ${topology.entities?.length ?? 0} entities, ${topology.edges?.length ?? 0} edges`);

const instance = await DuckDBInstance.create(":memory:");
const connection = await instance.connect();
try {
  for (const file of PARQUET_FILES) {
    const path = join(root, file);
    const reader = await connection.runAndReadAll(
      `SELECT count(*) AS row_count FROM read_parquet(${sqlString(path)})`,
    );
    const rowCount = reader.getRowObjectsJson()[0]?.row_count ?? "0";

    const describe = await connection.runAndReadAll(
      `DESCRIBE SELECT * FROM read_parquet(${sqlString(path)})`,
    );
    const columns = describe
      .getRowObjectsJson()
      .map((row) => String(row.column_name ?? row.column ?? row.name ?? ""))
      .filter(Boolean);
    console.log(`${file}: ${rowCount} rows | ${columns.slice(0, 10).join(", ")}${columns.length > 10 ? ", ..." : ""}`);
  }
} finally {
  connection.closeSync();
}

console.log("RCA100 smoke check passed.");
