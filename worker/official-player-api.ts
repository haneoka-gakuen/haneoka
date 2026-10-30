// L3 — GEB
// Input: Player profile and song ranking reads, saved pool results and the regional collector.
// Output: Normalized DTOs from official data; missing or stale entries queue a bounded pool read.
// Pos: [Map](L2.md); read side of the on-demand pool lookups beside official-ranking-api.ts.
// Effects/Dependencies: Reads D1/R2 and queues Durable Object demand; never contacts the game itself.
import type { GameProfileCardDto, GameRecordsRegion, PlayerProfileDto, SongRankingDto } from "../src/lib/game-records";
import { officialEventRanking } from "./official-ranking-api";
import { officialCardUrl, readOfficialCardImage, readOfficialPlayer, readOfficialSongRanking, type OfficialPlayerRecord, type OfficialRankingStoreBindings } from "./official-ranking-store";

export interface OfficialPlayerBindings extends OfficialRankingStoreBindings {
  OFFICIAL_RANKING_COLLECTOR?: Env["OFFICIAL_RANKING_COLLECTOR"];
}

const PREFIX = "/api/v1/game/records";
const REGIONS: readonly string[] = ["jp", "tw", "en", "kr"];
const PLAYER_TTL_MS = 6 * 3_600_000;
const MISSING_TTL_MS = 3_600_000;
const SONG_TTL_MS = 3_600_000;

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const integer = (value: unknown): number | null => {
  const number = typeof value === "number" ? value : typeof value === "string" && /^-?[0-9]+$/u.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) ? number : null;
};
const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const https = (value: unknown) => (typeof value === "string" && value.startsWith("https://") ? value : null);

const json = (request: Request, body: unknown, status = 200) =>
  new Response(request.method === "HEAD" ? null : JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
  } });

export function playerCard(region: GameRecordsRegion, profileId: string, value: unknown): GameProfileCardDto | null {
  if (value === null || typeof value !== "object") return null;
  const card = object(value);
  const urls = (Array.isArray(card.thumbnail_url) ? card.thumbnail_url : []).flatMap((url) => https(url) ?? []);
  return {
    name: text(card.name),
    slot: integer(card.slot),
    thumbnailUrls: urls.map((url) => officialCardUrl(region, url)),
    pages: urls.map((url, index) => {
      const file = new URL(url).pathname.split("/").pop() ?? "";
      return { page: index + 1, imageUrl: officialCardUrl(region, url), sourceUrl: url,
        downloadUrl: `${PREFIX}/${region}/players/${profileId}/cards/${index + 1}/download?file=${encodeURIComponent(file)}` };
    }),
  };
}

export function playerProfile(region: GameRecordsRegion, profileId: string, record: OfficialPlayerRecord, now: number): PlayerProfileDto {
  const profile = object(record.profile), favorite = object(profile.favorite_member_card);
  const favoriteId = integer(favorite.card_id);
  return {
    region, profileId, fetchedAtMs: record.observedAtMs, serverTimeMs: now, stale: now - record.observedAtMs > PLAYER_TTL_MS,
    profile: {
      playerId: text(profile.id),
      name: text(profile.name),
      level: null,
      rankExp: integer(profile.rank_exp ?? 0),
      totalFavorite: integer(record.totalFavorite),
      totalFavoriteExact: record.totalFavorite,
      favoriteMemberCardMasterId: text(profile.favorite_member_card_master_id) ?? (favoriteId ? String(favoriteId) : null),
      favoriteMemberCard: favoriteId
        ? { cardId: favoriteId, exp: integer(favorite.exp ?? 0), awakeCount: integer(favorite.awake_count ?? 0),
            cardRank: integer(favorite.card_rank ?? 0), liveSkillLevel: integer(favorite.live_skill_level),
            performanceSkillLevel: integer(favorite.performance_skill_level) }
        : null,
      profileCard: playerCard(region, profileId, profile.profile_card),
      lastUpdatedAtMs: integer(profile.last_updated_at),
    },
  };
}

const queue = (ctx: ExecutionContext, env: OfficialPlayerBindings, region: GameRecordsRegion, kind: "player" | "song" | "card", id: string) =>
  ctx.waitUntil(
    Promise.resolve(env.OFFICIAL_RANKING_COLLECTOR?.getByName(region).requestDemand(region, kind, [id])).catch(() => undefined),
  );

const pending = (request: Request) => json(request, { error: { kind: "pending", retryAfter: 30 } }, 503);

async function serveCard(request: Request, ctx: ExecutionContext, env: OfficialPlayerBindings, file: string) {
  const image = await readOfficialCardImage(env, "jp", file);
  if (!image) {
    queue(ctx, env, "jp", "card", file);
    return json(request, { error: { kind: "pending", retryAfter: 60 } }, 404);
  }
  return new Response(request.method === "HEAD" ? null : image.body, { headers: {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
  } });
}

/** Answers only from saved pool data; anything missing is queued and reported as pending. */
export async function handleOfficialPlayerApi(request: Request, ctx: ExecutionContext, url: URL, env: OfficialPlayerBindings): Promise<Response | null> {
  if (!env.DB || !env.OFFICIAL_RANKING_DATA || (request.method !== "GET" && request.method !== "HEAD")) return null;
  const card = new RegExp(`^${PREFIX}/jp/cards/([1-9][0-9]{0,18}_[A-Za-z0-9_.-]{1,200})$`, "u").exec(url.pathname);
  if (card) return serveCard(request, ctx, env, card[1]!);
  const match = new RegExp(`^${PREFIX}/([a-z]+)/(?:players/([1-9][0-9]{0,18})|songs/([1-9][0-9]{0,18})/ranking)$`, "u").exec(url.pathname);
  if (!match || !REGIONS.includes(match[1]!)) return null;
  const region = match[1] as GameRecordsRegion, now = Date.now();
  if (match[2]) {
    const profileId = match[2];
    const record = await readOfficialPlayer(env, region, profileId);
    if (!record || now - record.observedAtMs > PLAYER_TTL_MS) queue(ctx, env, region, "player", profileId);
    if (!record) return pending(request);
    if (!record.found) return now - record.observedAtMs < MISSING_TTL_MS ? json(request, { error: { kind: "not_found" } }, 404) : pending(request);
    return json(request, playerProfile(region, profileId, record, now));
  }
  const musicId = match[3]!;
  const ranking = await readOfficialSongRanking(env, region, musicId);
  if (!ranking || now - ranking.observedAtMs > SONG_TTL_MS) queue(ctx, env, region, "song", musicId);
  if (!ranking) return pending(request);
  const { eventId: _eventId, ...rows } = officialEventRanking(
    { region, eventId: "", kind: "total", challengeId: "", snapshotId: `song-${musicId}-${ranking.observedAtMs}`,
      observedAtMs: ranking.observedAtMs, players: ranking.players as never },
    now,
  );
  return json(request, { ...rows, musicId: Number(musicId) } satisfies SongRankingDto);
}
