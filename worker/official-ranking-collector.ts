// L3 — GEB
// Input: Region configuration, container callbacks and scheduled collection work.
// Output: Durable regional jobs/observations and read-only current collection availability.
// Pos: [Map](L2.md); official collector coordination and recovery.
// Effects/Dependencies: Starts isolated containers, persists DO state and writes D1/R2; credentials stay server-side.
import { Container } from "@cloudflare/containers";
import type { GameRecordsRegion } from "../src/lib/game-records";
import { OFFICIAL_API_ORIGINS as REGION_ORIGINS, parseOfficialCollectorConfiguration, selectOfficialCollectorAccount,
  type OfficialCollectorAccount, type OfficialCollectorAccountHealth, type OfficialCollectorPool,
  type OfficialArenaObservation, type OfficialArenaPopulationObservation, type OfficialArenaProgress, type OfficialCatalog, type OfficialCollectorFailure, type OfficialCollectorJob, type OfficialCollectorUpdate, type OfficialObservation } from "../src/lib/official-ranking";
import { harvestOfficialPlayers, saveOfficialCardImage, saveOfficialPlayers, saveOfficialSongRanking, officialDigest, readOfficialArenaMetadata, readOfficialArenaPopulation, saveOfficialArenaObservation, saveOfficialArenaPopulation, saveOfficialCatalog, saveOfficialObservation } from "./official-ranking-store";

export const OFFICIAL_RANKING_REGIONS = ["jp", "tw", "en", "kr"] as const;
export type OfficialCollectorConfigurationBindings = Partial<Pick<Env,
  "OFFICIAL_RANKING_JP_CONFIG" | "OFFICIAL_RANKING_TW_CONFIG" | "OFFICIAL_RANKING_EN_CONFIG" | "OFFICIAL_RANKING_KR_CONFIG"
>> & { OFFICIAL_RANKING_ENABLED_REGIONS?: string };
const INTERVAL_MS = 300_000;
const JOB_MS = 120_000;
const ARENA_DEMAND_INTERVAL_MS = 60_000;
const ARENA_INTEREST_TTL_MS = 3_600_000;
const DEMAND_TTL_MS = 600_000;
const DEMAND_LIMITS = { player: 64, song: 8, card: 128 };
const CARD_FILE = /^[1-9][0-9]{0,18}_[A-Za-z0-9_.-]{1,200}$/u;
type ArenaInterest = NonNullable<OfficialCollectorJob["arenaWindows"]>[number] & { requestedAtMs: number };
const MAX_UPDATE_BYTES = 8 * 1024 * 1024;
const CALLBACK_ORIGIN = "https://haneoka.org";

type JsonObject = Record<string, unknown>;
interface CollectorRun {
  id: string;
  token: string;
  generation: string;
  accountIdentity?: string;
  authGeneration?: string;
  apiOrigin?: string;
  startedAtMs: number;
  deadlineMs: number;
  pendingAttempt: string | null;
  resolvedAttempt: boolean;
  complete: boolean;
  catalog: OfficialCatalog | null;
  checkpoints: Record<string, string>;
}
interface DemandInterest {
  id: string;
  requestedAtMs: number;
}
interface CollectorState {
  region: GameRecordsRegion;
  status: string;
  nextAtMs: number;
  lastSuccessfulObservationAtMs: number | null;
  lastRunAtMs: number | null;
  failures: number;
  blockedGeneration: string | null;
  callbackProtocolVersion?: number;
  accounts?: Record<string, OfficialCollectorAccountHealth>;
  permissionPause?: { identity: string; authGeneration: string } | null;
  legacyPermissionBlock?: string | null;
  lastFailure?: OfficialCollectorFailure | null;
  run: CollectorRun | null;
  arenaProgress?: Record<string, OfficialArenaProgress>;
  arenaCatalog?: OfficialCatalog["arena"];
  arenaInterests?: ArenaInterest[];
  playerInterests?: DemandInterest[];
  songInterests?: DemandInterest[];
  cardInterests?: DemandInterest[];
  arenaPopulationAt?: Record<string, number>;
  arenaWarmupRuns?: number;
}

export function officialRegionEnabled(value: string | undefined, region: GameRecordsRegion): boolean {
  return (value ?? "").split(",").map((entry) => entry.trim()).includes(region);
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_collector_document");
  return value as JsonObject;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as JsonObject)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function validRegion(value: unknown): value is GameRecordsRegion {
  return OFFICIAL_RANKING_REGIONS.some((region) => region === value);
}
const sameThresholds = (left: readonly number[] | undefined, right: readonly number[] | undefined) =>
  left !== undefined && right !== undefined && left.length === right.length && left.every((value, index) => value === right[index]);
function decimal(value: unknown): value is string { return typeof value === "string" && /^[1-9][0-9]{0,18}$/u.test(value); }
function millis(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function retryMs(value: unknown): number {
  if (typeof value !== "number" || value <= 0 || Number.isNaN(value)) return INTERVAL_MS;
  const maximum = 8_640_000_000_000_000 - Date.now();
  return Math.max(INTERVAL_MS, Math.min(maximum, value * 1000));
}
function authRejected(observation: Pick<OfficialObservation, "httpStatus" | "grpcStatus" | "error">): boolean {
  return observation.httpStatus === 401 || observation.httpStatus === 403 || observation.grpcStatus === "7" || observation.grpcStatus === "16"
    || observation.grpcStatus === "2" && observation.error === "authentication_failed";
}
function limited(observation: Pick<OfficialObservation, "httpStatus" | "grpcStatus">): boolean { return observation.httpStatus === 429 || observation.grpcStatus === "8"; }
function permissionRejected(value: { httpStatus?: number | null; grpcStatus?: string | null }): boolean {
  return value.httpStatus === 403 || value.grpcStatus === "7";
}
function validateFailure(value: unknown): asserts value is OfficialCollectorFailure {
  const failure = object(value);
  if (!["container", "catalog", "catalog_version", "catalog_server_list", "catalog_manifest", "catalog_event", "catalog_challenges", "catalog_parameters",
    "catalog_callback", "version", "board", "attempt_callback", "observation_callback", "complete_callback",
    "demand", "arena_board", "arena_observation_callback", "arena_population_callback", "arena_progress_callback",
    "catalog_arena_season", "catalog_arena_league", "catalog_arena_rank"].includes(String(failure.stage))
    || !["Error", "TimeoutError", "SSLError", "SSLCertVerificationError", "OSError", "URLError", "gaierror", "ValueError", "RuntimeError", "VersionError",
      "CatalogRequestError", "CallbackError", "ImportError", "ModuleNotFoundError", "FileNotFoundError", "PermissionError", "JSONDecodeError",
      "ConnectionError", "ConnectionRefusedError", "ConnectionResetError", "ProtocolError", "H2Error", "http_error", "container_fetch_failed"].includes(String(failure.code))
    || failure.httpStatus !== undefined && (typeof failure.httpStatus !== "number" || !Number.isInteger(failure.httpStatus) || failure.httpStatus < 100 || failure.httpStatus > 599)
    || failure.grpcStatus !== undefined && (typeof failure.grpcStatus !== "string" || !/^[0-9]{1,3}$/u.test(failure.grpcStatus))) throw new Error("invalid_failure");
}
async function responseFailure(response: Response): Promise<OfficialCollectorFailure | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 1024) return null;
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const failure: unknown = object(JSON.parse(new TextDecoder().decode(bytes))).failure;
    validateFailure(failure);
    return { stage: failure.stage, code: failure.code,
      ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
      ...(failure.grpcStatus !== undefined ? { grpcStatus: failure.grpcStatus } : {}) };
  } catch { return null; }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
async function sameToken(actual: string, expected: string): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(expected), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(expected));
  return crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(actual));
}

async function configFor(env: OfficialCollectorConfigurationBindings, region: GameRecordsRegion): Promise<OfficialCollectorPool | null> {
  const secret = env[`OFFICIAL_RANKING_${region.toUpperCase()}_CONFIG` as "OFFICIAL_RANKING_JP_CONFIG"];
  if (!secret?.trim()) return null;
  return parseOfficialCollectorConfiguration(secret, region);
}

export async function officialCollectorAvailability(
  env: OfficialCollectorConfigurationBindings,
  region: GameRecordsRegion,
): Promise<"disabled" | "not_configured" | "invalid_config" | null> {
  if (!officialRegionEnabled(env.OFFICIAL_RANKING_ENABLED_REGIONS, region)) return "disabled";
  try { return await configFor(env, region) ? null : "not_configured"; }
  catch { return "invalid_config"; }
}

function validateCatalog(value: unknown, region: GameRecordsRegion): asserts value is OfficialCatalog {
  const catalog = object(value);
  if (catalog.region !== region || catalog.catalogSource !== "official-master" || !millis(catalog.catalogObservedAtMs)
    || catalog.catalogObservedAtMs > Date.now() + 60_000 || typeof catalog.masterVersion !== "string" || !catalog.masterVersion
    || !(catalog.resourceVersion === null || typeof catalog.resourceVersion === "string")
    || typeof catalog.apiOrigin !== "string" || !REGION_ORIGINS[region].includes(catalog.apiOrigin)) throw new Error("invalid_catalog");
  if (catalog.arena != null) {
    const arena = object(catalog.arena);
    if (!decimal(arena.seasonId) || !millis(arena.startAtMs) || !millis(arena.endAtMs) || !millis(arena.rankingEndAtMs)
      || arena.endAtMs <= arena.startAtMs || arena.rankingEndAtMs < arena.endAtMs || !Array.isArray(arena.bandIds)
      || arena.bandIds.length > 20 || !arena.bandIds.every(decimal) || new Set(arena.bandIds).size !== arena.bandIds.length) {
      throw new Error("invalid_catalog");
    }
    if (arena.thresholdsByBand !== undefined) {
      const thresholds = object(arena.thresholdsByBand);
      for (const [bandId, values] of Object.entries(thresholds)) {
        if (!arena.bandIds.includes(bandId) || !Array.isArray(values) || values.length > 128
          || values.some((value: unknown, index: number) => typeof value !== "number" || !Number.isSafeInteger(value)
            || value < 0 || index > 0 && value <= (values[index - 1] as number))) throw new Error("invalid_catalog");
      }
    }
  }
  if (catalog.event === null) return;
  const event = object(catalog.event);
  if (!decimal(event.id) || !millis(event.startAtMs) || !millis(event.endAtMs) || event.endAtMs <= event.startAtMs
    || typeof event.aggregationSeconds !== "number" || !Number.isSafeInteger(event.aggregationSeconds)
    || event.aggregationSeconds < 0 || event.aggregationSeconds > 604_800 || typeof event.totalRankingEnabled !== "boolean"
    || typeof event.pointRankingEnabled !== "boolean" || !Array.isArray(event.challenges) || event.challenges.length > 100) throw new Error("invalid_catalog");
  const ids = new Set<string>();
  for (const value of event.challenges) {
    const challenge = object(value);
    if (!decimal(challenge.id) || ids.has(challenge.id) || !decimal(challenge.musicId) || typeof challenge.enabled !== "boolean"
      || !millis(challenge.startAtMs) || !millis(challenge.endAtMs) || challenge.startAtMs < event.startAtMs
      || challenge.endAtMs > event.endAtMs || challenge.endAtMs <= challenge.startAtMs) throw new Error("invalid_catalog");
    ids.add(challenge.id);
  }
}

function validateObservation(value: unknown, region: GameRecordsRegion): asserts value is OfficialObservation {
  const observation = object(value);
  if (observation.region !== region || typeof observation.snapshotId !== "string" || !/^[a-f0-9]{32}$/u.test(observation.snapshotId)
    || !decimal(observation.eventId) || !millis(observation.observedAtMs) || observation.observedAtMs > Date.now() + 60_000
    || !((observation.kind === "total" || observation.kind === "point") && observation.challengeId === "" || observation.kind === "challenge" && decimal(observation.challengeId))) {
    throw new Error("invalid_observation");
  }
  if (observation.error !== undefined) {
    if (typeof observation.error !== "string" || !/^[A-Za-z0-9_]{1,80}$/u.test(observation.error) || observation.players !== undefined) throw new Error("invalid_observation");
  } else {
    if (!Array.isArray(observation.players) || observation.players.length > 100) throw new Error("invalid_observation");
    for (const value of observation.players) {
      const player = object(value);
      if (!(typeof player.score === "string" && /^[0-9]+$/u.test(player.score) || typeof player.score === "number" && Number.isSafeInteger(player.score) && player.score >= 0)) {
        throw new Error("invalid_observation_score");
      }
    }
  }
}

function validateArenaObservation(value: unknown, region: GameRecordsRegion): asserts value is OfficialArenaObservation {
  const observation = object(value);
  const start = observation.startRank, end = observation.endRank;
  if (observation.region !== region || typeof observation.snapshotId !== "string" || !/^[a-f0-9]{32}$/u.test(observation.snapshotId)
    || !decimal(observation.seasonId) || !decimal(observation.bandId) || !millis(observation.observedAtMs)
    || observation.observedAtMs > Date.now() + 60_000 || typeof start !== "number" || !Number.isSafeInteger(start) || start < 1 || (start - 1) % 100 !== 0
    || typeof end !== "number" || !Number.isSafeInteger(end) || end < start || end - start >= 100
    || !(observation.maxRank == null || typeof observation.maxRank === "number" && Number.isSafeInteger(observation.maxRank) && observation.maxRank >= 0)) {
    throw new Error("invalid_observation");
  }
  if (observation.error !== undefined) {
    if (typeof observation.error !== "string" || !/^[A-Za-z0-9_]{1,80}$/u.test(observation.error) || observation.players !== undefined) throw new Error("invalid_observation");
    return;
  }
  if (!Array.isArray(observation.players) || observation.players.length > end - start + 1) throw new Error("invalid_observation");
  for (const value of observation.players) {
    const player = object(value);
    if (!(typeof player.point === "string" && /^[0-9]+$/u.test(player.point) || typeof player.point === "number" && Number.isSafeInteger(player.point) && player.point >= 0)) {
      throw new Error("invalid_observation_point");
    }
  }
}

function validateArenaProgress(value: unknown): asserts value is OfficialArenaProgress {
  const progress = object(value);
  if (!decimal(progress.seasonId) || !decimal(progress.bandId) || typeof progress.maxRank !== "number"
    || !Number.isSafeInteger(progress.maxRank) || progress.maxRank < 0 || !Array.isArray(progress.thresholds)
    || !progress.thresholds.length || progress.thresholds.length > 128 || !Array.isArray(progress.counts)
    || progress.counts.length !== progress.thresholds.length || typeof progress.cursor !== "number"
    || !Number.isInteger(progress.cursor) || progress.cursor < 0 || progress.cursor > progress.thresholds.length) {
    throw new Error("invalid_arena_progress");
  }
  let threshold = -1;
  for (let index = 0; index < progress.thresholds.length; index++) {
    const nextThreshold: unknown = progress.thresholds[index], nextCount: unknown = progress.counts[index];
    if (typeof nextThreshold !== "number" || !Number.isSafeInteger(nextThreshold) || nextThreshold <= threshold
      || nextCount !== null && (typeof nextCount !== "number" || !Number.isSafeInteger(nextCount) || nextCount < 0 || nextCount > progress.maxRank)) {
      throw new Error("invalid_arena_progress");
    }
    threshold = nextThreshold;
  }
  if (progress.pending !== undefined) {
    const pending = object(progress.pending);
    if (typeof pending.index !== "number" || !Number.isInteger(pending.index) || pending.index < 0 || pending.index >= progress.thresholds.length
      || typeof pending.low !== "number" || !Number.isSafeInteger(pending.low) || pending.low < 0
      || typeof pending.high !== "number" || !Number.isSafeInteger(pending.high) || pending.high < pending.low || pending.high > progress.maxRank) {
      throw new Error("invalid_arena_progress");
    }
  }
}

function validateArenaPopulation(value: unknown, region: GameRecordsRegion): asserts value is OfficialArenaPopulationObservation {
  const observation = object(value);
  if (observation.region !== region || typeof observation.snapshotId !== "string" || !/^[a-f0-9]{32}$/u.test(observation.snapshotId)
    || !decimal(observation.seasonId) || !decimal(observation.bandId) || !millis(observation.observedAtMs)
    || observation.observedAtMs > Date.now() + 60_000 || typeof observation.maxRank !== "number"
    || !Number.isSafeInteger(observation.maxRank) || observation.maxRank < 0 || !Array.isArray(observation.atLeast)
    || !observation.atLeast.length || observation.atLeast.length > 128) throw new Error("invalid_arena_population");
  let previousThreshold = -1, previousCount = observation.maxRank;
  for (const value of observation.atLeast) {
    const row = object(value);
    if (typeof row.threshold !== "number" || !Number.isSafeInteger(row.threshold) || row.threshold <= previousThreshold
      || typeof row.count !== "number" || !Number.isSafeInteger(row.count) || row.count < 0 || row.count > previousCount
      || row.threshold === 0 && row.count !== observation.maxRank) throw new Error("invalid_arena_population");
    previousThreshold = row.threshold;
    previousCount = row.count;
  }
}

async function boundedUpdate(request: Request): Promise<OfficialCollectorUpdate> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid_update");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_UPDATE_BYTES) { await reader.cancel(); throw new Error("update_too_large"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return object(JSON.parse(new TextDecoder().decode(bytes))) as OfficialCollectorUpdate;
}

export class OfficialRankingCollector extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = "15s";
  override enableInternet = true;
  override pingEndpoint = "container/health";
  private mutations: Promise<void> = Promise.resolve();

  private expediteArena(state: CollectorState) {
    if (state.permissionPause || state.legacyPermissionBlock || state.blockedGeneration || state.status !== "ok" && state.status !== "not_started") return;
    const next = Math.max(Date.now() + 1_000, (state.lastRunAtMs ?? 0) + ARENA_DEMAND_INTERVAL_MS);
    state.nextAtMs = state.nextAtMs ? Math.min(state.nextAtMs, next) : next;
  }

  async requestArenaWindows(region: GameRecordsRegion, seasonId: string, bandId: string,
    starts: number[], thresholds: number[] = []): Promise<{ kind: string; retryAfter: number | null }> {
    return this.serialized(async () => {
      if (!decimal(seasonId) || !decimal(bandId) || !Array.isArray(starts) || starts.length > 20
        || starts.some((start) => !Number.isSafeInteger(start) || start < 1 || (start - 1) % 100 !== 0)
        || !Array.isArray(thresholds) || thresholds.length > 32
        || thresholds.some((value, index) => !Number.isSafeInteger(value) || value < 0 || index > 0 && value <= thresholds[index - 1]!)) {
        return { kind: "invalid_request", retryAfter: null };
      }
      const state = await this.stateFor(region), now = Date.now();
      const unavailable = await officialCollectorAvailability(this.env, region);
      if (unavailable) return { kind: unavailable, retryAfter: null };
      if (state.permissionPause || state.legacyPermissionBlock || state.blockedGeneration) return { kind: "auth_paused", retryAfter: null };
      if (["rate_limited", "failed", "auth_paused", "auth_uncertain", "no_available_account"].includes(state.status))
        return { kind: state.status, retryAfter: null };
      const active = state.run && !state.run.complete && now <= state.run.deadlineMs + 15_000;
      if (state.run && !state.run.complete && !active) return { kind: "unavailable", retryAfter: null };
      const pool = await configFor(this.env, region);
      if (!active && (!pool || !this.accountFor(state, pool))) return { kind: "no_available_account", retryAfter: null };
      const arena = state.arenaCatalog === undefined ? state.run?.catalog?.arena : state.arenaCatalog;
      if (!arena || seasonId !== arena.seasonId || !arena.bandIds.includes(bandId)
        || now < arena.startAtMs || now >= arena.rankingEndAtMs) return { kind: "inactive", retryAfter: null };
      if (!starts.length && arena.thresholdsByBand?.[bandId]?.length === 0) return { kind: "inactive", retryAfter: null };
      if (thresholds.length) {
        const known = arena.thresholdsByBand?.[bandId];
        if (!known) return { kind: "unavailable", retryAfter: null };
        if (thresholds.some((value) => value !== 0 && !known.includes(value))) return { kind: "invalid_request", retryAfter: null };
      }
      const queue = (state.arenaInterests ?? []).filter((entry) => now - entry.requestedAtMs < ARENA_INTEREST_TTL_MS);
      if (starts.length && starts.every((start) => queue.some((entry) => entry.seasonId === seasonId
        && entry.bandId === bandId && entry.startRank === start))) return { kind: "pending", retryAfter: 30 };
      const metadata = starts.length ? await readOfficialArenaMetadata(this.env, region, seasonId, bandId) : null;
      if (starts.some((start) => start > 1 && (metadata?.maxRank == null || start > metadata.maxRank)))
        return { kind: "unavailable", retryAfter: null };
      const missing = [...new Set(starts)].filter((start) => !queue.some((entry) => entry.seasonId === seasonId && entry.bandId === bandId && entry.startRank === start));
      if (queue.length + missing.length > 24) return { kind: "queue_full", retryAfter: null };
      for (const startRank of missing) queue.push({ seasonId, bandId, startRank, endRank: startRank + 99, requestedAtMs: now });
      state.arenaInterests = queue;
      if (!active) this.expediteArena(state);
      await this.persist(state);
      return { kind: "pending", retryAfter: 30 };
    });
  }

  /** Queues reads for the next run; the queues are bounded and repeat requests collapse. */
  async requestDemand(region: GameRecordsRegion, kind: "player" | "song" | "card", ids: string[]): Promise<{ kind: string; retryAfter: number | null }> {
    return this.serialized(async () => {
      if (ids.length > DEMAND_LIMITS[kind] || ids.some((id) => (kind === "card" ? !CARD_FILE.test(id) : !decimal(id))))
        return { kind: "invalid_request", retryAfter: null };
      const state = await this.stateFor(region), now = Date.now();
      const unavailable = await officialCollectorAvailability(this.env, region);
      if (unavailable) return { kind: unavailable, retryAfter: null };
      if (state.permissionPause || state.legacyPermissionBlock || state.blockedGeneration) return { kind: "auth_paused", retryAfter: null };
      if (["rate_limited", "failed", "auth_paused", "auth_uncertain", "no_available_account"].includes(state.status))
        return { kind: state.status, retryAfter: null };
      const field = kind === "player" ? "playerInterests" : kind === "song" ? "songInterests" : "cardInterests";
      const queue = (state[field] ?? []).filter((entry) => now - entry.requestedAtMs < DEMAND_TTL_MS);
      const missing = ids.filter((id) => !queue.some((entry) => entry.id === id));
      if (!missing.length) return { kind: "pending", retryAfter: 30 };
      if (queue.length + missing.length > DEMAND_LIMITS[kind]) return { kind: "queue_full", retryAfter: 60 };
      state[field] = [...queue, ...missing.map((id) => ({ id, requestedAtMs: now }))];
      this.expediteArena(state);
      await this.persist(state);
      return { kind: "pending", retryAfter: 30 };
    });
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation);
    this.mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  private async stateFor(region: GameRecordsRegion): Promise<CollectorState> {
    if (!validRegion(region)) throw new Error("invalid_region");
    const previous = await this.ctx.storage.get<CollectorState>("collectorState");
    if (previous && previous.region !== region) throw new Error("collector_region_changed");
    return previous ?? { region, status: "not_started", nextAtMs: 0, lastSuccessfulObservationAtMs: null,
      lastRunAtMs: null, failures: 0, blockedGeneration: null, run: null };
  }

  private async persist(state: CollectorState, schedule = true): Promise<void> {
    await this.ctx.storage.put("collectorState", state);
    this.deleteSchedules("collectDue");
    if (schedule) await this.schedule(new Date(Math.max(Date.now() + 1_000, state.nextAtMs)), "collectDue", state.region);
    else await this.scheduleNextAlarm();
  }

  private synchronizePool(state: CollectorState, pool: OfficialCollectorPool): void {
    const legacyGeneration = state.legacyPermissionBlock ?? (state.accounts === undefined ? state.blockedGeneration : null);
    const accounts = state.accounts ??= {};
    for (const config of pool.accounts) {
      const health = accounts[config.identity] ??= { blocked: {}, lastUsedAtMs: 0,
        lastSuccessAtMs: null, cooldownUntilMs: 0, leaseUntilMs: 0, failures: 0 };
      if (config.initialPause) health.blocked[config.authGeneration] = config.initialPause;
      if (config.permissionPaused) state.permissionPause = { identity: config.identity, authGeneration: config.authGeneration };
    }
    const run = state.run;
    if (run && !run.accountIdentity) {
      const config = pool.accounts.find((account) => account.generation === run.generation);
      if (config) { run.accountIdentity = config.identity; run.authGeneration = config.authGeneration; run.apiOrigin = String(config.credentials.origin); }
    }
    const blocked = pool.accounts.find((account) => account.generation === state.blockedGeneration);
    if (blocked) accounts[blocked.identity]!.blocked[blocked.authGeneration] = state.status === "auth_uncertain" ? "auth_uncertain" : "auth_paused";
    if (legacyGeneration) {
      const legacy = pool.accounts.find((account) => account.legacyGenerations.includes(legacyGeneration));
      if (legacy) {
        accounts[legacy.identity]!.blocked[legacy.authGeneration] = state.status === "auth_uncertain" ? "auth_uncertain" : "auth_paused";
        state.permissionPause = { identity: legacy.identity, authGeneration: legacy.authGeneration };
        state.legacyPermissionBlock = null;
      } else state.legacyPermissionBlock = legacyGeneration;
    }
    if (state.permissionPause) {
      const repaired = pool.accounts.find((account) => account.enabled && account.ready && account.identity === state.permissionPause?.identity
        && account.authGeneration !== state.permissionPause.authGeneration);
      if (repaired) state.permissionPause = null;
    }
  }

  private runHealth(state: CollectorState): OfficialCollectorAccountHealth | null {
    return state.run?.accountIdentity ? state.accounts?.[state.run.accountIdentity] ?? null : null;
  }

  private pauseRun(state: CollectorState, kind: "auth_paused" | "auth_uncertain", permission = false): void {
    const run = state.run;
    if (!run) return;
    state.blockedGeneration = run.generation;
    state.status = kind;
    const health = this.runHealth(state);
    if (health && run.authGeneration) health.blocked[run.authGeneration] = kind;
    if (permission && run.accountIdentity && run.authGeneration) state.permissionPause = { identity: run.accountIdentity, authGeneration: run.authGeneration };
  }

  private expireRun(state: CollectorState): boolean {
    const run = state.run;
    if (!run || run.complete) return false;
    if (Date.now() <= run.deadlineMs + 15_000) return true;
    if (run.pendingAttempt && !run.resolvedAttempt) this.pauseRun(state, "auth_uncertain");
    run.complete = true;
    const health = this.runHealth(state);
    if (health) health.leaseUntilMs = 0;
    return false;
  }

  private accountFor(state: CollectorState, pool: OfficialCollectorPool): OfficialCollectorAccount | null {
    if (state.permissionPause || state.legacyPermissionBlock) return null;
    return selectOfficialCollectorAccount(pool, state.accounts ?? {}, Date.now());
  }

  private async unavailablePool(state: CollectorState, pool: OfficialCollectorPool): Promise<void> {
    const times = pool.accounts.filter((account) => account.enabled && account.ready
      && !state.accounts?.[account.identity]?.blocked[account.authGeneration])
      .map((account) => Math.max(account.availableAtMs, state.accounts?.[account.identity]?.cooldownUntilMs ?? 0, state.accounts?.[account.identity]?.leaseUntilMs ?? 0))
      .filter((time) => time > Date.now());
    if (state.permissionPause || state.legacyPermissionBlock || pool.accounts.some((account) => state.accounts?.[account.identity]?.blocked[account.authGeneration])) state.status = "auth_paused";
    else state.status = "no_available_account";
    if (times.length && !state.permissionPause && !state.legacyPermissionBlock) state.nextAtMs = Math.max(state.nextAtMs, Math.min(...times));
    await this.persist(state, times.length > 0 && !state.permissionPause && !state.legacyPermissionBlock);
  }

  async ensureScheduled(region: GameRecordsRegion): Promise<void> {
    await this.serialized(async () => {
      const state = await this.stateFor(region);
      if (!officialRegionEnabled(this.env.OFFICIAL_RANKING_ENABLED_REGIONS, region)) {
        state.status = "disabled";
        await this.persist(state, false);
        return;
      }
      let pool: OfficialCollectorPool | null;
      try { pool = await configFor(this.env, region); }
      catch { state.status = "invalid_config"; await this.persist(state, false); return; }
      if (!pool) { state.status = "not_configured"; await this.persist(state, false); return; }
      this.synchronizePool(state, pool);
      if (state.callbackProtocolVersion !== 2 && ["failed", "invalid_config", "not_configured"].includes(state.status) && state.run?.complete
        && !state.run.catalog && !state.run.pendingAttempt && !state.blockedGeneration && !state.permissionPause && !state.legacyPermissionBlock
        && state.lastFailure?.stage === "catalog_callback" && state.lastFailure.code === "CallbackError"
        && state.lastFailure.httpStatus === 403) {
        state.callbackProtocolVersion = 2;
        state.failures = 0;
        state.nextAtMs = Date.now();
        const health = this.runHealth(state);
        if (health) { health.cooldownUntilMs = 0; health.failures = 0; }
      }
      if (state.status === "failed" && state.lastFailure === undefined && state.run?.complete
        && !state.run.catalog && !state.run.pendingAttempt && !state.blockedGeneration) {
        state.lastFailure = null;
        state.failures = 0;
        state.nextAtMs = Date.now();
      }
      if (this.expireRun(state)) return;
      if (!this.accountFor(state, pool)) { await this.unavailablePool(state, pool); return; }
      state.blockedGeneration = null;
      await this.persist(state);
    });
  }

  async status(region: GameRecordsRegion): Promise<Record<string, unknown>> {
    const state = structuredClone(await this.stateFor(region));
    const unavailable = await officialCollectorAvailability(this.env, region);
    let pool: OfficialCollectorPool | null = null;
    try { pool = await configFor(this.env, region); } catch { /* Availability reports invalid configuration. */ }
    if (pool) this.synchronizePool(state, pool);
    const now = Date.now();
    const age = state.lastSuccessfulObservationAtMs === null ? null : now - state.lastSuccessfulObservationAtMs;
    const accounts = pool?.accounts ?? [];
    const ready = (account: OfficialCollectorAccount): boolean => account.enabled && account.ready
      && !state.accounts?.[account.identity]?.blocked[account.authGeneration];
    const canSchedule = !state.permissionPause && !state.legacyPermissionBlock && accounts.some(ready);
    const counts = { accounts: accounts.length, enabled: accounts.filter((account) => account.enabled).length,
      ready: state.permissionPause || state.legacyPermissionBlock ? 0 : accounts.filter((account) => ready(account)
        && account.availableAtMs <= now && (state.accounts?.[account.identity]?.cooldownUntilMs ?? 0) <= now && (state.accounts?.[account.identity]?.leaseUntilMs ?? 0) <= now).length,
      paused: accounts.filter((account) => Boolean(state.accounts?.[account.identity]?.blocked[account.authGeneration]) || !account.enabled || !account.ready).length,
      coolingDown: accounts.filter((account) => Math.max(account.availableAtMs, state.accounts?.[account.identity]?.cooldownUntilMs ?? 0) > now).length,
      leased: accounts.filter((account) => (state.accounts?.[account.identity]?.leaseUntilMs ?? 0) > now).length };
    return { contract: "haneoka:ranking-status/1", region, serverTimeMs: now, collectorStatus: unavailable ?? state.status,
      collectionEnabled: officialRegionEnabled(this.env.OFFICIAL_RANKING_ENABLED_REGIONS, region),
      readEnabled: officialRegionEnabled(this.env.OFFICIAL_RANKING_READ_REGIONS, region),
      samplingIntervalSeconds: INTERVAL_MS / 1000, lastSuccessfulObservationAtMs: state.lastSuccessfulObservationAtMs,
      ageMs: age, stale: age === null || age < 0 || age > 600_000, pollAfterSeconds: unavailable ? 300 : 30,
      lastFailure: state.lastFailure ?? null,
      pool: counts,
      nextAttemptAtMs: unavailable || !canSchedule ? null : state.nextAtMs || null, catalogProvider: "official-master" };
  }

  async collectDue(region: GameRecordsRegion): Promise<void> {
    const job = await this.serialized(async (): Promise<OfficialCollectorJob | null> => {
      const state = await this.stateFor(region);
      if (!officialRegionEnabled(this.env.OFFICIAL_RANKING_ENABLED_REGIONS, region)) { state.status = "disabled"; await this.persist(state, false); return null; }
      let pool: OfficialCollectorPool | null;
      try { pool = await configFor(this.env, region); }
      catch { state.status = "invalid_config"; await this.persist(state, false); return null; }
      if (!pool) { state.status = "not_configured"; await this.persist(state, false); return null; }
      this.synchronizePool(state, pool);
      if (this.expireRun(state)) { state.nextAtMs = Math.max(state.nextAtMs, (state.run?.deadlineMs ?? 0) + 15_000); await this.persist(state); return null; }
      const config = this.accountFor(state, pool);
      if (!config) { await this.unavailablePool(state, pool); return null; }
      if (state.nextAtMs > Date.now() + 1000) { await this.persist(state); return null; }
      const now = Date.now();
      const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
      const runId = crypto.randomUUID().replaceAll("-", "");
      state.run = { id: runId, token, generation: config.generation, accountIdentity: config.identity,
        authGeneration: config.authGeneration, apiOrigin: String(config.credentials.origin), startedAtMs: now, deadlineMs: now + JOB_MS,
        pendingAttempt: null, resolvedAttempt: false, complete: false, catalog: null, checkpoints: {} };
      const health = this.runHealth(state);
      if (health) { health.lastUsedAtMs = now; health.leaseUntilMs = now + JOB_MS + 15_000; }
      state.status = "collecting";
      state.lastFailure = null;
      state.blockedGeneration = null;
      state.lastRunAtMs = now;
      state.nextAtMs = now + INTERVAL_MS;
      let serviceToken = await this.ctx.storage.get<string>("containerToken");
      if (!serviceToken) { serviceToken = token; await this.ctx.storage.put("containerToken", serviceToken); }
      this.envVars = { OFFICIAL_COLLECTOR_TOKEN: serviceToken, OFFICIAL_CALLBACK_ORIGIN: CALLBACK_ORIGIN };
      await this.persist(state);
      return { contract: "haneoka:official-ranking-job/1", region, runId, credentialGeneration: config.generation,
        capabilities: ["arena-ranking-v1", "arena-population-v1", "arena-progress-v1", "arena-demand-v1", "player-demand-v1"],
        playerLookups: (state.playerInterests ?? []).filter((entry) => now - entry.requestedAtMs < DEMAND_TTL_MS).slice(0, 16).map((entry) => entry.id),
        songRankings: (state.songInterests ?? []).filter((entry) => now - entry.requestedAtMs < DEMAND_TTL_MS).slice(0, 4).map((entry) => entry.id),
        cardImages: (state.cardInterests ?? []).filter((entry) => now - entry.requestedAtMs < DEMAND_TTL_MS).slice(0, 32).map((entry) => entry.id),
        arenaProgress: Object.values(state.arenaProgress ?? {}).sort((a, b) => (a.updatedAtMs ?? 0) - (b.updatedAtMs ?? 0)),
        arenaWindows: (state.arenaInterests ?? []).filter((entry) => now - entry.requestedAtMs < ARENA_INTEREST_TTL_MS)
          .slice(0, 20).map(({ seasonId, bandId, startRank, endRank }) => ({ seasonId, bandId, startRank, endRank })),
        clientVersion: config.clientVersion, credentials: config.credentials, masterConfig: config.masterConfig,
        callbackUrl: `${CALLBACK_ORIGIN}/api/internal/official-rankings/${region}/${runId}`, callbackToken: token, deadlineMs: now + JOB_MS };
    });
    if (!job) return;
    let failure: OfficialCollectorFailure | null = null;
    try {
      const serviceToken = await this.ctx.storage.get<string>("containerToken");
      const response = await this.containerFetch("http://container/collect", { method: "POST",
        headers: { Authorization: `Bearer ${serviceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(job), signal: AbortSignal.timeout(JOB_MS + 15_000) });
      if (!response.ok) failure = await responseFailure(response) ?? { stage: "container", code: "http_error", httpStatus: response.status };
      else await response.body?.cancel();
    } catch (error) {
      failure = { stage: "container", code: error instanceof Error && error.name === "TimeoutError" ? "TimeoutError" : "container_fetch_failed" };
    }
    if (failure) console.warn(JSON.stringify({ event: "official_ranking_container_failed", region, ...failure }));
    await this.serialized(async () => {
      const state = await this.stateFor(region);
      if (!state.run || state.run.id !== job.runId || state.run.complete) return;
      state.run.complete = true;
      state.lastFailure = failure ?? { stage: "container", code: "container_fetch_failed" };
      state.failures += 1;
      state.nextAtMs = Math.max(state.nextAtMs, Date.now() + Math.min(3_600_000, INTERVAL_MS * 2 ** Math.min(4, state.failures - 1)));
      const health = this.runHealth(state);
      if (health) { health.leaseUntilMs = 0; health.failures += 1; health.cooldownUntilMs = state.nextAtMs; }
      if (state.run.pendingAttempt && !state.run.resolvedAttempt && !state.blockedGeneration) {
        this.pauseRun(state, "auth_uncertain");
      }
      else if (!state.blockedGeneration && state.status !== "rate_limited") state.status = "failed";
      await this.persist(state, !state.permissionPause && !state.legacyPermissionBlock);
    });
  }

  async callback(request: Request, region: GameRecordsRegion, runId: string): Promise<Response> {
    if (request.method !== "POST" || !/^[a-f0-9]{32}$/u.test(runId)) return json({ error: "invalid_request" }, 400);
    const state = await this.stateFor(region);
    const authorization = request.headers.get("Authorization") ?? "";
    if (!state.run || state.run.id !== runId || !authorization.startsWith("Bearer ")
      || !await sameToken(authorization.slice(7), state.run.token)) return json({ error: "unauthorized" }, 401);
    let update: OfficialCollectorUpdate;
    try { update = await boundedUpdate(request); }
    catch { return json({ error: "invalid_update" }, 400); }
    return this.serialized(async () => {
      const state = await this.stateFor(region);
      const run = state.run;
      if (!run || run.id !== runId || update.contract !== "haneoka:official-ranking-update/1"
        || update.region !== region || update.runId !== runId || update.credentialGeneration !== run.generation) return json({ error: "run_mismatch" }, 409);
      if (!run.accountIdentity) {
        try { const pool = await configFor(this.env, region); if (pool) this.synchronizePool(state, pool); }
        catch { return json({ error: "invalid_config" }, 409); }
      }
      let checkpoint: string;
      if (update.type === "catalog" || update.type === "complete") checkpoint = update.type;
      else if (update.type === "attempt") checkpoint = `attempt:${update.snapshotId}`;
      else if (update.type === "observation") checkpoint = `observation:${update.observation?.snapshotId}`;
      else if (update.type === "arena-observation") checkpoint = `arena:${update.observation?.snapshotId}`;
      else if (update.type === "arena-population") checkpoint = `arena-population:${update.observation?.snapshotId}`;
      else if (update.type === "arena-progress") checkpoint = `arena-progress:${update.checkpointId}`;
      else if (update.type === "player-profile") checkpoint = `player:${update.profileId}`;
      else if (update.type === "song-ranking") checkpoint = `song:${update.musicId}`;
      else if (update.type === "card-image") checkpoint = `card:${update.file}`;
      else return json({ error: "invalid_update" }, 400);
      const updateHash = await officialDigest(canonical(update));
      if (run.checkpoints[checkpoint]) {
        if (run.checkpoints[checkpoint] !== updateHash) return json({ error: "checkpoint_conflict" }, 409);
        if (update.type === "attempt" && (run.complete || run.pendingAttempt !== update.snapshotId || state.blockedGeneration)) {
          return json({ error: "attempt_finished" }, 409);
        }
        return json({ ok: true });
      }
      if (run.complete) return json({ error: "run_finished" }, 409);
      if (Date.now() > run.deadlineMs + 10_000) return json({ error: "run_expired" }, 409);
      try {
        if (update.type === "catalog") {
          validateCatalog(update.catalog, region);
          if (run.apiOrigin && update.catalog.apiOrigin !== run.apiOrigin) return json({ error: "catalog_origin_mismatch" }, 409);
          if (run.pendingAttempt) return json({ error: "attempt_pending" }, 409);
          await saveOfficialCatalog(this.env, update.catalog);
          run.catalog = update.catalog;
          if (update.catalog.arena !== undefined) {
            const arena = update.catalog.arena, previous = state.arenaCatalog;
            const sameSeason = arena?.seasonId === previous?.seasonId;
            if (!arena || !sameSeason || arena?.bandIds.length !== previous?.bandIds.length
              || arena?.bandIds.some((id) => !previous?.bandIds.includes(id))) state.arenaWarmupRuns = 0;
            const activeBands = new Set(arena?.bandIds.map((id) => `${arena.seasonId}:${id}`));
            state.arenaPopulationAt = Object.fromEntries(Object.entries(state.arenaPopulationAt ?? {}).filter(([key]) => activeBands.has(key)));
            state.arenaProgress = Object.fromEntries(Object.entries(state.arenaProgress ?? {})
              .filter(([, progress]) => arena?.seasonId === progress.seasonId && arena.bandIds.includes(progress.bandId)));
            const signatures: Record<string, number[]> = {};
            for (const bandId of arena?.bandIds ?? []) {
              const key = `${arena!.seasonId}:${bandId}`;
              const before = sameSeason ? previous?.thresholdsByBand?.[bandId] : undefined;
              const next = arena!.thresholdsByBand?.[bandId] ?? before;
              if (!next) continue;
              if (!before && state.arenaPopulationAt[key] === undefined) state.arenaWarmupRuns = 0;
              signatures[bandId] = next;
              const progress = state.arenaProgress[key];
              if (progress && !sameThresholds(progress.thresholds, next)) {
                delete state.arenaProgress[key];
                state.arenaWarmupRuns = 0;
              }
              if (before && !sameThresholds(before, next)) {
                delete state.arenaPopulationAt[key];
                state.arenaWarmupRuns = 0;
              } else if (!before && state.arenaPopulationAt[key] !== undefined) {
                const population = await readOfficialArenaPopulation(this.env, region, arena!.seasonId, bandId);
                if (!sameThresholds(population?.atLeast.map((row) => row.threshold), next)) {
                  delete state.arenaPopulationAt[key];
                  state.arenaWarmupRuns = 0;
                }
              }
            }
            state.arenaCatalog = arena ? { ...arena, ...(Object.keys(signatures).length ? { thresholdsByBand: signatures } : {}) } : null;
            state.arenaInterests = (state.arenaInterests ?? []).filter((entry) => arena?.seasonId === entry.seasonId
              && arena.bandIds.includes(entry.bandId) && Date.now() < arena.rankingEndAtMs
              && Date.now() - entry.requestedAtMs < ARENA_INTEREST_TTL_MS);
          }
          run.checkpoints[checkpoint] = updateHash;
          await this.ctx.storage.put("collectorState", state);
        } else if (update.type === "attempt") {
          if (!/^[a-f0-9]{32}$/u.test(update.snapshotId) || run.pendingAttempt || state.blockedGeneration || !(run.catalog?.event || run.catalog?.arena)) return json({ error: "attempt_pending" }, 409);
          run.pendingAttempt = update.snapshotId;
          run.resolvedAttempt = false;
          run.checkpoints[checkpoint] = updateHash;
          await this.ctx.storage.put("collectorState", state);
        } else if (update.type === "observation") {
          validateObservation(update.observation, region);
          if (run.pendingAttempt !== update.observation.snapshotId) return json({ error: "attempt_mismatch" }, 409);
          const event = run.catalog?.event;
          if (!event || update.observation.eventId !== event.id || update.observation.observedAtMs < run.startedAtMs
            || (update.observation.kind === "total" ? !event.totalRankingEnabled
              : update.observation.kind === "point" ? !event.pointRankingEnabled
              : !event.challenges.some((challenge) => challenge.id === update.observation.challengeId && challenge.enabled))) {
            return json({ error: "board_mismatch" }, 409);
          }
          run.resolvedAttempt = true;
          if (authRejected(update.observation)) this.pauseRun(state, "auth_paused", permissionRejected(update.observation));
          if (limited(update.observation)) {
            state.status = "rate_limited";
            state.nextAtMs = Math.max(state.nextAtMs, Date.now() + retryMs(update.observation.retryAfterSeconds));
            const health = this.runHealth(state);
            if (health) health.cooldownUntilMs = state.nextAtMs;
          }
          await this.ctx.storage.put("collectorState", state);
          await saveOfficialObservation(this.env, update.observation);
          if (update.observation.players) await harvestOfficialPlayers(this.env, region, update.observation.players, update.observation.observedAtMs);
          run.pendingAttempt = null;
          run.checkpoints[checkpoint] = updateHash;
          if (!update.observation.error) {
            state.lastSuccessfulObservationAtMs = Math.max(state.lastSuccessfulObservationAtMs ?? 0, update.observation.observedAtMs);
            const health = this.runHealth(state);
            if (health) health.lastSuccessAtMs = Math.max(health.lastSuccessAtMs ?? 0, update.observation.observedAtMs);
          }
          await this.ctx.storage.put("collectorState", state);
        } else if (update.type === "player-profile") {
          if (!decimal(update.profileId) || !Number.isSafeInteger(update.observedAtMs)) return json({ error: "invalid_update" }, 400);
          await saveOfficialPlayers(this.env, region, [{ profileId: update.profileId, found: update.found === true,
            profile: update.profile ?? null, totalFavorite: update.totalFavorite ?? null, observedAtMs: update.observedAtMs }]);
          state.playerInterests = (state.playerInterests ?? []).filter((entry) => entry.id !== update.profileId);
          run.checkpoints[checkpoint] = updateHash;
          await this.ctx.storage.put("collectorState", state);
        } else if (update.type === "card-image") {
          if (!CARD_FILE.test(update.file) || typeof update.data !== "string") return json({ error: "invalid_update" }, 400);
          await saveOfficialCardImage(this.env, region, update.file, Uint8Array.from(atob(update.data), (character) => character.charCodeAt(0)));
          state.cardInterests = (state.cardInterests ?? []).filter((entry) => entry.id !== update.file);
          run.checkpoints[checkpoint] = updateHash;
          await this.ctx.storage.put("collectorState", state);
        } else if (update.type === "song-ranking") {
          if (!decimal(update.musicId) || !Array.isArray(update.players) || update.players.length > 100
            || !Number.isSafeInteger(update.observedAtMs)) return json({ error: "invalid_update" }, 400);
          await saveOfficialSongRanking(this.env, { region, musicId: update.musicId, players: update.players, observedAtMs: update.observedAtMs });
          await harvestOfficialPlayers(this.env, region, update.players, update.observedAtMs);
          state.songInterests = (state.songInterests ?? []).filter((entry) => entry.id !== update.musicId);
          run.checkpoints[checkpoint] = updateHash;
          await this.ctx.storage.put("collectorState", state);
        } else if (update.type === "arena-observation") {
          validateArenaObservation(update.observation, region);
          if (run.pendingAttempt !== update.observation.snapshotId) return json({ error: "attempt_mismatch" }, 409);
          const arena = run.catalog?.arena;
          if (!arena || update.observation.seasonId !== arena.seasonId || !arena.bandIds.includes(update.observation.bandId)
            || update.observation.observedAtMs < run.startedAtMs) {
            return json({ error: "board_mismatch" }, 409);
          }
          run.resolvedAttempt = true;
          if (authRejected(update.observation)) this.pauseRun(state, "auth_paused", permissionRejected(update.observation));
          if (limited(update.observation)) {
            state.status = "rate_limited";
            state.nextAtMs = Math.max(state.nextAtMs, Date.now() + retryMs(update.observation.retryAfterSeconds));
            const health = this.runHealth(state);
            if (health) health.cooldownUntilMs = state.nextAtMs;
          }
          await this.ctx.storage.put("collectorState", state);
          await saveOfficialArenaObservation(this.env, update.observation);
          if (!update.observation.error) {
            const observation = update.observation;
            state.arenaInterests = (state.arenaInterests ?? []).filter((entry) => entry.seasonId !== observation.seasonId
              || entry.bandId !== observation.bandId || entry.startRank !== observation.startRank
              || observation.endRank < Math.min(entry.endRank, observation.maxRank ?? entry.endRank)
              || observation.players!.length < Math.max(0, Math.min(entry.endRank, observation.maxRank ?? entry.endRank) - entry.startRank + 1));
          }
          run.pendingAttempt = null;
          run.checkpoints[checkpoint] = updateHash;
          if (!update.observation.error) {
            state.lastSuccessfulObservationAtMs = Math.max(state.lastSuccessfulObservationAtMs ?? 0, update.observation.observedAtMs);
            const health = this.runHealth(state);
            if (health) health.lastSuccessAtMs = Math.max(health.lastSuccessAtMs ?? 0, update.observation.observedAtMs);
          }
          await this.ctx.storage.put("collectorState", state);
        } else if (update.type === "arena-progress") {
          validateArenaProgress(update.progress);
          const arena = run.catalog?.arena, progress = update.progress;
          if (!/^[a-f0-9]{32}$/u.test(update.checkpointId) || run.pendingAttempt || !arena
            || progress.seasonId !== arena.seasonId || !arena.bandIds.includes(progress.bandId)) return json({ error: "board_mismatch" }, 409);
          const expected = arena.thresholdsByBand?.[progress.bandId];
          if (expected && !sameThresholds(expected, progress.thresholds)) return json({ error: "board_mismatch" }, 409);
          state.arenaProgress ??= {};
          state.arenaProgress[`${progress.seasonId}:${progress.bandId}`] = {
            seasonId: progress.seasonId, bandId: progress.bandId, thresholds: progress.thresholds,
            maxRank: progress.maxRank, counts: progress.counts, cursor: progress.cursor,
            ...(progress.pending ? { pending: { index: progress.pending.index, low: progress.pending.low, high: progress.pending.high } } : {}), updatedAtMs: Date.now(),
          };
          run.checkpoints[checkpoint] = updateHash;
          await this.ctx.storage.put("collectorState", state);
        } else if (update.type === "arena-population") {
          validateArenaPopulation(update.observation, region);
          const arena = run.catalog?.arena;
          if (run.pendingAttempt || state.blockedGeneration || !arena || update.observation.seasonId !== arena.seasonId
            || !arena.bandIds.includes(update.observation.bandId) || update.observation.observedAtMs < run.startedAtMs) {
            return json({ error: "board_mismatch" }, 409);
          }
          const expected = arena.thresholdsByBand?.[update.observation.bandId];
          if (expected && !sameThresholds(expected, update.observation.atLeast.map((row) => row.threshold))) return json({ error: "board_mismatch" }, 409);
          await saveOfficialArenaPopulation(this.env, update.observation);
          state.arenaPopulationAt ??= {};
          state.arenaPopulationAt[`${update.observation.seasonId}:${update.observation.bandId}`] = update.observation.observedAtMs;
          run.checkpoints[checkpoint] = updateHash;
          await this.ctx.storage.put("collectorState", state);
        } else if (update.type === "complete") {
          if (run.pendingAttempt || !["ok", "failed", "auth_paused", "rate_limited"].includes(update.status)) return json({ error: "attempt_pending" }, 409);
          if (update.failure !== undefined) validateFailure(update.failure);
          run.complete = true;
          state.lastFailure = update.failure ? { stage: update.failure.stage, code: update.failure.code,
            ...(update.failure.httpStatus !== undefined ? { httpStatus: update.failure.httpStatus } : {}),
            ...(update.failure.grpcStatus !== undefined ? { grpcStatus: update.failure.grpcStatus } : {}) } : null;
          state.status = state.blockedGeneration ? state.status : state.status === "rate_limited" ? "rate_limited" : update.status;
          state.failures = update.status === "ok" ? 0 : state.failures + 1;
          if (update.status === "auth_paused") this.pauseRun(state, "auth_paused", update.failure ? permissionRejected(update.failure) : false);
          if (update.status === "rate_limited") state.nextAtMs = Math.max(state.nextAtMs, Date.now() + retryMs(update.retryAfterSeconds));
          if (update.status === "failed") state.nextAtMs = Math.max(state.nextAtMs, Date.now() + Math.min(3_600_000, INTERVAL_MS * 2 ** Math.min(4, state.failures - 1)));
          const arena = run.catalog?.arena === undefined ? null : state.arenaCatalog;
          const cold = arena && Date.now() < arena.rankingEndAtMs && arena.bandIds.some((id) => arena.thresholdsByBand?.[id]?.length !== 0
            && !state.arenaPopulationAt?.[`${arena.seasonId}:${id}`]);
          if (update.status === "ok" && cold && (state.arenaWarmupRuns ?? 0) < 20) {
            state.arenaWarmupRuns = (state.arenaWarmupRuns ?? 0) + 1;
            this.expediteArena(state);
          } else if (update.status === "ok" && (state.arenaInterests?.length || state.playerInterests?.length || state.songInterests?.length || state.cardInterests?.length)) this.expediteArena(state);
          const health = this.runHealth(state);
          if (health) {
            health.leaseUntilMs = 0;
            health.failures = update.status === "ok" ? 0 : health.failures + 1;
            if (update.status === "failed" || update.status === "rate_limited") health.cooldownUntilMs = Math.max(health.cooldownUntilMs, state.nextAtMs);
          }
          run.checkpoints[checkpoint] = updateHash;
          await this.persist(state, !state.permissionPause && !state.legacyPermissionBlock);
        } else return json({ error: "invalid_update" }, 400);
      } catch (error) {
        console.warn(JSON.stringify({ event: "official_ranking_checkpoint_failed", region, error: error instanceof Error ? error.name : "Error" }));
        return json({ error: "checkpoint_failed" }, 503);
      }
      return json({ ok: true });
    });
  }

  override async fetch(): Promise<Response> { return json({ error: "not_found" }, 404); }
}
