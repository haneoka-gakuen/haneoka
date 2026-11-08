// L3 — GEB
// Input: D1 statements from the collector code; the official tables copied from D1.
// Output: D1 results from the host's own copy; every changed row of a replicated table queued for D1.
// Pos: [Map](../../L2.md); the collector host's database and its change outbox.
// Effects/Dependencies: Reads and writes the local official database; triggers record changed primary keys.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

type Row = Record<string, unknown>;

const value = (input: unknown): SQLInputValue => {
  if (typeof input === "boolean") return input ? 1 : 0;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input === undefined) throw new TypeError("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
  return input as SQLInputValue;
};

interface Result<T> {
  results: T[];
  success: true;
  meta: { changes: number; last_row_id: number; rows_read: number; rows_written: number; duration: number; changed_db: boolean };
}

export class LocalStatement {
  constructor(private readonly db: LocalD1, readonly sql: string, readonly params: SQLInputValue[] = []) {}

  bind(...params: unknown[]): LocalStatement {
    return new LocalStatement(this.db, this.sql, params.map(value));
  }

  run<T = Row>(): Promise<Result<T>> { return Promise.resolve(this.execute<T>()); }
  all<T = Row>(): Promise<Result<T>> { return Promise.resolve(this.execute<T>()); }

  async first<T = Row>(column?: string): Promise<T | null> {
    const row = this.execute<Row>().results[0];
    if (!row) return null;
    if (column === undefined) return row as T;
    if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
    return (row[column] ?? null) as T;
  }

  async raw<T = unknown[]>(options: { columnNames?: boolean } = {}): Promise<T[]> {
    const statement = this.db.handle.prepare(this.sql);
    const columns = statement.columns().map((column) => column.name);
    const rows = columns.length ? (statement.all(...this.params) as Row[]) : (statement.run(...this.params), []);
    const values = rows.map((row) => columns.map((name) => row[name])) as T[];
    return options.columnNames ? [columns as T, ...values] : values;
  }

  /** One statement as D1 reports it. */
  execute<T>(): Result<T> {
    const statement = this.db.handle.prepare(this.sql);
    if (statement.columns().length) {
      const results = statement.all(...this.params).map((row) => ({ ...row })) as T[];
      return { results, success: true, meta: { changes: 0, last_row_id: 0, rows_read: results.length, rows_written: 0, duration: 0, changed_db: false } };
    }
    const outcome = statement.run(...this.params);
    const changes = Number(outcome.changes);
    return { results: [], success: true, meta: { changes, last_row_id: Number(outcome.lastInsertRowid), rows_read: 0, rows_written: changes, duration: 0, changed_db: changes > 0 } };
  }
}

export class LocalD1 {
  readonly handle: DatabaseSync;

  constructor(path: string) {
    this.handle = new DatabaseSync(path);
    this.handle.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  }

  prepare(sql: string): LocalStatement { return new LocalStatement(this, sql); }

  /** All statements or none, as D1 batches are. */
  async batch<T = Row>(statements: LocalStatement[]): Promise<Result<T>[]> {
    this.handle.exec("SAVEPOINT d1_batch");
    try {
      const results = statements.map((statement) => statement.execute<T>());
      this.handle.exec("RELEASE d1_batch");
      return results;
    } catch (error) {
      this.handle.exec("ROLLBACK TO d1_batch; RELEASE d1_batch");
      throw error;
    }
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.handle.exec(sql);
    return { count: 1, duration: 0 };
  }

  async dump(): Promise<ArrayBuffer> { throw new Error("unsupported"); }
}

export interface ReplicatedTable { name: string; key: string[]; columns: string[] }

/** The replicated tables and the triggers that queue each changed primary key, oldest change first. */
export function installOutbox(db: DatabaseSync, owned: (table: string) => boolean): ReplicatedTable[] {
  db.exec(`CREATE TABLE IF NOT EXISTS _replica_outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, pk TEXT NOT NULL, UNIQUE (tbl, pk))`);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%'").all() as { name: string }[])
    .map((row) => row.name).filter(owned);
  const replicated: ReplicatedTable[] = [];
  for (const name of tables) {
    const info = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string; pk: number }[];
    const key = info.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
    if (!key.length) throw new Error(`replicated table without primary key: ${name}`);
    const columns = info.map((column) => column.name);
    const pick = (row: "NEW" | "OLD") => `json_array(${key.map((column) => `${row}."${column}"`).join(",")})`;
    db.exec(`DROP TRIGGER IF EXISTS "_replica_${name}_insert"; DROP TRIGGER IF EXISTS "_replica_${name}_update"; DROP TRIGGER IF EXISTS "_replica_${name}_delete";
      CREATE TRIGGER "_replica_${name}_insert" AFTER INSERT ON "${name}" BEGIN
        INSERT OR REPLACE INTO _replica_outbox (tbl, pk) VALUES ('${name}', ${pick("NEW")}); END;
      CREATE TRIGGER "_replica_${name}_update" AFTER UPDATE ON "${name}" BEGIN
        INSERT OR REPLACE INTO _replica_outbox (tbl, pk) VALUES ('${name}', ${pick("OLD")});
        INSERT OR REPLACE INTO _replica_outbox (tbl, pk) VALUES ('${name}', ${pick("NEW")}); END;
      CREATE TRIGGER "_replica_${name}_delete" AFTER DELETE ON "${name}" BEGIN
        INSERT OR REPLACE INTO _replica_outbox (tbl, pk) VALUES ('${name}', ${pick("OLD")}); END;`);
    replicated.push({ name, key, columns });
  }
  return replicated;
}

export type ReplicaOperation =
  | { table: string; upsert: Record<string, unknown> }
  | { table: string; remove: Record<string, unknown> };

/** The next run of queued changes: each row as it is now, or its removal. */
export function takeOutbox(db: DatabaseSync, tables: Map<string, ReplicatedTable>, limit: number, byteBudget: number) {
  const queued = db.prepare("SELECT seq, tbl, pk FROM _replica_outbox ORDER BY seq LIMIT ?").all(limit) as { seq: number; tbl: string; pk: string }[];
  const operations: ReplicaOperation[] = [];
  let bytes = 0, last = 0;
  for (const entry of queued) {
    const table = tables.get(entry.tbl);
    last = entry.seq;
    if (!table) continue;
    const values = JSON.parse(entry.pk) as unknown[];
    const where = Object.fromEntries(table.key.map((column, index) => [column, values[index]]));
    const row = db.prepare(`SELECT * FROM "${table.name}" WHERE ${table.key.map((column) => `"${column}" IS ?`).join(" AND ")}`)
      .get(...(values as SQLInputValue[])) as Row | undefined;
    const operation: ReplicaOperation = row ? { table: table.name, upsert: { ...row } } : { table: table.name, remove: where };
    bytes += JSON.stringify(operation).length;
    operations.push(operation);
    if (bytes >= byteBudget) break;
  }
  return { operations, last };
}

export function clearOutbox(db: DatabaseSync, through: number): void {
  db.prepare("DELETE FROM _replica_outbox WHERE seq<=?").run(through);
}
