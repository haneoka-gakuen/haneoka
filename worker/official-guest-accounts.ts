// L3 — GEB
// Input: Immutable JP creation identities, task leases, private credentials and verification results.
// Output: Encrypted immutable request snapshots, created guests and redacted lifecycle state; verified guests join the pool.
// Pos: [Map](L2.md); one-time guest creation separate from Global email identities.
// Effects/Dependencies: D1 and shared account vault key; no game requests or automatic registration replay.
import { normalizeOfficialPlayerId, parseOfficialCollectorConfiguration } from "../src/lib/official-ranking";
import { vaultKey, type OfficialPlatformBindings } from "./official-platform-accounts";
import type { GuestConfiguration } from "./official-guest-jobs";

export interface GuestLease { guestId: string; version: number; runId: string; deadlineMs: number }

const context = (id: string, player: string) =>
  new TextEncoder().encode(JSON.stringify(["official-guest-configuration/1", id, player]));
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

const requestContext = (id: string, runId: string) =>
  new TextEncoder().encode(JSON.stringify(["official-guest-request/1", id, runId]));

export async function saveGuestRequest(env: OfficialPlatformBindings, lease: GuestLease, configuration: GuestConfiguration): Promise<boolean> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: requestContext(lease.guestId, lease.runId) },
    await vaultKey(env), new TextEncoder().encode(JSON.stringify(configuration)));
  const box = `v1.${encode(nonce)}.${encode(new Uint8Array(sealed))}`;
  const result = await env.DB.prepare(`INSERT INTO official_guest_requests (guest_id,run_id,request_box)
    SELECT id,run_id,? FROM official_guest_accounts WHERE id=? AND version=? AND run_id=? AND status='queued'
      AND configuration_box IS NULL ON CONFLICT(guest_id) DO NOTHING`)
    .bind(box, lease.guestId, lease.version, lease.runId).run();
  return result.meta.changes === 1;
}

export async function readGuestRequest(env: OfficialPlatformBindings, id: string): Promise<GuestConfiguration | null> {
  const row = await env.DB.prepare("SELECT run_id AS runId,request_box AS box FROM official_guest_requests WHERE guest_id=?")
    .bind(id).first<{ runId: string; box: string }>();
  if (!row) return null;
  const [version, nonce, body] = row.box.split(".");
  if (version !== "v1" || !nonce || !body) throw new Error("guest_request_format");
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(nonce), additionalData: requestContext(id, row.runId) },
    await vaultKey(env), decode(body));
  return JSON.parse(new TextDecoder().decode(clear)) as GuestConfiguration;
}

export interface GuestAccountState {
  id: string; label: string; version: number; status: string; runId: string; deadlineMs: number;
  playerId: string | null; hasConfiguration: number;
}

export async function readGuestAccountState(env: OfficialPlatformBindings, id: string): Promise<GuestAccountState | null> {
  return env.DB.prepare(`SELECT id,label,version,status,run_id AS runId,deadline_ms AS deadlineMs,
    player_id AS playerId,configuration_box IS NOT NULL AS hasConfiguration FROM official_guest_accounts WHERE id=?`)
    .bind(id).first<GuestAccountState>();
}

export async function createGuestAccount(env: OfficialPlatformBindings, lease: GuestLease, label: string, now = Date.now()): Promise<boolean> {
  await vaultKey(env);
  const result = await env.DB.prepare(`INSERT INTO official_guest_accounts
    (id,label,version,status,run_id,deadline_ms,created_at_ms) VALUES (?,?,?,'queued',?,?,?)
    ON CONFLICT(id) DO NOTHING`).bind(lease.guestId, label, lease.version, lease.runId, lease.deadlineMs, now).run();
  return result.meta.changes === 1;
}

export async function claimGuestRegistration(env: OfficialPlatformBindings, lease: GuestLease, now = Date.now()): Promise<boolean> {
  const result = await env.DB.prepare(`UPDATE official_guest_accounts SET status='creating',deadline_ms=?
    WHERE id=? AND version=? AND run_id=? AND status='queued' AND deadline_ms>? AND ?>?
      AND player_id IS NULL AND configuration_box IS NULL
      AND EXISTS (SELECT 1 FROM official_guest_requests WHERE guest_id=official_guest_accounts.id AND run_id=official_guest_accounts.run_id)`)
    .bind(lease.deadlineMs, lease.guestId, lease.version, lease.runId, now, lease.deadlineMs, now).run();
  return result.meta.changes === 1;
}

async function sealConfiguration(env: OfficialPlatformBindings, id: string, playerId: string, configuration: Record<string, unknown>): Promise<string> {
  const parsed = await parseOfficialCollectorConfiguration(JSON.stringify(configuration), "jp");
  const account = parsed.accounts[0];
  if (parsed.accounts.length !== 1 || !account!.enabled || !account!.ready || account!.initialPause
    || (account!.credentials.credentials as Record<string, unknown>).player_id !== playerId)
    throw new Error("guest_session_identity_mismatch");
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: context(id, playerId) }, await vaultKey(env),
    new TextEncoder().encode(JSON.stringify({ clientVersion: account!.clientVersion,
      credentials: account!.credentials, masterConfig: account!.masterConfig })));
  return `v1.${encode(nonce)}.${encode(new Uint8Array(sealed))}`;
}

/** A completed one-time creation may arrive late; its exact nonce may still preserve the identity once. */
export async function saveGuestRegistration(env: OfficialPlatformBindings, lease: GuestLease, playerId: string, profileId: string,
  configuration: Record<string, unknown>): Promise<boolean> {
  const box = await sealConfiguration(env, lease.guestId, playerId, configuration);
  const result = await env.DB.prepare(`UPDATE official_guest_accounts SET status='created',player_id=?,profile_id=?,
    configuration_box=?,last_error_code=NULL WHERE id=? AND version=? AND run_id=?
      AND status IN ('creating','uncertain') AND player_id IS NULL AND configuration_box IS NULL
      AND NOT EXISTS (SELECT 1 FROM official_guest_accounts WHERE player_id=? AND id!=?)`)
    .bind(playerId, profileId, box, lease.guestId, lease.version, lease.runId, playerId, lease.guestId).run();
  return result.meta.changes === 1;
}

export async function finishGuestRegistrationFailure(env: OfficialPlatformBindings, lease: GuestLease,
  status: "failed" | "uncertain", errorCode: string): Promise<void> {
  await env.DB.prepare(`UPDATE official_guest_accounts SET status=?,last_error_code=?
    WHERE id=? AND version=? AND run_id=? AND (status='creating' OR status='queued' AND ?='failed') AND configuration_box IS NULL`)
    .bind(status, errorCode, lease.guestId, lease.version, lease.runId, status).run();
}

async function openConfiguration(env: OfficialPlatformBindings, id: string, playerId: string, box: string): Promise<Record<string, unknown>> {
  const [version, nonce, body] = box.split(".");
  if (version !== "v1" || !nonce || !body) throw new Error("guest_session_format");
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(nonce), additionalData: context(id, playerId) },
    await vaultKey(env), decode(body));
  return JSON.parse(new TextDecoder().decode(clear)) as Record<string, unknown>;
}

export async function readGuestConfiguration(env: OfficialPlatformBindings, id: string): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare("SELECT player_id AS playerId,configuration_box AS box FROM official_guest_accounts WHERE id=? AND configuration_box IS NOT NULL")
    .bind(id).first<{ playerId: string; box: string }>();
  return row ? openConfiguration(env, id, row.playerId, row.box) : null;
}

export async function claimGuestVerification(env: OfficialPlatformBindings, id: string, expectedVersion: number, runId: string,
  deadlineMs: number, now = Date.now()): Promise<GuestLease | null> {
  const result = await env.DB.prepare(`UPDATE official_guest_accounts SET version=version+1,status='verifying',run_id=?,
    deadline_ms=?,last_error_code=NULL WHERE id=? AND version=? AND configuration_box IS NOT NULL
      AND (status IN ('created','ready') OR status='verifying' AND deadline_ms<=?) AND run_id!=? AND ?>?`)
    .bind(runId, deadlineMs, id, expectedVersion, now, runId, deadlineMs, now).run();
  return result.meta.changes === 1 ? { guestId: id, version: expectedVersion + 1, runId, deadlineMs } : null;
}

export async function readGuestVerificationInput(env: OfficialPlatformBindings, lease: GuestLease): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare(`SELECT player_id AS playerId,configuration_box AS box FROM official_guest_accounts
    WHERE id=? AND version=? AND run_id=? AND status='verifying' AND deadline_ms>? AND configuration_box IS NOT NULL`)
    .bind(lease.guestId, lease.version, lease.runId, Date.now()).first<{ playerId: string; box: string }>();
  return row ? openConfiguration(env, lease.guestId, row.playerId, row.box) : null;
}

export async function finishGuestVerification(env: OfficialPlatformBindings, lease: GuestLease, playerId: string,
  ready: boolean, errorCode: string | null, now = Date.now()): Promise<boolean> {
  const result = await env.DB.prepare(`UPDATE official_guest_accounts SET status=?,last_verified_at_ms=?,last_error_code=?
    WHERE id=? AND version=? AND run_id=? AND player_id=? AND status='verifying' AND configuration_box IS NOT NULL
      AND (?=0 OR deadline_ms>?)`)
    .bind(ready ? "ready" : "created", ready ? now : null, errorCode, lease.guestId, lease.version, lease.runId,
      playerId, ready ? 1 : 0, now).run();
  return result.meta.changes === 1;
}

export type GuestAccountSummary = {
  id: string; label: string; version: number; status: string; playerId: string | null; profileId: string | null;
  createdAtMs: number; lastVerifiedAtMs: number | null; lastErrorCode: string | null;
};

export async function listGuestAccounts(env: OfficialPlatformBindings) {
  return (await env.DB.prepare(`SELECT id,label,version,
    CASE WHEN status='queued' AND deadline_ms<=? THEN 'failed'
      WHEN status='creating' AND deadline_ms<=? THEN 'uncertain'
      WHEN status='verifying' AND deadline_ms<=? THEN 'created' ELSE status END AS status,
    player_id AS playerId,profile_id AS profileId,created_at_ms AS createdAtMs,last_verified_at_ms AS lastVerifiedAtMs,
    last_error_code AS lastErrorCode FROM official_guest_accounts ORDER BY created_at_ms,id`)
    .bind(Date.now(), Date.now(), Date.now()).all<GuestAccountSummary>()).results;
}

export async function readReadyGuestAccounts(env: OfficialPlatformBindings) {
  const { results } = await env.DB.prepare(`SELECT id,player_id AS playerId,configuration_box AS box
    FROM official_guest_accounts WHERE status='ready' AND configuration_box IS NOT NULL AND last_verified_at_ms IS NOT NULL ORDER BY id`)
    .all<{ id: string; playerId: string; box: string }>();
  return Promise.all(results.map(async (row) => ({ ...await openConfiguration(env, row.id, row.playerId, row.box),
    id: `guest:${row.id}`, enabled: true, state: "ready" })));
}

export async function readGuestPlayerIds(env: OfficialPlatformBindings): Promise<Set<string>> {
  const { results } = await env.DB.prepare("SELECT player_id AS id FROM official_guest_accounts WHERE player_id IS NOT NULL").all<{ id: string }>();
  return new Set(results.map((row) => normalizeOfficialPlayerId(row.id)));
}
