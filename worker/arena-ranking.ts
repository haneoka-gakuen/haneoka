// L3 — GEB
// Input: Region, Arena season, league band, rank window, tier thresholds or profile ID, and saved official snapshots.
// Output: Normalized Arena league rankings, per-tier populations and exact profile lookups within the top 2000.
// Pos: [Map](L2.md); Arena read adapter beside song rankings using the account-pool collector.
// Effects/Dependencies: Reads D1/private R2 snapshots; missing windows register bounded regional interests, never game RPCs.
import type {
  ArenaPopulationDto,
  ArenaSearchDto,
  ArenaRankingDto,
  ArenaRankingRowDto,
  GameRecordsRegion,
  SongRankingCardDto,
} from "../src/lib/game-records";
import { officialProfileCard } from "./official-ranking-api";
import { playerCard } from "./official-player-api";
import { readOfficialArenaLatest, readOfficialArenaMetadata, readOfficialArenaPopulation, readOfficialArenaSearchMatch, readOfficialArenaSearchWindows, readOfficialCatalog, readOfficialPlayers, type OfficialRankingStoreBindings } from "./official-ranking-store";

export interface ArenaRankingBindings extends OfficialRankingStoreBindings {
  OFFICIAL_RANKING_COLLECTOR?: Env["OFFICIAL_RANKING_COLLECTOR"];
}

const PREFIX = "/api/v1/game/records";
const REGIONS: readonly GameRecordsRegion[] = ["jp", "tw", "en", "kr"];
const WINDOW = 100;
const SEARCH_DEPTH = 2000;
const CARD_DEMAND = 16;

class ArenaFailure extends Error {
  readonly status: number;
  readonly kind: string;
  readonly retryAfter: number | null;
  readonly windows: number[];
  constructor(status: number, kind: string, retryAfter: number | null = null, windows: number[] = []) {
    super(kind);
    this.status = status;
    this.kind = kind;
    this.retryAfter = retryAfter;
    this.windows = windows;
  }
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const integer = (value: unknown): number | null => {
  const number =
    typeof value === "number" ? value : typeof value === "string" && /^-?[0-9]+$/u.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) ? number : null;
};
const positive = (value: unknown): number | null => {
  const number = integer(value);
  return number !== null && number > 0 ? number : null;
};
const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
/** The collector preserves the game's snake_case fields. */
const field = (row: Record<string, unknown>, camel: string) =>
  row[camel] ?? row[camel.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)];

function card(value: unknown, index: number): SongRankingCardDto {
  const entry = object(value);
  const member = object(field(entry, "memberCard")),
    support = object(field(entry, "supportCard"));
  const memberId = positive(field(member, "cardId")),
    supportId = positive(field(support, "cardId"));
  return {
    slot: integer(field(entry, "slotIndex")) ?? index,
    memberCardId: memberId,
    memberExp: memberId ? integer(member.exp) : null,
    memberAwakeCount: memberId ? integer(field(member, "awakeCount")) : null,
    memberRank: memberId ? integer(field(member, "cardRank")) : null,
    supportCardId: supportId,
    supportExp: supportId ? integer(support.exp) : null,
    supportRank: supportId ? integer(support.rank) : null,
  };
}

export function arenaRankingRow(value: unknown, fallbackRank: number, region: GameRecordsRegion): ArenaRankingRowDto {
  const entry = object(value);
  const profile = object(entry.profile ?? field(entry, "playerData"));
  const favorite = object(field(profile, "favoriteMemberCard"));
  const deck = object(entry.deck ?? field(entry, "highScoreDeck"));
  const favoriteId = positive(field(favorite, "cardId")) ?? positive(field(profile, "favoriteMemberCardMasterId"));
  return {
    rank: positive(entry.rank) ?? fallbackRank,
    tied: false,
    playerId: text(profile.id),
    profileId: text(field(profile, "profileId")),
    name: text(profile.name) ?? "",
    rankExp: integer(field(profile, "rankExp")),
    favoriteMemberCardId: favoriteId,
    favoriteMemberExp: positive(field(favorite, "cardId")) ? integer(favorite.exp) : null,
    favoriteMemberAwakeCount: positive(field(favorite, "cardId")) ? integer(field(favorite, "awakeCount")) : null,
    favoriteMemberRank: positive(field(favorite, "cardId")) ? integer(field(favorite, "cardRank")) : null,
    score: null,
    point: integer(entry.point) ?? 0,
    deckId: positive(deck.id),
    deckName: text(deck.name),
    totalPower: positive(field(deck, "totalPower")),
    profileCard: officialProfileCard(field(profile, "profileCard"), region),
    cards: (Array.isArray(deck.cards) ? deck.cards : [])
      .slice(0, 5)
      .map(card)
      .sort((a, b) => a.slot - b.slot),
  };
}

function markTies(rows: ArenaRankingRowDto[]) {
  rows.forEach((row, index) => {
    row.tied = rows[index - 1]?.rank === row.rank || rows[index + 1]?.rank === row.rank;
  });
  return rows;
}

function pending(windows: number[] = []): never { throw new ArenaFailure(503, "pending", 30, windows); }

const staleAt = (observed: number, now: number, ttl: number) => now < observed || now - observed > ttl;

/** The game leaves `profile_card` empty on Arena rows; saved player records supply it. */
async function attachProfileCards(env: ArenaRankingBindings, ctx: ExecutionContext, region: GameRecordsRegion, rows: ArenaRankingRowDto[]) {
  const ids = rows.flatMap((row) => row.profileId ?? []);
  const players = await readOfficialPlayers(env, region, ids);
  for (const row of rows) {
    const profile = row.profileId ? players.get(row.profileId)?.profile : null;
    if (profile) row.profileCard = playerCard(region, row.profileId!, profile.profile_card);
  }
  const missing = ids.filter((id) => !players.has(id)).slice(0, CARD_DEMAND);
  if (missing.length)
    ctx.waitUntil(Promise.resolve(env.OFFICIAL_RANKING_COLLECTOR?.getByName(region).requestDemand(region, "player", missing)).catch(() => undefined));
}

async function ranking(env: ArenaRankingBindings, ctx: ExecutionContext, region: GameRecordsRegion, seasonId: string,
  bandId: string, start: number): Promise<ArenaRankingDto> {
  const metadata = await readOfficialArenaMetadata(env, region, seasonId, bandId);
  if (!metadata) return pending([Math.floor((start - 1) / WINDOW) * WINDOW + 1]);
  const end = start + WINDOW - 1;
  const stop = metadata.maxRank === null ? end : Math.min(end, metadata.maxRank);
  const rows: ArenaRankingRowDto[] = [];
  const snapshots = new Set([metadata.snapshotId]);
  let observedAtMs = metadata.observedAtMs, position = start;
  for (let window = 0; window < 2 && position <= stop; window++) {
    const source = await readOfficialArenaLatest(env, region, seasonId, bandId, position);
    if (!source?.players) return pending([Math.floor((position - 1) / WINDOW) * WINDOW + 1]);
    const until = Math.min(stop, source.endRank);
    const offset = position - source.startRank, length = until - position + 1;
    const players = source.players.slice(offset, offset + length);
    if (offset < 0 || length <= 0 || players.length !== length)
      return pending([Math.floor((position - 1) / WINDOW) * WINDOW + 1]);
    rows.push(...players.map((player, index) => arenaRankingRow(player, position + index, region)));
    observedAtMs = Math.min(observedAtMs, source.observedAtMs);
    snapshots.add(source.snapshotId);
    position = until + 1;
  }
  if (position <= stop) return pending([Math.floor((position - 1) / WINDOW) * WINDOW + 1]);
  await attachProfileCards(env, ctx, region, rows);
  const now = Date.now();
  return { region, seasonId, bandId, start, end, provider: "official", snapshotId: [...snapshots].join("."),
    observedAtMs, fetchedAtMs: observedAtMs, serverTimeMs: now, stale: staleAt(observedAtMs, now, 600_000),
    maxRank: metadata.maxRank, rows: markTies(rows) };
}

async function population(env: ArenaRankingBindings, region: GameRecordsRegion, seasonId: string,
  bandId: string, thresholds: number[]): Promise<ArenaPopulationDto> {
  const source = await readOfficialArenaPopulation(env, region, seasonId, bandId);
  if (!source) return pending();
  const catalog = await readOfficialCatalog(env, region);
  const expected = catalog?.arena?.seasonId === seasonId ? catalog.arena.thresholdsByBand?.[bandId] : undefined;
  if (expected && !expected.length) throw new ArenaFailure(503, "inactive");
  if (expected && (expected.length !== source.atLeast.length || expected.some((value, index) => source.atLeast[index]?.threshold !== value))) return pending();
  const counts = new Map(source.atLeast.map((row) => [row.threshold, row.count]));
  counts.set(0, source.maxRank);
  if (thresholds.some((threshold) => !counts.has(threshold))) return pending();
  const now = Date.now();
  return { region, seasonId, bandId, provider: "official", snapshotId: source.snapshotId,
    observedAtMs: source.observedAtMs, fetchedAtMs: source.observedAtMs, serverTimeMs: now,
    stale: staleAt(source.observedAtMs, now, 1_800_000), maxRank: source.maxRank,
    tiers: thresholds.map((threshold, index) => ({ threshold,
      count: counts.get(threshold)! - (thresholds[index + 1] === undefined ? 0 : counts.get(thresholds[index + 1]!)!) })) };
}

async function search(env: ArenaRankingBindings, region: GameRecordsRegion, seasonId: string,
  bandId: string, profileId: string): Promise<ArenaSearchDto> {
  const windows = await readOfficialArenaSearchWindows(env, region, seasonId, bandId, SEARCH_DEPTH);
  const latest = windows.reduce<(typeof windows)[number] | null>((result, row) =>
    !result || row.observedAtMs >= result.observedAtMs ? row : result, null);
  if (latest?.maxRank == null) return pending([1]);
  const searchedTo = Math.min(SEARCH_DEPTH, latest.maxRank), missing: number[] = [];
  const byStart = new Map(windows.map((row) => [row.startRank, row]));
  let observedAtMs = latest.observedAtMs;
  for (let start = 1; start <= searchedTo; start += WINDOW) {
    const metadata = byStart.get(start), length = Math.min(WINDOW, searchedTo - start + 1);
    if (!metadata || metadata.playerCount < length || metadata.endRank < start + length - 1) {
      missing.push(start);
      continue;
    }
    const index = JSON.parse(metadata.profileIndex) as Record<string, number>;
    const position = index[profileId];
    if (position !== undefined && position >= start && position < start + length) {
      const source = await readOfficialArenaSearchMatch(env, metadata);
      if (source.region !== region || source.seasonId !== seasonId || source.bandId !== bandId
        || source.snapshotId !== metadata.snapshotId) throw new Error("official_observation_identity_mismatch");
      const row = arenaRankingRow(source.players?.[position - start], position, region);
      if (row.profileId !== profileId) throw new Error("official_profile_index_mismatch");
      return { region, seasonId, bandId, profileId, searchedTo, observedAtMs: source.observedAtMs, row };
    }
    observedAtMs = Math.min(observedAtMs, metadata.observedAtMs);
  }
  if (missing.length) return pending(missing);
  return { region, seasonId, bandId, profileId, searchedTo, observedAtMs, row: null };
}

function json(request: Request, body: unknown, status = 200, retryAfter: number | null = null): Response {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*" });
  if (retryAfter) headers.set("Retry-After", String(retryAfter));
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), { status, headers });
}

/** Missing snapshot interests are queued; game requests stay in the regional collector. */
export async function handleArenaRankingApi(request: Request, ctx: ExecutionContext, url: URL,
  env: ArenaRankingBindings): Promise<Response | null> {
  const route = new RegExp(
    `^${PREFIX}/([a-z]+)/arena/seasons/([1-9][0-9]{0,9})/leagues/([1-9][0-9]{0,9})/(ranking|population|search)$`, "u",
  ).exec(url.pathname);
  if (!route) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    return json(request, { error: { kind: "method_not_allowed" } }, 405);
  const region = route[1] as GameRecordsRegion, seasonId = route[2]!, bandId = route[3]!, operation = route[4];
  if (!REGIONS.includes(region)) return json(request, { error: { kind: "not_found" } }, 404);
  try {
    if (operation === "search") {
      const profileId = url.searchParams.get("profileId") ?? "";
      if (!/^[1-9][0-9]{0,18}$/u.test(profileId) || url.searchParams.getAll("profileId").length !== 1
        || [...url.searchParams.keys()].some((key) => key !== "profileId"))
        return json(request, { error: { kind: "invalid_request" } }, 400);
      if (!env.DB || !env.OFFICIAL_RANKING_DATA) return pending([1]);
      return json(request, await search(env, region, seasonId, bandId, profileId));
    }
    if (operation === "ranking") {
      const raw = url.searchParams.get("start") ?? "1";
      if (!/^[1-9][0-9]{0,8}$/u.test(raw) || [...url.searchParams.keys()].some((key) => key !== "start")
        || url.searchParams.getAll("start").length > 1)
        return json(request, { error: { kind: "invalid_request" } }, 400);
      if (!env.DB || !env.OFFICIAL_RANKING_DATA) return pending();
      return json(request, await ranking(env, ctx, region, seasonId, bandId, Number(raw)));
    }
    const raw = url.searchParams.get("thresholds") ?? "", thresholds = raw.split(",").map(Number);
    if (!/^(0|[1-9][0-9]{0,8})(,(0|[1-9][0-9]{0,8})){0,31}$/u.test(raw)
      || thresholds.some((value, index) => index > 0 && value <= thresholds[index - 1]!)
      || url.searchParams.getAll("thresholds").length !== 1 || [...url.searchParams.keys()].some((key) => key !== "thresholds"))
      return json(request, { error: { kind: "invalid_request" } }, 400);
    if (!env.DB || !env.OFFICIAL_RANKING_DATA) return pending();
    return json(request, await population(env, region, seasonId, bandId, thresholds));
  } catch (error) {
    let failure = error instanceof ArenaFailure ? error : new ArenaFailure(503, "unavailable");
    if (failure.kind === "pending") {
      try {
        const collector = env.OFFICIAL_RANKING_COLLECTOR?.getByName(region);
        if (!collector) throw new Error("collector_unavailable");
        const thresholds = operation === "population" ? (url.searchParams.get("thresholds") ?? "").split(",").map(Number) : [];
        const demand = await collector.requestArenaWindows(region, seasonId, bandId, failure.windows, thresholds);
        failure = new ArenaFailure(503, demand.kind, demand.retryAfter);
      } catch { failure = new ArenaFailure(503, "unavailable"); }
    }
    return json(request, { error: { kind: failure.kind, retryAfter: failure.retryAfter } }, failure.status, failure.retryAfter);
  }
}
