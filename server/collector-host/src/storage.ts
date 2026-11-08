// L3 — GEB
// Input: One collector object's keys, values and SQL from the shared collector code.
// Output: The Durable Object storage calls that code makes, kept in a local SQLite file.
// Pos: [Map](../../L2.md); collector host storage.
// Effects/Dependencies: Reads and writes one SQLite file per region; values use V8 serialization as Durable Objects do.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { deserialize, serialize } from "node:v8";

type Row = Record<string, SQLInputValue>;

/** A finished statement, read like the Durable Object SQL cursor. */
class Cursor<T> implements Iterable<T> {
  constructor(private readonly rows: T[], readonly rowsWritten: number) {}
  toArray(): T[] { return this.rows; }
  one(): T {
    if (this.rows.length !== 1) throw new Error("Expected exactly one result from SQL query");
    return this.rows[0]!;
  }
  [Symbol.iterator](): Iterator<T> { return this.rows[Symbol.iterator](); }
  get rowsRead(): number { return this.rows.length; }
}

const sqlValue = (value: unknown): SQLInputValue => {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value === undefined) throw new TypeError("undefined is not a SQL value");
  return value as SQLInputValue;
};

export class LocalStorage {
  readonly sql: { exec<T = Row>(query: string, ...bindings: unknown[]): Cursor<T>; databaseSize: number };

  constructor(readonly db: DatabaseSync) {
    db.exec("CREATE TABLE IF NOT EXISTS _kv (key TEXT PRIMARY KEY, value BLOB NOT NULL) WITHOUT ROWID");
    const exec = <T>(query: string, ...bindings: unknown[]): Cursor<T> => {
      const statements = query.split(/;\s*(?=\S)/u).filter((part) => part.trim());
      let rows: T[] = [], written = 0;
      for (const [index, text] of statements.entries()) {
        const statement = db.prepare(text);
        const values = index === statements.length - 1 ? bindings.map(sqlValue) : [];
        if (statement.columns().length) rows = statement.all(...values) as T[];
        else written += Number(statement.run(...values).changes);
      }
      return new Cursor(rows, written);
    };
    this.sql = { exec, get databaseSize() { return 0; } };
  }

  async get<T>(key: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(key)) {
      const found = new Map<string, T>();
      for (const one of key) {
        const value = this.read<T>(one);
        if (value !== undefined) found.set(one, value);
      }
      return found;
    }
    return this.read<T>(key);
  }

  private read<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM _kv WHERE key=?").get(key) as { value: Uint8Array } | undefined;
    return row ? deserialize(row.value) as T : undefined;
  }

  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    const entries = typeof key === "string" ? [[key, value] as const] : Object.entries(key);
    const statement = this.db.prepare("INSERT INTO _kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    this.transaction(() => { for (const [name, item] of entries) statement.run(name, serialize(item)); });
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    const keys = Array.isArray(key) ? key : [key];
    let removed = 0;
    for (const one of keys) removed += Number(this.db.prepare("DELETE FROM _kv WHERE key=?").run(one).changes);
    return Array.isArray(key) ? removed : removed > 0;
  }

  async list<T>(options: { prefix?: string } = {}): Promise<Map<string, T>> {
    const rows = this.db.prepare("SELECT key, value FROM _kv WHERE key >= ? ORDER BY key").all(options.prefix ?? "") as { key: string; value: Uint8Array }[];
    return new Map(rows.filter((row) => row.key.startsWith(options.prefix ?? "")).map((row) => [row.key, deserialize(row.value) as T]));
  }

  transaction<T>(work: () => T): T {
    this.db.exec("SAVEPOINT host_tx");
    try {
      const result = work();
      this.db.exec("RELEASE host_tx");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK TO host_tx; RELEASE host_tx");
      throw error;
    }
  }

  transactionSync<T>(work: () => T): T { return this.transaction(work); }
  async sync(): Promise<void> {}
  async setAlarm(): Promise<void> {}
  async getAlarm(): Promise<null> { return null; }
  async deleteAlarm(): Promise<void> {}
}
