// L3 — GEB
// Input: Validated platform account input, a dedicated encryption key and private D1 storage.
// Output: Encrypted passwords, scoped SDK identities/owners, conflict resolution, shared SDK/role sessions, versioned removal and redacted state.
// Pos: [Map](L2.md); platform identity storage alongside the regional collector pool.
// Effects/Dependencies: D1 and AES-GCM; owner resolution atomically retires old sessions through a database trigger; no SDK/game requests.
import { normalizeOfficialPlayerId, parseOfficialCollectorConfiguration } from "../src/lib/official-ranking";
import { globalLoginConfiguration } from "./official-account-jobs";

export interface OfficialPlatformBindings {
  DB: D1Database;
  OFFICIAL_ACCOUNT_ENCRYPTION_KEY?: string;
}

export class AccountVaultUnavailable extends Error {
  constructor() { super("account_vault_unavailable"); }
}

export interface PlatformAccountInput { label: string; email: string; password: string }

export function parsePlatformAccount(value: Record<string, unknown>): PlatformAccountInput | null {
  const { email, password } = value;
  const label = value.label ?? (typeof email === "string" ? email.split("@")[0]!.slice(0, 100) : "");
  if (typeof label !== "string" || !label.trim() || label.length > 100
    || typeof email !== "string" || email.length > 254 || !/^[^\s@]+@[^\s@]+$/u.test(email.trim())
    || typeof password !== "string" || !password.length || password.length > 1024) return null;
  return { label: label.trim(), email: email.trim(), password };
}

export interface PlatformAccountUpdate { label: string; expectedVersion: number; password?: string }

export function parsePlatformAccountUpdate(value: Record<string, unknown>): PlatformAccountUpdate | null {
  const { label, expectedVersion, password } = value;
  if (typeof label !== "string" || !label.trim() || label.length > 100
    || typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1
    || password !== undefined && (typeof password !== "string" || !password.length || password.length > 1024)) return null;
  return { label: label.trim(), expectedVersion, ...(password === undefined ? {} : { password: password as string }) };
}

export async function vaultKey(env: OfficialPlatformBindings): Promise<CryptoKey> {
  const encoded = env.OFFICIAL_ACCOUNT_ENCRYPTION_KEY;
  if (!encoded || !/^[A-Za-z0-9+/]{43}=$/u.test(encoded)) throw new AccountVaultUnavailable();
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
const context = (id: string, email: string) => new TextEncoder().encode(JSON.stringify(["official-platform-password/1", id, email]));

async function sealPassword(env: OfficialPlatformBindings, id: string, email: string, password: string): Promise<string> {
  const key = await vaultKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: context(id, email) }, key,
    new TextEncoder().encode(password));
  return `v1.${encode(iv)}.${encode(new Uint8Array(encrypted))}`;
}

async function openPassword(env: OfficialPlatformBindings, id: string, email: string, box: string): Promise<string> {
  const [version, nonce, body] = box.split(".");
  if (version !== "v1" || !nonce || !body) throw new Error("account_password_format");
  const key = await vaultKey(env);
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(nonce), additionalData: context(id, email) }, key, decode(body));
  return new TextDecoder().decode(clear);
}

export async function createPlatformAccount(env: OfficialPlatformBindings, id: string, input: PlatformAccountInput): Promise<boolean> {
  const box = await sealPassword(env, id, input.email, input.password);
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO official_platform_accounts (id,label,email,password_box,created_at_ms)
      VALUES (?,?,?,?,?) ON CONFLICT(email) DO NOTHING`).bind(id, input.label, input.email, box, Date.now()),
    ...["tw", "en", "kr"].map((region) => env.DB.prepare(`INSERT INTO official_platform_roles (account_id,region)
      SELECT id,? FROM official_platform_accounts WHERE id=? ON CONFLICT(account_id,region) DO NOTHING`).bind(region, id)),
  ]);
  return result[0]!.meta.changes === 1;
}

export async function updatePlatformAccount(env: OfficialPlatformBindings, id: string, input: PlatformAccountUpdate): Promise<"ok" | "account_not_found" | "version_conflict"> {
  const row = await env.DB.prepare("SELECT email,version FROM official_platform_accounts WHERE id=?")
    .bind(id).first<{ email: string; version: number }>();
  if (!row) return "account_not_found";
  if (row.version !== input.expectedVersion) return "version_conflict";
  const box = input.password === undefined ? null : await sealPassword(env, id, row.email, input.password);
  const statements = box === null ? [] : [env.DB.prepare(`UPDATE official_platform_roles
    SET credential_box=NULL,last_verified_at_ms=NULL,last_error_code=NULL,
      status=CASE WHEN player_id IS NULL THEN 'not_initialized' ELSE 'auth_required' END
    WHERE account_id=? AND EXISTS (SELECT 1 FROM official_platform_accounts WHERE id=? AND version=?)`)
    .bind(id, id, input.expectedVersion)];
  if (box !== null) statements.push(env.DB.prepare(`DELETE FROM official_platform_sdk_sessions
    WHERE account_id=? AND EXISTS (SELECT 1 FROM official_platform_accounts WHERE id=? AND version=?)`)
    .bind(id, id, input.expectedVersion));
  statements.push(env.DB.prepare(`UPDATE official_platform_accounts SET label=?,password_box=COALESCE(?,password_box),version=version+1
    WHERE id=? AND version=?`).bind(input.label, box, id, input.expectedVersion));
  const results = await env.DB.batch(statements);
  return results.at(-1)!.meta.changes === 1 ? "ok" : "version_conflict";
}

export async function listPlatformAccounts(env: OfficialPlatformBindings) {
  const { results } = await env.DB.prepare(`SELECT a.id,a.label,a.email,a.version,a.created_at_ms AS createdAtMs,
    r.region,CASE WHEN r.status IN ('auth_required','not_initialized') AND EXISTS (
      SELECT 1 FROM official_platform_login_batches AS b WHERE b.account_id=a.id AND b.account_version=a.version AND b.deadline_ms>?
    ) THEN 'queued' WHEN r.status='authenticating' AND NOT EXISTS (
      SELECT 1 FROM official_platform_login_jobs AS j WHERE j.account_id=a.id AND j.region=r.region
        AND j.account_version=a.version AND j.status='running' AND j.deadline_ms>?
    ) THEN 'auth_uncertain' ELSE r.status END AS status,
    r.player_id AS playerId,r.last_verified_at_ms AS lastVerifiedAtMs,r.last_error_code AS lastErrorCode
    FROM official_platform_accounts AS a JOIN official_platform_roles AS r ON r.account_id=a.id
    ORDER BY a.created_at_ms,a.id,r.region`).bind(Date.now(), Date.now()).all<{
      id: string; label: string; email: string; version: number; createdAtMs: number;
      region: string; status: string; playerId: string | null; lastVerifiedAtMs: number | null; lastErrorCode: string | null;
    }>();
  return results;
}

export async function removePlatformAccount(env: OfficialPlatformBindings, id: string, version: number) {
  const result = await env.DB.prepare("DELETE FROM official_platform_accounts WHERE id=? AND version=? RETURNING id")
    .bind(id, version).first<{ id: string }>();
  return result !== null;
}

export async function readRemovedPlayerIds(env: OfficialPlatformBindings, region: string): Promise<Set<string>> {
  const { results } = await env.DB.prepare("SELECT player_id AS id FROM official_collector_removed_players WHERE region=?")
    .bind(region).all<{ id: string }>();
  return new Set(results.map((row) => normalizeOfficialPlayerId(row.id)));
}

export async function readPlatformPassword(env: OfficialPlatformBindings, id: string): Promise<{ email: string; password: string } | null> {
  const row = await env.DB.prepare("SELECT email,password_box FROM official_platform_accounts WHERE id=?")
    .bind(id).first<{ email: string; password_box: string }>();
  if (!row) return null;
  return { email: row.email, password: await openPassword(env, id, row.email, row.password_box) };
}

export type PlatformRegion = "tw" | "en" | "kr";
export interface PlatformLoginLease {
  accountId: string;
  region: PlatformRegion;
  runId: string;
  accountVersion: number;
  deadlineMs: number;
}

export async function claimPlatformBatch(env: OfficialPlatformBindings, accountId: string, version: number, batchId: string, deadlineMs: number) {
  const row = await env.DB.prepare(`INSERT INTO official_platform_login_batches (account_id,batch_id,account_version,deadline_ms)
    SELECT id,?,version,? FROM official_platform_accounts WHERE id=? AND version=?
    ON CONFLICT(account_id) DO UPDATE SET batch_id=excluded.batch_id,account_version=excluded.account_version,deadline_ms=excluded.deadline_ms
    WHERE official_platform_login_batches.deadline_ms<=? OR official_platform_login_batches.account_version!=excluded.account_version
    RETURNING batch_id`).bind(batchId, deadlineMs, accountId, version, Date.now()).first();
  return row !== null;
}

export async function platformBatchCurrent(env: OfficialPlatformBindings, accountId: string, version: number, batchId: string) {
  return await env.DB.prepare(`SELECT 1 FROM official_platform_login_batches AS b JOIN official_platform_accounts AS a ON a.id=b.account_id
    WHERE b.account_id=? AND b.account_version=? AND a.version=b.account_version AND b.batch_id=? AND b.deadline_ms>?`)
    .bind(accountId, version, batchId, Date.now()).first() !== null;
}

export async function releasePlatformBatch(env: OfficialPlatformBindings, accountId: string, batchId: string) {
  await env.DB.prepare("DELETE FROM official_platform_login_batches WHERE account_id=? AND batch_id=?").bind(accountId, batchId).run();
}

export async function platformDeviceId(env: OfficialPlatformBindings, accountId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT device_id AS deviceId FROM official_platform_devices WHERE account_id=?")
    .bind(accountId).first<{ deviceId: string }>();
  return row?.deviceId ?? accountId;
}

export async function savePlatformDeviceId(env: OfficialPlatformBindings, accountId: string, deviceId: string) {
  await env.DB.prepare("INSERT INTO official_platform_devices (account_id,device_id) VALUES (?,?) ON CONFLICT(account_id) DO NOTHING")
    .bind(accountId, deviceId).run();
}

interface PlatformBootstrapAccount {
  id: string; deviceId: string; email: string; password?: string;
  sdkSession: PlatformSdkSession; configurations: Record<PlatformRegion, Record<string, unknown>>;
}
type PlatformBootstrapBindings = OfficialPlatformBindings & { OFFICIAL_GLOBAL_LOGIN_CONFIG?: string };

export async function readPlatformBootstraps(env: PlatformBootstrapBindings): Promise<PlatformBootstrapAccount[]> {
  if (!env.OFFICIAL_GLOBAL_LOGIN_CONFIG) return [];
  const packed = (JSON.parse(env.OFFICIAL_GLOBAL_LOGIN_CONFIG) as { bootstrapAccounts?: string }).bootstrapAccounts;
  if (!packed) return [];
  const bytes = Uint8Array.from(atob(packed), (character) => character.charCodeAt(0));
  const entries = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).json() as PlatformBootstrapAccount[];
  if (!Array.isArray(entries) || entries.length > 32 || entries.some((entry) => !/^[a-f0-9-]{36}$/u.test(entry.id)
    || typeof entry.email !== "string" || typeof entry.deviceId !== "string")) throw new Error("invalid_bootstrap_accounts");
  return entries;
}

export async function adoptConfiguredPlatformAccounts(env: PlatformBootstrapBindings): Promise<void> {
  for (const entry of await readPlatformBootstraps(env)) {
    if (!entry.password) continue;
    const input = parsePlatformAccount({ email: entry.email, password: entry.password });
    if (!input) throw new Error("invalid_bootstrap_account");
    const created = await createPlatformAccount(env, entry.id, input);
    if (!created) continue;
    await savePlatformDeviceId(env, entry.id, entry.deviceId);
    const config = globalLoginConfiguration(env.OFFICIAL_GLOBAL_LOGIN_CONFIG, entry.deviceId, "tw");
    await adoptPlatformSessions(env, entry.id, 1, entry.sdkSession, entry.configurations, await platformSdkScopes(config.sdkProfile));
  }
}

/** The caller must first drain this role's regional collection and lookup leases. */
export async function claimPlatformLogin(env: OfficialPlatformBindings, lease: PlatformLoginLease, now = Date.now(), invalidateAll = false): Promise<boolean> {
  await vaultKey(env);
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO official_platform_login_jobs
      (account_id,region,run_id,account_version,status,started_at_ms,deadline_ms,completed_at_ms)
      SELECT id,?,?,version,'running',?,?,NULL FROM official_platform_accounts WHERE id=? AND version=?
      ON CONFLICT(account_id) DO UPDATE SET region=excluded.region,run_id=excluded.run_id,
        account_version=excluded.account_version,status='running',started_at_ms=excluded.started_at_ms,
        deadline_ms=excluded.deadline_ms,completed_at_ms=NULL
      WHERE (official_platform_login_jobs.status!='running' OR official_platform_login_jobs.deadline_ms<=?)
        AND official_platform_login_jobs.run_id!=excluded.run_id`)
      .bind(lease.region, lease.runId, now, lease.deadlineMs, lease.accountId, lease.accountVersion, now),
    env.DB.prepare(`UPDATE official_platform_roles SET status=CASE WHEN region=? THEN 'authenticating' ELSE 'auth_required' END,
      credential_box=NULL,last_verified_at_ms=NULL,last_error_code=NULL
      WHERE account_id=? AND (?=1 OR region=? OR status='authenticating') AND EXISTS (
        SELECT 1 FROM official_platform_login_jobs WHERE account_id=? AND run_id=? AND status='running'
      )`).bind(lease.region, lease.accountId, invalidateAll ? 1 : 0, lease.region, lease.accountId, lease.runId),
  ]);
  return results[0]!.meta.changes === 1;
}

export async function limitPlatformLoginLease(env: OfficialPlatformBindings, lease: PlatformLoginLease): Promise<void> {
  await env.DB.prepare(`UPDATE official_platform_login_jobs SET deadline_ms=MIN(deadline_ms,?)
    WHERE account_id=? AND run_id=? AND account_version=? AND status='running'`)
    .bind(lease.deadlineMs, lease.accountId, lease.runId, lease.accountVersion).run();
}

export async function platformSdkScopes(profile: { origin: string; app_key: string; email_country_id?: number; one_sdk_version?: string; common_params: Record<string, string> }) {
  const digest = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(JSON.stringify(value)))), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { sdkScope: await digest([profile.origin, profile.app_key, profile.email_country_id ?? null, profile.one_sdk_version ?? null,
    Object.keys(profile.common_params).sort().map((key) => [key, profile.common_params[key]])]),
    sdkIdentityScope: await digest(["official-sdk-identity/1",
      ...["game_id", "server_id", "merchant_id", "channel_id", "platform", "platform_type"].map((key) => profile.common_params[key])]) };
}

export async function adoptPlatformSessions(env: OfficialPlatformBindings, accountId: string, accountVersion: number,
  session: PlatformSdkSession, configurations: Record<PlatformRegion, Record<string, unknown>>, scopes: { sdkScope: string; sdkIdentityScope: string }) {
  for (const region of ["tw", "en", "kr"] as const) {
    const lease = { accountId, accountVersion, region, runId: crypto.randomUUID().replaceAll("-", ""), deadlineMs: Date.now() + 120_000 };
    if (!await claimPlatformLogin(env, lease)) throw new Error("account_busy");
    try {
      if (!await bindPlatformSdkIdentity(env, lease, scopes.sdkIdentityScope, session.uid)
        || await claimPlatformSdkOwner(env, lease, scopes.sdkIdentityScope, session.uid) !== "owned") throw new Error("sdk_identity_conflict");
      await savePlatformSdkSession(env, lease, scopes.sdkScope, session);
      const configuration = configurations[region];
      const parsed = await parseOfficialCollectorConfiguration(JSON.stringify(configuration), region);
      const credentials = parsed.accounts[0]!.credentials.credentials as Record<string, unknown>;
      if (credentials.bid !== session.uid || !await finishPlatformLogin(env, lease, {
        status: "ready", playerId: String(credentials.player_id), configuration })) throw new Error("game_player_mismatch");
    } finally { await releasePlatformLogin(env, lease); }
  }
}

export async function readPlatformLoginInput(env: OfficialPlatformBindings, lease: PlatformLoginLease) {
  const row = await env.DB.prepare(`SELECT a.email,a.password_box,r.player_id AS playerId
    FROM official_platform_accounts AS a JOIN official_platform_roles AS r ON r.account_id=a.id AND r.region=?
    JOIN official_platform_login_jobs AS j ON j.account_id=a.id AND j.run_id=? AND j.region=r.region
    WHERE a.id=? AND a.version=? AND j.account_version=a.version AND j.status='running' AND j.deadline_ms>?`)
    .bind(lease.region, lease.runId, lease.accountId, lease.accountVersion, Date.now())
    .first<{ email: string; password_box: string; playerId: string | null }>();
  if (!row) return null;
  return { email: row.email, password: await openPassword(env, lease.accountId, row.email, row.password_box), playerId: row.playerId };
}

/** A terminal execution may release its stale lease without touching the current role. */
export async function releasePlatformLogin(env: OfficialPlatformBindings, lease: PlatformLoginLease): Promise<void> {
  await env.DB.prepare(`UPDATE official_platform_login_jobs SET status='failed',completed_at_ms=?
    WHERE account_id=? AND region=? AND run_id=? AND account_version=? AND status='running'`)
    .bind(Date.now(), lease.accountId, lease.region, lease.runId, lease.accountVersion).run();
}

export interface PlatformSdkSession { uid: string; access_key: string; id_token: string; mid: string | null }

export async function readPlatformSdkIdentity(env: OfficialPlatformBindings, lease: PlatformLoginLease, scope: string): Promise<{ uid: string | null } | null> {
  return env.DB.prepare(`SELECT i.sdk_uid AS uid FROM official_platform_login_jobs AS j
    JOIN official_platform_accounts AS a ON a.id=j.account_id
    LEFT JOIN official_platform_sdk_identities AS i ON i.account_id=j.account_id AND i.identity_scope=?
    WHERE j.account_id=? AND j.region=? AND j.run_id=? AND j.account_version=?
      AND a.version=j.account_version AND j.status='running' AND j.deadline_ms>?`)
    .bind(scope, lease.accountId, lease.region, lease.runId, lease.accountVersion, Date.now()).first<{ uid: string | null }>();
}

/** Identity survives session/password replacement; a current lease may bind it once or confirm the same UID. */
export async function bindPlatformSdkIdentity(env: OfficialPlatformBindings, lease: PlatformLoginLease, scope: string, uid: string): Promise<boolean> {
  const result = await env.DB.prepare(`INSERT INTO official_platform_sdk_identities (account_id,identity_scope,sdk_uid,bound_at_ms)
    SELECT ?,?,?,? WHERE EXISTS (
      SELECT 1 FROM official_platform_login_jobs AS j JOIN official_platform_accounts AS a ON a.id=j.account_id
      WHERE j.account_id=? AND j.region=? AND j.run_id=? AND j.account_version=? AND a.version=j.account_version
        AND j.status='running' AND j.deadline_ms>?
    ) ON CONFLICT(account_id,identity_scope) DO UPDATE SET sdk_uid=official_platform_sdk_identities.sdk_uid
      WHERE official_platform_sdk_identities.sdk_uid=excluded.sdk_uid`)
    .bind(lease.accountId, scope, uid, Date.now(), lease.accountId, lease.region, lease.runId, lease.accountVersion, Date.now()).run();
  return result.meta.changes === 1;
}

const sdkContext = (id: string, scope: string) =>
  new TextEncoder().encode(JSON.stringify(["official-platform-sdk/1", id, scope]));

export async function claimPlatformSdkOwner(env: OfficialPlatformBindings, lease: PlatformLoginLease, scope: string, uid: string): Promise<"owned" | "duplicate_sdk_identity" | "sdk_identity_conflict" | "account_lease_invalidated"> {
  const allowed = `SELECT 1 FROM official_platform_login_jobs AS j JOIN official_platform_accounts AS a ON a.id=j.account_id
    JOIN official_platform_sdk_identities AS i ON i.account_id=a.id AND i.identity_scope=? AND i.sdk_uid=?
    WHERE j.account_id=? AND j.region=? AND j.run_id=? AND j.account_version=? AND a.version=j.account_version
      AND j.status='running' AND j.deadline_ms>?`;
  const args = [scope, uid, lease.accountId, lease.region, lease.runId, lease.accountVersion, Date.now()];
  await env.DB.prepare(`INSERT INTO official_platform_sdk_owners (identity_scope,sdk_uid,account_id,bound_at_ms)
    SELECT ?,?,?,? WHERE EXISTS (${allowed}) ON CONFLICT(identity_scope,sdk_uid) DO NOTHING`)
    .bind(scope, uid, lease.accountId, Date.now(), ...args).run();
  const row = await env.DB.prepare(`SELECT account_id AS accountId FROM official_platform_sdk_owners
    WHERE identity_scope=? AND sdk_uid=? AND EXISTS (${allowed})`)
    .bind(scope, uid, ...args).first<{ accountId: string | null }>();
  return !row ? "account_lease_invalidated" : row.accountId === null ? "sdk_identity_conflict"
    : row.accountId === lease.accountId ? "owned" : "duplicate_sdk_identity";
}

const sdkConflictHash = async (value: unknown): Promise<string> => Array.from(new Uint8Array(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))).map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function sdkOwnerGroups(env: OfficialPlatformBindings) {
  const { results } = await env.DB.prepare(`SELECT o.identity_scope AS scope,o.sdk_uid AS uid,o.account_id AS owner,
    a.id,a.label,a.email,a.version FROM official_platform_sdk_owners AS o
    JOIN official_platform_sdk_identities AS i USING(identity_scope,sdk_uid)
    JOIN official_platform_accounts AS a ON a.id=i.account_id
    ORDER BY o.identity_scope,o.sdk_uid,a.id`).all<{
      scope: string; uid: string; owner: string | null; id: string; label: string; email: string; version: number;
    }>();
  const groups = new Map<string, { scope: string; uid: string; owner: string | null;
    accounts: Array<{ id: string; label: string; email: string; version: number }> }>();
  for (const row of results) {
    const key = JSON.stringify([row.scope, row.uid]);
    let group = groups.get(key);
    if (!group) { group = { scope: row.scope, uid: row.uid, owner: row.owner, accounts: [] }; groups.set(key, group); }
    group.accounts.push({ id: row.id, label: row.label, email: row.email, version: row.version });
  }
  return Promise.all([...groups.values()].map(async (group) => ({ ...group,
    id: await sdkConflictHash(["sdk-owner-conflict/1", group.scope, group.uid]),
    revision: await sdkConflictHash([group.scope, group.uid, group.accounts.map(({ id, version }) => [id, version])]) })));
}

export async function listPlatformSdkConflicts(env: OfficialPlatformBindings) {
  return (await sdkOwnerGroups(env)).filter((group) => group.owner === null)
    .map(({ id, revision, accounts }) => ({ id, revision, accounts }));
}

/** A single guarded owner update fires session/version invalidation in the same SQLite transaction. */
export async function resolvePlatformSdkConflict(env: OfficialPlatformBindings, id: string, accountId: string, revision: string, now = Date.now()) {
  const group = (await sdkOwnerGroups(env)).find((entry) => entry.id === id);
  if (!group) return "conflict_not_found";
  if (group.owner !== null) return group.owner === accountId ? "resolved" : "conflict_changed";
  if (group.revision !== revision) return "conflict_changed";
  if (!group.accounts.some((account) => account.id === accountId)) return "account_not_candidate";
  const busy = await env.DB.prepare(`SELECT 1 AS busy FROM official_platform_login_jobs AS j
    JOIN official_platform_sdk_identities AS i ON i.account_id=j.account_id
    WHERE i.identity_scope=? AND i.sdk_uid=? AND j.status='running' AND j.deadline_ms+15000>? LIMIT 1`)
    .bind(group.scope, group.uid, now).first();
  if (busy) return "account_busy";
  const result = await env.DB.prepare(`UPDATE official_platform_sdk_owners SET account_id=?,bound_at_ms=?
    WHERE identity_scope=? AND sdk_uid=? AND account_id IS NULL
    AND (SELECT COUNT(*) FROM official_platform_sdk_identities WHERE identity_scope=? AND sdk_uid=?)=?
    AND NOT EXISTS (SELECT 1 FROM official_platform_sdk_identities AS i
      JOIN official_platform_accounts AS a ON a.id=i.account_id WHERE i.identity_scope=? AND i.sdk_uid=?
      AND NOT EXISTS (SELECT 1 FROM json_each(?) AS member
        WHERE json_extract(member.value,'$.id')=a.id AND json_extract(member.value,'$.version')=a.version))
    AND NOT EXISTS (SELECT 1 FROM official_platform_login_jobs AS j
      JOIN official_platform_sdk_identities AS i ON i.account_id=j.account_id
      WHERE i.identity_scope=? AND i.sdk_uid=? AND j.status='running' AND j.deadline_ms+15000>?) RETURNING account_id AS accountId`)
    .bind(accountId, now, group.scope, group.uid, group.scope, group.uid, group.accounts.length,
      group.scope, group.uid, JSON.stringify(group.accounts.map(({ id, version }) => ({ id, version }))), group.scope, group.uid, now).first<{ accountId: string }>();
  return result ? "resolved" : "conflict_changed";
}

export async function readPlatformSdkSession(env: OfficialPlatformBindings, lease: PlatformLoginLease, scope: string): Promise<PlatformSdkSession | null> {
  const row = await env.DB.prepare(`SELECT s.session_box AS box FROM official_platform_sdk_sessions AS s
    JOIN official_platform_login_jobs AS j ON j.account_id=s.account_id
    JOIN official_platform_accounts AS a ON a.id=j.account_id
    WHERE s.account_id=? AND s.profile_scope=? AND j.region=? AND j.run_id=? AND j.account_version=?
      AND a.version=j.account_version AND j.status='running' AND j.deadline_ms>?`)
    .bind(lease.accountId, scope, lease.region, lease.runId, lease.accountVersion, Date.now()).first<{ box: string }>();
  if (!row) return null;
  const [version, nonce, body] = row.box.split(".");
  if (version !== "v1" || !nonce || !body) throw new Error("account_sdk_session_format");
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(nonce),
    additionalData: sdkContext(lease.accountId, scope) }, await vaultKey(env), decode(body));
  return JSON.parse(new TextDecoder().decode(clear)) as PlatformSdkSession;
}

/** The verified SDK session is independent of a role's ranking-readiness result. */
export async function savePlatformSdkSession(env: OfficialPlatformBindings, lease: PlatformLoginLease, scope: string, session: PlatformSdkSession | null): Promise<void> {
  let box: string | null = null;
  if (session !== null) {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce,
      additionalData: sdkContext(lease.accountId, scope) }, await vaultKey(env), new TextEncoder().encode(JSON.stringify(session)));
    box = `v1.${encode(nonce)}.${encode(new Uint8Array(sealed))}`;
  }
  const allowed = `SELECT 1 FROM official_platform_login_jobs AS j JOIN official_platform_accounts AS a ON a.id=j.account_id
    WHERE j.account_id=? AND j.region=? AND j.run_id=? AND j.account_version=? AND a.version=j.account_version
      AND j.status='running' AND j.deadline_ms>?`;
  const args = [lease.accountId, lease.region, lease.runId, lease.accountVersion, Date.now()];
  if (box === null) {
    await env.DB.prepare(`DELETE FROM official_platform_sdk_sessions WHERE account_id=? AND EXISTS (${allowed})`)
      .bind(lease.accountId, ...args).run();
  } else {
    await env.DB.prepare(`INSERT INTO official_platform_sdk_sessions (account_id,profile_scope,session_box,stored_at_ms)
      SELECT ?,?,?,? WHERE EXISTS (${allowed}) ON CONFLICT(account_id) DO UPDATE SET
        profile_scope=excluded.profile_scope,session_box=excluded.session_box,stored_at_ms=excluded.stored_at_ms`)
      .bind(lease.accountId, scope, box, Date.now(), ...args).run();
  }
}

export type PlatformLoginResult = (
  | { status: "ready"; playerId: string; configuration: Record<string, unknown> }
  | { status: "needs_initialization"; playerId: string }
  | { status: "auth_required" | "auth_uncertain" | "failed"; errorCode: string; playerId?: string }
) & { sdkSession?: PlatformSdkSession | null };

const roleContext = (id: string, region: PlatformRegion, playerId: string) =>
  new TextEncoder().encode(JSON.stringify(["official-platform-role/1", id, region, playerId]));

export async function finishPlatformLogin(env: OfficialPlatformBindings, lease: PlatformLoginLease, result: PlatformLoginResult, now = Date.now()): Promise<boolean> {
  const playerId = result.playerId ?? null;
  let box: string | null = null;
  if (result.status === "ready") {
    const parsed = await parseOfficialCollectorConfiguration(JSON.stringify(result.configuration), lease.region);
    const account = parsed.accounts[0];
    if (parsed.accounts.length !== 1 || !account!.enabled || !account!.ready || account!.initialPause
      || (account!.credentials.credentials as Record<string, unknown>).player_id !== playerId)
      throw new Error("platform_session_identity_mismatch");
    const key = await vaultKey(env), nonce = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce,
      additionalData: roleContext(lease.accountId, lease.region, playerId!) }, key,
    new TextEncoder().encode(JSON.stringify({ clientVersion: account!.clientVersion,
      credentials: account!.credentials, masterConfig: account!.masterConfig })));
    box = `v1.${encode(nonce)}.${encode(new Uint8Array(sealed))}`;
  }
  const succeeded = result.status === "ready" || result.status === "needs_initialization";
  const errorCode = "errorCode" in result ? result.errorCode : null;
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE official_platform_roles SET status=?,player_id=COALESCE(?,player_id),credential_box=?,
      last_verified_at_ms=?,last_error_code=? WHERE account_id=? AND region=?
      AND (? IS NULL OR player_id IS NULL OR player_id=?) AND EXISTS (
        SELECT 1 FROM official_platform_login_jobs AS j JOIN official_platform_accounts AS a ON a.id=j.account_id
        WHERE j.account_id=? AND j.region=? AND j.run_id=? AND j.account_version=? AND a.version=j.account_version
          AND j.status='running' AND j.deadline_ms>?
      )`).bind(result.status, playerId, box, result.status === "ready" ? now : null, errorCode,
      lease.accountId, lease.region, playerId, playerId, lease.accountId, lease.region, lease.runId, lease.accountVersion, now),
    env.DB.prepare(`UPDATE official_platform_login_jobs SET status=?,completed_at_ms=?
      WHERE account_id=? AND region=? AND run_id=? AND account_version=? AND status='running' AND deadline_ms>?
        AND EXISTS (SELECT 1 FROM official_platform_accounts WHERE id=? AND version=?)
        AND EXISTS (SELECT 1 FROM official_platform_roles WHERE account_id=? AND region=?
          AND (? IS NULL OR player_id=?))`)
      .bind(succeeded ? "succeeded" : "failed", now, lease.accountId, lease.region, lease.runId, lease.accountVersion, now,
        lease.accountId, lease.accountVersion, lease.accountId, lease.region, playerId, playerId),
  ]);
  return results[0]!.meta.changes === 1;
}

/** Only verified role sessions join the existing regional selection and health policy. */
export async function readReadyPlatformAccounts(env: OfficialPlatformBindings, region: "jp" | PlatformRegion) {
  if (region === "jp") return [];
  const { results } = await env.DB.prepare(`SELECT account_id AS id,player_id AS playerId,credential_box AS box
    FROM official_platform_roles WHERE region=? AND status='ready' AND credential_box IS NOT NULL
      AND last_verified_at_ms IS NOT NULL ORDER BY account_id`).bind(region)
    .all<{ id: string; playerId: string; box: string }>();
  if (!results.length) return [];
  const key = await vaultKey(env);
  return Promise.all(results.map(async (row) => {
    const [version, nonce, body] = row.box.split(".");
    if (version !== "v1" || !nonce || !body) throw new Error("account_session_format");
    const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(nonce),
      additionalData: roleContext(row.id, region, row.playerId) }, key, decode(body));
    const configuration = JSON.parse(new TextDecoder().decode(clear)) as Record<string, unknown>;
    return { ...configuration, id: `platform:${row.id}`, enabled: true, state: "ready" };
  }));
}

export async function readPlatformPlayerIds(env: OfficialPlatformBindings, region: "jp" | PlatformRegion, exceptAccountId?: string, ownedIdentity?: { scope: string; uid: string }): Promise<Set<string>> {
  if (region === "jp") return new Set();
  const { results } = await env.DB.prepare(`SELECT r.player_id AS id FROM official_platform_roles AS r
    WHERE r.region=? AND r.player_id IS NOT NULL AND (? IS NULL OR r.account_id!=?)
    AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM official_platform_sdk_identities AS i
      JOIN official_platform_sdk_owners AS o USING(identity_scope,sdk_uid)
      WHERE i.account_id=r.account_id AND i.identity_scope=? AND i.sdk_uid=? AND o.account_id=?))`)
    .bind(region, exceptAccountId ?? null, exceptAccountId ?? null, ownedIdentity?.scope ?? null,
      ownedIdentity?.scope ?? null, ownedIdentity?.uid ?? null, exceptAccountId ?? null).all<{ id: string }>();
  return new Set(results.map((row) => normalizeOfficialPlayerId(row.id)));
}
