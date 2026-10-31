// L3 — GEB
// Input: Region, event, rank window or profile ID, and saved event point windows.
// Output: Event point ranking windows past the top 100 and exact profile lookups within the top 2000.
// Pos: [Map](L2.md); event point read adapter sharing the Arena row shape and leaderboard.
// Effects/Dependencies: Reads D1/private R2 windows; missing windows register bounded regional interests, never game RPCs.
import type { EventPointRankingDto, EventPointSearchDto, GameRecordsRegion } from "../src/lib/game-records";
import { arenaRankingRow, attachProfileCards, markTies, type ArenaRankingBindings } from "./arena-ranking";
import { readOfficialEventMaxRank, readOfficialEventWindow, readOfficialEventWindows, readOfficialPayload } from "./official-ranking-store";
import type { OfficialEventWindow } from "../src/lib/official-ranking";

const REGIONS: readonly GameRecordsRegion[] = ["jp", "tw", "en", "kr"];
const WINDOW = 100;
const SEARCH_DEPTH = 2000;
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

async function search(env: ArenaRankingBindings, region: GameRecordsRegion, eventId: string, profileId: string): Promise<EventPointSearchDto> {
  const windows = await readOfficialEventWindows(env, region, eventId, SEARCH_DEPTH);
  if (!windows.length) throw new PendingWindows([1]);
  const searchedTo = Math.min(SEARCH_DEPTH, await readOfficialEventMaxRank(env, region, eventId) ?? SEARCH_DEPTH);
  const byStart = new Map(windows.map((row) => [row.startRank, row])), missing: number[] = [];
  let observedAtMs = Date.now();
  for (let start = 1; start <= searchedTo; start += WINDOW) {
    const metadata = byStart.get(start);
    if (!metadata) { missing.push(start); continue; }
    const position = (JSON.parse(metadata.profileIndex) as Record<string, number>)[profileId];
    if (position !== undefined) {
      const source = await readOfficialPayload<OfficialEventWindow>(env, metadata.payloadKey, metadata.payloadHash);
      if (source.region !== region || source.eventId !== eventId || source.snapshotId !== metadata.snapshotId) throw new Error("official_observation_identity_mismatch");
      const row = arenaRankingRow(source.players?.[position - start], position, region);
      if (row.profileId !== profileId) throw new Error("official_profile_index_mismatch");
      return { region, eventId, profileId, searchedTo, observedAtMs: source.observedAtMs, row };
    }
    observedAtMs = Math.min(observedAtMs, metadata.observedAtMs);
  }
  if (missing.length) throw new PendingWindows(missing);
  return { region, eventId, profileId, searchedTo, observedAtMs, row: null };
}

function json(request: Request, body: unknown, status = 200, retryAfter: number | null = null): Response {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*" });
  if (retryAfter) headers.set("Retry-After", String(retryAfter));
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), { status, headers });
}

export async function handleEventPointRankingApi(request: Request, ctx: ExecutionContext, url: URL,
  env: ArenaRankingBindings): Promise<Response | null> {
  const route = /^\/api\/v1\/game\/records\/([a-z]+)\/events\/([1-9][0-9]{0,18})\/points\/(ranking|search)$/u.exec(url.pathname);
  if (!route) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return json(request, { error: { kind: "method_not_allowed" } }, 405);
  const region = route[1] as GameRecordsRegion, eventId = route[2]!, operation = route[3];
  if (!REGIONS.includes(region)) return json(request, { error: { kind: "not_found" } }, 404);
  const name = operation === "search" ? "profileId" : "start";
  const raw = url.searchParams.get(name) ?? (operation === "search" ? "" : "1");
  if (!(operation === "search" ? /^[1-9][0-9]{0,18}$/u : /^[1-9][0-9]{0,8}$/u).test(raw) || url.searchParams.getAll(name).length > 1
    || [...url.searchParams.keys()].some((key) => key !== name)) return json(request, { error: { kind: "invalid_request" } }, 400);
  try {
    if (!env.DB || !env.OFFICIAL_RANKING_DATA) throw new PendingWindows([1]);
    return json(request, await (operation === "search" ? search(env, region, eventId, raw) : ranking(env, ctx, region, eventId, Number(raw))));
  } catch (error) {
    if (!(error instanceof PendingWindows)) return json(request, { error: { kind: "unavailable", retryAfter: null } }, 503);
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
