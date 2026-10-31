// L3 — GEB
// Input: Region and a player, song or event board the official pool has no saved data for.
// Output: The same record DTOs, marked `provider: "moenotes"`, or null when Moenotes has nothing usable.
// Pos: [Map](L2.md); last resort behind official-player-api.ts and official-ranking-api.ts.
// Effects/Dependencies: Reads Moenotes over HTTPS with a one-minute edge cache; never stores its data as official.
import type {
  EventRankingDto,
  GameProfileCardDto,
  GameRecordsRegion,
  PlayerProfileDto,
  SongRankingCardDto,
  SongRankingDto,
  SongRankingRowDto,
} from "../src/lib/game-records";

export interface MoenotesBindings {
  MOENOTES_PROFILE_API_TOKEN?: string;
}

const RANKING_ORIGIN = "https://api.bdon.moe";
const PROFILE_ORIGIN = "https://bdon-api.bdon.moe";
const TIMEOUT_MS = 4_000;
const MAX_BYTES = 512 * 1024;
const CACHE_SECONDS = 60;

type Json = Record<string, unknown>;
const object = (value: unknown): Json => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const number = (value: unknown): number | null => {
  const parsed = typeof value === "string" && /^-?[0-9]+$/u.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
};
const integer = (value: unknown): number | null => {
  const parsed = number(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
};

async function read(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const key = new Request(url.replace(/^https:\/\/[^/]+/u, "https://moenotes-fallback.invalid"));
  const cache = typeof caches === "undefined" ? null : caches.default;
  const hit = await cache?.match(key).catch(() => undefined);
  if (hit) return hit.json();
  const response = await fetch(url, { headers: { Accept: "application/json", ...headers }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) return null;
  const body = await response.text();
  if (body.length > MAX_BYTES) return null;
  await cache?.put(key, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_SECONDS}` } })).catch(() => undefined);
  return JSON.parse(body) as unknown;
}

/** A failed fallback leaves the caller's own pending answer in place. */
async function attempt<T>(producer: () => Promise<T | null>): Promise<T | null> {
  try {
    return await producer();
  } catch (error) {
    console.warn(JSON.stringify({ event: "moenotes-fallback-failed", error: error instanceof Error ? error.name : "Error" }));
    return null;
  }
}

function profileCard(value: unknown, region: GameRecordsRegion, profileId: string | null): GameProfileCardDto | null {
  const card = object(value);
  const urls = list(card.thumbnailUrl).flatMap((url) => text(url) ?? []);
  if (!urls.length) return null;
  const pages = urls.map((sourceUrl, index) => ({
    page: index + 1,
    sourceUrl,
    imageUrl: region === "jp" && profileId ? `${RANKING_ORIGIN}/api/v1/jp/ranking/profile/${profileId}/card/${index + 1}` : sourceUrl,
    downloadUrl: null,
  }));
  return { name: text(card.name), slot: integer(card.slot), thumbnailUrls: pages.map((page) => page.imageUrl), pages };
}

function deckCard(value: unknown, index: number): SongRankingCardDto {
  const entry = object(value), member = object(entry.memberCard), support = object(entry.supportCard);
  return {
    slot: integer(entry.slotIndex) ?? index,
    memberCardId: integer(member.cardId),
    memberExp: number(member.exp),
    memberAwakeCount: integer(member.awakeCount),
    memberRank: integer(member.cardRank),
    supportCardId: integer(support.cardId),
    supportExp: number(support.exp),
    supportRank: integer(support.rank),
  };
}

function row(value: unknown, index: number, region: GameRecordsRegion): SongRankingRowDto {
  const entry = object(value), player = object(entry.playerData), favorite = object(player.favoriteMemberCard), deck = object(entry.highScoreDeck);
  const profileId = text(player.profileId);
  return {
    rank: index + 1,
    tied: false,
    playerId: text(player.id),
    profileId,
    name: text(player.name) ?? "",
    rankExp: number(player.rankExp),
    favoriteMemberCardId: integer(favorite.cardId),
    favoriteMemberExp: number(favorite.exp),
    favoriteMemberAwakeCount: integer(favorite.awakeCount),
    favoriteMemberRank: integer(favorite.cardRank),
    score: number(entry.score),
    deckId: integer(deck.id),
    deckName: text(deck.name),
    totalPower: number(deck.totalPower),
    profileCard: profileCard(player.profileCard, region, profileId),
    cards: list(deck.cards).slice(0, 5).map(deckCard).sort((a, b) => a.slot - b.slot),
  };
}

/** Moenotes lists players in the game's own order. */
function ranking(value: unknown, region: GameRecordsRegion) {
  const players = object(value).players;
  if (!Array.isArray(players) || !players.length) return null;
  const now = Date.now();
  return { region, provider: "moenotes" as const, fetchedAtMs: now, serverTimeMs: now, stale: false,
    rows: players.slice(0, 100).map((player, index) => row(player, index, region)) };
}

export const moenotesSongRanking = (region: GameRecordsRegion, musicId: string): Promise<SongRankingDto | null> =>
  attempt(async () => {
    const board = ranking(await read(`${RANKING_ORIGIN}/api/v1/${region}/music/${musicId}/ranking`), region);
    return board && { ...board, musicId: Number(musicId) };
  });

export const moenotesEventRanking = (region: GameRecordsRegion, eventId: string, challengeId: string): Promise<EventRankingDto | null> =>
  attempt(async () => {
    const path = challengeId ? `challenges/${challengeId}/ranking` : "challenge-total-ranking";
    const board = ranking(await read(`${RANKING_ORIGIN}/api/v1/${region}/events/${eventId}/${path}`), region);
    return board && { ...board, eventId, ...(challengeId ? { challengeId } : {}) };
  });

export const moenotesPlayer = (env: MoenotesBindings, region: GameRecordsRegion, profileId: string): Promise<PlayerProfileDto | null> =>
  attempt(async () => {
    const token = env.MOENOTES_PROFILE_API_TOKEN?.trim();
    if (!token) return null;
    const headers = { Authorization: `Bearer ${token}`, "User-Agent": "Mozilla/5.0" };
    const profile = object(object(await read(`${PROFILE_ORIGIN}/v1/${region}/profile/${profileId}`, headers)).playerProfile);
    if (!Object.keys(profile).length) return null;
    const playerId = text(profile.id);
    const favorites = playerId
      ? object(await read(`${PROFILE_ORIGIN}/v1/${region}/profile/favorites?playerId=${encodeURIComponent(playerId)}`, headers).catch(() => null))
      : {};
    const favorite = object(profile.favoriteMemberCard), total = text(favorites.totalFavorite) ?? (integer(favorites.totalFavorite) ?? 0).toString();
    const now = Date.now();
    return {
      region,
      profileId,
      provider: "moenotes",
      fetchedAtMs: now,
      serverTimeMs: now,
      stale: false,
      profile: {
        playerId,
        name: text(profile.name),
        level: null,
        rankExp: number(profile.rankExp) ?? 0,
        totalFavorite: integer(total),
        totalFavoriteExact: total,
        favoriteMemberCardMasterId: text(profile.favoriteMemberCardMasterId),
        favoriteMemberCard: integer(favorite.cardId)
          ? { cardId: integer(favorite.cardId), exp: number(favorite.exp) ?? 0, awakeCount: integer(favorite.awakeCount) ?? 0,
              cardRank: integer(favorite.cardRank) ?? 0, liveSkillLevel: integer(favorite.liveSkillLevel) ?? 0,
              performanceSkillLevel: integer(favorite.performanceSkillLevel) ?? 0 }
          : null,
        profileCard: profileCard(profile.profileCard, region, profileId),
        lastUpdatedAtMs: integer(profile.lastUpdatedAt) ? integer(profile.lastUpdatedAt)! * 1000 : null,
      },
    };
  });
