// L3 — GEB
// Input: 构建快照 `/data/sponsors/v1.json`（ASSETS）、D1 来源层（爱发电／Patreon 同步行、Ko-fi 付款、公开留言与最近一笔公开付款的金额币种）、管理员覆盖层（含 `sponsor_amount`）与档位。
// Output: 公开名单 `GET /api/v1/sponsors`，个人金额只随随心档（无门槛档）的当前与过往赞助者输出；管理面板读取的来源值／覆盖值／生效值；条目、金额与档位的版本检查写入。
// Pos: [Map](L2.md)；赞助名单的来源同步、合并与持久化。
// Effects/Dependencies: 公开名单与管理面板都用请求的 ExecutionContext 读取 ASSETS／打包静态文档；新快照写入 `sponsor_source` 并为每个来源键登记 `sponsor_entry`，`masked` 来源清空名字与头像、条目不再显示（覆盖层也不恢复），离开的赞助者转为过往并保留名字与最后档位；写入提高 `sponsor_state.revision`，公开名单按 revision 与小时缓存。
import {
  SPONSOR_ACTIVE_SECONDS,
  SPONSOR_CARDS,
  SPONSOR_LOCALES,
  SPONSOR_MESSAGE_LENGTH,
  SPONSOR_NAME_LENGTH,
  SPONSOR_TIER_ID,
  fallbackSponsorTier,
  isFlexibleSponsorTier,
  isSponsorAvatar,
  isSponsorChannel,
  sponsorAmount,
  sponsorTier,
  type SponsorAmount,
  type SponsorChannel,
  type SponsorFeed,
  type SponsorTier,
} from "../src/config/sponsor";
import { serveStaticDocument } from "./static-documents";

const FEED = "/api/v1/sponsors";
const SNAPSHOT = "/data/sponsors/v1.json";
const SOURCE_KEY = /^(afdian|patreon):[a-f0-9]{32}$/u;
const ENTRY_ID = /^[a-f0-9]{32}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const BATCH = 90;

interface StateRow {
  revision: number;
  tiersVersion: number;
  sourceUpdatedAt: string | null;
  updatedAt: number;
}
interface TierRow {
  id: string;
  labels: string;
  cny: number;
  usd: number;
  card: string | null;
}
interface SourceRow {
  key: string;
  channel: "afdian" | "patreon";
  name: string;
  avatar: string | null;
  tier: string;
  active: number;
  firstAt: number;
  lastAt: number | null;
}
interface KofiRow {
  supporter: string;
  name: string;
  isPublic: number;
  amount: number;
  currency: string;
  tierName: string | null;
  subscription: number;
  paidAt: number;
  message: string | null;
}
interface EntryRow {
  id: string;
  sourceKey: string | null;
  channel: SponsorChannel | null;
  name: string | null;
  avatar: string | null;
  message: string | null;
  tier: string | null;
  status: "active" | "past" | null;
  firstAt: number | null;
  lastAt: number | null;
  hidden: number;
  version: number;
  updatedAt: number;
}
interface AmountRow {
  id: string;
  amount: string | null;
  currency: string | null;
}

/** What the platform says about one supporter. */
export interface SponsorSource {
  channel: SponsorChannel;
  name: string;
  avatar: string | null;
  message: string | null;
  tier: string;
  active: boolean;
  firstAt: number;
  lastAt: number | null;
  /** Ko-fi: the latest public payment. Other platforms leave it to administrators. */
  amount: SponsorAmount | null;
}
/** Fields an administrator set; `null` follows the source, `""` clears an avatar, message or amount. */
export interface SponsorOverrides {
  channel: SponsorChannel | null;
  name: string | null;
  avatar: string | null;
  message: string | null;
  tier: string | null;
  status: "active" | "past" | null;
  firstAt: number | null;
  lastAt: number | null;
  amount: SponsorAmount | "" | null;
}
interface Person {
  id: string;
  sourceChannel: SponsorChannel | null;
  channel: SponsorChannel;
  name: string;
  avatar: string | null;
  message: string | null;
  tier: string;
  active: boolean;
  firstAt: number;
  amount: SponsorAmount | null;
  hidden: boolean;
}
interface Model {
  state: StateRow;
  tiers: SponsorTier[];
  entries: EntryRow[];
  amounts: Map<string, SponsorAmount | "">;
  sources: Map<string, SponsorSource>;
}

const ENTRY_COLUMNS = `id, source_key AS sourceKey, channel, name, avatar, message, tier, status,
  first_at AS firstAt, last_at AS lastAt, hidden, version, updated_at AS updatedAt`;

const withinMonth = (seconds: number, now: number) => now - seconds <= SPONSOR_ACTIVE_SECONDS;

async function readState(env: Env): Promise<StateRow | null> {
  return env.DB.prepare(
    `SELECT revision, tiers_version AS tiersVersion, source_updated_at AS sourceUpdatedAt, updated_at AS updatedAt
     FROM sponsor_state WHERE id = 1`,
  ).first<StateRow>();
}

function tierValue(row: TierRow): SponsorTier {
  const labels = JSON.parse(row.labels) as Record<string, string>;
  return {
    id: row.id,
    labels: Object.fromEntries(SPONSOR_LOCALES.map((locale) => [locale, labels[locale] ?? ""])) as SponsorTier["labels"],
    cny: row.cny,
    usd: row.usd,
    card: row.card,
  };
}

/** A Ko-fi membership tier named after a site tier, the subscription amount reached, or the fallback tier. */
function kofiTier(tiers: readonly SponsorTier[], row: KofiRow): string {
  const named = row.tierName && tiers.find((tier) => row.tierName!.toLowerCase().includes(tier.id));
  if (named) return named.id;
  return row.subscription ? sponsorTier(tiers, row.amount, "USD") : (fallbackSponsorTier(tiers)?.id ?? "");
}

/** Ko-fi supporters by payment history; the latest payment carries their choice to be listed and its amount. */
function kofiSources(rows: readonly KofiRow[], tiers: readonly SponsorTier[], now: number): Map<string, SponsorSource> {
  const sources = new Map<string, SponsorSource & { listed: boolean }>();
  for (const row of rows) {
    const key = `kofi:${row.supporter}`;
    const known = sources.get(key);
    if (known) {
      known.firstAt = row.paidAt;
      if (known.listed && !known.message && row.isPublic && row.message) known.message = row.message;
      continue;
    }
    sources.set(key, {
      listed: row.isPublic === 1 && !!row.name,
      channel: "kofi",
      name: row.name,
      avatar: null,
      message: row.isPublic ? row.message : null,
      tier: kofiTier(tiers, row),
      active: withinMonth(row.paidAt, now),
      firstAt: row.paidAt,
      lastAt: row.paidAt,
      amount: row.isPublic ? sponsorAmount(String(row.amount), row.currency) : null,
    });
  }
  const listed = new Map<string, SponsorSource>();
  for (const [key, { listed: shown, ...source }] of sources) if (shown) listed.set(key, source);
  return listed;
}

async function readModel(env: Env): Promise<Model> {
  const [state, tiers, sources, kofi, entries, amounts] = await env.DB.batch([
    env.DB.prepare(
      `SELECT revision, tiers_version AS tiersVersion, source_updated_at AS sourceUpdatedAt, updated_at AS updatedAt
       FROM sponsor_state WHERE id = 1`,
    ),
    env.DB.prepare("SELECT id, labels, cny, usd, card FROM sponsor_tier ORDER BY sort_order, id"),
    env.DB.prepare(
      `SELECT source_key AS key, channel, name, avatar, tier, active, first_at AS firstAt, last_at AS lastAt
       FROM sponsor_source`,
    ),
    env.DB.prepare(
      `SELECT payment.supporter, payment.from_name AS name, payment.is_public AS isPublic, payment.amount,
              payment.currency, payment.tier_name AS tierName, payment.is_subscription AS subscription, payment.paid_at AS paidAt,
              message.message
       FROM kofi_payment AS payment
       LEFT JOIN kofi_payment_message AS message ON message.message_id = payment.message_id
       ORDER BY payment.paid_at DESC`,
    ),
    env.DB.prepare(`SELECT ${ENTRY_COLUMNS} FROM sponsor_entry`),
    env.DB.prepare("SELECT entry_id AS id, amount, currency FROM sponsor_amount"),
  ]);
  const stateRow = (state!.results as StateRow[])[0];
  if (!stateRow) throw new Error("Sponsor state is missing");
  const tierValues = (tiers!.results as TierRow[]).map(tierValue);
  const now = Math.floor(Date.now() / 1000);
  const sourceMap = kofiSources(kofi!.results as KofiRow[], tierValues, now);
  // An empty name is the platform's masked identity; like an unlisted Ko-fi supporter, the entry is not shown.
  for (const row of sources!.results as SourceRow[])
    if (row.name) sourceMap.set(row.key, {
      channel: row.channel,
      name: row.name,
      avatar: row.avatar,
      message: null,
      tier: row.tier,
      active: row.channel === "afdian" && row.lastAt !== null ? withinMonth(row.lastAt, now) : row.active === 1,
      firstAt: row.firstAt,
      lastAt: row.lastAt,
      amount: null,
    });
  const amountMap = new Map<string, SponsorAmount | "">(
    (amounts!.results as AmountRow[]).map((row) => [
      row.id,
      row.amount !== null && row.currency !== null ? { value: row.amount, currency: row.currency } : "",
    ]),
  );
  return { state: stateRow, tiers: tierValues, entries: entries!.results as EntryRow[], amounts: amountMap, sources: sourceMap };
}

function overridesOf(entry: EntryRow, amount: SponsorAmount | "" | undefined): SponsorOverrides {
  return {
    channel: entry.channel,
    name: entry.name,
    avatar: entry.avatar,
    message: entry.message,
    tier: entry.tier,
    status: entry.status,
    firstAt: entry.firstAt,
    lastAt: entry.lastAt,
    amount: amount ?? null,
  };
}

function person(
  entry: EntryRow,
  source: SponsorSource | undefined,
  amount: SponsorAmount | "" | undefined,
  tiers: readonly SponsorTier[],
  now: number,
): Person {
  const firstAt = entry.firstAt ?? source?.firstAt ?? 0;
  const lastAt = entry.lastAt ?? source?.lastAt ?? null;
  const tier = entry.tier ?? source?.tier;
  return {
    id: entry.id,
    sourceChannel: source?.channel ?? null,
    channel: entry.channel ?? source!.channel,
    name: entry.name ?? source?.name ?? "",
    avatar: (entry.avatar ?? source?.avatar) || null,
    message: (entry.message ?? source?.message) || null,
    tier: tiers.find((row) => row.id === tier)?.id ?? fallbackSponsorTier(tiers)?.id ?? "",
    active: entry.status
      ? entry.status === "active"
      : source && entry.lastAt === null
        ? source.active
        : withinMonth(lastAt ?? firstAt, now),
    firstAt,
    amount: amount === undefined ? (source?.amount ?? null) : amount || null,
    hidden: entry.hidden === 1,
  };
}

/** Every entry with its source, skipping registry rows whose supporter the platform does not list or lists masked. */
function people(model: Model): {
  entry: EntryRow;
  source: SponsorSource | undefined;
  amount: SponsorAmount | "" | undefined;
  person: Person;
}[] {
  const now = Math.floor(Date.now() / 1000);
  return model.entries
    .filter((entry) => !entry.sourceKey || model.sources.has(entry.sourceKey))
    .map((entry) => {
      const source = entry.sourceKey ? model.sources.get(entry.sourceKey) : undefined;
      const amount = model.amounts.get(entry.id);
      return { entry, source, amount, person: person(entry, source, amount, model.tiers, now) };
    })
    .sort((a, b) => a.person.firstAt - b.person.firstAt || a.person.name.localeCompare(b.person.name, "en"));
}

function feed(model: Model): SponsorFeed {
  const shown = people(model)
    .map((row) => row.person)
    .filter((row) => !row.hidden && row.name);
  // Amounts leave the Worker only for supporters, current or past, in a tier without thresholds.
  const flexible = new Set(model.tiers.filter(isFlexibleSponsorTier).map((tier) => tier.id));
  const display = ({ name, avatar, channel, message, tier, amount }: Person) => ({
    name,
    avatar,
    platform: channel,
    message,
    ...(amount && flexible.has(tier) ? { amount } : {}),
  });
  return {
    updatedAt: new Date(model.state.updatedAt).toISOString(),
    tiers: model.tiers,
    active: shown.filter((row) => row.active).map((row) => ({ ...display(row), tier: row.tier })),
    past: shown.filter((row) => !row.active).map(display),
  };
}

/** The Ko-fi part of the public list in the original `/api/v1/sponsors/kofi` shape. */
export async function kofiSponsorList(env: Env): Promise<{
  active: { name: string; tier: string; since: number }[];
  past: { name: string; since: number }[];
}> {
  const rows = people(await readModel(env))
    .map((row) => row.person)
    .filter((row) => row.sourceChannel === "kofi" && !row.hidden);
  const since = (seconds: number) => seconds - (seconds % 86_400);
  return {
    active: rows.filter((row) => row.active).map((row) => ({ name: row.name, tier: row.tier, since: since(row.firstAt) })),
    past: rows.filter((row) => !row.active).map((row) => ({ name: row.name, since: since(row.firstAt) })),
  };
}

type SnapshotRow = Omit<SourceRow, "active"> & { active: boolean };

/** Rows of a snapshot; `masked` holds keys whose supporter hid their identity, empty for snapshots written before it existed. */
function snapshotRows(value: unknown): {
  updatedAt: string;
  sources: ("afdian" | "patreon")[];
  rows: SnapshotRow[];
  masked: { key: string; channel: "afdian" | "patreon" }[];
} | null {
  const body = value as {
    updatedAt?: unknown;
    sources?: unknown;
    active?: Record<string, unknown>[];
    past?: Record<string, unknown>[];
    masked?: unknown;
  };
  if (typeof body?.updatedAt !== "string" || !Number.isFinite(Date.parse(body.updatedAt))) return null;
  const sources = (Array.isArray(body.sources) ? body.sources : []).filter(
    (channel): channel is "afdian" | "patreon" => channel === "afdian" || channel === "patreon",
  );
  const rows: SnapshotRow[] = [];
  for (const [list, active] of [
    [body.active, true],
    [body.past, false],
  ] as const) {
    for (const row of Array.isArray(list) ? list : []) {
      const key = typeof row.key === "string" ? SOURCE_KEY.exec(row.key) : null;
      if (!key || row.platform !== key[1] || typeof row.name !== "string" || !row.name) continue;
      rows.push({
        key: key[0],
        channel: key[1] as "afdian" | "patreon",
        name: row.name.slice(0, SPONSOR_NAME_LENGTH),
        avatar: typeof row.avatar === "string" && /^https:\/\//u.test(row.avatar) ? row.avatar : null,
        tier: typeof row.tier === "string" ? row.tier : "",
        active,
        firstAt: Number.isSafeInteger(row.since) ? (row.since as number) : 0,
        lastAt: Number.isSafeInteger(row.last) ? (row.last as number) : null,
      });
    }
  }
  const masked = (Array.isArray(body.masked) ? body.masked : []).flatMap((value) => {
    const key = typeof value === "string" ? SOURCE_KEY.exec(value) : null;
    return key && sources.includes(key[1] as "afdian" | "patreon")
      ? [{ key: key[0], channel: key[1] as "afdian" | "patreon" }]
      : [];
  });
  return { updatedAt: body.updatedAt, sources, rows, masked };
}

/** Completed, parsed snapshot data only; each miss reads with its own request's I/O. */
let snapshotMemo: { at: number; value: ReturnType<typeof snapshotRows> } | undefined;

/** The build's source snapshot from the asset binding, or the packed static document that carries it. */
async function readSnapshot(request: Request, env: Env, ctx: ExecutionContext): Promise<ReturnType<typeof snapshotRows>> {
  const startedAt = Date.now();
  if (snapshotMemo && startedAt - snapshotMemo.at < 300_000) return snapshotMemo.value;
  let value: ReturnType<typeof snapshotRows>;
  try {
    const url = new URL(SNAPSHOT, request.url);
    let response = await env.ASSETS.fetch(new Request(url));
    if (response.status === 404) {
      await response.body?.cancel();
      response = (await serveStaticDocument(new Request(url), env, ctx, SNAPSHOT)) ?? new Response(null, { status: 404 });
    }
    if (response.ok) value = snapshotRows(await response.json());
    else {
      await response.body?.cancel();
      value = null;
    }
  } catch (error) {
    // The list still serves the source layer already in D1.
    console.warn(JSON.stringify({ event: "sponsors.snapshot_unavailable", error: String(error) }));
    value = null;
  }
  // A read that started earlier than the cached one leaves the newer result in place.
  if (!snapshotMemo || snapshotMemo.at <= startedAt) snapshotMemo = { at: startedAt, value };
  return value;
}

/**
 * Copy a newer build snapshot into the source layer. Supporters a fully read platform no longer lists move to past
 * and keep their last name and tier; a masked supporter's name and avatar are cleared.
 */
async function syncSnapshot(request: Request, env: Env, state: StateRow, ctx: ExecutionContext): Promise<boolean> {
  const snapshot = await readSnapshot(request, env, ctx);
  if (!snapshot || (state.sourceUpdatedAt !== null && snapshot.updatedAt <= state.sourceUpdatedAt)) return false;
  const syncedAt = Date.parse(snapshot.updatedAt);
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (const row of snapshot.rows) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO sponsor_source (source_key, channel, name, avatar, tier, active, first_at, last_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_key) DO UPDATE SET
           name = excluded.name, avatar = excluded.avatar,
           tier = CASE WHEN excluded.active = 1 OR sponsor_source.tier = '' THEN excluded.tier ELSE sponsor_source.tier END,
           active = excluded.active,
           first_at = MIN(sponsor_source.first_at, excluded.first_at),
           last_at = COALESCE(excluded.last_at, sponsor_source.last_at), synced_at = excluded.synced_at
         WHERE sponsor_source.synced_at <= excluded.synced_at`,
      ).bind(row.key, row.channel, row.name, row.avatar, row.tier, row.active ? 1 : 0, row.firstAt, row.lastAt, syncedAt),
      env.DB.prepare(
        "INSERT OR IGNORE INTO sponsor_entry (id, source_key, created_at, updated_at) VALUES (?, ?, ?, ?)",
      ).bind(crypto.randomUUID().replaceAll("-", ""), row.key, now, now),
    );
  }
  for (const { key, channel } of snapshot.masked)
    statements.push(
      env.DB.prepare(
        `INSERT INTO sponsor_source (source_key, channel, name, avatar, tier, active, first_at, last_at, synced_at)
         VALUES (?, ?, '', NULL, '', 0, ?, NULL, ?)
         ON CONFLICT (source_key) DO UPDATE SET name = '', avatar = NULL, synced_at = excluded.synced_at
         WHERE sponsor_source.synced_at <= excluded.synced_at`,
      ).bind(key, channel, Math.floor(syncedAt / 1000), syncedAt),
    );
  for (const channel of snapshot.sources)
    statements.push(
      env.DB.prepare("UPDATE sponsor_source SET active = 0 WHERE channel = ? AND synced_at < ?").bind(channel, syncedAt),
    );
  statements.push(
    env.DB.prepare(
      `UPDATE sponsor_state SET source_updated_at = ?, revision = revision + 1, updated_at = ?
       WHERE id = 1 AND (source_updated_at IS NULL OR source_updated_at < ?)`,
    ).bind(snapshot.updatedAt, now, snapshot.updatedAt),
  );
  for (let start = 0; start < statements.length; start += BATCH) await env.DB.batch(statements.slice(start, start + BATCH));
  return true;
}

const feedHeaders = (etag: string) => ({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, no-cache",
  ETag: etag,
  "X-Content-Type-Options": "nosniff",
});

/** `GET /api/v1/sponsors`. Each revision and hour has its own cache entry, so edits show on the next request. */
export async function handleSponsorFeedRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== FEED || request.method === "OPTIONS") return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json; charset=utf-8", Allow: "GET, HEAD", "Cache-Control": "no-store" },
    });
  let state = await readState(env);
  if (!state)
    return new Response(JSON.stringify({ error: "sponsors_unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  if (await syncSnapshot(request, env, state, ctx)) state = (await readState(env))!;
  const hour = Math.floor(Date.now() / 3_600_000);
  const etag = `W/"sponsors-${state.revision}-${hour}"`;
  if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: feedHeaders(etag) });
  const cacheKey = new Request(`${url.origin}${FEED}?revision=${state.revision}&hour=${hour}`);
  const cached = await caches.default.match(cacheKey);
  let body: string;
  if (cached) body = await cached.text();
  else {
    body = JSON.stringify(feed(await readModel(env)));
    ctx.waitUntil(
      caches.default.put(
        cacheKey,
        new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600" } }),
      ),
    );
  }
  return new Response(request.method === "HEAD" ? null : body, { headers: feedHeaders(etag) });
}

/** Ko-fi webhook side: register the supporter and publish the change. */
export function kofiSponsorStatements(env: Env, supporter: string, messageId: string, message: string | null): D1PreparedStatement[] {
  const now = Date.now();
  return [
    ...(message
      ? [env.DB.prepare("INSERT OR IGNORE INTO kofi_payment_message (message_id, message) VALUES (?, ?)").bind(messageId, message)]
      : []),
    env.DB.prepare("INSERT OR IGNORE INTO sponsor_entry (id, source_key, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(
      crypto.randomUUID().replaceAll("-", ""),
      `kofi:${supporter}`,
      now,
      now,
    ),
    env.DB.prepare("UPDATE sponsor_state SET revision = revision + 1, updated_at = ? WHERE id = 1").bind(now),
  ];
}

/** Supporter text as stored: NFC, line breaks kept, other control characters removed. */
export const sponsorPlainText = (value: string): string =>
  value
    .normalize("NFC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/gu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

/* ---- Administration ---- */

export interface SponsorAdminEntry {
  id: string;
  origin: "manual" | "source";
  source: SponsorSource | null;
  overrides: SponsorOverrides;
  effective: Omit<Person, "id" | "hidden" | "sourceChannel">;
  hidden: boolean;
  version: number;
  updatedAt: number;
}
export interface SponsorAdminDocument {
  revision: number;
  tiersVersion: number;
  sourceUpdatedAt: string | null;
  tiers: SponsorTier[];
  entries: SponsorAdminEntry[];
}

export async function readSponsorAdmin(request: Request, env: Env, ctx: ExecutionContext): Promise<SponsorAdminDocument> {
  const state = await readState(env);
  if (state) await syncSnapshot(request, env, state, ctx);
  const model = await readModel(env);
  return {
    revision: model.state.revision,
    tiersVersion: model.state.tiersVersion,
    sourceUpdatedAt: model.state.sourceUpdatedAt,
    tiers: model.tiers,
    entries: people(model).map(({ entry, source, amount, person: row }) => ({
      id: entry.id,
      origin: entry.sourceKey ? "source" : "manual",
      source: source ?? null,
      overrides: overridesOf(entry, amount),
      effective: {
        channel: row.channel,
        name: row.name,
        avatar: row.avatar,
        message: row.message,
        tier: row.tier,
        active: row.active,
        firstAt: row.firstAt,
        amount: row.amount,
      },
      hidden: row.hidden,
      version: entry.version,
      updatedAt: entry.updatedAt,
    })),
  };
}

type FieldName = Exclude<keyof SponsorOverrides, "amount">;
const COLUMNS: Record<FieldName, string> = {
  channel: "channel",
  name: "name",
  avatar: "avatar",
  message: "message",
  tier: "tier",
  status: "status",
  firstAt: "first_at",
  lastAt: "last_at",
};
const REQUIRED_MANUAL: readonly FieldName[] = ["channel", "name", "firstAt"];
/** Column changes, plus the amount and currency, which are always written together. */
export type SponsorFieldChanges = Partial<Record<FieldName, string | number | null>> & {
  amount?: SponsorAmount | "" | null;
};

/**
 * Field changes from a request: a missing key keeps the stored value, `null` follows the source again,
 * `amount: ""` publishes no amount and `amount: { value, currency }` sets both.
 * Returns the invalid field names when any value is unusable.
 */
export async function parseSponsorFields(
  env: Env,
  value: unknown,
  manual: boolean,
): Promise<{ fields: SponsorFieldChanges } | { invalid: string[] }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { invalid: ["fields"] };
  const input = value as Record<string, unknown>;
  const fields: SponsorFieldChanges = {};
  const invalid: string[] = [];
  const tiers = "tier" in input && typeof input.tier === "string"
    ? (await env.DB.prepare("SELECT id FROM sponsor_tier").all<{ id: string }>()).results.map((row) => row.id)
    : [];
  for (const key of Object.keys(COLUMNS) as FieldName[]) {
    if (!(key in input)) continue;
    const raw = input[key];
    if (raw === null) {
      if (manual && REQUIRED_MANUAL.includes(key)) invalid.push(key);
      else fields[key] = null;
      continue;
    }
    if (typeof raw !== "string") {
      invalid.push(key);
      continue;
    }
    if (key === "name") {
      const text = sponsorPlainText(raw).replace(/\n/gu, " ");
      if (text && [...text].length <= SPONSOR_NAME_LENGTH) fields.name = text;
      else invalid.push(key);
    } else if (key === "message") {
      const text = sponsorPlainText(raw);
      if ([...text].length <= SPONSOR_MESSAGE_LENGTH) fields.message = text;
      else invalid.push(key);
    } else if (key === "avatar") {
      const url = raw.trim();
      if (isSponsorAvatar(url)) fields.avatar = url;
      else invalid.push(key);
    } else if (key === "channel") {
      if (isSponsorChannel(raw)) fields.channel = raw;
      else invalid.push(key);
    } else if (key === "tier") {
      if (tiers.includes(raw)) fields.tier = raw;
      else invalid.push(key);
    } else if (key === "status") {
      if (raw === "active" || raw === "past") fields.status = raw;
      else invalid.push(key);
    } else {
      const seconds = DATE.test(raw) ? Date.parse(`${raw}T00:00:00Z`) / 1000 : Number.NaN;
      if (Number.isSafeInteger(seconds) && seconds > 0) fields[key] = seconds;
      else invalid.push(key);
    }
  }
  if ("amount" in input) {
    const raw = input.amount as { value?: unknown; currency?: unknown } | null | "";
    if (raw === null || raw === "") fields.amount = raw;
    else {
      const amount =
        raw && typeof raw === "object" && typeof raw.value === "string" && typeof raw.currency === "string"
          ? sponsorAmount(raw.value, raw.currency)
          : null;
      if (amount) fields.amount = amount;
      else invalid.push("amount");
    }
  }
  return invalid.length ? { invalid } : { fields };
}

export const isSponsorEntryId = (value: string) => ENTRY_ID.test(value);

const revisionBump = (env: Env, now: number) =>
  env.DB.prepare("UPDATE sponsor_state SET revision = revision + 1, updated_at = ? WHERE id = 1").bind(now);

export async function sponsorEntryOrigin(env: Env, id: string): Promise<"manual" | "source" | null> {
  const row = await env.DB.prepare("SELECT source_key AS sourceKey FROM sponsor_entry WHERE id = ?")
    .bind(id)
    .first<{ sourceKey: string | null }>();
  return row ? (row.sourceKey ? "source" : "manual") : null;
}

const columnKeys = (fields: SponsorFieldChanges) => (Object.keys(fields) as (FieldName | "amount")[]).filter(
  (key): key is FieldName => key !== "amount",
);

/** Create a hand-entered supporter. Replays of the same id leave the first one in place. */
export async function createSponsorEntry(env: Env, id: string, fields: SponsorFieldChanges): Promise<void> {
  const now = Date.now();
  const keys = columnKeys(fields);
  const amount = fields.amount;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO sponsor_entry (id, ${keys.map((key) => COLUMNS[key]).join(", ")}, created_at, updated_at)
       VALUES (?, ${keys.map(() => "?").join(", ")}, ?, ?)`,
    ).bind(id, ...keys.map((key) => fields[key] ?? null), now, now),
    // Only the insert above owns the amount; a replay finds an older created_at.
    ...(amount
      ? [
          env.DB.prepare(
            `INSERT OR IGNORE INTO sponsor_amount (entry_id, amount, currency, updated_at)
             SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sponsor_entry WHERE id = ? AND created_at = ?)`,
          ).bind(id, amount.value, amount.currency, now, id, now),
        ]
      : []),
    revisionBump(env, now),
  ]);
}

/** The amount change, applied only while the entry still has the expected version. */
function amountStatement(env: Env, id: string, version: number, amount: SponsorAmount | "" | null, now: number) {
  const current = "EXISTS (SELECT 1 FROM sponsor_entry WHERE id = ? AND version = ?)";
  if (amount === null)
    return env.DB.prepare(`DELETE FROM sponsor_amount WHERE entry_id = ? AND ${current}`).bind(id, id, version);
  return env.DB.prepare(
    `INSERT INTO sponsor_amount (entry_id, amount, currency, updated_at)
     SELECT ?, ?, ?, ? WHERE ${current}
     ON CONFLICT (entry_id) DO UPDATE SET
       amount = excluded.amount, currency = excluded.currency, updated_at = excluded.updated_at`,
  ).bind(id, amount ? amount.value : null, amount ? amount.currency : null, now, id, version);
}

export async function updateSponsorEntry(
  env: Env,
  id: string,
  version: number,
  fields: SponsorFieldChanges,
  hidden: boolean | undefined,
): Promise<"ok" | "conflict"> {
  const now = Date.now();
  const keys = columnKeys(fields);
  const assignments = [...keys.map((key) => `${COLUMNS[key]} = ?`), ...(hidden === undefined ? [] : ["hidden = ?"])];
  const amount = fields.amount === undefined ? [] : [amountStatement(env, id, version, fields.amount, now)];
  const results = await env.DB.batch([
    ...amount,
    env.DB.prepare(
      `UPDATE sponsor_entry SET ${[...assignments, "version = version + 1", "updated_at = ?"].join(", ")}
       WHERE id = ? AND version = ?`,
    ).bind(
      ...keys.map((key) => fields[key] ?? null),
      ...(hidden === undefined ? [] : [hidden ? 1 : 0]),
      now,
      id,
      version,
    ),
    revisionBump(env, now),
  ]);
  return Number(results[amount.length]!.meta.changes || 0) === 1 ? "ok" : "conflict";
}

/** Remove a hand-entered supporter. Synchronized supporters are hidden instead, which keeps their tombstone. */
export async function deleteSponsorEntry(env: Env, id: string, version: number): Promise<"ok" | "conflict"> {
  const now = Date.now();
  const [removed] = await env.DB.batch([
    env.DB.prepare("DELETE FROM sponsor_entry WHERE id = ? AND version = ? AND source_key IS NULL RETURNING id").bind(
      id,
      version,
    ),
    revisionBump(env, now),
  ]);
  // meta.changes also counts the cascaded sponsor_amount row; RETURNING lists only the matched entry.
  return removed!.results.length === 1 ? "ok" : "conflict";
}

export function parseSponsorTiers(value: unknown): SponsorTier[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return null;
  const tiers: SponsorTier[] = [];
  for (const raw of value as Record<string, unknown>[]) {
    const labels = raw?.labels as Record<string, unknown> | undefined;
    if (
      !raw ||
      typeof raw.id !== "string" ||
      !SPONSOR_TIER_ID.test(raw.id) ||
      tiers.some((tier) => tier.id === raw.id) ||
      !labels ||
      typeof labels !== "object" ||
      !SPONSOR_LOCALES.every((locale) => {
        const label = labels[locale];
        return typeof label === "string" && label.trim().length > 0 && [...label.trim()].length <= 40;
      }) ||
      typeof raw.cny !== "number" ||
      typeof raw.usd !== "number" ||
      !(raw.cny >= 0 && raw.cny <= 100_000 && raw.usd >= 0 && raw.usd <= 100_000) ||
      !(raw.card === null || SPONSOR_CARDS.includes(raw.card as (typeof SPONSOR_CARDS)[number]))
    )
      return null;
    tiers.push({
      id: raw.id,
      labels: Object.fromEntries(
        SPONSOR_LOCALES.map((locale) => [locale, sponsorPlainText(String(labels[locale])).replace(/\n/gu, " ")]),
      ) as SponsorTier["labels"],
      cny: raw.cny,
      usd: raw.usd,
      card: raw.card as string | null,
    });
  }
  return tiers;
}

/** Replace the tier list in one transaction when `tiersVersion` still matches. */
export async function replaceSponsorTiers(env: Env, version: number, tiers: readonly SponsorTier[]): Promise<"ok" | "conflict"> {
  const now = Date.now();
  const token = crypto.randomUUID();
  const owned = "(SELECT write_token FROM sponsor_state WHERE id = 1) = ?";
  const [claimed] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE sponsor_state SET tiers_version = tiers_version + 1, revision = revision + 1, write_token = ?, updated_at = ?
       WHERE id = 1 AND tiers_version = ?`,
    ).bind(token, now, version),
    env.DB.prepare(`DELETE FROM sponsor_tier WHERE ${owned}`).bind(token),
    ...tiers.map((tier, index) =>
      env.DB.prepare(
        `INSERT INTO sponsor_tier (id, labels, sort_order, cny, usd, card) SELECT ?, ?, ?, ?, ?, ? WHERE ${owned}`,
      ).bind(tier.id, JSON.stringify(tier.labels), index, tier.cny, tier.usd, tier.card, token),
    ),
  ]);
  return Number(claimed!.meta.changes || 0) === 1 ? "ok" : "conflict";
}
