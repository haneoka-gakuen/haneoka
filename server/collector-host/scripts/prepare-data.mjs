// L3 — GEB
// Input: A D1 export of the official tables, their schema rows, and optionally each region's exported object state.
// Output: The collector host's data directory: official.sqlite and objects/<region>.sqlite.
// Pos: [Map](../../L2.md); one-time move onto the collector host, and its rebuild from D1.
// Effects/Dependencies: Writes the directory given as --out; reads local files only.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { serialize } from "node:v8";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  dump: { type: "string" }, schema: { type: "string" }, state: { type: "string", multiple: true }, out: { type: "string" },
} });
if (!values.dump || !values.schema || !values.out) {
  console.error("usage: prepare-data.mjs --dump official.sql --schema schema.json --out DIR [--state jp=jp.json ...]");
  process.exit(2);
}

mkdirSync(join(values.out, "objects"), { recursive: true });
const officialPath = join(values.out, "official.sqlite");
for (const suffix of ["", "-wal", "-shm"]) rmSync(officialPath + suffix, { force: true });
const official = new DatabaseSync(officialPath);
official.exec("PRAGMA journal_mode=WAL");
official.exec(readFileSync(values.dump, "utf8"));
// D1's export carries tables and rows; indexes and triggers come from its schema rows.
const schema = JSON.parse(readFileSync(values.schema, "utf8"));
const rows = (Array.isArray(schema) ? schema[0].results : schema.results ?? schema).filter((row) => row.sql);
let indexes = 0, triggers = 0;
for (const row of rows) {
  if (/^CREATE (UNIQUE )?INDEX/u.test(row.sql)) {
    official.exec(row.sql.replace(/^CREATE (UNIQUE )?INDEX /u, (match) => `${match}IF NOT EXISTS `));
    indexes++;
  } else if (row.sql.startsWith("CREATE TRIGGER")) {
    official.exec(row.sql.replace(/^CREATE TRIGGER /u, "CREATE TRIGGER IF NOT EXISTS "));
    triggers++;
  }
}
official.close();
console.log(JSON.stringify({ official: officialPath, indexes, triggers }));

for (const entry of values.state ?? []) {
  const [region, file] = entry.split("=");
  const state = JSON.parse(readFileSync(file, "utf8"));
  const path = join(values.out, "objects", `${region}.sqlite`);
  if (existsSync(path)) rmSync(path);
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE _kv (key TEXT PRIMARY KEY, value BLOB NOT NULL) WITHOUT ROWID;
    CREATE TABLE container_schedules (id TEXT PRIMARY KEY NOT NULL, callback TEXT NOT NULL, payload TEXT, type TEXT NOT NULL DEFAULT 'scheduled',
      time INTEGER NOT NULL, delayInSeconds INTEGER, cron TEXT, created_at INTEGER DEFAULT (unixepoch()));
    CREATE TABLE collector_window_cache (window_key TEXT PRIMARY KEY, attempted_at_ms INTEGER NOT NULL, snapshot_id TEXT NOT NULL,
      observation_json TEXT, retained INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE collector_window_replies (snapshot_id TEXT PRIMARY KEY, expires_at_ms INTEGER NOT NULL, update_hash TEXT NOT NULL, body_json TEXT NOT NULL);`);
  const put = db.prepare("INSERT INTO _kv (key,value) VALUES (?,?)");
  for (const [key, value] of Object.entries(state.storage ?? {})) put.run(key, serialize(value));
  const copied = {};
  for (const [table, list] of Object.entries(state.tables ?? {})) {
    const columns = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((column) => column.name));
    for (const row of list) {
      const names = Object.keys(row).filter((name) => columns.has(name));
      db.prepare(`INSERT OR REPLACE INTO "${table}" (${names.map((name) => `"${name}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`)
        .run(...names.map((name) => row[name]));
    }
    copied[table] = list.length;
  }
  db.close();
  console.log(JSON.stringify({ region, keys: Object.keys(state.storage ?? {}), copied }));
}
