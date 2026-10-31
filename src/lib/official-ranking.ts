// L3 — GEB
// Input: Official catalog identities, game protobuf observations and collector checkpoints.
// Output: Shared wire contracts including Arena windows, complete populations, resumable hints and origin-bound account-pool parsing.
// Pos: [Map](L2-2.md); official ranking wire types alongside game-records DTOs.
// Effects/Dependencies: Web Crypto digests; parses private configuration without logging or network access.
import type { GameRecordsRegion } from "./game-records";

export const OFFICIAL_API_ORIGINS: Record<GameRecordsRegion, readonly string[]> = {
  jp: ["https://api.bang-dream-on.jp"],
  tw: ["https://l12-prod-hk-all-gs-sirius.gamerfusiontech.com", "https://l14-prod-hk-all-gs-sirius.gamerfusiontech.com"],
  en: ["https://l14-prod-va-all-gs-sirius.bilibiligame.net", "https://l17-prod-va-all-gs-sirius.bilibiligame.net"],
  kr: ["https://l14-prod-kr-all-gs-sirius.bilibiligame.net", "https://l17-prod-kr-all-gs-sirius.bilibiligame.net"],
};

export interface OfficialCollectorAccount {
  /** The pool's own name for the account; holds no credential. */
  label: string;
  identity: string;
  generation: string;
  authGeneration: string;
  legacyGenerations: string[];
  enabled: boolean;
  ready: boolean;
  availableAtMs: number;
  initialPause: "auth_paused" | "auth_uncertain" | null;
  permissionPaused: boolean;
  clientVersion: string;
  credentials: Record<string, unknown>;
  masterConfig: Record<string, unknown>;
}
export interface OfficialCollectorPool {
  accounts: OfficialCollectorAccount[];
  preferredIdentity: string | null;
}
export interface OfficialCollectorAccountHealth {
  blocked: Record<string, "auth_paused" | "auth_uncertain">;
  lastUsedAtMs: number;
  lastSuccessAtMs: number | null;
  cooldownUntilMs: number;
  leaseUntilMs: number;
  failures: number;
  /** Set from the admin panel: skipped until released. */
  held?: boolean;
}

export function selectOfficialCollectorAccount(pool: OfficialCollectorPool, health: Record<string, OfficialCollectorAccountHealth>, now: number): OfficialCollectorAccount | null {
  return pool.accounts.filter((account) => account.enabled && account.ready && !account.initialPause && !health[account.identity]?.held && !health[account.identity]?.blocked[account.authGeneration]
    && account.availableAtMs <= now && (health[account.identity]?.cooldownUntilMs ?? 0) <= now && (health[account.identity]?.leaseUntilMs ?? 0) <= now)
    // Least recently used first, so work spreads across the pool; the preferred account only breaks ties.
    .sort((left, right) => (health[left.identity]?.lastUsedAtMs ?? 0) - (health[right.identity]?.lastUsedAtMs ?? 0)
      || Number(right.identity === pool.preferredIdentity) - Number(left.identity === pool.preferredIdentity)
      || left.identity.localeCompare(right.identity))[0] ?? null;
}

export async function parseOfficialCollectorConfiguration(raw: string, region: GameRecordsRegion): Promise<OfficialCollectorPool> {
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_collector_config");
    return value as Record<string, unknown>;
  };
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(object(value)[key])}`).join(",")}}`;
    return JSON.stringify(value);
  };
  const digest = async (value: unknown): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)))),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (new TextEncoder().encode(raw).length > 131_072) throw new Error("invalid_collector_config");
  const document = object(JSON.parse(raw));
  const pooled = document.contract === "haneoka:official-ranking-account-pool/1";
  if (document.contract !== undefined && !pooled || pooled && (document.region !== region || !Array.isArray(document.accounts)
    || !document.accounts.length || document.accounts.length > 32)) throw new Error("invalid_collector_config");
  const values = pooled ? document.accounts as unknown[] : [document];
  const accounts: OfficialCollectorAccount[] = [];
  const identities = new Set<string>(), ids = new Set<string>();
  let preferredIdentity: string | null = null;
  for (const value of values) {
    const config = object(value), credentials = object(config.credentials), auth = object(credentials.credentials);
    if (credentials.region !== (region === "tw" ? "hk" : region) || typeof credentials.origin !== "string"
      || !OFFICIAL_API_ORIGINS[region].includes(credentials.origin) || typeof auth.player_id !== "string" || !auth.player_id
      || typeof auth.credential !== "string" || !auth.credential || typeof config.clientVersion !== "string"
      || !/^\d+\.\d+\.\d+$/u.test(config.clientVersion)) throw new Error("invalid_collector_config");
    const deviceId = auth.device_id || null, bid = region === "jp" ? undefined : auth.bid || undefined;
    if (deviceId !== null && typeof deviceId !== "string" || bid !== undefined && typeof bid !== "string" || region === "jp" && auth.bid)
      throw new Error("invalid_collector_config");
    if (pooled && (typeof config.id !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/u.test(config.id) || ids.has(config.id)
      || typeof config.enabled !== "boolean" || !["ready", "unverified", "cooldown", "auth_required", "version", "device_conflict", "retired"].includes(String(config.state))))
      throw new Error("invalid_collector_config");
    if (config.pauseReason !== undefined && !["authentication", "permission", "auth_uncertain", "device_conflict", "version"].includes(String(config.pauseReason)))
      throw new Error("invalid_collector_config");
    if (pooled && config.nextRequestAtMs !== undefined && (typeof config.nextRequestAtMs !== "number"
      || !Number.isSafeInteger(config.nextRequestAtMs) || config.nextRequestAtMs < 0 || config.nextRequestAtMs > 8_640_000_000_000_000))
      throw new Error("invalid_collector_config");
    const authentication = { player_id: auth.player_id, credential: auth.credential, device_id: deviceId, ...(bid ? { bid } : {}) };
    const playerIdentity = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(auth.player_id) ? auth.player_id.toLowerCase() : auth.player_id;
    const identity = await digest({ region, player_id: playerIdentity });
    if (identities.has(identity)) throw new Error("duplicate_collector_account");
    identities.add(identity);
    if (pooled) ids.add(config.id as string);
    const generation = await digest({ region, origin: credentials.origin, auth: authentication });
    const authGeneration = await digest({ region, auth: { ...authentication, player_id: playerIdentity } });
    const legacyGenerations = await Promise.all(OFFICIAL_API_ORIGINS[region].map((origin) => origin === credentials.origin
      ? generation : digest({ region, origin, auth: authentication })));
    const masterConfig = object(config.masterConfig);
    if (!Object.keys(masterConfig).length) throw new Error("invalid_collector_config");
    accounts.push({ label: pooled ? String(config.id) : "default", identity, generation, authGeneration, legacyGenerations, enabled: !pooled || config.enabled === true,
      ready: !pooled || config.state === "ready" || config.state === "cooldown",
      availableAtMs: pooled ? Number(config.nextRequestAtMs ?? 0) : 0,
      initialPause: pooled && (["auth_required", "device_conflict"].includes(String(config.state))
        || ["authentication", "permission", "auth_uncertain", "device_conflict"].includes(String(config.pauseReason)))
        ? config.pauseReason === "auth_uncertain" ? "auth_uncertain" : "auth_paused" : null,
      permissionPaused: pooled && (config.pauseReason === "permission" || config.state === "auth_required" && config.pauseReason === undefined),
      clientVersion: config.clientVersion, credentials, masterConfig });
    if (pooled && config.id === document.selectedAccountId) preferredIdentity = identity;
  }
  if (pooled && document.selectedAccountId !== undefined && preferredIdentity === null) throw new Error("invalid_collector_config");
  return { accounts, preferredIdentity };
}

export interface OfficialCatalog {
  region: GameRecordsRegion;
  catalogSource: "official-master";
  catalogObservedAtMs: number;
  masterVersion: string;
  resourceVersion: string | null;
  apiOrigin: string;
  tableHashes?: Record<string, string>;
  event: {
    id: string;
    startAtMs: number;
    endAtMs: number;
    aggregationSeconds: number;
    status: string;
    totalRankingEnabled: boolean;
    pointRankingEnabled: boolean;
    challenges: Array<{ id: string; musicId: string; enabled: boolean; startAtMs: number; endAtMs: number; status: string }>;
  } | null;
  /** The Arena season whose league boards the collector samples; absent while Arena collection is off. */
  arena?: {
    seasonId: string;
    startAtMs: number;
    endAtMs: number;
    rankingEndAtMs: number;
    bandIds: string[];
    thresholdsByBand?: Record<string, number[]>;
  } | null;
}

/** One rank window of one Arena league board, in the game's snake_case player fields. */
export interface OfficialArenaObservation {
  snapshotId: string;
  region: GameRecordsRegion;
  seasonId: string;
  bandId: string;
  startRank: number;
  endRank: number;
  maxRank?: number | null;
  observedAtMs: number;
  players?: Array<Record<string, unknown>>;
  provenance?: Record<string, unknown>;
  error?: string;
  httpStatus?: number | null;
  grpcStatus?: string | null;
  retryAfterSeconds?: number;
}

/** Completed threshold counts from the collector's actual league-window probes. */
export interface OfficialArenaPopulationObservation {
  snapshotId: string;
  region: GameRecordsRegion;
  seasonId: string;
  bandId: string;
  observedAtMs: number;
  maxRank: number;
  atLeast: Array<{ threshold: number; count: number }>;
  provenance?: Record<string, unknown>;
}

/** Resumable search hints; published population counts require fresh boundary probes. */
export interface OfficialArenaProgress {
  seasonId: string;
  bandId: string;
  thresholds: number[];
  maxRank: number;
  counts: Array<number | null>;
  cursor: number;
  pending?: { index: number; low: number; high: number };
  updatedAtMs?: number;
}

export interface OfficialObservation {
  snapshotId: string;
  region: GameRecordsRegion;
  eventId: string;
  kind: "challenge" | "total" | "point";
  challengeId: string;
  observedAtMs: number;
  players?: Array<Record<string, unknown>>;
  provenance?: Record<string, unknown>;
  error?: string;
  httpStatus?: number | null;
  grpcStatus?: string | null;
  retryAfterSeconds?: number;
}

export interface OfficialCollectorJob {
  contract: "haneoka:official-ranking-job/1";
  /** `lookup` skips catalog and boards and only serves demand. */
  mode?: "lookup";
  capabilities?: string[];
  arenaProgress?: OfficialArenaProgress[];
  arenaWindows?: Array<{ seasonId: string; bandId: string; startRank: number; endRank: number }>;
  playerLookups?: string[];
  songRankings?: string[];
  cardImages?: string[];
  region: GameRecordsRegion;
  runId: string;
  credentialGeneration: string;
  clientVersion: string;
  credentials: Record<string, unknown>;
  masterConfig: Record<string, unknown>;
  callbackUrl: string;
  callbackToken: string;
  deadlineMs: number;
}

export interface OfficialCollectorFailure {
  stage: string;
  code: string;
  httpStatus?: number;
  grpcStatus?: string;
}

export type OfficialCollectorUpdate = {
  contract: "haneoka:official-ranking-update/1";
  region: GameRecordsRegion;
  runId: string;
  credentialGeneration: string;
} & (
  | { type: "catalog"; catalog: OfficialCatalog }
  | { type: "attempt"; snapshotId: string }
  | { type: "observation"; observation: OfficialObservation }
  | { type: "arena-observation"; observation: OfficialArenaObservation }
  | { type: "arena-population"; observation: OfficialArenaPopulationObservation }
  | { type: "arena-progress"; checkpointId: string; progress: OfficialArenaProgress }
  | { type: "player-profile"; profileId: string; found: boolean; profile?: unknown; totalFavorite?: string | null; observedAtMs: number }
  | { type: "card-image"; file: string; data: string }
  | { type: "song-ranking"; musicId: string; players: unknown[]; observedAtMs: number }
  | { type: "complete"; status: "ok" | "failed" | "auth_paused" | "rate_limited"; retryAfterSeconds?: number; failure?: OfficialCollectorFailure }
);
