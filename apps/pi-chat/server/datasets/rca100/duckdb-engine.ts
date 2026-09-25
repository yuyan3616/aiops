export type DuckDbJsonRow = Record<string, unknown>;

type DuckDbConnectionLike = {
  runAndReadAll(sql: string): Promise<{
    getRowObjectsJson(): DuckDbJsonRow[];
  }>;
};

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite number cannot be used in DuckDB SQL.");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return sqlString(String(value));
}

export function sqlLikeContains(columnSql: string, value: string) {
  return `lower(CAST(${columnSql} AS VARCHAR)) LIKE ${sqlLiteral(`%${value.toLowerCase()}%`)}`;
}

export function parquetSql(path: string) {
  return `read_parquet(${sqlLiteral(path)})`;
}

export class DuckDbParquetEngine {
  private connectionPromise?: Promise<DuckDbConnectionLike>;

  async query(sql: string): Promise<DuckDbJsonRow[]> {
    const connection = await this.connection();
    const reader = await connection.runAndReadAll(sql);
    return reader.getRowObjectsJson();
  }

  async columns(path: string): Promise<string[]> {
    const rows = await this.query(`DESCRIBE SELECT * FROM ${parquetSql(path)}`);
    return rows
      .map((row) => String(row.column_name ?? row.column ?? row.name ?? ""))
      .filter(Boolean);
  }

  async count(path: string) {
    const rows = await this.query(`SELECT count(*) AS count FROM ${parquetSql(path)}`);
    return Number(rows[0]?.count ?? 0);
  }

  private connection() {
    this.connectionPromise ??= this.createConnection();
    return this.connectionPromise;
  }

  private async createConnection(): Promise<DuckDbConnectionLike> {
    const moduleName = "@duckdb/node-api";
    let duckdb: { DuckDBInstance?: { create(path?: string): Promise<{ connect(): Promise<DuckDbConnectionLike> }> } };
    try {
      duckdb = (await import(moduleName)) as typeof duckdb;
    } catch (error) {
      throw new Error(
        `DuckDB runtime is unavailable. Run npm install in apps/pi-chat. Original error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!duckdb.DuckDBInstance) throw new Error("@duckdb/node-api did not expose DuckDBInstance.");
    const instance = await duckdb.DuckDBInstance.create(":memory:");
    return instance.connect();
  }
}
