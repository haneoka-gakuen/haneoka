// L3 — GEB
// Input: Authenticated Cloudflare account/database IDs and local pinned gacha catalog files.
// Output: Private reconciliation snapshot and an aggregate plan; --apply atomically combines proven accounts.
// Pos: [Map](L2-2.md); one-time maintenance for legacy gacha-history account identities.
// Effects/Dependencies: Reads remote D1; --apply preserves originals and writes owner-scoped aliases with revision guards.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { matchingHistoryGroups, mergeAccountHistories, historyMatchCards } from "../../src/lib/gacha-history-merge.ts";
import {
  HISTORY_CLOUD_SCHEMA,
  HISTORY_CLOUD_BYTES,
  parseStoredCloudHistory,
} from "../../src/lib/gacha-history-cloud-data.ts";
import type { HistoryRegion } from "@haneoka/game-data-exporter/gacha-history";

const { values } = parseArgs({
  options: {
    "account-id": { type: "string" },
    "database-id": { type: "string" },
    "catalog-intl": { type: "string" },
    "catalog-jp": { type: "string" },
    output: { type: "string" },
    apply: { type: "boolean", default: false },
  },
});
if (!values["account-id"] || !values["database-id"] || !values["catalog-intl"] || !values.output)
  throw new Error(
    "Provide --account-id, --database-id, --catalog-intl and a private --output directory; --apply enables writes",
  );
if (!/^[a-f0-9]{32}$/u.test(values["account-id"]) || !/^[a-f0-9-]{36}$/u.test(values["database-id"]))
  throw new Error("Invalid Cloudflare target");
const require = createRequire(import.meta.url);
const cli = resolve(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
const auth = spawnSync(process.execPath, [cli, "auth", "token", "--json"], {
  encoding: "utf8",
  env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
if (auth.status !== 0) throw new Error("Wrangler authentication failed");
const credentials = JSON.parse(auth.stdout) as { token?: string };
if (!credentials.token) throw new Error("Wrangler did not supply a token");
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${values["account-id"]}/d1/database/${values["database-id"]}/query`;
async function query<T>(sql: string, params: Array<string | number | null> = []): Promise<T[]> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${credentials.token}`, "content-type": "application/json" },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await response.json()) as {
    success?: boolean;
    result?: Array<{ success?: boolean; results: T[] }>;
    errors?: Array<{ message: string }>;
  };
  if (!response.ok || !body.success || body.result?.some((row) => !row.success)) {
    const conflict = body.errors?.some((error) => error.message.includes("history_merge_conflict"));
    throw new Error(
      conflict ? "history_merge_conflict: rerun with a fresh snapshot" : `D1 query failed (${response.status})`,
    );
  }
  return body.result?.flatMap((row) => row.results) ?? [];
}
async function catalog(path: string | undefined): Promise<{ prizes?: unknown }> {
  if (!path) return {};
  const raw = JSON.parse(await readFile(path, "utf8"));
  return raw.value?.history ?? raw.history ?? raw;
}
const cards = historyMatchCards({
  intl: await catalog(values["catalog-intl"]),
  jp: await catalog(values["catalog-jp"]),
});
interface Row {
  userId: string;
  key: string;
  server: HistoryRegion;
  revision: number;
  historyJson: string;
  updatedAt: number;
}
const rows =
  await query<Row>(`SELECT user_id AS userId, account_key AS key, server, revision, history_json AS historyJson, updated_at AS updatedAt
  FROM account_gacha_history h WHERE NOT EXISTS (SELECT 1 FROM account_gacha_history_alias a WHERE a.user_id = h.user_id AND a.alias_key = h.account_key)`);
const output = resolve(values.output);
await mkdir(output, { recursive: true, mode: 0o700 });
await chmod(output, 0o700);
const receipt = resolve(output, `gacha-${Date.now()}`);
await writeFile(`${receipt}-before.json`, JSON.stringify(rows), { mode: 0o600, flag: "wx" });
const owners = new Map<string, Row[]>();
for (const row of rows) {
  const group = owners.get(row.userId) ?? [];
  group.push(row);
  owners.set(row.userId, group);
}
const plans: Array<{
  ownerId: string;
  canonical: string;
  sources: Array<{ accountKey: string; revision: number }>;
  historyJson: string;
  before: number[];
  after: number;
}> = [];
for (const [ownerId, accounts] of owners) {
  const records = accounts.map((row) => ({
    key: row.key,
    ownerId,
    histories: parseStoredCloudHistory(JSON.parse(row.historyJson), row.key, row.server).histories,
  }));
  for (const keys of matchingHistoryGroups(records, cards)) {
    const selected = records.filter((row) => keys.includes(row.key)).sort((a, b) => a.key.localeCompare(b.key));
    const canonical = selected[0]!.key,
      histories = mergeAccountHistories(selected, canonical);
    const historyJson = JSON.stringify({ schema: HISTORY_CLOUD_SCHEMA, histories });
    if (Buffer.byteLength(historyJson) > HISTORY_CLOUD_BYTES) throw new Error("Merged history exceeds cloud budget");
    parseStoredCloudHistory(JSON.parse(historyJson), canonical, histories[0]!.source.server);
    plans.push({
      ownerId,
      canonical,
      sources: keys.map((accountKey) => ({
        accountKey,
        revision: accounts.find((row) => row.key === accountKey)!.revision,
      })),
      historyJson,
      before: selected.map((row) => row.histories.reduce((n, history) => n + history.batches.length, 0)),
      after: histories.reduce((n, history) => n + history.batches.length, 0),
    });
  }
}
await writeFile(`${receipt}-plan.json`, JSON.stringify(plans), { mode: 0o600, flag: "wx" });
console.log(
  JSON.stringify({
    mode: values.apply ? "apply" : "plan",
    accounts: rows.length,
    groups: plans.length,
    absorbed: plans.reduce((n, plan) => n + plan.sources.length - 1, 0),
    batches: plans.map((plan) => ({ before: plan.before, after: plan.after })),
  }),
);
if (values.apply) {
  for (const plan of plans) {
    await query(
      `INSERT INTO account_gacha_history_combine(id, user_id, canonical_key, sources_json, history_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [randomUUID(), plan.ownerId, plan.canonical, JSON.stringify(plan.sources), plan.historyJson, Date.now()],
    );
    const [current] = await query<{ historyJson: string }>(
      "SELECT history_json AS historyJson FROM account_gacha_history WHERE user_id = ? AND account_key = ?",
      [plan.ownerId, plan.canonical],
    );
    if (current?.historyJson !== plan.historyJson)
      throw new Error("History changed during verification; rerun from a fresh snapshot");
  }
  const counts = await query<{ canonical: number; aliases: number; originals: number; pending: number }>(`SELECT
    (SELECT COUNT(*) FROM account_gacha_history h WHERE NOT EXISTS (SELECT 1 FROM account_gacha_history_alias a WHERE a.user_id = h.user_id AND a.alias_key = h.account_key)) AS canonical,
    (SELECT COUNT(*) FROM account_gacha_history_alias) AS aliases, (SELECT COUNT(*) FROM account_gacha_history_original) AS originals,
    (SELECT COUNT(*) FROM account_gacha_history_combine) AS pending`);
  await writeFile(`${receipt}-result.json`, JSON.stringify(counts), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ applied: plans.length, ...counts[0] }));
}
