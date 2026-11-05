// L3 — GEB
// Input: Region, event, rank window, player ID or username, and saved event point windows.
// Output: Event point ranking windows past the top 100 and player ID and username lookups across the complete board.
// Pos: [Map](L2.md); event point read adapter sharing the Arena row shape and leaderboard.
// Effects/Dependencies: Reads D1/private R2 windows; missing windows register bounded regional interests, never game RPCs.
import type {
  EventPointRankingDto,
  EventPointSearchDto,
  EventPointPlayerSearchDto,
  GameRecordsRegion,
} from "../src/lib/game-records";
import {
  arenaRankingRow,
  attachProfileCards,
  markTies,
  rankingSearchQuery,
  type RankingSearch,
  type ArenaRankingBindings,
} from "./arena-ranking";
import {
  readOfficialEventMaxRank,
  readOfficialEventWindow,
  readOfficialEventWindows,
  readOfficialPayload,
} from "./official-ranking-store";
import { searchRankingWindows } from "./ranking-search";
import type { OfficialEventWindow } from "../src/lib/official-ranking";

const REGIONS: readonly GameRecordsRegion[] = ["jp", "tw", "en", "kr"];
const WINDOW = 100;
const SEARCH_DEPTH = Number.MAX_SAFE_INTEGER;
const STALE_MS = 1_200_000;

class PendingWindows extends Error {
  readonly starts: number[];
  constructor(starts: number[]) {
    super("pending");
    this.starts = starts;
  }
}

const aligned = (rank: number) => Math.floor((rank - 1) / WINDOW) * WINDOW + 1;

/** The game's list can skip tied ranks, so a window's rows keep their own rank. */
async function ranking(env: ArenaRankingBindings, ctx: ExecutionContext, region: GameRecordsRegion, eventId: string,
  rank: number): Promise<EventPointRankingDto> {
  const start = aligned(rank), now = Date.now();
  const [source, maxRank] = await Promise.all([readOfficialEventWindow(env, region, eventId, start), readOfficialEventMaxRank(env, region, eventId)]);
  const base = { region, eventId, start, end: start + WINDOW - 1, provider: "official" as const, serverTimeMs: now, maxRank };
  if (!source?.players) {
    if (maxRank !== null && start > maxRank) return { ...base, snapshotId: "", observedAtMs: now, fetchedAtMs: now, stale: false, rows: [] };
    throw new PendingWindows([start]);
  }
  const rows = source.players.map((player, index) => arenaRankingRow(player, start + index, region));
  await attachProfileCards(env, ctx, region, rows);
  const stale = now - source.observedAtMs > STALE_MS;
  if (stale) ctx.waitUntil(Promise.resolve(env.OFFICIAL_RANKING_COLLECTOR?.getByName(region).requestEventWindows(region, eventId, [start])).catch(() => undefined));
  return { ...base, snapshotId: source.snapshotId, observedAtMs: source.observedAtMs, fetchedAtMs: source.observedAtMs, stale, rows: markTies(rows) };
}

async function search(
  env: ArenaRankingBindings,
  region: GameRecordsRegion,
  eventId: string,
  lookup: RankingSearch,
): Promise<EventPointSearchDto | EventPointPlayerSearchDto> {
  const windows = await readOfficialEventWindows(env, region, eventId, SEARCH_DEPTH);
  const maximum = await readOfficialEventMaxRank(env, region, eventId);
  const byStart = new Map(windows.map((row) => [row.startRank, row]));
  const searchedTo = maximum ?? Math.max(100, ...windows.map((row) => row.startRank + 99)) + 1;
  const missing: number[] = [];
  for (let start = 1; start <= searchedTo && missing.length < 20; start += 100)
    if (!byStart.has(start)) missing.push(start);
  if (missing.length || maximum === null) throw new PendingWindows(missing.length ? missing : [searchedTo]);
  const batches = new Map<string, Record<string, string>>();
  const load = async (metadata: (typeof windows)[number]) => {
    const source = await readOfficialPayload<OfficialEventWindow>(
      env,
      metadata.payloadKey,
      metadata.payloadHash,
      batches,
    );
    if (source.region !== region || source.eventId !== eventId || source.snapshotId !== metadata.snapshotId)
      throw new Error("official_observation_identity_mismatch");
    return source.players ?? [];
  };
  const matches = await searchRankingWindows(
    env.DB!,
    region,
    `event/${eventId}`,
    windows,
    lookup.value,
    lookup.after,
    lookup.kind === "id",
    load,
  );
  if (!matches) throw new PendingWindows([]);
  const observedAtMs = windows.reduce((time, row) => Math.min(time, row.observedAtMs), Date.now());
  if (lookup.kind === "query") return { region, eventId, query: lookup.value, searchedTo, observedAtMs, ...matches };
  const match = matches.matches.find((row) => row.profileId === lookup.value);
  const metadata = match && byStart.get(aligned(match.rank));
  const players = metadata ? await load(metadata) : [];
  const raw = players.find(
    (value, index) => arenaRankingRow(value, metadata!.startRank + index, region).profileId === lookup.value,
  );
  return {
    region,
    eventId,
    profileId: lookup.value,
    searchedTo,
    observedAtMs,
    row: raw ? arenaRankingRow(raw, match!.rank, region) : null,
  };
}

function json(request: Request, body: unknown, status = 200, retryAfter: number | null = null): Response {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*" });
  if (retryAfter) headers.set("Retry-After", String(retryAfter));
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), { status, headers });
}

export async function handleEventPointRankingApi(
  request: Request,
  ctx: ExecutionContext,
  url: URL,
  env: ArenaRankingBindings,
): Promise<Response | null> {
  const route = /^\/api\/v1\/game\/records\/([a-z]+)\/events\/([1-9][0-9]{0,18})\/points\/(ranking|search)$/u.exec(
    url.pathname,
  );
  if (!route) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    return json(request, { error: { kind: "method_not_allowed" } }, 405);
  const region = route[1] as GameRecordsRegion,
    eventId = route[2]!,
    operation = route[3];
  if (!REGIONS.includes(region)) return json(request, { error: { kind: "not_found" } }, 404);
  const lookup = operation === "search" ? rankingSearchQuery(url) : null;
  const name = "start";
  const raw = url.searchParams.get(name) ?? (operation === "search" ? "" : "1");
  if (
    operation === "search"
      ? !lookup
      : !/^[1-9][0-9]{0,8}$/u.test(raw) ||
        url.searchParams.getAll(name).length > 1 ||
        [...url.searchParams.keys()].some((key) => key !== name)
  )
    return json(request, { error: { kind: "invalid_request" } }, 400);
  try {
    if (!env.DB || !env.OFFICIAL_RANKING_DATA) throw new PendingWindows([1]);
    return json(
      request,
      await (operation === "search"
        ? search(env, region, eventId, lookup!)
        : ranking(env, ctx, region, eventId, Number(raw))),
    );
  } catch (error) {
    if (!(error instanceof PendingWindows))
      return json(request, { error: { kind: "unavailable", retryAfter: null } }, 503);
    if (!error.starts.length) return json(request, { error: { kind: "pending", retryAfter: 3 } }, 503, 3);
    try {
      const collector = env.OFFICIAL_RANKING_COLLECTOR?.getByName(region);
      if (!collector) throw new Error("collector_unavailable");
      const demand = await collector.requestEventWindows(region, eventId, error.starts.slice(0, 20));
      return json(request, { error: { kind: demand.kind, retryAfter: demand.retryAfter } }, 503, demand.retryAfter);
    } catch {
      return json(request, { error: { kind: "unavailable", retryAfter: null } }, 503);
    }
  }
}
