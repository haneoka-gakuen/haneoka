// L3 — GEB
// Input: D1 statements from the collector code; the official tables copied from D1.
// Output: Local SQLite results and a coalesced queue for live projections and completed daily archives.
// Pos: [Map](../../L2.md); the collector host's database and its change outbox.
// Effects/Dependencies: Reads and writes the local official database; triggers record changed primary keys. Coalesced profile observation times stay local.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { HOST_LOCAL_UPSERTS } from "../../../worker/official-host";
import { EVENT_RANK_DAY_MS, EVENT_RANK_JST_MS } from "../../../worker/event-rank-archive";
import { OFFICIAL_RANKING_DEPTH_SCALE } from "../../../src/lib/official-ranking.ts";

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
    this.handle.exec(`CREATE TABLE IF NOT EXISTS _player_profile_observations (
      region TEXT NOT NULL, profile_id TEXT NOT NULL, observed_at_ms INTEGER NOT NULL,
      PRIMARY KEY (region, profile_id),
      FOREIGN KEY (region, profile_id) REFERENCES official_player_profiles(region, profile_id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) WITHOUT ROWID`);
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
  if (!db.prepare("PRAGMA table_info(_replica_outbox)").all().some((row) => row.name === "available_at"))
    db.exec("ALTER TABLE _replica_outbox ADD COLUMN available_at INTEGER NOT NULL DEFAULT 0");
  db.exec(`CREATE TABLE IF NOT EXISTS _replica_policy (key TEXT PRIMARY KEY,value INTEGER NOT NULL) WITHOUT ROWID`);
  const cutover = Math.floor((Date.now() + EVENT_RANK_JST_MS) / EVENT_RANK_DAY_MS) + 1;
  db.prepare("INSERT OR IGNORE INTO _replica_policy VALUES ('arena_daily_cutover', ?)").run(cutover);
  const dailyCutover = Number(db.prepare("SELECT value FROM _replica_policy WHERE key='arena_daily_cutover'").get()?.value);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%'").all() as { name: string }[])
    .map((row) => row.name).filter(owned);
  const replicated: ReplicatedTable[] = [];
  for (const name of tables) {
    const info = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string; pk: number }[];
    const key = info.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
    if (!key.length) throw new Error(`replicated table without primary key: ${name}`);
    const columns = info.map((column) => column.name);
    const pick = (row: "NEW" | "OLD") => `json_array(${key.map((column) => `${row}."${column}"`).join(",")})`;
    // A trigger's own conflict clause yields to the outer statement's, so the
    // key moves to the end of the queue by removing it first.
    const defer = name === "official_ranking_daily"
      ? `CASE WHEN NEW.day >= ${dailyCutover} AND NEW.board_key LIKE 'arena/%' AND NEW.board_key NOT LIKE '%/1'
          THEN (NEW.day+1)*${EVENT_RANK_DAY_MS}-${EVENT_RANK_JST_MS} ELSE 0 END`
      : "0";
    const queue = (row: "NEW" | "OLD") => `DELETE FROM _replica_outbox WHERE tbl='${name}' AND pk=${pick(row)};
        INSERT INTO _replica_outbox (tbl, pk, available_at) VALUES ('${name}', ${pick(row)}, ${row === "NEW" ? defer : "0"});`;
    const upsert = HOST_LOCAL_UPSERTS.has(name) ? "SELECT 1;" : queue("NEW");
    const sameKey = key.map((column) => `OLD."${column}" IS NEW."${column}"`).join(" AND ");
    const checkBucket = `(300000+600000*(NEW.start_rank-1)/(NEW.start_rank-1+${OFFICIAL_RANKING_DEPTH_SCALE}))`;
    const changed = columns.map((column) => name === "official_arena_window_metadata" && column === "observed_at_ms"
      ? `(OLD.observed_at_ms/${checkBucket}<>NEW.observed_at_ms/${checkBucket})`
      : `OLD."${column}" IS NOT NEW."${column}"`).join(" OR ");
    db.exec(`DROP TRIGGER IF EXISTS "_replica_${name}_key_change";
      DROP TRIGGER IF EXISTS "_replica_${name}_insert"; DROP TRIGGER IF EXISTS "_replica_${name}_update"; DROP TRIGGER IF EXISTS "_replica_${name}_delete";
      CREATE TRIGGER "_replica_${name}_insert" AFTER INSERT ON "${name}" BEGIN ${upsert} END;
      CREATE TRIGGER "_replica_${name}_update" AFTER UPDATE ON "${name}"
        WHEN (${sameKey}) AND (${changed}) BEGIN ${upsert} END;
      CREATE TRIGGER "_replica_${name}_key_change" AFTER UPDATE ON "${name}"
        WHEN NOT (${sameKey}) BEGIN ${queue("OLD")} ${upsert} END;
      CREATE TRIGGER "_replica_${name}_delete" AFTER DELETE ON "${name}" BEGIN ${queue("OLD")} END;`);
    replicated.push({ name, key, columns });
  }
  return replicated;
}

export type ReplicaOperation =
  | { table: string; upsert: Record<string, unknown> }
  | { table: string; remove: Record<string, unknown> };

function readReplicaRow(db: DatabaseSync, table: string, key: Record<string, unknown>): Row | undefined {
  const columns = Object.keys(key);
  return db.prepare(`SELECT * FROM "${table}" WHERE ${columns.map((column) => `"${column}" IS ?`).join(" AND ")}`)
    .get(...(Object.values(key) as SQLInputValue[])) as Row | undefined;
}

/** The next run of queued changes: each row as it is now, or its removal. */
export function takeOutbox(db: DatabaseSync, tables: Map<string, ReplicatedTable>, limit: number, byteBudget: number) {
  const queued = db.prepare("SELECT seq, tbl, pk FROM _replica_outbox WHERE available_at<=? ORDER BY seq LIMIT ?")
    .all(Date.now(), limit) as { seq: number; tbl: string; pk: string }[];
  const operations: ReplicaOperation[] = [];
  const sequences: number[] = [];
  let bytes = 0;
  const append = (operation: ReplicaOperation) => {
    operations.push(operation);
    bytes += Buffer.byteLength(JSON.stringify(operation)) + 1;
  };
  for (const entry of queued) {
    const table = tables.get(entry.tbl);
    sequences.push(entry.seq);
    if (!table) continue;
    const values = JSON.parse(entry.pk) as unknown[];
    const where = Object.fromEntries(table.key.map((column, index) => [column, values[index]]));
    const row = readReplicaRow(db, table.name, where);
    if (row && HOST_LOCAL_UPSERTS.has(table.name)) continue;
    append(row ? { table: table.name, upsert: { ...row } } : { table: table.name, remove: where });
    if (bytes >= byteBudget) break;
  }
  return { operations, sequences };
}

export function clearOutbox(db: DatabaseSync, sequences: readonly number[]): void {
  db.prepare("DELETE FROM _replica_outbox WHERE seq IN (SELECT value FROM json_each(?))").run(JSON.stringify(sequences));
}
