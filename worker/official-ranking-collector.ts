// L3 — GEB
// Input: Regional configuration, account-login requests, container results and scheduled collection work.
// Output: Regional observations, serialized account jobs, session renewal, redacted pool health, anonymous Version diagnostics and durable 150-second window admission.
// Pos: [Map](L2.md); official collector coordination and recovery.
// Effects/Dependencies: Starts isolated containers or calls the self-hosted collector, persists DO state and writes D1/R2; credentials stay server-side.
import { Container } from "@cloudflare/containers";
import { adoptConfiguredPlatformAccounts, bindPlatformSdkIdentity, claimPlatformBatch, claimPlatformSdkOwner, claimPlatformLogin, finishPlatformLogin, limitPlatformLoginLease, listPlatformAccounts, platformBatchCurrent, platformDeviceId, platformSdkScopes, readPlatformLoginInput, readPlatformPassword, readPlatformPlayerIds, readPlatformBootstraps, readRemovedPlayerIds, readPlatformSdkIdentity, readPlatformSdkSession, readReadyPlatformAccounts, releasePlatformBatch, releasePlatformLogin, savePlatformSdkSession,
  type PlatformLoginLease, type PlatformLoginResult, type PlatformRegion } from "./official-platform-accounts";
import { AccountJobContractError, globalLoginConfiguration, platformLoginResult, platformSdkResult } from "./official-account-jobs";
import { adoptGuestAccount, claimGuestRegistration, claimGuestVerification, createGuestAccount, finishGuestRegistrationFailure, finishGuestVerification, listGuestAccounts,
  readGuestAccountState, readGuestConfiguration, readGuestPlayerIds, readGuestRequest, readGuestVerificationInput,
  readReadyGuestAccounts, saveGuestRegistration, saveGuestRequest, type GuestLease } from "./official-guest-accounts";
import { GuestJobContractError, guestConfiguration, guestPhaseResult, type GuestConfiguration, type GuestPhaseResult } from "./official-guest-jobs";
import type { GameRecordsRegion } from "../src/lib/game-records";
import { OFFICIAL_API_ORIGINS as REGION_ORIGINS, normalizeOfficialPlayerId, parseOfficialCollectorConfiguration, selectOfficialCollectorAccount,
  type OfficialCollectorAccount, type OfficialCollectorAccountHealth, type OfficialCollectorPool,
  type OfficialArenaObservation, type OfficialArenaPopulationObservation, type OfficialArenaProgress, type OfficialCatalog, type OfficialEventWindow, type OfficialCollectorFailure, type OfficialCollectorJob, type OfficialCollectorUpdate, type OfficialObservation } from "../src/lib/official-ranking";
import { flushOfficialPayloads, pruneOfficialObservations, readOfficialCatalog, takeOfficialFinalTarget, saveOfficialFinalArenaProgress, saveOfficialEventWindow, harvestOfficialPlayers, saveOfficialCardImage, saveOfficialPlayers, saveOfficialSongRanking, officialDigest, readOfficialArenaMetadata, readOfficialArenaPopulation, saveOfficialArenaObservation, saveOfficialArenaPopulation, saveOfficialCatalog, saveOfficialObservation } from "./official-ranking-store";

export const OFFICIAL_RANKING_REGIONS = ["jp", "tw", "en", "kr"] as const;
export type OfficialCollectorConfigurationBindings = Partial<Pick<Env,
  "OFFICIAL_RANKING_JP_CONFIG" | "OFFICIAL_RANKING_TW_CONFIG" | "OFFICIAL_RANKING_EN_CONFIG" | "OFFICIAL_RANKING_KR_CONFIG"
>> & { OFFICIAL_RANKING_ENABLED_REGIONS?: string };
const INTERVAL_MS = 300_000;
const JOB_MS = 120_000;
const LOOKUP_MS = 60_000;
const WINDOW_REUSE_MS = 150_000;
const ARENA_DEMAND_INTERVAL_MS = 60_000;
/** The collector reuses counts read in the last five minutes; one more covers clock skew. */
const ARENA_WITNESS_REUSE_MS = 360_000;
const ARENA_POPULATION_TARGET_MS = 1_200_000;
const ARENA_POPULATION_CATCHUP_MS = ARENA_POPULATION_TARGET_MS - INTERVAL_MS;
const ARENA_INTEREST_TTL_MS = 3_600_000;
/** Windows past the top 100 each run refreshes in turn; within the container's 40 s Arena demand budget. */
const ARENA_SWEEP_WINDOWS = 20;
/** Ranks searched by player ID stay freshest: three windows in four go to them. */
const ARENA_NEAR_RANKS = 2000;
/** Event point windows past the top 100 each run refreshes in turn. */
const EVENT_SWEEP_WINDOWS = 9;
/** Rejections in a row before an account is paused; each one rests it this much longer, and any success clears them. */
const AUTH_STRIKES = 3;
const AUTH_RETRY_MS = 900_000;
const DEMAND_TTL_MS = 600_000;
const DEMAND_LIMITS = { player: 64, song: 8, card: 128 };
const CARD_FILE = /^[1-9][0-9]{0,18}_[A-Za-z0-9_.-]{1,200}$/u;
type EventInterest = NonNullable<OfficialCollectorJob["eventWindows"]>[number] & { requestedAtMs: number };
type ArenaInterest = NonNullable<OfficialCollectorJob["arenaWindows"]>[number] & { requestedAtMs: number };
const MAX_UPDATE_BYTES = 8 * 1024 * 1024;

type JsonObject = Record<string, unknown>;
interface PlatformRenewal {
  accountId: string; accountVersion: number; identity: string;
  generation: string; authGeneration: string; notBeforeMs: number;
}
interface PendingPlatformLogin extends PlatformLoginLease { batchId?: string; batchDeadlineMs?: number; started: boolean; claimed?: boolean; reuseSdk?: boolean; remainingRegions?: PlatformRegion[]; automatic?: PlatformRenewal }
interface PlatformCascade { batchId: string; accountId: string; accountVersion: number; regions: PlatformRegion[]; deadlineMs: number }
interface PendingGuestJob extends GuestLease { action: "register" | "verify"; started: boolean; recovering?: boolean }
interface PreparedGuestJob {
  lease: GuestLease; action: "register" | "verify"; config: GuestConfiguration; token: string;
  job?: JsonObject; playerId?: string;
}
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
  pendingWindowKey?: string;
  resolvedAttempt: boolean;
  authStruck?: boolean;
  complete: boolean;
  catalog: OfficialCatalog | null;
  finalEvent?: OfficialCollectorJob["finalEvent"];
  finalBoards?: OfficialCollectorJob["finalBoards"];
  finalWindows?: OfficialCollectorJob["eventWindows"];
  finalArena?: OfficialCollectorJob["finalArena"];
  finalArenaWindows?: OfficialCollectorJob["arenaWindows"];
  finalPopulationBands?: string[];
  checkpoints: Record<string, string>;
  arenaProbes?: boolean;
  sweepWindows?: Array<{ seasonId: string; bandId: string; startRank: number; endRank: number }>;
  eventSweepWindows?: Array<{ eventId: string; startRank: number; endRank: number }>;
  /** Admitted requests; progress narrows these to the subset actually attempted. */
  attempted?: { player: string[]; song: string[]; card: string[] };
  songOnly?: boolean;
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
  arenaProbeReads?: number;
  arenaStoredReads?: number;
  windowReuses?: number;
  windowDeferrals?: number;
  populationWorkKey?: string;
  populationWorkStreak?: number;
  blockedGeneration: string | null;
  callbackProtocolVersion?: number;
  accountBootstrapDigest?: string;
  readRecoveryVersion?: number;
  accounts?: Record<string, OfficialCollectorAccountHealth>;
  permissionPause?: { identity: string; authGeneration: string } | null;
  legacyPermissionBlock?: string | null;
  lastFailure?: OfficialCollectorFailure | null;
  run: CollectorRun | null;
  /** The short demand-only job, separate from collection so a lookup never waits for one. */
  lookup?: CollectorRun | null;
  lookupFailures?: number;
  lookupNextAtMs?: number;
  songLookupNextAtMs?: number;
  songLookupFailures?: number;
  lookupLastFailure?: OfficialCollectorFailure | null;
  arenaProgress?: Record<string, OfficialArenaProgress>;
  arenaCatalog?: OfficialCatalog["arena"];
  /** Next window past the top 100 that each `season:band` board refreshes, and the band whose turn it is. */
  arenaSweep?: { band: number; next: Record<string, number> };
  eventSweep?: { eventId: string; next: number; maxRank: number | null };
  eventInterests?: EventInterest[];
  strikesApplied?: boolean;
  arenaInterests?: ArenaInterest[];
  playerInterests?: DemandInterest[];
  songInterests?: DemandInterest[];
  cardInterests?: DemandInterest[];
  arenaPopulationAt?: Record<string, number>;
  arenaWarmupRuns?: number;
  nextFinalAtMs?: number;
  platformRenewals?: Record<string, PlatformRenewal>;
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
function observationWindowKey(value: OfficialObservation | OfficialArenaObservation | OfficialEventWindow): string {
  if ("seasonId" in value) return `arena/${value.seasonId}/${value.bandId}/${value.startRank}/${value.endRank}`;
  if ("startRank" in value) return `event/${value.eventId}/point/${value.startRank}/${value.endRank}`;
  return `event/${value.eventId}/${value.kind === "challenge" ? `challenge/${value.challengeId}` : value.kind === "point" ? "point/1/100" : "total"}`;
}
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
function sessionRejected(value: { httpStatus?: number | null; grpcStatus?: string | null; error?: string | null }): boolean {
  return !permissionRejected(value) && !limited(value) && (value.httpStatus === 401 || value.grpcStatus === "16"
    || value.grpcStatus === "2" && value.error === "authentication_failed");
}
function rejectedSessionFailure(update: Extract<OfficialCollectorUpdate, { type: "complete" }>): boolean {
  const failure = update.failure;
  return update.status === "auth_paused" && !!failure && ["board", "arena_board", "demand"].includes(failure.stage)
    && sessionRejected({ ...failure, error: "authentication_failed" });
}
function limited(observation: Pick<OfficialObservation, "httpStatus" | "grpcStatus">): boolean { return observation.httpStatus === 429 || observation.grpcStatus === "8"; }
function permissionRejected(value: { httpStatus?: number | null; grpcStatus?: string | null }): boolean {
  return value.httpStatus === 403 || value.grpcStatus === "7";
}
function poolAccountStatus(account: OfficialCollectorAccount, health: OfficialCollectorAccountHealth | undefined, now: number): string {
  const blocked = health?.blocked[account.authGeneration] ?? account.initialPause;
  return !account.enabled || !account.ready ? "disabled" : health?.held ? "held" : blocked ? blocked
    : (health?.leaseUntilMs ?? 0) > now ? "working"
    : Math.max(account.availableAtMs, health?.cooldownUntilMs ?? 0) > now ? "cooling_down" : "ready";
}
function validateFailure(value: unknown): asserts value is OfficialCollectorFailure {
  const failure = object(value);
  if (!["container", "catalog", "catalog_version", "catalog_server_list", "catalog_manifest", "catalog_event", "catalog_challenges", "catalog_parameters",
    "catalog_callback", "version", "board", "attempt_callback", "observation_callback", "complete_callback",
    "demand", "arena_board", "arena_observation_callback", "arena_population_callback", "arena_progress_callback",
    "catalog_arena_season", "catalog_arena_league", "catalog_arena_rank"].includes(String(failure.stage))
    || !["Error", "TimeoutError", "SSLError", "SSLCertVerificationError", "OSError", "URLError", "gaierror", "ValueError", "RuntimeError", "VersionError",
      "CatalogRequestError", "CallbackError", "ImportError", "ModuleNotFoundError", "FileNotFoundError", "PermissionError", "JSONDecodeError",
      "ConnectionError", "ConnectionRefusedError", "ConnectionResetError", "ProtocolError", "H2Error", "KeyError", "TypeError", "AttributeError", "InterruptedError", "http_error", "container_fetch_failed"].includes(String(failure.code))
    || failure.httpStatus !== undefined && (typeof failure.httpStatus !== "number" || !Number.isInteger(failure.httpStatus) || failure.httpStatus < 100 || failure.httpStatus > 599)
    || failure.grpcStatus !== undefined && (typeof failure.grpcStatus !== "string" || !/^[0-9]{1,3}$/u.test(failure.grpcStatus))
    || (failure.clientVersion !== undefined || failure.upstreamMessage !== undefined) && !["catalog_version", "version"].includes(String(failure.stage))
    || failure.clientVersion !== undefined && (typeof failure.clientVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(failure.clientVersion))
    || failure.upstreamMessage !== undefined && (typeof failure.upstreamMessage !== "string" || failure.upstreamMessage.length > 256)
    || failure.location !== undefined && (typeof failure.location !== "string" || !/^[A-Za-z0-9_.-]{1,100}:[1-9][0-9]{0,6}$/u.test(failure.location))) throw new Error("invalid_failure");
}
function transientCollectorFailure(failure: OfficialCollectorFailure | null | undefined): boolean {
  if (!failure) return true;
  if (failure.stage === "container" || failure.stage.startsWith("catalog") || failure.stage === "version" || failure.stage.endsWith("_callback")) return true;
  return ![401, 403, 429].includes(failure.httpStatus ?? 0) && !["7", "8", "16"].includes(failure.grpcStatus ?? "");
}
const recoveryDelay = (failures: number): number => Math.min(120_000, 15_000 * 2 ** Math.min(3, Math.max(0, failures - 1)));
async function responseFailure(response: Response): Promise<OfficialCollectorFailure | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let oversized = false;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 1024) { oversized = true; chunks.length = 0; }
      if (!oversized) chunks.push(next.value);
    }
    if (oversized) return null;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const failure: unknown = object(JSON.parse(new TextDecoder().decode(bytes))).failure;
    validateFailure(failure);
    return { stage: failure.stage, code: failure.code,
      ...(typeof failure.location === "string" && /^[A-Za-z0-9_.-]{1,100}:[1-9][0-9]{0,6}$/u.test(failure.location) ? { location: failure.location } : {}),
      ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
      ...(failure.grpcStatus !== undefined ? { grpcStatus: failure.grpcStatus } : {}) };
  } catch { return null; }
  finally { reader.releaseLock(); }
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

function validateEventWindow(value: unknown, region: GameRecordsRegion): asserts value is OfficialEventWindow {
  const observation = object(value);
  const start = observation.startRank, end = observation.endRank;
  if (observation.region !== region || typeof observation.snapshotId !== "string" || !/^[a-f0-9]{32}$/u.test(observation.snapshotId)
    || !decimal(observation.eventId) || !millis(observation.observedAtMs) || observation.observedAtMs > Date.now() + 60_000
    || typeof start !== "number" || !Number.isSafeInteger(start) || start < 1 || (start - 1) % 100 !== 0 || end !== start + 99
    || !(observation.maxRank == null || typeof observation.maxRank === "number" && Number.isSafeInteger(observation.maxRank) && observation.maxRank >= 0)) {
    throw new Error("invalid_observation");
  }
  if (observation.error !== undefined) {
    if (typeof observation.error !== "string" || !/^[A-Za-z0-9_]{1,80}$/u.test(observation.error) || observation.players !== undefined) throw new Error("invalid_observation");
    return;
  }
  if (!Array.isArray(observation.players) || observation.players.length > 100) throw new Error("invalid_observation");
  for (const row of observation.players) {
    const player = object(row);
    if (!(typeof player.point === "number" && Number.isSafeInteger(player.point) && player.point >= 0)
      || typeof player.rank !== "number" || player.rank < start || player.rank > end) throw new Error("invalid_observation_point");
  }
}

function validateArenaProgress(value: unknown): asserts value is OfficialArenaProgress {
  const reason = object(value).deferredReason;
  if (reason !== undefined && reason !== "budget" && reason !== "changed") throw new Error("invalid_population_progress");
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
  const counts = progress.counts, witnessed = progress.witnessedAtMs;
  if (witnessed !== undefined && (!Array.isArray(witnessed) || witnessed.length !== counts.length
    || witnessed.some((at, index) => at !== null && (!millis(at) || at > Date.now() + 60_000 || counts[index] === null)))) {
    throw new Error("invalid_arena_progress");
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

  /**
   * With OFFICIAL_COLLECTOR_REMOTE_ORIGIN set, the collector runs on a host
   * outside Cloudflare and no Container starts. Requests keep their path and
   * body and carry the shared remote token instead of this object's own.
   */
  override async containerFetch(requestOrUrl: Request | string | URL, portOrInit?: number | RequestInit, portParam?: number): Promise<Response> {
    const origin = this.env.OFFICIAL_COLLECTOR_REMOTE_ORIGIN;
    if (!origin) return super.containerFetch(requestOrUrl, portOrInit, portParam);
    const token = this.env.OFFICIAL_COLLECTOR_REMOTE_TOKEN;
    if (!token || token.length < 32) throw new Error("remote_collector_token_missing");
    const request = requestOrUrl instanceof Request
      ? requestOrUrl
      : new Request(String(requestOrUrl), typeof portOrInit === "object" ? portOrInit : undefined);
    const target = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(new URL(target.pathname + target.search, origin), {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer(),
      signal: request.signal,
      redirect: "manual",
    });
  }
  override pingEndpoint = "container/health";
  /** Where the collector reports runs: the site, or the collector host itself when it runs there. */
  private get callbackOrigin(): string { return this.env.OFFICIAL_CALLBACK_ORIGIN ?? "https://haneoka.org"; }
  private mutations: Promise<void> = Promise.resolve();

  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS collector_window_cache (
      window_key TEXT PRIMARY KEY, attempted_at_ms INTEGER NOT NULL, snapshot_id TEXT NOT NULL,
      observation_json TEXT, retained INTEGER NOT NULL DEFAULT 0)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS collector_window_replies (
      snapshot_id TEXT PRIMARY KEY, expires_at_ms INTEGER NOT NULL, update_hash TEXT NOT NULL, body_json TEXT NOT NULL)`);
    ctx.blockConcurrencyWhile(async () => {
      let token = await ctx.storage.get<string>("containerToken");
      if (!token) {
        token = crypto.randomUUID() + crypto.randomUUID();
        await ctx.storage.put("containerToken", token);
      }
      this.envVars = { OFFICIAL_COLLECTOR_TOKEN: token, OFFICIAL_CALLBACK_ORIGIN: this.callbackOrigin };
    });
  }

  /** Hands this object's state to the collector host and stops it scheduling anything more. */
  async exportForHost(): Promise<{ storage: Record<string, unknown>; tables: Record<string, unknown[]> }> {
    const tables: Record<string, unknown[]> = {};
    for (const table of ["container_schedules", "collector_window_cache", "collector_window_replies"]) {
      try { tables[table] = this.ctx.storage.sql.exec(`SELECT * FROM ${table}`).toArray(); } catch { tables[table] = []; }
    }
    try { this.ctx.storage.sql.exec("DELETE FROM container_schedules"); } catch { /* no schedules yet */ }
    const storage = Object.fromEntries(await this.ctx.storage.list());
    return { storage, tables };
  }

  collectorRuntimeInfo() {
    return { interfaceVersion: 3, serviceAuthReady: Boolean(this.envVars?.OFFICIAL_COLLECTOR_TOKEN) };
  }

  async pruneObservations(region: GameRecordsRegion): Promise<number> {
    return this.serialized(async () => {
      this.ctx.storage.sql.exec("DELETE FROM collector_window_cache WHERE attempted_at_ms<?", Date.now() - 2 * WINDOW_REUSE_MS);
      this.ctx.storage.sql.exec("DELETE FROM collector_window_replies WHERE expires_at_ms<?", Date.now());
      await flushOfficialPayloads(this.env, region);
      return pruneOfficialObservations(this.env, region);
    });
  }

  private validWindow(run: CollectorRun, key: string): boolean {
    const [kind, id, board, start, end] = key.split("/");
    const event = run.catalog?.event, arena = run.catalog?.arena;
    if (kind === "event" && event && id === event.id) {
      if (board === "total" && key === `event/${id}/total`) return event.totalRankingEnabled;
      if (board === "challenge" && key === `event/${id}/challenge/${start}`)
        return event.challenges.some((row) => row.id === start && row.enabled);
      if (board !== "point" || !event.pointRankingEnabled) return false;
    } else if (kind !== "arena" || !arena || id !== arena.seasonId || !arena.bandIds.includes(board!)) return false;
    const first = Number(start), last = Number(end);
    return key === `${kind}/${id}/${board}/${first}/${last}` && Number.isSafeInteger(first) && first > 0
      && (first - 1) % 100 === 0 && last === first + 99;
  }

  private async claimWindow(state: CollectorState, run: CollectorRun,
    update: Extract<OfficialCollectorUpdate, { type: "attempt" }>, updateHash: string): Promise<Response | null> {
    const key = update.windowKey!;
    if (typeof key !== "string" || key.length > 160 || !this.validWindow(run, key)) return json({ error: "board_mismatch" }, 409);
    const prior = this.ctx.storage.sql.exec<{ update_hash: string; body_json: string }>(
      "SELECT update_hash,body_json FROM collector_window_replies WHERE snapshot_id=?", update.snapshotId).toArray()[0];
    if (prior) {
      if (prior.update_hash !== updateHash) return json({ error: "checkpoint_conflict" }, 409);
      run.checkpoints[`attempt:${update.snapshotId}`] = updateHash;
      await this.ctx.storage.put("collectorState", state);
      return json(JSON.parse(prior.body_json));
    }
    let cached = this.ctx.storage.sql.exec<{ attempted_at_ms: number; snapshot_id: string; observation_json: string | null; retained: number }>(
      "SELECT attempted_at_ms,snapshot_id,observation_json,retained FROM collector_window_cache WHERE window_key=?", key).toArray()[0];
    if (!cached || Date.now() >= cached.attempted_at_ms + WINDOW_REUSE_MS) {
      const [kind, id, board, start] = key.split("/");
      const statement = kind === "arena" ? this.env.DB!.prepare(`SELECT observed_at_ms,snapshot_id FROM official_arena_window_metadata
        WHERE region=? AND season_id=? AND band_id=? AND start_rank=?`).bind(state.region, id, board, Number(start))
        : board === "point" ? this.env.DB!.prepare(`SELECT observed_at_ms,snapshot_id FROM official_event_window_metadata
          WHERE region=? AND event_id=? AND start_rank=? UNION ALL
          SELECT observed_at_ms,snapshot_id FROM official_ranking_observations
          WHERE region=? AND event_id=? AND board_kind='challenge' AND challenge_id='point' AND ?=1
          ORDER BY observed_at_ms DESC LIMIT 1`).bind(state.region, id, Number(start), state.region, id, Number(start))
          : this.env.DB!.prepare(`SELECT observed_at_ms,snapshot_id FROM official_ranking_observations
            WHERE region=? AND event_id=? AND board_kind=? AND challenge_id=? ORDER BY observed_at_ms DESC LIMIT 1`)
            .bind(state.region, id, board, board === "challenge" ? start : "");
      const previous = await statement.first<{ observed_at_ms: number; snapshot_id: string }>();
      if (previous && Date.now() < previous.observed_at_ms + WINDOW_REUSE_MS) {
        this.ctx.storage.sql.exec(`INSERT INTO collector_window_cache VALUES (?,?,?,NULL,1)
          ON CONFLICT(window_key) DO UPDATE SET attempted_at_ms=excluded.attempted_at_ms,
          snapshot_id=excluded.snapshot_id,observation_json=NULL,retained=1`, key, previous.observed_at_ms, previous.snapshot_id);
        cached = { attempted_at_ms: previous.observed_at_ms, snapshot_id: previous.snapshot_id, observation_json: null, retained: 1 };
      }
    }
    if (cached && cached.snapshot_id !== update.snapshotId && Date.now() < cached.attempted_at_ms + WINDOW_REUSE_MS) {
      const observation = cached.observation_json ? JSON.parse(cached.observation_json) as OfficialArenaObservation | OfficialEventWindow | OfficialObservation : null;
      const challengeEnd = run.finalEvent?.challenges.find((row) => key === `event/${run.finalEvent!.id}/challenge/${row.id}`)?.endAtMs;
      const cutoff = run.finalArena?.rankingEndAtMs ?? (run.finalEvent ? (challengeEnd ?? run.finalEvent.endAtMs) + run.finalEvent.aggregationSeconds * 1000 : 0);
      const reusable = observation && !observation.error && observation.observedAtMs >= cutoff;
      if (reusable && key.startsWith("arena/") && (update.retain || run.finalArena) && !cached.retained) {
        await saveOfficialArenaObservation(this.env, observation as OfficialArenaObservation);
        this.ctx.storage.sql.exec("UPDATE collector_window_cache SET retained=1 WHERE window_key=?", key);
        state.arenaStoredReads = (state.arenaStoredReads ?? 0) + 1;
      }
      if (reusable && key.startsWith("arena/") && update.retain) {
        const window = observation as OfficialArenaObservation;
        state.arenaInterests = (state.arenaInterests ?? []).filter((entry) => entry.seasonId !== window.seasonId
          || entry.bandId !== window.bandId || entry.startRank !== window.startRank);
        if (state.arenaSweep && run.sweepWindows?.some((entry) => entry.bandId === window.bandId && entry.startRank === window.startRank)) {
          const sweepKey = `${window.seasonId}:${window.bandId}${window.startRank > ARENA_NEAR_RANKS ? ":deep" : ""}`;
          state.arenaSweep.next[sweepKey] = window.startRank + 100;
          state.arenaSweep.band = ((run.catalog?.arena?.bandIds.indexOf(window.bandId) ?? 0) + 1) % run.catalog!.arena!.bandIds.length;
        }
      }
      const reply = reusable ? { ok: true, reused: observation } : { ok: true, deferredUntilMs: cached.attempted_at_ms + WINDOW_REUSE_MS };
      this.ctx.storage.sql.exec("INSERT INTO collector_window_replies VALUES (?,?,?,?)", update.snapshotId, run.deadlineMs + 15_000, updateHash, JSON.stringify(reply));
      if (reusable) state.windowReuses = (state.windowReuses ?? 0) + 1;
      else {
        state.windowDeferrals = (state.windowDeferrals ?? 0) + 1;
        if (run.finalEvent || run.finalArena) state.nextFinalAtMs = Math.min(state.nextFinalAtMs ?? Infinity, cached.attempted_at_ms + WINDOW_REUSE_MS);
      }
      run.checkpoints[`attempt:${update.snapshotId}`] = updateHash;
      await this.ctx.storage.put("collectorState", state);
      return json(reply);
    }
    this.ctx.storage.sql.exec(`INSERT INTO collector_window_cache (window_key,attempted_at_ms,snapshot_id)
      VALUES (?,?,?) ON CONFLICT(window_key) DO UPDATE SET attempted_at_ms=excluded.attempted_at_ms,
      snapshot_id=excluded.snapshot_id,observation_json=NULL,retained=0`, key, Date.now(), update.snapshotId);
    run.pendingWindowKey = key;
    return null;
  }

  private rememberWindow(run: CollectorRun, observation: OfficialArenaObservation | OfficialEventWindow | OfficialObservation, retained: boolean): void {
    if (!run.pendingWindowKey) return;
    const key = observationWindowKey(observation);
    const body = JSON.stringify(observation);
    this.ctx.storage.sql.exec(`UPDATE collector_window_cache SET attempted_at_ms=MAX(attempted_at_ms,?),observation_json=?,retained=?
      WHERE window_key=? AND snapshot_id=?`, observation.observedAtMs,
      new TextEncoder().encode(body).byteLength <= 1_000_000 ? body : null, Number(retained), key, observation.snapshotId);
    delete run.pendingWindowKey;
  }

  async platformLoginView(region: PlatformRegion) {
    const pending = await this.ctx.storage.get<PendingPlatformLogin>("platformLogin");
    return pending?.region === region && pending.deadlineMs + 15_000 > Date.now()
      ? { accountId: pending.accountId, accountVersion: pending.accountVersion,
        status: pending.started ? "authenticating" : "queued", deadlineMs: pending.deadlineMs } : null;
  }

  async platformAccountView(region: PlatformRegion) {
    const state = await this.stateFor(region), now = Date.now();
    const pending = await this.ctx.storage.get<PendingPlatformLogin>("platformLogin");
    const job = pending?.region === region && pending.deadlineMs + (pending.started ? 15_000 : 0) > now
      ? { accountId: pending.accountId, accountVersion: pending.accountVersion,
        status: pending.automatic ? pending.started ? "renewing" : "renewal_queued" : pending.started ? "authenticating" : "queued" } : null;
    let pool: OfficialCollectorPool | null;
    try { pool = await this.poolFor(region); }
    catch { return { job, status: "invalid_config", accounts: [] }; }
    const accounts = (pool?.accounts ?? []).filter((account) => account.label.startsWith("platform:")).map((account) => {
      const health = state.accounts?.[account.identity];
      const renewal = state.platformRenewals?.[account.identity];
      const status = poolAccountStatus(account, health, now);
      return { accountId: account.label.slice("platform:".length),
        playerId: normalizeOfficialPlayerId(String((account.credentials.credentials as JsonObject).player_id)),
        status: status === "held" ? status : !officialRegionEnabled(this.env.OFFICIAL_RANKING_ENABLED_REGIONS, region) ? "disabled"
          : state.permissionPause || state.legacyPermissionBlock ? "auth_paused" : status,
        renewal: renewal?.generation === account.generation && !state.permissionPause && !state.legacyPermissionBlock
          ? { accountVersion: renewal.accountVersion } : null };
    });
    return { job, status: "ok", accounts };
  }

  async requestPlatformLogin(region: PlatformRegion, accountId: string, accountVersion: number): Promise<{ kind: string; runId?: string }> {
    return this.serialized(() => this.queuePlatformLogin(region, accountId, accountVersion));
  }

  async platformAccountDrained(region: PlatformRegion, accountId: string): Promise<boolean> {
    const row = await this.env.DB.prepare("SELECT player_id AS playerId FROM official_platform_roles WHERE account_id=? AND region=?")
      .bind(accountId, region).first<{ playerId: string | null }>();
    if (!row?.playerId) return true;
    const identity = await officialDigest(canonical({ region, player_id: normalizeOfficialPlayerId(row.playerId) }));
    const state = await this.stateFor(region), now = Date.now();
    return ![state.run, state.lookup].some((run) => run?.accountIdentity === identity && !run.complete && run.deadlineMs + 15_000 > now);
  }

  async requestPlatformContinuation(region: PlatformRegion, batch: PlatformCascade) {
    return this.serialized(async () => {
      if (!await this.platformContinuationAllowed(region, batch.accountId)) return { kind: "held" };
      return this.queuePlatformLogin(region, batch.accountId, batch.accountVersion, undefined, batch);
    });
  }

  private async platformContinuationAllowed(region: PlatformRegion, accountId: string): Promise<boolean> {
    const state = await this.stateFor(region);
    if (!officialRegionEnabled(this.env.OFFICIAL_RANKING_ENABLED_REGIONS, region) || state.permissionPause || state.legacyPermissionBlock) return false;
    const row = await this.env.DB.prepare("SELECT player_id AS playerId FROM official_platform_roles WHERE account_id=? AND region=?")
      .bind(accountId, region).first<{ playerId: string | null }>();
    if (!row?.playerId) return true;
    const identity = await officialDigest(canonical({ region, player_id: normalizeOfficialPlayerId(row.playerId) }));
    return !state.accounts?.[identity]?.held;
  }

  async continuePlatformLogin(): Promise<void> {
    const batch = await this.ctx.storage.get<PlatformCascade>("platformCascade");
    if (!batch) return;
    if (!batch.regions.length || batch.deadlineMs <= Date.now()) {
      await releasePlatformBatch(this.env, batch.accountId, batch.batchId);
      await this.ctx.storage.delete("platformCascade"); return;
    }
    const [region, ...regions] = batch.regions;
    const result = await this.env.OFFICIAL_RANKING_COLLECTOR.getByName(region!).requestPlatformContinuation(region!, { ...batch, regions });
    if (result.kind === "queued") await this.ctx.storage.delete("platformCascade");
    else if (result.kind === "busy") await this.schedule(new Date(Date.now() + 5_000), "continuePlatformLogin");
    else if (result.kind === "held") {
      await this.ctx.storage.put("platformCascade", { ...batch, regions });
      await this.schedule(new Date(Date.now() + 1_000), "continuePlatformLogin");
    }
    else {
      await releasePlatformBatch(this.env, batch.accountId, batch.batchId);
      await this.ctx.storage.delete("platformCascade");
    }
  }

  private async queuePlatformLogin(region: PlatformRegion, accountId: string, accountVersion: number, automatic?: PlatformRenewal, continuation?: PlatformCascade): Promise<{ kind: string; runId?: string }> {
    if (await this.platformLoginView(region)) return { kind: "busy" };
    try { globalLoginConfiguration(this.env.OFFICIAL_GLOBAL_LOGIN_CONFIG, accountId, region); }
    catch { return { kind: "login_not_configured" }; }
    if (!this.env.OFFICIAL_ACCOUNT_ENCRYPTION_KEY) return { kind: "login_not_configured" };
    const account = await this.env.DB.prepare("SELECT version FROM official_platform_accounts WHERE id=?")
      .bind(accountId).first<{ version: number }>();
    if (!account) return { kind: "account_not_found" };
    if (account.version !== accountVersion) return { kind: "version_conflict" };
    try {
      if (!await readPlatformPassword(this.env, accountId)) return { kind: "account_not_found" };
    } catch (error) {
      console.warn(JSON.stringify({ event: "official_account_job_failed", region, code: "account_store_failed",
        error: error instanceof Error ? error.name : "Error" }));
      return { kind: "account_store_failed" };
    }
    const batchId = continuation?.batchId ?? crypto.randomUUID();
    const batchDeadlineMs = continuation?.deadlineMs ?? Date.now() + 900_000;
    if (continuation ? !await platformBatchCurrent(this.env, accountId, accountVersion, batchId)
      : !await claimPlatformBatch(this.env, accountId, accountVersion, batchId, batchDeadlineMs)) return { kind: "busy" };
    const pending: PendingPlatformLogin = { accountId, accountVersion, region, batchId, batchDeadlineMs,
      runId: continuation ? (await officialDigest(JSON.stringify([batchId, region]))).slice(0, 32) : crypto.randomUUID().replaceAll("-", ""),
      started: false, deadlineMs: Math.min(batchDeadlineMs, Date.now() + 300_000),
      remainingRegions: continuation?.regions ?? (["tw", "en", "kr"] as const).filter((value) => value !== region),
      ...(continuation ? { reuseSdk: true } : {}), ...(automatic ? { automatic } : {}) };
    try {
      await this.ctx.storage.put("platformLogin", pending);
      await this.schedule(new Date(Date.now() + 1_000), "runPlatformLogin", region);
    }
    catch (error) {
      const current = await this.ctx.storage.get<PendingPlatformLogin>("platformLogin");
      if (current?.runId === pending.runId && !current.started) await this.ctx.storage.delete("platformLogin");
      if (!continuation) await releasePlatformBatch(this.env, accountId, batchId);
      throw error;
    }
    return { kind: "queued", runId: pending.runId };
  }

  private async rememberPlatformRenewal(state: CollectorState, run: CollectorRun): Promise<void> {
    if (state.region === "jp" || !run.accountIdentity || state.platformRenewals?.[run.accountIdentity]) return;
    const pool = await this.poolFor(state.region);
    const account = pool?.accounts.find((entry) => entry.identity === run.accountIdentity && entry.generation === run.generation);
    const health = state.accounts?.[run.accountIdentity];
    if (!account?.label.startsWith("platform:") || !account.enabled || account.initialPause || health?.held) return;
    const accountId = account.label.slice("platform:".length);
    const row = await this.env.DB.prepare(`SELECT a.version FROM official_platform_accounts AS a
      JOIN official_platform_roles AS r ON r.account_id=a.id
      WHERE a.id=? AND r.region=? AND r.status='ready' AND r.player_id=? AND r.credential_box IS NOT NULL`)
      .bind(accountId, state.region, normalizeOfficialPlayerId(String((account.credentials.credentials as JsonObject).player_id)))
      .first<{ version: number }>();
    if (!row) return;
    const notBeforeMs = Math.max(Date.now() + AUTH_RETRY_MS, health?.cooldownUntilMs ?? 0);
    (state.platformRenewals ??= {})[run.accountIdentity] = { accountId, accountVersion: row.version,
      identity: account.identity, generation: account.generation, authGeneration: account.authGeneration, notBeforeMs };
    if (health) health.blocked[account.authGeneration] = "auth_paused";
    await this.ctx.storage.put("collectorState", state);
    await this.schedule(new Date(notBeforeMs), "renewPlatformSessions", state.region);
  }

  async renewPlatformSessions(region: PlatformRegion): Promise<void> {
    if (this.env.OFFICIAL_GLOBAL_LOGIN_CONFIG
      && (JSON.parse(this.env.OFFICIAL_GLOBAL_LOGIN_CONFIG) as { automaticRenewal?: boolean }).automaticRenewal === false) return;
    await this.serialized(async () => {
      if (!officialRegionEnabled(this.env.OFFICIAL_RANKING_ENABLED_REGIONS, region)) return;
      const state = await this.stateFor(region), pool = await this.poolFor(region), now = Date.now();
      let next = Infinity;
      for (const renewal of Object.values(state.platformRenewals ?? {}).sort((a, b) => a.notBeforeMs - b.notBeforeMs)) {
        const account = pool?.accounts.find((entry) => entry.identity === renewal.identity && entry.generation === renewal.generation);
        if (!account) { delete state.platformRenewals![renewal.identity]; continue; }
        const health = state.accounts?.[renewal.identity];
        const due = Math.max(renewal.notBeforeMs, health?.cooldownUntilMs ?? 0, health?.leaseUntilMs ?? 0);
        if (!account.enabled || account.initialPause || health?.held || state.permissionPause || state.legacyPermissionBlock) {
          next = Math.min(next, now + AUTH_RETRY_MS);
        } else if (due > now) next = Math.min(next, due);
        else {
          const result = await this.queuePlatformLogin(region, renewal.accountId, renewal.accountVersion, renewal);
          if (result.kind !== "queued" && result.kind !== "busy") delete state.platformRenewals![renewal.identity];
          else next = Math.min(next, now + 15_000);
          if (result.kind === "queued" || result.kind === "busy") break;
        }
      }
      await this.ctx.storage.put("collectorState", state);
      if (Number.isFinite(next)) await this.schedule(new Date(next), "renewPlatformSessions", region);
    });
  }

  async runPlatformLogin(region: PlatformRegion): Promise<void> {
    let claimed: PlatformLoginLease | null = null;
    let preparingRunId: string | null = null;
    const resume = async (keepBatch = false) => {
      const pending = await this.ctx.storage.get<PendingPlatformLogin>("platformLogin");
      if (!keepBatch && pending?.batchId) await releasePlatformBatch(this.env, pending.accountId, pending.batchId);
      await this.ctx.storage.delete("platformLogin");
      await this.schedule(new Date(Date.now() + 1_000), "collectDue", region);
    };
    let prepared;
    try {
      prepared = await this.serialized(async () => {
        const pending = await this.ctx.storage.get<PendingPlatformLogin>("platformLogin"), now = Date.now();
        if (!pending || pending.region !== region) return null;
        preparingRunId = pending.runId;
        if (pending.batchId && !await platformBatchCurrent(this.env, pending.accountId, pending.accountVersion, pending.batchId)) {
          await resume(); return null;
        }
        if (pending.deadlineMs + (pending.started ? 15_000 : 0) <= now) { await resume(); return null; }
        if (pending.started) {
          await this.schedule(new Date(pending.deadlineMs + 15_001), "runPlatformLogin", region);
          return null;
        }
        const account = await this.env.DB.prepare("SELECT version FROM official_platform_accounts WHERE id=?")
          .bind(pending.accountId).first<{ version: number }>();
        if (!account || account.version !== pending.accountVersion) { await resume(); return null; }
        const state = await this.stateFor(region);
        if (pending.automatic && !pending.claimed) {
          const renewal = pending.automatic, pool = await this.poolFor(region);
          const account = pool?.accounts.find((entry) => entry.identity === renewal.identity && entry.generation === renewal.generation);
          const health = state.accounts?.[renewal.identity];
          if (!officialRegionEnabled(this.env.OFFICIAL_RANKING_ENABLED_REGIONS, region) || !account || !account.enabled
            || state.platformRenewals?.[renewal.identity]?.generation !== renewal.generation
            || account.initialPause || health?.held || state.permissionPause || state.legacyPermissionBlock
            || Math.max(renewal.notBeforeMs, health?.cooldownUntilMs ?? 0) > now) {
            await this.schedule(new Date(now + AUTH_RETRY_MS), "renewPlatformSessions", region);
            await resume();
            return null;
          }
        }
        if ([state.run, state.lookup].some((run) => run && !run.complete && run.deadlineMs + 15_000 > now)) {
          await this.schedule(new Date(Math.min(pending.deadlineMs, now + 5_000)), "runPlatformLogin", region);
          return null;
        }
        const config = globalLoginConfiguration(this.env.OFFICIAL_GLOBAL_LOGIN_CONFIG, await platformDeviceId(this.env, pending.accountId), region);
        if (!pending.claimed && !await claimPlatformLogin(this.env, pending, now, !pending.reuseSdk)) {
          await this.schedule(new Date(Math.min(pending.deadlineMs, now + 15_000)), "runPlatformLogin", region);
          return null;
        }
        pending.claimed = true;
        await this.ctx.storage.put("platformLogin", pending);
        claimed = pending;
        if (!pending.reuseSdk) {
          const drained = await Promise.all((["tw", "en", "kr"] as const).filter((value) => value !== region)
            .map((value) => this.env.OFFICIAL_RANKING_COLLECTOR.getByName(value).platformAccountDrained(value, pending.accountId)));
          if (drained.some((value) => !value)) {
            await this.schedule(new Date(Math.min(pending.deadlineMs, now + 5_000)), "runPlatformLogin", region);
            return null;
          }
        }
        const lease = { ...pending, deadlineMs: Math.min(pending.deadlineMs, now + JOB_MS) };
        await limitPlatformLoginLease(this.env, lease);
        claimed = lease;
        const input = await readPlatformLoginInput(this.env, lease);
        if (!input) { await releasePlatformLogin(this.env, lease); await resume(); return null; }
        const { sdkScope, sdkIdentityScope } = await platformSdkScopes(config.sdkProfile);
        const sdkSession = await readPlatformSdkSession(this.env, lease, sdkScope);
        if (pending.reuseSdk && !sdkSession) throw new AccountJobContractError("sdk_session_missing");
        const sdkIdentity = await readPlatformSdkIdentity(this.env, lease, sdkIdentityScope);
        if (!sdkIdentity) throw new AccountJobContractError("account_lease_invalidated");
        let expectedSdkUid = sdkIdentity.uid;
        if (sdkSession) {
          if (!await bindPlatformSdkIdentity(this.env, lease, sdkIdentityScope, sdkSession.uid)) throw new AccountJobContractError("sdk_identity_mismatch");
          expectedSdkUid = sdkSession.uid;
        }
        await this.ctx.storage.put("platformLogin", { ...lease, started: true });
        if (pending.automatic) {
          delete state.platformRenewals?.[pending.automatic.identity];
          await this.ctx.storage.put("collectorState", state);
        }
        await this.schedule(new Date(lease.deadlineMs + 15_001), "runPlatformLogin", region);
        let token = await this.ctx.storage.get<string>("containerToken");
        if (!token) { token = crypto.randomUUID() + crypto.randomUUID(); await this.ctx.storage.put("containerToken", token); }
        this.envVars = { OFFICIAL_COLLECTOR_TOKEN: token, OFFICIAL_CALLBACK_ORIGIN: this.callbackOrigin };
        return { lease, config, token, sdkScope, sdkIdentityScope, expectedSdkUid, job: { contract: "haneoka:official-account-job/1", action: "sdk", region, runId: lease.runId,
          deadlineMs: lease.deadlineMs, email: input.email, password: input.password, expectedPlayerId: input.playerId, expectedSdkUid, sdkSession, ...config } };
      });
    } catch (error) {
      const code = error instanceof AccountJobContractError ? error.message : "account_setup_failed";
      console.warn(JSON.stringify({ event: "official_account_job_failed", region, code }));
      await this.serialized(async () => {
        if (claimed && !await finishPlatformLogin(this.env, claimed, { status: code === "sdk_identity_mismatch" ? "auth_required" : "failed", errorCode: code }))
          await releasePlatformLogin(this.env, claimed);
        const current = await this.ctx.storage.get<PendingPlatformLogin>("platformLogin");
        if (current?.runId === preparingRunId) await resume();
      });
      return;
    }
    if (!prepared) return;
    let result: PlatformLoginResult;
    let verifiedSdkUid = prepared.expectedSdkUid;
    let sdkAvailable = false;
    let phase: "sdk" | "ownership" | "game" = "sdk";
    try {
      const dispatchPhase = async (action: "sdk" | "game", job: JsonObject) => {
        const dispatch = async () => {
          if (!await readPlatformSdkIdentity(this.env, prepared.lease, prepared.sdkIdentityScope))
            throw new AccountJobContractError("account_lease_invalidated");
          if (prepared.lease.automatic) {
            const state = await this.stateFor(region);
            if (!officialRegionEnabled(this.env.OFFICIAL_RANKING_ENABLED_REGIONS, region)
              || state.accounts?.[prepared.lease.automatic.identity]?.held || state.permissionPause || state.legacyPermissionBlock)
              throw new AccountJobContractError("automatic_login_paused");
          }
          if (prepared.lease.reuseSdk && !await this.platformContinuationAllowed(region, prepared.lease.accountId))
            throw new AccountJobContractError("automatic_login_paused");
          return this.containerFetch(`http://container/account-${action}`, { method: "POST",
            headers: { Authorization: `Bearer ${prepared.token}`, "Content-Type": "application/json" },
            body: JSON.stringify(job), signal: AbortSignal.timeout(Math.max(1, prepared.lease.deadlineMs + 15_000 - Date.now())) });
        };
        let response = await dispatch();
        let conflict: "account_container_busy" | "account_job_conflict" | "account_job_uncertain" | null = null;
        if (response.status === 409) {
          const reason = async (value: Response) => {
            const code = object(await value.json()).error;
            if (code !== "busy" && code !== "run_conflict" && code !== "run_uncertain") throw new AccountJobContractError("invalid_account_result");
            return code;
          };
          let code = await reason(response);
          if (code === "busy") {
            // Busy is rejected before any SDK/game request; ambiguous failures are not replayed.
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            response = await dispatch();
            if (response.status === 409) code = await reason(response);
          }
          if (response.status === 409) conflict = code === "busy" ? "account_container_busy"
            : code === "run_uncertain" ? "account_job_uncertain" : "account_job_conflict";
        }
        if (conflict) throw new AccountJobContractError(conflict);
        if ([400, 403, 404].includes(response.status)) {
          await responseFailure(response);
          throw new AccountJobContractError("account_container_rejected");
        }
        const raw = await response.text();
        if (!response.ok || new TextEncoder().encode(raw).length > 65_536) throw new Error("account_container_failed");
        return JSON.parse(raw) as unknown;
      };
      const sdk = prepared.lease.reuseSdk && prepared.job.sdkSession
        ? { status: "sdk_ready" as const, sdkSession: prepared.job.sdkSession }
        : platformSdkResult(await dispatchPhase("sdk", prepared.job), prepared.lease.runId, region, prepared.config, prepared.expectedSdkUid);
      if (sdk.status !== "sdk_ready") result = sdk;
      else {
        verifiedSdkUid = sdk.sdkSession.uid;
        phase = "ownership";
        const ownership = await this.serialized(async () => {
          const pending = await this.ctx.storage.get<PendingPlatformLogin>("platformLogin");
          if (pending?.runId !== prepared.lease.runId) return "account_lease_invalidated";
          if (!await bindPlatformSdkIdentity(this.env, prepared.lease, prepared.sdkIdentityScope, sdk.sdkSession.uid)) return "account_lease_invalidated";
          const owner = await claimPlatformSdkOwner(this.env, prepared.lease, prepared.sdkIdentityScope, sdk.sdkSession.uid);
          if (owner === "owned") await savePlatformSdkSession(this.env, prepared.lease, prepared.sdkScope, sdk.sdkSession);
          return owner;
        });
        if (ownership !== "owned") result = { status: "failed", errorCode: ownership };
        else {
          sdkAvailable = true;
          phase = "game";
          result = platformLoginResult(await dispatchPhase("game", { contract: "haneoka:official-account-job/1", action: "game", region,
            runId: prepared.lease.runId, deadlineMs: prepared.lease.deadlineMs, expectedPlayerId: prepared.job.expectedPlayerId,
            expectedSdkUid: sdk.sdkSession.uid, sdkSession: sdk.sdkSession, ...prepared.config }), prepared.lease.runId, region, prepared.config, sdk.sdkSession.uid);
        }
      }
    } catch (error) {
      const code = error instanceof AccountJobContractError ? error.message : error instanceof SyntaxError ? "account_result_invalid_json"
        : phase === "ownership" ? "account_store_failed" : "account_container_failed";
      result = { status: code === "sdk_identity_mismatch" ? "auth_required"
        : phase === "game" && !["account_container_busy", "account_job_conflict", "account_container_rejected", "account_lease_invalidated", "automatic_login_paused"].includes(code) ? "auth_uncertain" : "failed", errorCode: code };
      console.warn(JSON.stringify({ event: "official_account_job_failed", region, code }));
    }
    await this.serialized(async () => {
      const pending = await this.ctx.storage.get<PendingPlatformLogin>("platformLogin");
      if (pending?.runId !== prepared.lease.runId) return;
      if (result.sdkSession === null) await savePlatformSdkSession(this.env, prepared.lease, prepared.sdkScope, null);
      if (result.playerId && (await readPlatformPlayerIds(this.env, region, prepared.lease.accountId,
        verifiedSdkUid ? { scope: prepared.sdkIdentityScope, uid: verifiedSdkUid } : undefined)).has(normalizeOfficialPlayerId(result.playerId)))
        result = { status: "failed", errorCode: "duplicate_player" };
      const saved = await finishPlatformLogin(this.env, prepared.lease, result);
      if (saved && result.status === "ready") {
        const state = await this.stateFor(region);
        const identity = await officialDigest(canonical({ region, player_id: normalizeOfficialPlayerId(result.playerId) }));
        const health = state.accounts?.[identity];
        if (health) {
          health.blocked = {};
          health.cooldownUntilMs = 0;
          health.failures = 0;
          health.rejections = 0;
        }
        if (state.permissionPause?.identity === identity) state.permissionPause = null;
        if (prepared.lease.automatic && state.blockedGeneration === prepared.lease.automatic.generation) state.blockedGeneration = null;
        if (["auth_paused", "auth_uncertain", "failed", "no_available_account"].includes(state.status)) state.status = "not_started";
        state.nextAtMs = Math.min(state.nextAtMs || Date.now(), Date.now() + 1_000);
        await this.ctx.storage.put("collectorState", state);
      }
      if (!saved && !await finishPlatformLogin(this.env, prepared.lease, { status: "auth_required", errorCode: "game_player_mismatch" }))
        await releasePlatformLogin(this.env, prepared.lease);
      const continuing = sdkAvailable && !!prepared.lease.remainingRegions?.length && !!prepared.lease.batchId;
      if (continuing) {
        await this.ctx.storage.put("platformCascade", { batchId: prepared.lease.batchId!, accountId: prepared.lease.accountId, accountVersion: prepared.lease.accountVersion,
          regions: prepared.lease.remainingRegions!, deadlineMs: prepared.lease.batchDeadlineMs! } satisfies PlatformCascade);
        await this.schedule(new Date(Date.now() + 1_000), "continuePlatformLogin");
      }
      await resume(continuing);
    });
  }

  async guestJobView() {
    const pending = await this.ctx.storage.get<PendingGuestJob>("guestJob");
    return pending ? { guestId: pending.guestId, version: pending.version, action: pending.action,
      status: pending.recovering ? "uncertain" : pending.started ? pending.action === "register" ? "creating" : "verifying" : "queued",
      deadlineMs: pending.deadlineMs } : null;
  }

  async adoptConfiguredGuests(verifiedOnly = false): Promise<number> {
    return this.serialized(async () => {
      const pool = await configFor(this.env, "jp");
      const owned = await readGuestPlayerIds(this.env);
      const state = await this.stateFor("jp");
      const configured = this.env.OFFICIAL_RANKING_JP_CONFIG ? object(JSON.parse(this.env.OFFICIAL_RANKING_JP_CONFIG)) : null;
      const labels = new Map((Array.isArray(configured?.accounts) ? configured.accounts : []).map((entry: unknown) => {
        const row = object(entry);
        return [String(row.id), typeof row.label === "string" && row.label.trim() ? row.label.trim().slice(0, 80) : String(row.id)];
      }));
      let imported = 0;
      for (const account of pool?.accounts ?? []) {
        const playerId = normalizeOfficialPlayerId(String((account.credentials.credentials as JsonObject).player_id));
        if (owned.has(playerId) || !account.ready || !account.enabled) continue;
        const health = state.accounts?.[account.identity];
        const verifiedAtMs = health?.lastSuccessAtMs && !health.blocked[account.authGeneration] ? health.lastSuccessAtMs : undefined;
        if (verifiedOnly && !verifiedAtMs) continue;
        if (await adoptGuestAccount(this.env, labels.get(account.label) ?? account.label, { clientVersion: account.clientVersion,
          credentials: account.credentials, masterConfig: account.masterConfig }, verifiedAtMs)) imported++;
      }
      return imported;
    });
  }

  async guestAccountView() {
    const state = await this.stateFor("jp"), job = await this.guestJobView(), now = Date.now();
    let pool: OfficialCollectorPool | null;
    try { pool = await this.poolFor("jp"); }
    catch { return { job, status: "invalid_config", accounts: [] }; }
    const accounts = (pool?.accounts ?? []).filter((account) => account.label.startsWith("guest:")).map((account) => {
      const status = poolAccountStatus(account, state.accounts?.[account.identity], now);
      return { guestId: account.label.slice("guest:".length),
        playerId: normalizeOfficialPlayerId(String((account.credentials.credentials as JsonObject).player_id)),
        status: status === "held" ? status : !officialRegionEnabled(this.env.OFFICIAL_RANKING_ENABLED_REGIONS, "jp") ? "disabled"
          : state.permissionPause || state.legacyPermissionBlock ? "auth_paused" : status };
    });
    return { job, status: "ok", accounts };
  }

  async requestGuestRegistration(guestId: string, label: string): Promise<{ kind: string; guestId?: string }> {
    return this.serialized(async () => {
      const pending = await this.ctx.storage.get<PendingGuestJob>("guestJob");
      if (pending) {
        await this.schedule(new Date(Date.now() + 1_000), "runGuestJob", "jp");
        return pending.guestId === guestId ? { kind: "queued", guestId } : { kind: "busy" };
      }
      let row = await readGuestAccountState(this.env, guestId);
      if (row && (row.hasConfiguration || row.status === "failed")) return { kind: "exists", guestId };
      const now = Date.now();
      if (row?.status === "queued" && row.deadlineMs <= now) return { kind: "guest_expired", guestId };
      try {
        if (!row) {
          const config = guestConfiguration(this.env.OFFICIAL_JP_GUEST_CONFIG);
          const lease = { guestId, version: 1, runId: crypto.randomUUID().replaceAll("-", ""), deadlineMs: now + 300_000 };
          await createGuestAccount(this.env, lease, label);
          await saveGuestRequest(this.env, lease, config);
          row = await readGuestAccountState(this.env, guestId);
        } else if (!await readGuestRequest(this.env, guestId) && row.status === "queued") {
          await saveGuestRequest(this.env, { guestId, version: row.version, runId: row.runId, deadlineMs: row.deadlineMs },
            guestConfiguration(this.env.OFFICIAL_JP_GUEST_CONFIG));
        }
      } catch (error) {
        console.warn(JSON.stringify({ event: "official_guest_setup_failed", code: error instanceof GuestJobContractError ? error.message : "guest_store_failed" }));
        return { kind: error instanceof GuestJobContractError ? "guest_not_configured" : "guest_store_failed" };
      }
      if (!row) return { kind: "guest_not_found" };
      await this.ctx.storage.put("guestJob", { guestId, version: row.version, runId: row.runId, deadlineMs: row.deadlineMs,
        action: "register", started: row.status !== "queued" } satisfies PendingGuestJob);
      await this.schedule(new Date(now + 1_000), "runGuestJob", "jp");
      return { kind: "queued", guestId };
    });
  }

  async requestGuestVerification(guestId: string, expectedVersion: number): Promise<{ kind: string }> {
    return this.serialized(async () => {
      if (await this.guestJobView()) return { kind: "busy" };
      const row = await readGuestAccountState(this.env, guestId);
      if (!row) return { kind: "guest_not_found" };
      if (row.version !== expectedVersion) return { kind: "version_conflict" };
      if (!row.hasConfiguration) return { kind: "guest_not_created" };
      if (row.status === "verifying" && row.deadlineMs > Date.now()) return { kind: "busy" };
      try {
        if (!await readGuestConfiguration(this.env, guestId) || !await readGuestRequest(this.env, guestId)) return { kind: "guest_not_created" };
      } catch { return { kind: "guest_store_failed" }; }
      await this.queueGuestVerification(guestId, expectedVersion);
      return { kind: "queued" };
    });
  }

  private async queueGuestVerification(guestId: string, version: number) {
    await this.ctx.storage.put("guestJob", { guestId, version, runId: crypto.randomUUID().replaceAll("-", ""),
      deadlineMs: Date.now() + 300_000, action: "verify", started: false } satisfies PendingGuestJob);
    await this.schedule(new Date(Date.now() + 1_000), "runGuestJob", "jp");
  }

  private async finishGuestWork(lease: GuestLease) {
    const pending = await this.ctx.storage.get<PendingGuestJob>("guestJob");
    if (pending?.guestId !== lease.guestId || pending.runId !== lease.runId) return;
    await this.ctx.storage.delete("guestJob");
    await this.schedule(new Date(Date.now() + 1_000), "collectDue", "jp");
  }

  private async guestToken() {
    let token = await this.ctx.storage.get<string>("containerToken");
    if (!token) { token = crypto.randomUUID() + crypto.randomUUID(); await this.ctx.storage.put("containerToken", token); }
    this.envVars = { OFFICIAL_COLLECTOR_TOKEN: token, OFFICIAL_CALLBACK_ORIGIN: this.callbackOrigin };
    return token;
  }

  async runGuestJob(region: "jp"): Promise<void> {
    let preparing: PendingGuestJob | null = null;
    let prepared: PreparedGuestJob | null;
    try {
      prepared = await this.serialized(async (): Promise<PreparedGuestJob | null> => {
        const pending = await this.ctx.storage.get<PendingGuestJob>("guestJob"), now = Date.now();
        if (!pending) return null;
        preparing = pending;
        const row = await readGuestAccountState(this.env, pending.guestId);
        if (!row) { await this.finishGuestWork(pending); return null; }
        if (pending.action === "register" && row.hasConfiguration) {
          if (row.status === "created" || row.status === "ready") await this.queueGuestVerification(row.id, row.version);
          else await this.finishGuestWork(pending);
          return null;
        }
        const config = await readGuestRequest(this.env, pending.guestId);
        if (!config) throw new GuestJobContractError("guest_request_missing");
        if (pending.started || row.runId === pending.runId && (row.status === "creating" || row.status === "verifying")) {
          const lease = { guestId: row.id, version: row.version, runId: row.runId, deadlineMs: row.deadlineMs };
          if (row.runId !== pending.runId) { await this.finishGuestWork(pending); return null; }
          await this.ctx.storage.put("guestJob", { ...pending, ...lease, started: true } satisfies PendingGuestJob);
          if (now < lease.deadlineMs + 15_000) {
            await this.schedule(new Date(lease.deadlineMs + 15_001), "runGuestJob", region);
            return null;
          }
          if (pending.action === "verify") {
            if (row.playerId) await finishGuestVerification(this.env, lease, row.playerId, false, "guest_verification_incomplete");
            await this.finishGuestWork(pending); return null;
          }
          return { lease, action: "register", config, token: await this.guestToken() };
        }
        if (pending.deadlineMs <= now) {
          if (pending.action === "register") await finishGuestRegistrationFailure(this.env, pending, "failed", "guest_queue_expired");
          await this.finishGuestWork(pending); return null;
        }
        const state = await this.stateFor(region);
        if ([state.run, state.lookup].some((run) => run && !run.complete && run.deadlineMs + 15_000 > now)) {
          await this.schedule(new Date(Math.min(pending.deadlineMs, now + 5_000)), "runGuestJob", region);
          return null;
        }
        let lease = { ...pending, deadlineMs: Math.min(pending.deadlineMs, now + JOB_MS) };
        if (pending.action === "register") {
          if (!await claimGuestRegistration(this.env, lease, now)) { await this.finishGuestWork(pending); return null; }
        } else {
          const claimed = await claimGuestVerification(this.env, pending.guestId, pending.version, pending.runId, lease.deadlineMs, now);
          if (!claimed) { await this.finishGuestWork(pending); return null; }
          lease = { ...pending, ...claimed };
        }
        await this.ctx.storage.put("guestJob", { ...lease, started: true });
        await this.schedule(new Date(lease.deadlineMs + 15_001), "runGuestJob", region);
        const configuration = pending.action === "verify" ? await readGuestVerificationInput(this.env, lease) : null;
        if (pending.action === "verify" && !configuration) throw new GuestJobContractError("guest_lease_invalidated");
        const credentials = configuration ? object(object(configuration.credentials).credentials) : undefined;
        return { lease, action: pending.action, config, token: await this.guestToken(),
          ...(credentials ? { playerId: credentials.player_id as string } : {}),
          job: { contract: "haneoka:official-guest-job/1", action: pending.action, region, guestId: lease.guestId,
            runId: lease.runId, deadlineMs: lease.deadlineMs, ...config, ...(credentials ? { credentials } : {}) } };
      });
    } catch (error) {
      console.warn(JSON.stringify({ event: "official_guest_job_failed", code: error instanceof GuestJobContractError ? error.message : "guest_setup_failed" }));
      await this.serialized(async () => {
        const lease = preparing as PendingGuestJob | null;
        if (!lease) return;
        const row = await readGuestAccountState(this.env, lease.guestId);
        if (row?.runId === lease.runId) {
          const current = { guestId: row.id, version: row.version, runId: row.runId, deadlineMs: row.deadlineMs };
          if (lease.action === "register") await finishGuestRegistrationFailure(this.env, current, lease.started ? "uncertain" : "failed", "guest_setup_failed");
          else if (row.playerId) await finishGuestVerification(this.env, current, row.playerId, false, "guest_setup_failed");
        }
        await this.finishGuestWork(lease);
      });
      return;
    }
    if (!prepared) return;
    if (!prepared.job) { await this.recoverGuestRegistration(prepared); return; }
    try {
      const response = await this.containerFetch("http://container/guest-job", { method: "POST",
        headers: { Authorization: `Bearer ${prepared.token}`, "Content-Type": "application/json" }, body: JSON.stringify(prepared.job),
        signal: AbortSignal.timeout(Math.max(1, prepared.lease.deadlineMs + 15_000 - Date.now())) });
      if (!response.ok) { await responseFailure(response); throw new GuestJobContractError("guest_container_failed"); }
      const raw = await response.text();
      if (new TextEncoder().encode(raw).length > 65_536) throw new GuestJobContractError("invalid_guest_result");
      await this.acceptGuestResult(prepared, guestPhaseResult(JSON.parse(raw), prepared.action, prepared.lease, prepared.config, prepared.playerId));
    } catch (error) {
      console.warn(JSON.stringify({ event: "official_guest_job_failed", code: error instanceof GuestJobContractError ? error.message : "guest_container_failed" }));
      if (prepared.action === "register") await this.recoverGuestRegistration(prepared);
      else await this.serialized(async () => {
        if (prepared.playerId) await finishGuestVerification(this.env, prepared.lease, prepared.playerId, false, "guest_verification_incomplete");
        await this.finishGuestWork(prepared.lease);
      });
    }
  }

  private async acceptGuestResult(prepared: PreparedGuestJob, result: GuestPhaseResult) {
    await this.serialized(async () => {
      if (result.action === "register" && result.status === "created") {
        const saved = await saveGuestRegistration(this.env, prepared.lease, result.playerId, result.profileId, result.configuration);
        const row = await readGuestAccountState(this.env, prepared.lease.guestId);
        if (!saved && row?.runId === prepared.lease.runId && row.version === prepared.lease.version && !row.hasConfiguration)
          await finishGuestRegistrationFailure(this.env, prepared.lease, "uncertain", "guest_identity_conflict");
        const pending = await this.ctx.storage.get<PendingGuestJob>("guestJob");
        if (row?.hasConfiguration && row.status === "created" && (!pending || pending.guestId === prepared.lease.guestId && pending.runId === prepared.lease.runId)) {
          await this.queueGuestVerification(row.id, row.version);
          return;
        }
      } else if (result.action === "register") {
        await finishGuestRegistrationFailure(this.env, prepared.lease, result.status, result.errorCode);
      } else {
        const saved = await finishGuestVerification(this.env, prepared.lease, result.playerId, result.status === "ready", result.status === "created" ? result.errorCode : null);
        if (!saved && Date.now() >= prepared.lease.deadlineMs)
          await finishGuestVerification(this.env, prepared.lease, result.playerId, false, "guest_verification_incomplete");
      }
      await this.finishGuestWork(prepared.lease);
    });
  }

  private async recoverGuestRegistration(prepared: PreparedGuestJob) {
    try {
      const response = await this.containerFetch(`http://container/guest-result/${prepared.lease.runId}`, {
        headers: { Authorization: `Bearer ${prepared.token}` }, signal: AbortSignal.timeout(10_000) });
      if (response.status === 200) {
        const raw = await response.text();
        if (new TextEncoder().encode(raw).length > 65_536) throw new GuestJobContractError("invalid_guest_result");
        await this.acceptGuestResult(prepared, guestPhaseResult(JSON.parse(raw), "register", prepared.lease, prepared.config));
        return;
      }
      if (response.ok) await response.arrayBuffer();
      else await responseFailure(response);
    } catch (error) {
      console.warn(JSON.stringify({ event: "official_guest_recovery_failed", code: error instanceof GuestJobContractError ? error.message : "guest_result_unavailable" }));
    }
    await this.serialized(async () => {
      const pending = await this.ctx.storage.get<PendingGuestJob>("guestJob");
      if (pending?.guestId !== prepared.lease.guestId || pending.runId !== prepared.lease.runId) return;
      if (Date.now() < prepared.lease.deadlineMs + 15_000) {
        await this.ctx.storage.put("guestJob", { ...pending, recovering: true });
        await this.schedule(new Date(prepared.lease.deadlineMs + 15_001), "runGuestJob", "jp");
      } else {
        await finishGuestRegistrationFailure(this.env, prepared.lease, "uncertain", "guest_result_unavailable");
        await this.finishGuestWork(prepared.lease);
      }
    });
  }

  private expediteArena(state: CollectorState) {
    if (state.permissionPause || state.legacyPermissionBlock || state.blockedGeneration || state.status !== "ok" && state.status !== "not_started") return;
    const next = Math.max(Date.now() + 1_000, (state.lastRunAtMs ?? 0) + ARENA_DEMAND_INTERVAL_MS);
    state.nextAtMs = state.nextAtMs ? Math.min(state.nextAtMs, next) : next;
  }

  /** Windows past the top 100 that this run refreshes on its own, so the whole board stays current without anyone
   * opening it: bands take turns, each walking its windows from 101 to its last rank and starting over. */
  private async arenaSweep(state: CollectorState, region: GameRecordsRegion, now: number, count: number) {
    const arena = state.arenaCatalog;
    if (!arena || count <= 0 || now < arena.startAtMs || now >= arena.rankingEndAtMs || !arena.bandIds.length) return [];
    const sweep = state.arenaSweep ??= { band: 0, next: {} };
    let band = sweep.band;
    const next = { ...sweep.next };
    const maxima = new Map<string, number | null>();
    const windows: { seasonId: string; bandId: string; startRank: number; endRank: number }[] = [];
    for (let turn = 0; windows.length < count && turn < 2 * count + arena.bandIds.length; turn++) {
      const bandId = arena.bandIds[band % arena.bandIds.length]!;
      band = (band + 1) % arena.bandIds.length;
      if (!maxima.has(bandId))
        maxima.set(bandId, (await readOfficialArenaMetadata(this.env, region, arena.seasonId, bandId).catch(() => null))?.maxRank ?? null);
      const maxRank = maxima.get(bandId);
      if (!maxRank || maxRank <= 100) continue;
      const deep = turn % 4 === 3 && maxRank > ARENA_NEAR_RANKS;
      const key = `${arena.seasonId}:${bandId}${deep ? ":deep" : ""}`;
      const first = deep ? ARENA_NEAR_RANKS + 1 : 101, last = deep ? maxRank : Math.min(maxRank, ARENA_NEAR_RANKS);
      let startRank = next[key] ?? first;
      if (startRank > last) startRank = first;
      next[key] = startRank + 100;
      windows.push({ seasonId: arena.seasonId, bandId, startRank, endRank: startRank + 99 });
    }
    sweep.next = Object.fromEntries(Object.entries(sweep.next).filter(([key]) => key.startsWith(`${arena.seasonId}:`)));
    return windows;
  }

  private async runningEvent(region: GameRecordsRegion, now: number) {
    const event = (await readOfficialCatalog(this.env, region).catch(() => null))?.event;
    return event?.pointRankingEnabled && now >= event.startAtMs && now < event.endAtMs + event.aggregationSeconds * 1000 ? event : null;
  }

  /** The running event's top window plus the next ones in turn, walking the board from 101 to its last rank. */
  private async eventSweep(state: CollectorState, region: GameRecordsRegion, now: number) {
    const event = await this.runningEvent(region, now);
    if (!event) return [];
    if (state.eventSweep?.eventId !== event.id) state.eventSweep = { eventId: event.id, next: 101, maxRank: null };
    const sweep = state.eventSweep, starts = [1];
    let next = sweep.next;
    for (let turn = 0; turn < EVENT_SWEEP_WINDOWS; turn++) {
      if (sweep.maxRank !== null && next > sweep.maxRank) {
        next = 101;
        if (sweep.maxRank <= 100) break;
      }
      starts.push(next);
      next += 100;
    }
    return [...new Set(starts)].map((startRank) => ({ eventId: event.id, startRank, endRank: startRank + 99 }));
  }

  /** Queues event point windows for the next run, as {@link requestArenaWindows} does for leagues. */
  async requestEventWindows(region: GameRecordsRegion, eventId: string, starts: number[], expedite = true): Promise<{ kind: string; retryAfter: number | null }> {
    return this.serialized(async () => {
      if (!decimal(eventId) || !Array.isArray(starts) || !starts.length || starts.length > 20
        || starts.some((start) => !Number.isSafeInteger(start) || start < 1 || (start - 1) % 100 !== 0)) return { kind: "invalid_request", retryAfter: null };
      const state = await this.stateFor(region), now = Date.now();
      const unavailable = await officialCollectorAvailability(this.env, region);
      if (unavailable) return { kind: unavailable, retryAfter: null };
      if (state.permissionPause || state.legacyPermissionBlock || state.blockedGeneration) return { kind: "auth_paused", retryAfter: null };
      if (["rate_limited", "failed", "auth_paused", "auth_uncertain", "no_available_account"].includes(state.status)) return { kind: state.status, retryAfter: null };
      if ((await this.runningEvent(region, now))?.id !== eventId) return { kind: "inactive", retryAfter: null };
      const queue = (state.eventInterests ?? []).filter((entry) => now - entry.requestedAtMs < ARENA_INTEREST_TTL_MS);
      const missing = [...new Set(starts)].filter((start) => !queue.some((entry) => entry.eventId === eventId && entry.startRank === start));
      if (!missing.length) return { kind: "pending", retryAfter: 30 };
      if (queue.length + missing.length > 24) return { kind: "queue_full", retryAfter: null };
      for (const startRank of missing) queue.push({ eventId, startRank, endRank: startRank + 99, requestedAtMs: now });
      state.eventInterests = queue;
      const active = state.run && !state.run.complete && now <= state.run.deadlineMs + 15_000;
      if (!active && expedite) this.expediteArena(state);
      await this.persist(state);
      return { kind: "pending", retryAfter: 30 };
    });
  }

  async requestArenaWindows(region: GameRecordsRegion, seasonId: string, bandId: string,
    starts: number[], thresholds: number[] = [], expedite = true): Promise<{ kind: string; retryAfter: number | null }> {
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
      const pool = await this.poolFor(region);
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
      if (!active && expedite) this.expediteArena(state);
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
      const field = kind === "player" ? "playerInterests" : kind === "song" ? "songInterests" : "cardInterests";
      const queue = (state[field] ?? []).filter((entry) => now - entry.requestedAtMs < DEMAND_TTL_MS);
      const missing = ids.filter((id) => !queue.some((entry) => entry.id === id));
      if (!missing.length) {
        if (!state.lookup || state.lookup.complete || state.lookup.deadlineMs + 15_000 < now) {
          await this.queueLookup(region, now + 1_000);
          this.ctx.waitUntil(this.runLookup(region));
        }
        return { kind: "pending", retryAfter: 3 };
      }
      if (queue.length + missing.length > DEMAND_LIMITS[kind]) return { kind: "queue_full", retryAfter: 60 };
      state[field] = [...queue, ...missing.map((id) => ({ id, requestedAtMs: now }))];
      await this.ctx.storage.put("collectorState", state);
      await this.queueLookup(region, now + 1_000);
      this.ctx.waitUntil(this.runLookup(region));
      return { kind: "pending", retryAfter: 3 };
    });
  }

  /** Secret/manual entries and verified regional platform sessions share selection and health. */
  private async poolFor(region: GameRecordsRegion): Promise<OfficialCollectorPool | null> {
    const extra = await this.ctx.storage.get<Record<string, unknown>[]>("extraAccounts") ?? [];
    const [managed, ownedPlayers] = region === "jp"
      ? await Promise.all([readReadyGuestAccounts(this.env), readGuestPlayerIds(this.env)])
      : await Promise.all([readReadyPlatformAccounts(this.env, region), readPlatformPlayerIds(this.env, region)]);
    for (const playerId of await readRemovedPlayerIds(this.env, region)) ownedPlayers.add(playerId);
    if (!extra.length && !managed.length && !ownedPlayers.size) return configFor(this.env, region);
    const secret = this.env[`OFFICIAL_RANKING_${region.toUpperCase()}_CONFIG` as "OFFICIAL_RANKING_JP_CONFIG"];
    const base = secret?.trim() ? object(JSON.parse(secret)) : null;
    const accounts = base?.contract === "haneoka:official-ranking-account-pool/1" ? base.accounts as unknown[]
      : base ? [{ ...base, id: "default", enabled: true, state: "ready" }] : [];
    const manual = accounts.length || extra.length ? await parseOfficialCollectorConfiguration(JSON.stringify({ ...(base?.contract ? base : {}),
      contract: "haneoka:official-ranking-account-pool/1", region, accounts: [...accounts, ...extra] }), region) : null;
    const manualAccounts = manual?.accounts.filter((account) =>
      !ownedPlayers.has(normalizeOfficialPlayerId(String((account.credentials.credentials as JsonObject).player_id)))) ?? [];
    const preferredIdentity = manualAccounts.some((account) => account.identity === manual?.preferredIdentity) ? manual!.preferredIdentity : null;
    if (!managed.length) return { accounts: manualAccounts, preferredIdentity };
    const automatic = await parseOfficialCollectorConfiguration(JSON.stringify({
      contract: "haneoka:official-ranking-account-pool/1", region, accounts: managed }), region);
    const combined = [...manualAccounts, ...automatic.accounts.map((account) => ({ ...account,
      enabled: manual?.accounts.find((entry) => entry.identity === account.identity)?.enabled ?? account.enabled }))];
    return { accounts: combined,
      preferredIdentity: combined.some((account) => account.identity === manual?.preferredIdentity) ? manual!.preferredIdentity : null };
  }

  /** Redacted per-account state for the admin panel; never credentials. */
  async poolView(region: GameRecordsRegion): Promise<Record<string, unknown>> {
    const state = await this.stateFor(region), now = Date.now();
    let pool: OfficialCollectorPool | null = null;
    try { pool = await this.poolFor(region); } catch { return { region, status: "invalid_config", accounts: [] }; }
    if (!pool) return { region, status: "not_configured", accounts: [] };
    this.synchronizePool(state, pool);
    const extra = new Set((await this.ctx.storage.get<Record<string, unknown>[]>("extraAccounts") ?? []).map((row) => row.id));
    const names = new Map(region === "jp"
      ? (await listGuestAccounts(this.env)).filter((row) => row.playerId).map((row) => [row.playerId!, row.label])
      : (await listPlatformAccounts(this.env)).filter((row) => row.region === region && row.playerId).map((row) => [row.playerId!, row.email]));
    return { region, status: state.status, nextAtMs: state.nextAtMs, lastFailure: state.lastFailure ?? null,
      queued: (state.playerInterests ?? []).filter((entry) => now - entry.requestedAtMs < DEMAND_TTL_MS).length,
      accounts: pool.accounts.map((account) => {
        const health = state.accounts?.[account.identity];
        const status = poolAccountStatus(account, health, now);
        return { label: names.get(normalizeOfficialPlayerId(String((account.credentials.credentials as JsonObject).player_id))) ?? account.label, identity: account.identity, status, removable: extra.has(account.label),
          preferred: account.identity === pool!.preferredIdentity, clientVersion: account.clientVersion,
          lastUsedAtMs: health?.lastUsedAtMs || null, lastSuccessAtMs: health?.lastSuccessAtMs ?? null,
          cooldownUntilMs: health?.cooldownUntilMs ?? 0, failures: health?.failures ?? 0 };
      }) };
  }

  /** `hold` skips an account, `release` undoes it, `clear` forgets its pause and cooldown. */
  async poolAction(region: GameRecordsRegion, identity: string, action: "hold" | "release" | "clear" | "remove"): Promise<boolean> {
    return this.serialized(async () => {
      const state = await this.stateFor(region);
      const pool = await this.poolFor(region);
      const account = pool?.accounts.find((row) => row.identity === identity);
      if (!pool || !account) return false;
      this.synchronizePool(state, pool);
      const health = state.accounts![identity]!;
      if (action === "remove") {
        const extra = await this.ctx.storage.get<Record<string, unknown>[]>("extraAccounts") ?? [];
        const kept = extra.filter((row) => row.id !== account.label);
        if (kept.length === extra.length) return false;
        await this.ctx.storage.put("extraAccounts", kept);
        delete state.accounts![identity];
      } else if (action === "hold") health.held = true;
      else if (action === "release") health.held = false;
      else {
        delete state.platformRenewals?.[identity];
        health.blocked = {};
        health.cooldownUntilMs = 0;
        health.failures = 0;
        health.rejections = 0;
        if (state.permissionPause?.identity === identity) state.permissionPause = null;
        if (state.legacyPermissionBlock) state.legacyPermissionBlock = null;
        if (pool.accounts.some((row) => row.generation === state.blockedGeneration && row.identity === identity)) state.blockedGeneration = null;
        if (["auth_paused", "auth_uncertain", "no_available_account"].includes(state.status)) state.status = "not_started";
        state.nextAtMs = Math.min(state.nextAtMs || Date.now(), Date.now() + 1_000);
      }
      await this.persist(state);
      return true;
    });
  }

  /** Adds an account in the pool's own format after validating it with the parser. */
  async poolAdd(region: GameRecordsRegion, value: unknown): Promise<string> {
    return this.serialized(async () => {
      const account = object(value);
      try {
        await parseOfficialCollectorConfiguration(JSON.stringify({ contract: "haneoka:official-ranking-account-pool/1", region, accounts: [account] }), region);
      } catch { return "invalid_account"; }
      const extra = await this.ctx.storage.get<Record<string, unknown>[]>("extraAccounts") ?? [];
      try { await this.ctx.storage.put("extraAccounts", [...extra, account]); await this.poolFor(region); }
      catch { await this.ctx.storage.put("extraAccounts", extra); return "duplicate_account"; }
      return "ok";
    });
  }

  private async queueLookup(region: GameRecordsRegion, atMs: number): Promise<void> {
    this.deleteSchedules("runLookup");
    await this.schedule(new Date(Math.ceil(atMs / 1000) * 1000), "runLookup", region);
  }

  async runLookup(region: GameRecordsRegion): Promise<void> {
    const job = await this.serialized(async (): Promise<OfficialCollectorJob | null> => {
      if (!officialRegionEnabled(this.env.OFFICIAL_RANKING_ENABLED_REGIONS, region)) {
        this.deleteSchedules("runLookup");
        return null;
      }
      if (region === "jp" ? await this.guestJobView() : await this.platformLoginView(region)) {
        await this.queueLookup(region, Date.now() + 5_000);
        return null;
      }
      const state = await this.stateFor(region), now = Date.now();
      if ((state.lookupNextAtMs ?? 0) > now) {
        await this.queueLookup(region, state.lookupNextAtMs!);
        return null;
      }
      if (state.lookup && !state.lookup.complete && now <= state.lookup.deadlineMs + 15_000) {
        await this.queueLookup(region, state.lookup.deadlineMs + 15_001);
        return null;
      }
      const live = (entries?: DemandInterest[], limit = 16) =>
        (entries ?? []).filter((entry) => now - entry.requestedAtMs < DEMAND_TTL_MS).slice(0, limit).map((entry) => entry.id);
      const hadRequests = Boolean(state.playerInterests?.length || state.songInterests?.length || state.cardInterests?.length);
      for (const field of ["playerInterests", "songInterests", "cardInterests"] as const)
        state[field] = (state[field] ?? []).filter((entry) => now - entry.requestedAtMs < DEMAND_TTL_MS);
      const playerLookups = live(state.playerInterests), cardImages = live(state.cardInterests, 32);
      const songRankings = !playerLookups.length && !cardImages.length ? live(state.songInterests, 1) : [];
      if (songRankings.length && (state.songLookupNextAtMs ?? 0) > now) {
        await this.ctx.storage.put("collectorState", state);
        await this.queueLookup(region, state.songLookupNextAtMs!);
        return null;
      }
      if (!playerLookups.length && !songRankings.length && !cardImages.length) {
        this.deleteSchedules("runLookup");
        if (hadRequests) await this.ctx.storage.put("collectorState", state);
        return null;
      }
      let pool: OfficialCollectorPool | null;
      try { pool = await this.poolFor(region); } catch { return null; }
      if (!pool) return null;
      this.synchronizePool(state, pool);
      if (songRankings.length) {
        const idle = pool.accounts.filter((account) => account.enabled && account.ready && !account.initialPause
          && account.availableAtMs <= now && !state.accounts?.[account.identity]?.held
          && !state.accounts?.[account.identity]?.blocked[account.authGeneration]
          && (state.accounts?.[account.identity]?.cooldownUntilMs ?? 0) <= now
          && (state.accounts?.[account.identity]?.leaseUntilMs ?? 0) <= now);
        if (idle.length < 2) {
          await this.ctx.storage.put("collectorState", state);
          await this.queueLookup(region, Math.max(now + 30_000, state.nextAtMs ?? 0));
          return null;
        }
      }
      const config = this.accountFor(state, pool);
      if (!config) {
        const available = pool.accounts.filter((account) => account.enabled && account.ready && !account.initialPause && !state.accounts?.[account.identity]?.held
          && !state.accounts?.[account.identity]?.blocked[account.authGeneration]);
        if (available.length && !state.permissionPause && !state.legacyPermissionBlock) {
          const next = Math.min(...available.map((account) => Math.max(account.availableAtMs,
            state.accounts?.[account.identity]?.cooldownUntilMs ?? 0, state.accounts?.[account.identity]?.leaseUntilMs ?? 0)));
          await this.queueLookup(region, Math.max(now + 3_000, next + 1));
        }
        await this.ctx.storage.put("collectorState", state);
        return null;
      }
      const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
      const runId = crypto.randomUUID().replaceAll("-", "");
      const duration = songRankings.length ? 30_000 : LOOKUP_MS;
      if (songRankings.length) state.songLookupNextAtMs = now + 60_000;
      state.lookup = { id: runId, token, generation: config.generation, accountIdentity: config.identity,
        authGeneration: config.authGeneration, apiOrigin: String(config.credentials.origin), startedAtMs: now, deadlineMs: now + duration,
        pendingAttempt: null, resolvedAttempt: false, complete: false, catalog: null, checkpoints: {},
        attempted: { player: playerLookups, song: songRankings, card: cardImages }, songOnly: Boolean(songRankings.length) };
      const health = state.accounts?.[config.identity];
      if (health) { health.lastUsedAtMs = now; health.leaseUntilMs = now + duration + 15_000; }
      let serviceToken = await this.ctx.storage.get<string>("containerToken");
      if (!serviceToken) { serviceToken = token; await this.ctx.storage.put("containerToken", serviceToken); }
      this.envVars = { OFFICIAL_COLLECTOR_TOKEN: serviceToken, OFFICIAL_CALLBACK_ORIGIN: this.callbackOrigin };
      await this.ctx.storage.put("collectorState", state);
      await this.queueLookup(region, now + duration + 15_001);
      return { contract: "haneoka:official-ranking-job/1", mode: "lookup", region, runId, credentialGeneration: config.generation,
        capabilities: ["player-demand-v1", "demand-progress-v1"], playerLookups, songRankings, cardImages, arenaProgress: [], arenaWindows: [],
        clientVersion: config.clientVersion, credentials: config.credentials, masterConfig: config.masterConfig,
        callbackUrl: `${this.callbackOrigin}/api/internal/official-rankings/${region}/${runId}`, callbackToken: token, deadlineMs: now + duration };
    });
    if (!job) return;
    let failed = false;
    let busy = false;
    let failure: OfficialCollectorFailure | null = null;
    try {
      const serviceToken = await this.ctx.storage.get<string>("containerToken");
      const response = await this.containerFetch("http://container/collect", { method: "POST",
        headers: { Authorization: `Bearer ${serviceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(job), signal: AbortSignal.timeout(LOOKUP_MS + 15_000) });
      failed = !response.ok;
      if (response.ok) await response.arrayBuffer();
      else if (response.status === 409) {
        busy = object(await response.json()).error === "busy";
        if (!busy) failure = { stage: "container", code: "http_error", httpStatus: response.status };
      } else failure = await responseFailure(response) ?? { stage: "container", code: "http_error", httpStatus: response.status };
    } catch (error) {
      failed = true;
      failure = { stage: "container", code: error instanceof Error && error.name === "TimeoutError" ? "TimeoutError" : "container_fetch_failed" };
    }
    const again = await this.serialized(async () => {
      const state = await this.stateFor(region), lookup = state.lookup;
      if (!lookup || lookup.id !== job.runId) return false;
      if (!lookup.complete) {
        lookup.complete = true;
        if (busy) {
          delete lookup.attempted;
          if (!lookup.songOnly) state.lookupNextAtMs = Date.now() + 1_000;
        } else if (failed && lookup.songOnly) {
          state.songLookupFailures = (state.songLookupFailures ?? 0) + 1;
          state.songLookupNextAtMs = Math.max(state.songLookupNextAtMs ?? 0, Date.now() + recoveryDelay(state.songLookupFailures));
        } else if (failed) {
          state.lookupFailures = (state.lookupFailures ?? 0) + 1;
          state.lookupNextAtMs = Date.now() + recoveryDelay(state.lookupFailures);
          state.lookupLastFailure = failure;
        }
        const health = lookup.accountIdentity ? state.accounts?.[lookup.accountIdentity] : undefined;
        if (health && health.leaseUntilMs <= lookup.deadlineMs + 15_000) health.leaseUntilMs = 0;
      }
      // Without a completion acknowledgement, retire the admitted requests once.
      const tried = lookup.attempted;
      if (tried) {
        const drop = (entries: DemandInterest[] | undefined, ids: string[]) => (entries ?? []).filter((entry) => !ids.includes(entry.id));
        state.playerInterests = drop(state.playerInterests, tried.player);
        state.songInterests = drop(state.songInterests, tried.song);
        state.cardInterests = drop(state.cardInterests, tried.card);
        delete lookup.attempted;
      }
      await this.ctx.storage.put("collectorState", state);
      if (state.playerInterests?.length || state.songInterests?.length || state.cardInterests?.length) {
        const next = state.playerInterests?.length || state.cardInterests?.length
          ? state.lookupNextAtMs ?? 0 : Math.max(state.lookupNextAtMs ?? 0, state.songLookupNextAtMs ?? 0);
        await this.queueLookup(region, Math.max(Date.now() + 1_000, next));
      }
      else this.deleteSchedules("runLookup");
      return !failed;
    });
    if (again) await this.runLookup(region);
  }

  /** Applies a player, song or card result from either job. */
  private async applyDemand(state: CollectorState, region: GameRecordsRegion, update: OfficialCollectorUpdate): Promise<Response | null> {
    if (update.type === "player-profile") {
      if (!decimal(update.profileId) || !Number.isSafeInteger(update.observedAtMs)) return json({ error: "invalid_update" }, 400);
      await saveOfficialPlayers(this.env, region, [{ profileId: update.profileId, found: update.found === true,
        profile: update.profile ?? null, totalFavorite: update.totalFavorite ?? null, observedAtMs: update.observedAtMs }]);
      state.playerInterests = (state.playerInterests ?? []).filter((entry) => entry.id !== update.profileId);
    } else if (update.type === "card-image") {
      if (!CARD_FILE.test(update.file) || typeof update.data !== "string") return json({ error: "invalid_update" }, 400);
      await saveOfficialCardImage(this.env, region, update.file, Uint8Array.from(atob(update.data), (character) => character.charCodeAt(0)));
      state.cardInterests = (state.cardInterests ?? []).filter((entry) => entry.id !== update.file);
    } else if (update.type === "song-ranking") {
      if (!decimal(update.musicId) || !Array.isArray(update.players) || update.players.length > 100
        || !Number.isSafeInteger(update.observedAtMs)) return json({ error: "invalid_update" }, 400);
      await saveOfficialSongRanking(this.env, { region, musicId: update.musicId, players: update.players, observedAtMs: update.observedAtMs });
      await harvestOfficialPlayers(this.env, region, update.players, update.observedAtMs);
      state.songInterests = (state.songInterests ?? []).filter((entry) => entry.id !== update.musicId);
    }
    if (update.type === "player-profile" || update.type === "song-ranking") {
      const run = state.lookup?.id === update.runId ? state.lookup : state.run;
      const health = run?.accountIdentity ? state.accounts?.[run.accountIdentity] : undefined;
      if (health) health.lastSuccessAtMs = Math.max(health.lastSuccessAtMs ?? 0, update.observedAtMs);
    }
    return null;
  }

  private async lookupCallback(region: GameRecordsRegion, runId: string, update: OfficialCollectorUpdate): Promise<Response> {
    return this.serialized(async () => {
      const state = await this.stateFor(region), lookup = state.lookup;
      if (!lookup || lookup.id !== runId || update.contract !== "haneoka:official-ranking-update/1"
        || update.region !== region || update.runId !== runId || update.credentialGeneration !== lookup.generation) return json({ error: "run_mismatch" }, 409);
      if (update.type === "complete") {
        if (!["ok", "failed", "auth_paused", "rate_limited"].includes(update.status)) return json({ error: "invalid_update" }, 400);
        if (update.failure !== undefined) {
          try { validateFailure(update.failure); } catch { return json({ error: "invalid_update" }, 400); }
        }
        if (lookup.complete) return json({ ok: true });
        if (update.processedDemand && lookup.attempted) {
          const processed = update.processedDemand;
          for (const kind of ["player", "song", "card"] as const) {
            if (!Array.isArray(processed[kind]) || processed[kind].length > lookup.attempted[kind].length
              || processed[kind].some((id) => typeof id !== "string" || !lookup.attempted![kind].includes(id))) return json({ error: "invalid_update" }, 400);
          }
          if (update.status === "ok" || processed.player.length + processed.song.length + processed.card.length > 0)
            lookup.attempted = processed;
        }
        lookup.complete = true;
        if (update.status === "ok" && lookup.songOnly) {
          state.songLookupFailures = 0;
        } else if (update.status === "ok") {
          state.lookupFailures = 0;
          state.lookupNextAtMs = 0;
          state.lookupLastFailure = null;
        } else if (update.status === "failed" && transientCollectorFailure(update.failure) && lookup.songOnly) {
          state.songLookupFailures = (state.songLookupFailures ?? 0) + 1;
          state.songLookupNextAtMs = Math.max(state.songLookupNextAtMs ?? 0, Date.now() + recoveryDelay(state.songLookupFailures));
        } else if (update.status === "failed" && transientCollectorFailure(update.failure)) {
          state.lookupFailures = (state.lookupFailures ?? 0) + 1;
          state.lookupNextAtMs = Date.now() + recoveryDelay(state.lookupFailures);
          state.lookupLastFailure = update.failure ?? null;
        }
        const health = lookup.accountIdentity ? state.accounts?.[lookup.accountIdentity] : undefined;
        if (health) {
          health.leaseUntilMs = 0;
          if (update.status === "rate_limited") health.cooldownUntilMs = Date.now() + retryMs(update.retryAfterSeconds);
          if (update.status === "ok") health.failures = 0;
          if (rejectedSessionFailure(update)) {
            health.rejections = (health.rejections ?? 0) + 1;
            health.cooldownUntilMs = Math.max(health.cooldownUntilMs, Date.now() + AUTH_RETRY_MS * health.rejections);
          }
        }
        if (rejectedSessionFailure(update)) await this.rememberPlatformRenewal(state, lookup);
        const tried = lookup.attempted;
        if (tried) {
          const drop = (entries: DemandInterest[] | undefined, ids: string[]) => (entries ?? []).filter((entry) => !ids.includes(entry.id));
          state.playerInterests = drop(state.playerInterests, tried.player);
          state.songInterests = drop(state.songInterests, tried.song);
          state.cardInterests = drop(state.cardInterests, tried.card);
          delete lookup.attempted;
        }
      } else if (["player-profile", "song-ranking", "card-image"].includes(update.type)) {
        const refused = await this.applyDemand(state, region, update);
        if (refused) return refused;
      } else return json({ error: "invalid_update" }, 400);
      await this.ctx.storage.put("collectorState", state);
      return json({ ok: true });
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
    // Pauses from before strikes each came from one response: lift them, with one rejection left.
    if (!state.strikesApplied) {
      state.strikesApplied = true;
      for (const health of Object.values(accounts)) {
        if (!Object.keys(health.blocked).length) continue;
        health.blocked = {};
        health.rejections = AUTH_STRIKES - 1;
      }
      state.permissionPause = null;
      state.blockedGeneration = null;
      if (["auth_paused", "auth_uncertain"].includes(state.status)) state.status = "not_started";
    }
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
      // The rejected account stays blocked on its own; any other usable account keeps the region running.
      const usable = pool.accounts.find((account) => account.enabled && account.ready && !account.initialPause
        && !accounts[account.identity]!.blocked[account.authGeneration]);
      if (usable) state.permissionPause = null;
    }
  }

  private runHealth(state: CollectorState): OfficialCollectorAccountHealth | null {
    return state.run?.accountIdentity ? state.accounts?.[state.run.accountIdentity] ?? null : null;
  }

  /** A single rejection or a lost response proves little: the account rests and is tried again. Only repeated
   * rejections pause it. `auth_uncertain` says nothing about the credential, so it never counts. */
  private pauseRun(state: CollectorState, kind: "auth_paused" | "auth_uncertain", permission = false): void {
    const run = state.run;
    if (!run) return;
    const health = this.runHealth(state);
    if (health && kind === "auth_paused" && !run.authStruck) {
      run.authStruck = true;
      health.rejections = (health.rejections ?? 0) + 1;
    }
    if (health && (kind === "auth_uncertain" || (health.rejections ?? 0) < AUTH_STRIKES)) {
      health.cooldownUntilMs = Math.max(health.cooldownUntilMs, Date.now() + AUTH_RETRY_MS * Math.max(1, health.rejections ?? 0));
      state.status = "failed";
      return;
    }
    state.blockedGeneration = run.generation;
    state.status = kind;
    if (health && run.authGeneration) health.blocked[run.authGeneration] = kind;
    if (permission && run.accountIdentity && run.authGeneration) state.permissionPause = { identity: run.accountIdentity, authGeneration: run.authGeneration };
  }

  private expireRun(state: CollectorState): boolean {
    const run = state.run;
    if (!run || run.complete) return false;
    if (Date.now() <= run.deadlineMs + 15_000) return true;
    run.complete = true;
    if (!state.blockedGeneration && !state.permissionPause && !state.legacyPermissionBlock) {
      state.status = "failed";
      state.lastFailure = { stage: "container", code: "TimeoutError" };
      state.failures += 1;
      state.nextAtMs = Math.min(state.nextAtMs || Date.now(), Date.now() + recoveryDelay(state.failures));
    }
    const health = this.runHealth(state);
    if (health && health.leaseUntilMs <= run.deadlineMs + 15_000) health.leaseUntilMs = 0;
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
    if (region === "jp" && this.env.OFFICIAL_GLOBAL_LOGIN_CONFIG
      && (JSON.parse(this.env.OFFICIAL_GLOBAL_LOGIN_CONFIG) as { bootstrapAccounts?: string }).bootstrapAccounts) {
      try { await this.adoptConfiguredGuests(true); }
      catch (error) { console.warn(JSON.stringify({ event: "official_guest_bootstrap_failed", error: error instanceof Error ? error.name : "Error" })); }
    }
    await this.serialized(async () => {
      try { await adoptConfiguredPlatformAccounts(this.env); }
      catch (error) { console.warn(JSON.stringify({ event: "official_account_bootstrap_failed", error: error instanceof Error ? error.name : "Error" })); }
      if (await this.ctx.storage.get("platformCascade")) await this.schedule(new Date(Date.now() + 1_000), "continuePlatformLogin");
      const state = await this.stateFor(region);
      if (!officialRegionEnabled(this.env.OFFICIAL_RANKING_ENABLED_REGIONS, region)) {
        state.status = "disabled";
        await this.persist(state, false);
        return;
      }
      if (state.playerInterests?.length || state.songInterests?.length || state.cardInterests?.length)
        await this.queueLookup(region, Date.now() + 1_000);
      let pool: OfficialCollectorPool | null;
      try { pool = await this.poolFor(region); }
      catch { state.status = "invalid_config"; await this.persist(state, false); return; }
      if (!pool) { state.status = "not_configured"; await this.persist(state, false); return; }
      this.synchronizePool(state, pool);
      if (state.readRecoveryVersion !== 3) {
        const rateLimited = state.status === "rate_limited" || Boolean(state.lastFailure && limited(state.lastFailure));
        for (const account of pool.accounts) {
          const health = state.accounts?.[account.identity];
          if (rateLimited || !health || health.held || health.rejections || health.blocked[account.authGeneration] === "auth_paused") continue;
          if (health.blocked[account.authGeneration] === "auth_uncertain") delete health.blocked[account.authGeneration];
          health.cooldownUntilMs = 0;
          health.failures = 0;
          if (state.blockedGeneration === account.generation) state.blockedGeneration = null;
        }
        if (!rateLimited && state.run?.complete && transientCollectorFailure(state.lastFailure) && !state.permissionPause && !state.legacyPermissionBlock) {
          state.nextAtMs = Date.now();
          if (["failed", "no_available_account", "auth_uncertain"].includes(state.status)) state.status = "not_started";
        }
        state.readRecoveryVersion = 3;
      }
      const renewals = Object.values(state.platformRenewals ?? {});
      if (region !== "jp" && renewals.length)
        await this.schedule(new Date(Math.max(Date.now() + 1_000, Math.min(...renewals.map((entry) => entry.notBeforeMs)))), "renewPlatformSessions", region);
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
      const bootstrap = this.env.OFFICIAL_GLOBAL_LOGIN_CONFIG
        ? (JSON.parse(this.env.OFFICIAL_GLOBAL_LOGIN_CONFIG) as { bootstrapAccounts?: string }).bootstrapAccounts : undefined;
      if (region !== "jp" && bootstrap) {
        const digest = await officialDigest(bootstrap);
        const managed = pool.accounts.filter((account) => account.label.startsWith("platform:"));
        const expected = (await readPlatformBootstraps(this.env)).length;
        const active = [state.run, state.lookup].some((run) => run && !run.complete && run.deadlineMs + 15_000 > Date.now());
        if (state.accountBootstrapDigest !== digest && expected > 0 && managed.length === expected && !active) {
          for (const account of managed) {
            const health = state.accounts?.[account.identity];
            if (health) { health.blocked = {}; health.cooldownUntilMs = 0; health.failures = 0; health.rejections = 0; }
          }
          if (managed.some((account) => account.identity === state.permissionPause?.identity)) state.permissionPause = null;
          state.accountBootstrapDigest = digest;
          state.nextAtMs = Date.now();
          if (["failed", "auth_paused", "auth_uncertain", "no_available_account"].includes(state.status)) state.status = "not_started";
        }
      }
      if (!this.accountFor(state, pool)) { await this.unavailablePool(state, pool); return; }
      state.blockedGeneration = null;
      await this.persist(state);
    });
  }

  async status(region: GameRecordsRegion): Promise<Record<string, unknown>> {
    const state = structuredClone(await this.stateFor(region));
    const unavailable = await officialCollectorAvailability(this.env, region);
    let pool: OfficialCollectorPool | null = null;
    try { pool = await this.poolFor(region); } catch { /* Availability reports invalid configuration. */ }
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
      ageMs: age, stale: age === null || age < 0 || age > 2 * INTERVAL_MS, pollAfterSeconds: unavailable ? 300 : 30,
      lastFailure: state.lastFailure ?? null,
      sampling: { arenaProbes: state.arenaProbeReads ?? 0, arenaStoredWindows: state.arenaStoredReads ?? 0,
        windowReuseSeconds: WINDOW_REUSE_MS / 1000, windowReuses: state.windowReuses ?? 0, windowDeferrals: state.windowDeferrals ?? 0,
        populationTargetSeconds: ARENA_POPULATION_TARGET_MS / 1000,
        populationCatchupSeconds: ARENA_POPULATION_CATCHUP_MS / 1000,
        populationProgress: Object.entries(state.arenaProgress ?? {}).map(([key, progress]) => ({
          bandId: progress.bandId, lastWorkedAtMs: progress.updatedAtMs ?? null,
          publishedAtMs: state.arenaPopulationAt?.[key] ?? null, unknown: progress.counts.filter((value) => value === null).length,
          reason: progress.deferredReason ?? null })) },
      demand: { queued: [...state.playerInterests ?? [], ...state.songInterests ?? [], ...state.cardInterests ?? []]
          .filter((entry) => now - entry.requestedAtMs < DEMAND_TTL_MS).length,
        retryAtMs: (state.lookupNextAtMs ?? 0) > now ? state.lookupNextAtMs : null, lastFailure: state.lookupLastFailure ?? null },
      pool: counts,
      nextAttemptAtMs: unavailable || !canSchedule ? null : state.nextAtMs || null, catalogProvider: "official-master" };
  }

  async collectDue(region: GameRecordsRegion): Promise<void> {
    const job = await this.serialized(async (): Promise<OfficialCollectorJob | null> => {
      if (region === "jp" ? await this.guestJobView() : await this.platformLoginView(region)) return null;
      const state = await this.stateFor(region);
      if (!officialRegionEnabled(this.env.OFFICIAL_RANKING_ENABLED_REGIONS, region)) { state.status = "disabled"; await this.persist(state, false); return null; }
      let pool: OfficialCollectorPool | null;
      try { pool = await this.poolFor(region); }
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
      const final = now >= (state.nextFinalAtMs ?? 0) ? await takeOfficialFinalTarget(this.env, region, now) : null;
      const eventFinal = final?.kind === "event" ? final : null;
      const arenaFinal = final?.kind === "arena" ? final : null;
      if (final) state.nextFinalAtMs = now + 2 * INTERVAL_MS;
      state.run = { id: runId, token, generation: config.generation, accountIdentity: config.identity,
        authGeneration: config.authGeneration, apiOrigin: String(config.credentials.origin), startedAtMs: now, deadlineMs: now + JOB_MS,
        pendingAttempt: null, resolvedAttempt: false, complete: false, catalog: null, checkpoints: {}, arenaProbes: true,
        ...(eventFinal ? { finalEvent: eventFinal.event, finalBoards: eventFinal.boards, finalWindows: eventFinal.windows } : {}),
        ...(arenaFinal ? { finalArena: arenaFinal.arena, finalArenaWindows: arenaFinal.windows, finalPopulationBands: arenaFinal.populationBands } : {}) };
      const health = this.runHealth(state);
      if (health) { health.lastUsedAtMs = now; health.leaseUntilMs = now + JOB_MS + 15_000; }
      state.status = "collecting";
      state.lastFailure = null;
      state.blockedGeneration = null;
      state.lastRunAtMs = now;
      // Accounts take turns, so each keeps the base rate however many there are.
      const usable = pool.accounts.filter((account) => account.enabled && account.ready && !account.initialPause
        && !state.accounts?.[account.identity]?.held && !state.accounts?.[account.identity]?.blocked[account.authGeneration]
        && (state.accounts?.[account.identity]?.cooldownUntilMs ?? 0) <= now).length;
      state.nextAtMs = now + Math.max(WINDOW_REUSE_MS, Math.ceil(INTERVAL_MS / Math.max(1, usable)));
      const demanded = (state.arenaInterests ?? []).filter((entry) => now - entry.requestedAtMs < ARENA_INTEREST_TTL_MS)
        .slice(0, 20).map(({ seasonId, bandId, startRank, endRank }) => ({ seasonId, bandId, startRank, endRank }));
      const eventDemand = (state.eventInterests ?? []).filter((entry) => now - entry.requestedAtMs < ARENA_INTEREST_TTL_MS)
        .slice(0, 10).map(({ eventId, startRank, endRank }) => ({ eventId, startRank, endRank }));
      const eventSwept = final ? [] : await this.eventSweep(state, region, now);
      const arena = state.arenaCatalog;
      const populationOrder = [...(arena?.bandIds ?? [])].filter((id) => arena?.thresholdsByBand?.[id]?.length !== 0)
        .sort((left, right) => (state.arenaPopulationAt?.[`${arena!.seasonId}:${left}`] ?? 0) - (state.arenaPopulationAt?.[`${arena!.seasonId}:${right}`] ?? 0));
      if (populationOrder.length > 1 && (state.populationWorkStreak ?? 0) >= 3
        && state.populationWorkKey === `${arena!.seasonId}:${populationOrder[0]}`) populationOrder.push(populationOrder.shift()!);
      const populationDue = arena && now >= arena.startAtMs && now < arena.rankingEndAtMs
        && arena.bandIds.some((id) => arena.thresholdsByBand?.[id]?.length !== 0
          && now - (state.arenaPopulationAt?.[`${arena.seasonId}:${id}`] ?? 0) > ARENA_POPULATION_CATCHUP_MS);
      const swept = final || populationDue ? [] : await this.arenaSweep(state, region, now, Math.min(ARENA_SWEEP_WINDOWS, 20 - demanded.length));
      state.run.eventSweepWindows = eventSwept;
      state.run.sweepWindows = swept;
      const eventWindows = final ? eventFinal?.windows ?? [] : [...eventDemand, ...eventSwept
        .filter((row) => !eventDemand.some((entry) => entry.eventId === row.eventId && entry.startRank === row.startRank))];
      const arenaWindows = final ? arenaFinal?.windows ?? [] : [...demanded, ...swept];
      let serviceToken = await this.ctx.storage.get<string>("containerToken");
      if (!serviceToken) { serviceToken = token; await this.ctx.storage.put("containerToken", serviceToken); }
      this.envVars = { OFFICIAL_COLLECTOR_TOKEN: serviceToken, OFFICIAL_CALLBACK_ORIGIN: this.callbackOrigin };
      await this.persist(state);
      return { contract: "haneoka:official-ranking-job/1", region, runId, credentialGeneration: config.generation,
        capabilities: eventFinal ? ["event-finals-v1", "ranking-window-cache-v1", ...(eventFinal.windows.length ? ["event-windows-v1"] : [])]
          : arenaFinal ? ["arena-finals-v1", "arena-ranking-v1", "arena-population-v1", "arena-progress-v1", "arena-probes-v1", "population-priority-v1", "ranking-window-cache-v1"]
            : ["arena-ranking-v1", "arena-population-v1", "arena-progress-v1", "arena-demand-v1", "event-windows-v1", "arena-probes-v1", "population-priority-v1", "ranking-window-cache-v1"],
        ...(eventFinal ? { finalEvent: eventFinal.event, finalBoards: eventFinal.boards } : {}),
        ...(arenaFinal ? { finalArena: arenaFinal.arena, finalPopulationBands: arenaFinal.populationBands } : {}),
        playerLookups: [], songRankings: [], cardImages: [],
        populationOrder,
        arenaProgress: arenaFinal ? arenaFinal.progress : Object.values(state.arenaProgress ?? {}).sort((a, b) => (a.updatedAtMs ?? 0) - (b.updatedAtMs ?? 0)),
        arenaWindows,
        eventWindows,
        clientVersion: config.clientVersion, credentials: config.credentials, masterConfig: config.masterConfig,
        callbackUrl: `${this.callbackOrigin}/api/internal/official-rankings/${region}/${runId}`, callbackToken: token, deadlineMs: now + JOB_MS };
    });
    if (!job) return;
    let failure: OfficialCollectorFailure | null = null;
    try {
      const serviceToken = await this.ctx.storage.get<string>("containerToken");
      // A remote collector accepts the run at once and reports its end through the callbacks.
      const response = await this.containerFetch("http://container/collect", { method: "POST",
        headers: { Authorization: `Bearer ${serviceToken}`, "Content-Type": "application/json", "X-Haneoka-Collector-Async": "1" },
        body: JSON.stringify(job), signal: AbortSignal.timeout(JOB_MS + 15_000) });
      if (response.status === 202) {
        await response.arrayBuffer();
        return;
      }
      if (!response.ok) {
        const detail = await responseFailure(response);
        failure = detail ? { ...detail, httpStatus: detail.httpStatus ?? response.status }
          : { stage: "container", code: "http_error", httpStatus: response.status };
      }
      else await response.arrayBuffer();
    } catch (error) {
      failure = { stage: "container", code: error instanceof Error && error.name === "TimeoutError" ? "TimeoutError" : "container_fetch_failed" };
    }
    await this.failRun(region, job.runId, failure);
  }

  /** A run that ended without its completion callback: the collector service failed it. */
  private async failRun(region: GameRecordsRegion, runId: string, failure: OfficialCollectorFailure | null): Promise<void> {
    if (failure) console.warn(JSON.stringify({ event: "official_ranking_container_failed", region, ...failure }));
    await this.serialized(async () => {
      const state = await this.stateFor(region);
      if (!state.run || state.run.id !== runId || state.run.complete) return;
      state.run.complete = true;
      state.lastFailure = failure ?? { stage: "container", code: "container_fetch_failed" };
      state.failures += 1;
      const serviceFailure = transientCollectorFailure(failure);
      state.nextAtMs = serviceFailure ? Date.now() + recoveryDelay(state.failures)
        : Math.max(state.nextAtMs, Date.now() + Math.min(3_600_000, INTERVAL_MS * 2 ** Math.min(4, state.failures - 1)));
      const health = this.runHealth(state);
      if (health) {
        if (health.leaseUntilMs <= state.run.deadlineMs + 15_000) health.leaseUntilMs = 0;
        if (!serviceFailure) { health.failures += 1; health.cooldownUntilMs = state.nextAtMs; }
      }
      if (!serviceFailure && state.run.pendingAttempt && !state.run.resolvedAttempt && !state.blockedGeneration) {
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
    const active = state.lookup?.id === runId ? state.lookup : state.run?.id === runId ? state.run : null;
    if (!active || !authorization.startsWith("Bearer ") || !await sameToken(authorization.slice(7), active.token))
      return json({ error: "unauthorized" }, 401);
    let update: OfficialCollectorUpdate;
    try { update = await boundedUpdate(request); }
    catch { return json({ error: "invalid_update" }, 400); }
    if (active === state.lookup) return this.lookupCallback(region, runId, update);
    if (update.type === "service-failure") {
      if (update.contract !== "haneoka:official-ranking-update/1" || update.region !== region || update.runId !== runId
        || update.credentialGeneration !== active.generation) return json({ error: "run_mismatch" }, 409);
      try { validateFailure(update.failure); } catch { return json({ error: "invalid_update" }, 400); }
      await this.failRun(region, runId, update.failure);
      return json({ ok: true });
    }
    return this.serialized(async () => {
      const state = await this.stateFor(region);
      const run = state.run;
      if (!run || run.id !== runId || update.contract !== "haneoka:official-ranking-update/1"
        || update.region !== region || update.runId !== runId || update.credentialGeneration !== run.generation) return json({ error: "run_mismatch" }, 409);
      if (!run.accountIdentity) {
        try { const pool = await this.poolFor(region); if (pool) this.synchronizePool(state, pool); }
        catch { return json({ error: "invalid_config" }, 409); }
      }
      let checkpoint: string;
      if (update.type === "catalog" || update.type === "complete") checkpoint = update.type;
      else if (update.type === "attempt") checkpoint = `attempt:${update.snapshotId}`;
      else if (update.type === "observation") checkpoint = `observation:${update.observation?.snapshotId}`;
      else if (update.type === "arena-observation" || update.type === "arena-probe") checkpoint = `${update.type === "arena-probe" ? "probe" : "arena"}:${update.observation?.snapshotId}`;
      else if (update.type === "event-window") checkpoint = `event-window:${update.observation?.snapshotId}`;
      else if (update.type === "arena-population") checkpoint = `arena-population:${update.observation?.snapshotId}`;
      else if (update.type === "arena-progress") checkpoint = `arena-progress:${update.checkpointId}`;
      else if (update.type === "player-profile") checkpoint = `player:${update.profileId}`;
      else if (update.type === "song-ranking") checkpoint = `song:${update.musicId}`;
      else if (update.type === "card-image") checkpoint = `card:${update.file}`;
      else return json({ error: "invalid_update" }, 400);
      const updateHash = await officialDigest(canonical(update));
      if (run.checkpoints[checkpoint]) {
        if (run.checkpoints[checkpoint] !== updateHash) return json({ error: "checkpoint_conflict" }, 409);
        if (update.type === "attempt" && update.windowKey) {
          const reply = this.ctx.storage.sql.exec<{ body_json: string }>("SELECT body_json FROM collector_window_replies WHERE snapshot_id=?", update.snapshotId).toArray()[0];
          if (reply) return json(JSON.parse(reply.body_json));
        }
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
          if (run.finalEvent) {
            if (canonical(update.catalog.event) !== canonical(run.finalEvent) || update.catalog.arena != null) return json({ error: "final_target_mismatch" }, 409);
          } else if (run.finalArena) {
            if (canonical(update.catalog.arena) !== canonical(run.finalArena) || update.catalog.event !== null) return json({ error: "final_target_mismatch" }, 409);
          } else await saveOfficialCatalog(this.env, update.catalog);
          run.catalog = update.catalog;
          if (!run.finalArena && update.catalog.arena !== undefined) {
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
          if (update.windowKey !== undefined) {
            const cached = await this.claimWindow(state, run, update, updateHash);
            if (cached) return cached;
          }
          run.pendingAttempt = update.snapshotId;
          run.resolvedAttempt = false;
          run.checkpoints[checkpoint] = updateHash;
          await this.ctx.storage.put("collectorState", state);
        } else if (update.type === "observation") {
          validateObservation(update.observation, region);
          if (run.pendingWindowKey && run.pendingWindowKey !== observationWindowKey(update.observation)) return json({ error: "board_mismatch" }, 409);
          if (run.pendingAttempt !== update.observation.snapshotId) return json({ error: "attempt_mismatch" }, 409);
          const event = run.catalog?.event;
          if (!event || update.observation.eventId !== event.id || update.observation.observedAtMs < run.startedAtMs
            || run.finalBoards && !run.finalBoards.some((board) => board.kind === update.observation.kind && board.challengeId === update.observation.challengeId)
            || (update.observation.kind === "total" ? !event.totalRankingEnabled
              : update.observation.kind === "point" ? !event.pointRankingEnabled
              : !event.challenges.some((challenge) => challenge.id === update.observation.challengeId && challenge.enabled))) {
            return json({ error: "board_mismatch" }, 409);
          }
          run.resolvedAttempt = true;
          if (authRejected(update.observation) && !(run.finalEvent && permissionRejected(update.observation))) {
            this.pauseRun(state, "auth_paused", permissionRejected(update.observation));
          }
          if (sessionRejected(update.observation)) await this.rememberPlatformRenewal(state, run);
          if (limited(update.observation)) {
            state.status = "rate_limited";
            state.nextAtMs = Math.max(state.nextAtMs, Date.now() + retryMs(update.observation.retryAfterSeconds));
            const health = this.runHealth(state);
            if (health) health.cooldownUntilMs = state.nextAtMs;
          }
          await this.ctx.storage.put("collectorState", state);
          await saveOfficialObservation(this.env, update.observation);
          if (update.observation.players) await harvestOfficialPlayers(this.env, region, update.observation.players, update.observation.observedAtMs);
          this.rememberWindow(run, update.observation, true);
          run.pendingAttempt = null;
          run.checkpoints[checkpoint] = updateHash;
          if (!update.observation.error) {
            state.lastSuccessfulObservationAtMs = Math.max(state.lastSuccessfulObservationAtMs ?? 0, update.observation.observedAtMs);
            const health = this.runHealth(state);
            if (health) {
              health.rejections = 0;
              health.lastSuccessAtMs = Math.max(health.lastSuccessAtMs ?? 0, update.observation.observedAtMs);
            }
          }
          await this.ctx.storage.put("collectorState", state);
        } else if (update.type === "player-profile" || update.type === "card-image" || update.type === "song-ranking") {
          const refused = await this.applyDemand(state, region, update);
          if (refused) return refused;
          run.checkpoints[checkpoint] = updateHash;
          await this.ctx.storage.put("collectorState", state);
        } else if (update.type === "event-window") {
          validateEventWindow(update.observation, region);
          const observation = update.observation;
          if (run.pendingWindowKey && run.pendingWindowKey !== observationWindowKey(observation)) return json({ error: "board_mismatch" }, 409);
          if (run.pendingAttempt !== observation.snapshotId) return json({ error: "attempt_mismatch" }, 409);
          if (observation.eventId !== run.catalog?.event?.id || observation.observedAtMs < run.startedAtMs) return json({ error: "board_mismatch" }, 409);
          if (run.finalEvent && !run.finalWindows?.some((window) => window.eventId === observation.eventId
            && window.startRank === observation.startRank && window.endRank === observation.endRank)) return json({ error: "board_mismatch" }, 409);
          run.resolvedAttempt = true;
          if (authRejected(observation) && !(run.finalEvent && permissionRejected(observation))) {
            this.pauseRun(state, "auth_paused", permissionRejected(observation));
          }
          if (sessionRejected(observation)) await this.rememberPlatformRenewal(state, run);
          if (limited(observation)) {
            state.status = "rate_limited";
            state.nextAtMs = Math.max(state.nextAtMs, Date.now() + retryMs(observation.retryAfterSeconds));
            const health = this.runHealth(state);
            if (health) health.cooldownUntilMs = state.nextAtMs;
          }
          await this.ctx.storage.put("collectorState", state);
          await saveOfficialEventWindow(this.env, observation);
          if (observation.startRank === 1) {
            const players = observation.players?.map((row) => ({ player_data: row.profile ?? {}, score: row.point ?? 0 }));
            await saveOfficialObservation(this.env, {
              snapshotId: observation.snapshotId, region, eventId: observation.eventId, kind: "point", challengeId: "",
              observedAtMs: observation.observedAtMs, ...(observation.provenance ? { provenance: observation.provenance } : {}),
              ...(observation.error ? { error: observation.error, httpStatus: observation.httpStatus ?? null, grpcStatus: observation.grpcStatus ?? null }
                : { players: players! }),
            });
            if (players) await harvestOfficialPlayers(this.env, region, players, observation.observedAtMs);
          }
          this.rememberWindow(run, observation, true);
          if (!observation.error) {
            state.eventInterests = (state.eventInterests ?? []).filter((entry) => entry.eventId !== observation.eventId || entry.startRank !== observation.startRank);
            const sweep = state.eventSweep;
            if (sweep?.eventId === observation.eventId) {
              if (observation.startRank > 1 && run.eventSweepWindows?.some((window) => window.startRank === observation.startRank))
                sweep.next = observation.startRank + 100;
              const last = observation.maxRank ?? null;
              // A full window past the known end means the board grew.
              if (last !== null) sweep.maxRank = Math.min(sweep.maxRank ?? last, last);
              else if (sweep.maxRank !== null && observation.endRank > sweep.maxRank) sweep.maxRank = null;
            }
          }
          run.pendingAttempt = null;
          run.checkpoints[checkpoint] = updateHash;
          await this.ctx.storage.put("collectorState", state);
        } else if (update.type === "arena-observation" || update.type === "arena-probe") {
          const retained = update.type === "arena-observation";
          if (!retained && !run.arenaProbes) return json({ error: "capability_mismatch" }, 409);
          validateArenaObservation(update.observation, region);
          if (run.pendingWindowKey && run.pendingWindowKey !== observationWindowKey(update.observation)) return json({ error: "board_mismatch" }, 409);
          if (run.pendingAttempt !== update.observation.snapshotId) return json({ error: "attempt_mismatch" }, 409);
          const arena = run.catalog?.arena;
          if (!arena || update.observation.seasonId !== arena.seasonId || !arena.bandIds.includes(update.observation.bandId)
            || update.observation.observedAtMs < run.startedAtMs) {
            return json({ error: "board_mismatch" }, 409);
          }
          if (run.finalArena && !run.finalPopulationBands?.includes(update.observation.bandId)
            && !run.finalArenaWindows?.some((window) => window.bandId === update.observation.bandId
              && window.startRank === update.observation.startRank && window.endRank === update.observation.endRank)) return json({ error: "board_mismatch" }, 409);
          run.resolvedAttempt = true;
          if (authRejected(update.observation) && !(run.finalArena && permissionRejected(update.observation))) {
            this.pauseRun(state, "auth_paused", permissionRejected(update.observation));
          }
          if (sessionRejected(update.observation)) await this.rememberPlatformRenewal(state, run);
          if (limited(update.observation)) {
            state.status = "rate_limited";
            state.nextAtMs = Math.max(state.nextAtMs, Date.now() + retryMs(update.observation.retryAfterSeconds));
            const health = this.runHealth(state);
            if (health) health.cooldownUntilMs = state.nextAtMs;
          }
          if (retained) await this.ctx.storage.put("collectorState", state);
          if (retained) await saveOfficialArenaObservation(this.env, update.observation);
          this.rememberWindow(run, update.observation, retained);
          if (retained && !update.observation.error) {
            const observation = update.observation;
            state.arenaInterests = (state.arenaInterests ?? []).filter((entry) => entry.seasonId !== observation.seasonId
              || entry.bandId !== observation.bandId || entry.startRank !== observation.startRank
              || observation.endRank < Math.min(entry.endRank, observation.maxRank ?? entry.endRank)
              || observation.players!.length < Math.max(0, Math.min(entry.endRank, observation.maxRank ?? entry.endRank) - entry.startRank + 1));
            if (state.arenaSweep && run.sweepWindows?.some((window) => window.bandId === observation.bandId && window.startRank === observation.startRank)) {
              const key = `${observation.seasonId}:${observation.bandId}${observation.startRank > ARENA_NEAR_RANKS ? ":deep" : ""}`;
              state.arenaSweep.next[key] = observation.startRank + 100;
              state.arenaSweep.band = (arena.bandIds.indexOf(observation.bandId) + 1) % arena.bandIds.length;
            }
          }
          run.pendingAttempt = null;
          run.checkpoints[checkpoint] = updateHash;
          if (!update.observation.error) {
            if (retained) state.lastSuccessfulObservationAtMs = Math.max(state.lastSuccessfulObservationAtMs ?? 0, update.observation.observedAtMs);
            if (retained) state.arenaStoredReads = (state.arenaStoredReads ?? 0) + 1;
            else state.arenaProbeReads = (state.arenaProbeReads ?? 0) + 1;
            const health = this.runHealth(state);
            if (health) {
              health.rejections = 0;
              health.lastSuccessAtMs = Math.max(health.lastSuccessAtMs ?? 0, update.observation.observedAtMs);
            }
          }
          await this.ctx.storage.put("collectorState", state);
        } else if (update.type === "arena-progress") {
          validateArenaProgress(update.progress);
          const arena = run.catalog?.arena, progress = update.progress;
          if (!/^[a-f0-9]{32}$/u.test(update.checkpointId) || run.pendingAttempt || !arena
            || progress.seasonId !== arena.seasonId || !arena.bandIds.includes(progress.bandId)) return json({ error: "board_mismatch" }, 409);
          const expected = arena.thresholdsByBand?.[progress.bandId];
          if (expected && !sameThresholds(expected, progress.thresholds)) return json({ error: "board_mismatch" }, 409);
          if (run.finalArena && !run.finalPopulationBands?.includes(progress.bandId)) return json({ error: "board_mismatch" }, 409);
          const stored: OfficialArenaProgress = {
            seasonId: progress.seasonId, bandId: progress.bandId, thresholds: progress.thresholds,
            maxRank: progress.maxRank, counts: progress.counts, cursor: progress.cursor,
            ...(progress.pending ? { pending: { index: progress.pending.index, low: progress.pending.low, high: progress.pending.high } } : {}),
            ...(progress.deferredReason ? { deferredReason: progress.deferredReason } : {}),
            ...(progress.witnessedAtMs ? { witnessedAtMs: progress.witnessedAtMs } : {}), updatedAtMs: Date.now(),
          };
          if (run.finalArena) await saveOfficialFinalArenaProgress(this.env, region, stored);
          else {
            state.arenaProgress ??= {};
            const key = `${progress.seasonId}:${progress.bandId}`;
            state.arenaProgress[key] = stored;
            state.populationWorkStreak = progress.deferredReason ? state.populationWorkKey === key ? (state.populationWorkStreak ?? 0) + 1 : 1 : 0;
            state.populationWorkKey = key;
          }
          run.checkpoints[checkpoint] = updateHash;
          await this.ctx.storage.put("collectorState", state);
        } else if (update.type === "arena-population") {
          validateArenaPopulation(update.observation, region);
          const arena = run.catalog?.arena;
          if (run.pendingAttempt || state.blockedGeneration || !arena || update.observation.seasonId !== arena.seasonId
            || !arena.bandIds.includes(update.observation.bandId) || update.observation.observedAtMs < run.startedAtMs - ARENA_WITNESS_REUSE_MS) {
            return json({ error: "board_mismatch" }, 409);
          }
          const expected = arena.thresholdsByBand?.[update.observation.bandId];
          if (expected && !sameThresholds(expected, update.observation.atLeast.map((row) => row.threshold))) return json({ error: "board_mismatch" }, 409);
          if (run.finalArena && !run.finalPopulationBands?.includes(update.observation.bandId)) return json({ error: "board_mismatch" }, 409);
          await saveOfficialArenaPopulation(this.env, update.observation);
          if (!run.finalArena) {
            state.arenaPopulationAt ??= {};
            state.arenaPopulationAt[`${update.observation.seasonId}:${update.observation.bandId}`] = update.observation.observedAtMs;
          }
          run.checkpoints[checkpoint] = updateHash;
          await this.ctx.storage.put("collectorState", state);
        } else if (update.type === "complete") {
          if (run.pendingAttempt || !["ok", "failed", "auth_paused", "rate_limited"].includes(update.status)) return json({ error: "attempt_pending" }, 409);
          if (update.failure !== undefined) validateFailure(update.failure);
          run.complete = true;
          state.lastFailure = update.failure ? { stage: update.failure.stage, code: update.failure.code,
            ...(update.failure.location ? { location: update.failure.location } : {}),
            ...(update.failure.httpStatus !== undefined ? { httpStatus: update.failure.httpStatus } : {}),
            ...(update.failure.grpcStatus !== undefined ? { grpcStatus: update.failure.grpcStatus } : {}),
            ...(update.failure.clientVersion !== undefined ? { clientVersion: update.failure.clientVersion } : {}),
            ...(update.failure.upstreamMessage !== undefined ? { upstreamMessage: update.failure.upstreamMessage } : {}) } : null;
          state.status = state.blockedGeneration ? state.status : state.status === "rate_limited" ? "rate_limited" : update.status;
          state.failures = update.status === "ok" ? 0 : state.failures + 1;
          if (update.status === "auth_paused") this.pauseRun(state, "auth_paused", update.failure ? permissionRejected(update.failure) : false);
          if (rejectedSessionFailure(update)) await this.rememberPlatformRenewal(state, run);
          if (update.status === "rate_limited") state.nextAtMs = Math.max(state.nextAtMs, Date.now() + retryMs(update.retryAfterSeconds));
          const serviceFailure = update.status === "failed" && transientCollectorFailure(update.failure);
          if (update.status === "failed") state.nextAtMs = serviceFailure ? Date.now() + recoveryDelay(state.failures)
            : Math.max(state.nextAtMs, Date.now() + Math.min(3_600_000, INTERVAL_MS * 2 ** Math.min(4, state.failures - 1)));
          const arena = run.finalArena || run.catalog?.arena === undefined ? null : state.arenaCatalog;
          const cold = arena && Date.now() >= arena.startAtMs && Date.now() < arena.rankingEndAtMs
            && arena.bandIds.some((id) => arena.thresholdsByBand?.[id]?.length !== 0
              && Date.now() - (state.arenaPopulationAt?.[`${arena.seasonId}:${id}`] ?? 0) > ARENA_POPULATION_CATCHUP_MS);
          if (update.status === "ok" && cold && (state.arenaWarmupRuns ?? 0) < 20) {
            state.arenaWarmupRuns = (state.arenaWarmupRuns ?? 0) + 1;
            this.expediteArena(state);
          } else if (update.status === "ok") {
            if (!cold) state.arenaWarmupRuns = 0;
            if (state.arenaInterests?.length) this.expediteArena(state);
          }
          if (update.status === "ok" && !run.finalEvent && !run.finalArena) {
            const now = Date.now(), event = run.catalog?.event, arena = run.catalog?.arena;
            const keys = event && now >= event.startAtMs && now < event.endAtMs + event.aggregationSeconds * 1000 ? [
              ...event.challenges.filter((row) => row.enabled && now >= row.startAtMs && now < row.endAtMs + event.aggregationSeconds * 1000)
                .map((row) => `event/${event.id}/challenge/${row.id}`),
              ...(event.totalRankingEnabled ? [`event/${event.id}/total`] : []),
              ...(event.pointRankingEnabled ? [`event/${event.id}/point/1/100`] : []),
            ] : [];
            if (arena && now >= arena.startAtMs && now < arena.rankingEndAtMs)
              keys.push(...arena.bandIds.map((id) => `arena/${arena.seasonId}/${id}/1/100`));
            if (keys.length) {
              const due = this.ctx.storage.sql.exec<{ due: number | null }>(
                `SELECT MIN(attempted_at_ms+?) AS due FROM collector_window_cache WHERE window_key IN (${keys.map(() => "?").join(",")})`, WINDOW_REUSE_MS, ...keys).one().due;
              if (due !== null) state.nextAtMs = Math.min(state.nextAtMs, Math.max(now + 1000, due));
            }
          }
          this.ctx.waitUntil(this.runLookup(region));
          const health = this.runHealth(state);
          if (health) {
            if (health.leaseUntilMs <= run.deadlineMs + 15_000) health.leaseUntilMs = 0;
            health.failures = update.status === "ok" ? 0 : serviceFailure ? health.failures : health.failures + 1;
            if (update.status === "rate_limited" || update.status === "failed" && !serviceFailure)
              health.cooldownUntilMs = Math.max(health.cooldownUntilMs, state.nextAtMs);
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
