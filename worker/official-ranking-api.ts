// L3 — GEB
// Input: Saved regional official catalogs/observations, collector availability and public requests.
// Output: Normalized rankings, every archived event's boards, preferred saved v1 totals and explicit pending availability.
// Pos: [Map](L2.md); official read adapter alongside legacy PT and SHA history.
// Effects/Dependencies: Reads D1/private R2; keeps boards read from Moenotes in the event archive; never requests the game or writes observations.
import type { EventRankingDto, EventTrackerDto, GameRecordsRegion, SongRankingCardDto, SongRankingRowDto, TrackedEventDto } from "../src/lib/game-records";
import { moenotesEventRanking } from "./moenotes-fallback";
import type { OfficialCatalog, OfficialObservation } from "../src/lib/official-ranking";
import { OFFICIAL_RANKING_REGIONS, officialCollectorAvailability, officialRegionEnabled, type OfficialCollectorConfigurationBindings } from "./official-ranking-collector";
import { OFFICIAL_RANKING_STALE_MS, officialCardUrl, readOfficialBoardStatus, readOfficialCatalog, readOfficialHistory, readOfficialLatest, type OfficialRankingStoreBindings, type StoredOfficialObservation } from "./official-ranking-store";

export interface OfficialRankingReadBindings extends OfficialRankingStoreBindings, OfficialCollectorConfigurationBindings {
  OFFICIAL_RANKING_READ_REGIONS?: string;
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const integer = (value: unknown): number | null => {
  if (typeof value !== "number" && !(typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};
const positiveInteger = (value: unknown): number | null => {
  const number = integer(value);
  return number !== null && number > 0 ? number : null;
};
const text = (value: unknown): string | null => typeof value === "string" && value ? value : null;
const decimalId = (value: string | undefined): value is string => !!value && /^[1-9][0-9]{0,18}$/u.test(value);
const regionValue = (value: string | undefined): value is GameRecordsRegion => OFFICIAL_RANKING_REGIONS.some((region) => region === value);
const staleAt = (observed: number, now: number): boolean => now < observed || now - observed > OFFICIAL_RANKING_STALE_MS;

export function officialRankingReadEnabled(env: OfficialRankingReadBindings, region: GameRecordsRegion): boolean {
  return officialRegionEnabled(env.OFFICIAL_RANKING_READ_REGIONS, region);
}

export async function officialRankingStatus(env: OfficialRankingReadBindings, region: GameRecordsRegion, state: Record<string, unknown>) {
  const catalog = await readOfficialCatalog(env, region);
  if (!catalog?.event) return { ...state, boards: [] };
  const event = catalog.event, now = Date.now();
  const saved = await readOfficialBoardStatus(env, region, event.id);
  const targets = [
    ...event.challenges.filter((challenge) => challenge.enabled).map((challenge) => ({
      kind: "challenge" as const, challengeId: challenge.id, startAtMs: challenge.startAtMs, endAtMs: challenge.endAtMs,
    })),
    ...(event.totalRankingEnabled ? [{ kind: "total" as const, challengeId: "", startAtMs: event.startAtMs, endAtMs: event.endAtMs }] : []),
    ...(event.pointRankingEnabled ? [{ kind: "point" as const, challengeId: "", startAtMs: event.startAtMs, endAtMs: event.endAtMs }] : []),
  ];
  return { ...state, eventId: event.id, catalogObservedAtMs: catalog.catalogObservedAtMs,
    boards: targets.map((target) => ({
      kind: target.kind,
      challengeId: target.challengeId,
      active: now >= target.startAtMs && (target.kind !== "challenge"
        || now < target.endAtMs + event.aggregationSeconds * 1000 || now >= event.endAtMs + event.aggregationSeconds * 1000),
      ...(saved.find((board) => board.kind === target.kind && board.challengeId === target.challengeId) ?? {
        lastAttemptAtMs: null, lastSuccessfulObservationAtMs: null, consecutiveFailures: 0, ageMs: null, stale: true, openGapMs: null,
      }),
    })),
  };
}

function boardStatus(enabled: boolean, start: number, end: number, aggregation: number, now: number): string {
  return !enabled ? "disabled" : now < start ? "upcoming" : now < end ? "collecting"
    : now < end + aggregation * 1000 ? "finalizing" : "archived";
}

type OfficialEvent = NonNullable<OfficialCatalog["event"]>;

/** An event's boards as readers see them; a board that closed with nothing saved is `missed`. */
function trackedEvent(event: OfficialEvent, now: number, recorded?: ReadonlySet<string>): TrackedEventDto {
  const status = (enabled: boolean, start: number, end: number, board: string) => {
    const value = boardStatus(enabled, start, end, event.aggregationSeconds, now);
    return value === "archived" && recorded && !recorded.has(`${event.id}/${board}`) ? "missed" : value;
  };
  return {
    id: event.id,
    startAtMs: event.startAtMs,
    endAtMs: event.endAtMs,
    status: now < event.endAtMs ? "nowOn" : "result",
    pointRankingEnabled: event.pointRankingEnabled,
    pointRankingStatus: boardStatus(event.pointRankingEnabled, event.startAtMs, event.endAtMs, event.aggregationSeconds, now),
    totalRankingEnabled: event.totalRankingEnabled,
    totalRankingStatus: status(event.totalRankingEnabled, event.startAtMs, event.endAtMs, ""),
    challenges: event.challenges.map((challenge) => ({
      ...challenge,
      status: status(challenge.enabled, challenge.startAtMs, challenge.endAtMs, challenge.id),
      rewardRanks: [],
    })),
  };
}

export function officialEventTracker(catalog: OfficialCatalog, now = Date.now()): EventTrackerDto {
  const event = catalog.event;
  return {
    region: catalog.region,
    provider: "official",
    fetchedAtMs: catalog.catalogObservedAtMs,
    serverTimeMs: now,
    stale: staleAt(catalog.catalogObservedAtMs, now),
    event: event ? trackedEvent(event, now) : null,
  };
}

/** Every event with known boards, newest first: the current one, those the collector finished, and the archive. */
async function eventArchive(env: OfficialRankingReadBindings, region: GameRecordsRegion, now: number): Promise<TrackedEventDto[]> {
  const db = env.DB!;
  const [catalog, finals, archived, observed, boards] = await Promise.all([
    readOfficialCatalog(env, region).catch(() => null),
    db.prepare("SELECT event_id, MAX(event_json) AS event_json FROM official_ranking_finals WHERE region = ? GROUP BY event_id")
      .bind(region).all<{ event_id: string; event_json: string }>(),
    db.prepare("SELECT event_id, event_json FROM event_ranking_archive WHERE region = ?").bind(region).all<{ event_id: string; event_json: string }>(),
    db.prepare(`SELECT event_id, challenge_id FROM official_ranking_observations WHERE region = ? AND error IS NULL
      GROUP BY event_id, board_kind, challenge_id`).bind(region).all<{ event_id: string; challenge_id: string }>(),
    db.prepare("SELECT event_id, challenge_id FROM event_ranking_archive_boards WHERE region = ?").bind(region).all<{ event_id: string; challenge_id: string }>(),
  ]);
  const events = new Map<string, OfficialEvent>();
  for (const row of [...archived.results, ...finals.results]) events.set(row.event_id, JSON.parse(row.event_json) as OfficialEvent);
  if (catalog?.event) events.set(catalog.event.id, catalog.event);
  const recorded = new Set([...observed.results, ...boards.results].map((row) => `${row.event_id}/${row.challenge_id}`));
  return [...events.values()].sort((a, b) => b.startAtMs - a.startAtMs).map((event) => trackedEvent(event, now, recorded));
}

async function archivedBoard(env: OfficialRankingReadBindings, region: GameRecordsRegion, eventId: string, challengeId: string) {
  const row = await env.DB!.prepare("SELECT body_json FROM event_ranking_archive_boards WHERE region = ? AND event_id = ? AND challenge_id = ?")
    .bind(region, eventId, challengeId).first<{ body_json: string }>();
  return row ? JSON.parse(row.body_json) as EventRankingDto : null;
}

/** Keeps a board read from elsewhere, refreshed at most every ten minutes. */
async function keepBoard(env: OfficialRankingReadBindings, region: GameRecordsRegion, eventId: string, challengeId: string, board: EventRankingDto) {
  const { provider: _provider, ...body } = board;
  const observed = body.fetchedAtMs ?? Date.now();
  await env.DB!.prepare(`INSERT INTO event_ranking_archive_boards (region, event_id, challenge_id, body_json, observed_at_ms) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (region, event_id, challenge_id) DO UPDATE SET body_json = excluded.body_json, observed_at_ms = excluded.observed_at_ms
    WHERE excluded.observed_at_ms > event_ranking_archive_boards.observed_at_ms + 600000`)
    .bind(region, eventId, challengeId, JSON.stringify(body), observed).run();
}

function officialCard(value: unknown): SongRankingCardDto {
  const entry = object(value), member = object(entry.member_card), support = object(entry.support_card);
  const memberId = positiveInteger(member.card_id), supportId = positiveInteger(support.card_id);
  return {
    slot: integer(entry.slot_index ?? 0) ?? 0,
    memberCardId: memberId,
    memberExp: memberId ? integer(member.exp ?? 0) : null,
    memberAwakeCount: memberId ? integer(member.awake_count ?? 0) : null,
    memberRank: memberId ? integer(member.card_rank ?? 0) : null,
    supportCardId: supportId,
    supportExp: supportId ? integer(support.exp ?? 0) : null,
    supportRank: supportId ? integer(support.rank ?? 0) : null,
  };
}

export function officialProfileCard(value: unknown, region: GameRecordsRegion): SongRankingRowDto["profileCard"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const card = object(value);
  const thumbnailUrls = (Array.isArray(card.thumbnail_url) ? card.thumbnail_url : []).flatMap((source) => {
    if (typeof source !== "string") return [];
    try {
      const url = new URL(source);
      return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? [officialCardUrl(region, url.href)] : [];
    } catch {
      return [];
    }
  });
  return { name: text(card.name), slot: integer(card.slot), thumbnailUrls };
}

export function officialEventRanking(observation: OfficialObservation, now = Date.now()): EventRankingDto {
  const rows: SongRankingRowDto[] = (observation.players ?? []).map((entry, index) => {
    const player = object(entry.player_data), favorite = object(player.favorite_member_card), deck = object(entry.high_score_deck);
    const hasPlayer = entry.player_data !== null && typeof entry.player_data === "object" && !Array.isArray(entry.player_data);
    const scoreExact = String(entry.score ?? 0);
    return {
      rank: index + 1,
      tied: false,
      playerId: text(player.id),
      profileId: text(player.profile_id),
      name: text(player.name) ?? "",
      rankExp: hasPlayer ? integer(player.rank_exp ?? 0) : null,
      favoriteMemberCardId: positiveInteger(favorite.card_id ?? player.favorite_member_card_master_id),
      favoriteMemberExp: positiveInteger(favorite.card_id) ? integer(favorite.exp ?? 0) : null,
      favoriteMemberAwakeCount: positiveInteger(favorite.card_id) ? integer(favorite.awake_count ?? 0) : null,
      favoriteMemberRank: positiveInteger(favorite.card_id) ? integer(favorite.card_rank ?? 0) : null,
      score: integer(scoreExact),
      scoreExact,
      deckId: positiveInteger(deck.id),
      deckName: text(deck.name),
      totalPower: positiveInteger(deck.total_power),
      profileCard: officialProfileCard(player.profile_card, observation.region),
      cards: Array.isArray(deck.cards) ? deck.cards.slice(0, 5).map(officialCard).sort((left, right) => left.slot - right.slot) : [],
    };
  });
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const previous = rows[index - 1];
    const tied = !!previous && previous.scoreExact === row.scoreExact;
    if (tied) row.rank = previous.rank;
    row.tied = tied || rows[index + 1]?.scoreExact === row.scoreExact;
  }
  return {
    region: observation.region,
    eventId: observation.eventId,
    ...(observation.kind === "challenge" ? { challengeId: observation.challengeId } : {}),
    provider: "official",
    snapshotId: observation.snapshotId,
    observedAtMs: observation.observedAtMs,
    fetchedAtMs: observation.observedAtMs,
    serverTimeMs: now,
    stale: staleAt(observation.observedAtMs, now),
    rows,
  };
}

function response(request: Request, body: unknown, status = 200, cache = "no-store"): Response {
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": cache,
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
  } });
}
function failure(request: Request, kind: string, status: number): Response {
  return response(request, { error: { kind, retryAfter: status === 503 ? 30 : null } }, status);
}
async function pending(request: Request, env: OfficialRankingReadBindings, region: GameRecordsRegion): Promise<Response> {
  const collectorStatus = await officialCollectorAvailability(env, region);
  return response(request, { error: { kind: "pending", retryAfter: collectorStatus ? null : 30,
    ...(collectorStatus ? { collectorStatus } : {}) } }, 503);
}
function publicObservation(value: StoredOfficialObservation, now: number) {
  return {
    snapshotId: value.snapshotId,
    cursor: value.cursor,
    payloadHash: value.payloadHash,
    observedAtMs: value.observedAtMs,
    ...(value.error ? { error: value.error, httpStatus: value.httpStatus ?? null, grpcStatus: value.grpcStatus ?? null }
      : { ranking: officialEventRanking(value, now) }),
  };
}

export async function handleOfficialRankingApi(request: Request, url: URL, env: OfficialRankingReadBindings): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const route = /^\/api\/(v1|v2)\/game\/records\/([^/]+)\/events\/(.+)$/u.exec(url.pathname);
  if (!route || !regionValue(route[2])) return null;
  const version = route[1], region = route[2], path = route[3]!;
  const current = path === "current";
  if (path === "archive") {
    if (!officialRankingReadEnabled(env, region) || !env.DB || url.searchParams.size > 0) return null;
    const now = Date.now();
    try {
      return response(request, { region, serverTimeMs: now, events: await eventArchive(env, region, now) }, 200, "public, max-age=60");
    } catch {
      return failure(request, "upstream", 503);
    }
  }
  const points = /^([1-9][0-9]{0,18})\/latest$/u.exec(path);
  if (points) {
    if (!officialRankingReadEnabled(env, region) || !env.DB || !env.OFFICIAL_RANKING_DATA) return null;
    const observation = await readOfficialLatest(env, region, points[1]!, "point", "").catch(() => null);
    return observation ? response(request, officialEventRanking(observation)) : null;
  }
  const board = /^([1-9][0-9]{0,18})\/(total|challenges\/([1-9][0-9]{0,18}))\/(latest|ranking|history)$/u.exec(path);
  const optionalTotal = version === "v1" && !officialRankingReadEnabled(env, region)
    && board?.[2] === "total" && board[4] === "latest";
  if (version === "v1" && !officialRankingReadEnabled(env, region) && !optionalTotal) return null;
  if (!current && !board) return null;
  if (board && version === "v1" && board[4] === "history") return null;
  if (current ? url.searchParams.size > 0 : board![4] !== "history" && url.searchParams.size > 0) return failure(request, "invalid_request", 400);
  if (!env.DB || !env.OFFICIAL_RANKING_DATA) return optionalTotal ? null : pending(request, env, region);
  try {
    if (current) {
      const catalog = await readOfficialCatalog(env, region);
      return catalog ? response(request, officialEventTracker(catalog)) : pending(request, env, region);
    }
    const eventId = board![1], challengeId = board![3] ?? "", operation = board![4]!;
    if (!decimalId(eventId)) return failure(request, "invalid_request", 400);
    const kind = challengeId ? "challenge" : "total";
    if (operation === "history") {
      const after = url.searchParams.get("after") ?? "0";
      if (!/^(0|[1-9][0-9]*)$/u.test(after) || !Number.isSafeInteger(Number(after))
        || url.searchParams.getAll("after").length > 1 || [...url.searchParams.keys()].some((key) => key !== "after")) {
        return failure(request, "invalid_request", 400);
      }
      const history = await readOfficialHistory(env, region, eventId, kind, challengeId, Number(after));
      const now = Date.now();
      return response(request, { provider: "official", region, eventId, kind, challengeId, serverTimeMs: now,
        observations: history.observations.map((value) => publicObservation(value, now)), nextCursor: history.nextCursor });
    }
    const observation = await readOfficialLatest(env, region, eventId, kind, challengeId);
    if (observation) return response(request, officialEventRanking(observation));
    const fallback = await moenotesEventRanking(region, eventId, challengeId);
    if (fallback) {
      await keepBoard(env, region, eventId, challengeId, fallback).catch(() => undefined);
      return response(request, fallback);
    }
    const archived = await archivedBoard(env, region, eventId, challengeId);
    if (archived) return response(request, archived);
    return optionalTotal ? null : pending(request, env, region);
  } catch (error) {
    console.warn(JSON.stringify({ event: "official_ranking_read_failed", region, error: error instanceof Error ? error.name : "Error" }));
    return optionalTotal ? null : failure(request, "upstream", 503);
  }
}
