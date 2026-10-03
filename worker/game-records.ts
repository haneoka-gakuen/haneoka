const GAME_RECORDS_API_PREFIX = "/api/v1/game/records";
const RANKING_ORIGIN = "https://api.bdon.moe";
const PROFILE_ORIGIN = "https://bdon.moe";
const MOENOTES_PROFILE_ORIGIN = "https://bdon-api.bdon.moe";
const REGIONS = ["jp", "tw", "en", "kr"] as const;
const MAX_UPSTREAM_BODY_BYTES = 512 * 1024;
const UPSTREAM_TIMEOUT_MS = 4_000;
const CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";
const MAX_CARD_IMAGE_BYTES = 8 * 1024 * 1024;
const CARD_DOWNLOAD_TIMEOUT_MS = 12_000;

import type {
  GameRecordsRegion,
  GameProfileCardDto,
  SongRankingCardDto,
  SongRankingRowDto,
  SongRankingDto,
  PlayerProfileDto,
  EventTrackerDto,
  EventRankingDto,
} from "../src/lib/game-records";

type JsonObject = Record<string, unknown>;
type CacheableJson = { body: string };
export interface GameRecordsBindings {
  MOENOTES_PROFILE_API_TOKEN?: string;
}
type FailureKind = "invalid_request" | "not_found" | "pending" | "timeout" | "upstream" | "stale_version";

const CORS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

class RequestFailure extends Error {
  readonly status: number;
  readonly kind: FailureKind;
  readonly retryAfter: number | null;

  constructor(status: number, kind: FailureKind, retryAfterValue: number | null = null) {
    super(kind);
    this.status = status;
    this.kind = kind;
    this.retryAfter = retryAfterValue;
  }
}

const asObject = (value: unknown): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const safeInteger = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

const httpUrlOrNull = (value: unknown): string | null => {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : null;
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
    return null;
  }
};

const epochMillis = (value: unknown, seconds = false): number | null => {
  const number =
    finiteNumber(value) ??
    (typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null);
  if (number === null || number < 0) return null;
  const millis = seconds ? number * 1_000 : number;
  return Number.isSafeInteger(millis) ? millis : null;
};

const headerEpochMillis = (headers: Headers, name: string): number | null =>
  epochMillis(headers.get(name) || undefined);

const retryAfter = (headers: Headers): number | null => {
  const value = headers.get("Retry-After");
  if (!value || !/^[0-9]+$/u.test(value.trim())) return null;
  const seconds = Number(value.trim());
  return Number.isSafeInteger(seconds) && seconds <= 3_600 ? seconds : null;
};

const knownFailureKind = (value: unknown): FailureKind | null =>
  value === "pending" || value === "not_found" || value === "upstream" ? value : null;

const readErrorKind = (value: unknown): FailureKind | null => {
  if (typeof value === "string") return knownFailureKind(value);
  const root = asObject(value);
  const error = root.error;
  if (typeof error === "string") return knownFailureKind(error);
  return knownFailureKind(asObject(error).kind);
};

const readBoundedText = async (response: Response): Promise<string> => {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength && /^[0-9]+$/u.test(contentLength) && Number(contentLength) > MAX_UPSTREAM_BODY_BYTES) {
    throw new RequestFailure(502, "upstream");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      length += value.byteLength;
      if (length > MAX_UPSTREAM_BODY_BYTES) {
        await reader.cancel();
        throw new RequestFailure(502, "upstream");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

const readJson = async (response: Response): Promise<unknown> => {
  const text = await readBoundedText(response);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RequestFailure(502, "upstream");
  }
};

const upstreamJson = async (
  target: string,
  headers: Record<string, string> = {},
): Promise<{ value: unknown; response: Response }> => {
  const deadline = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  let upstreamStatus: number | null = null;
  try {
    const response = await fetch(target, {
      method: "GET",
      headers: { Accept: "application/json", ...headers },
      redirect: headers.Authorization ? "manual" : "follow",
      signal: deadline,
    });
    upstreamStatus = response.status;
    if (!response.ok) {
      if (
        headers.Authorization &&
        ((response.status >= 300 && response.status < 400) || response.status === 401 || response.status === 403)
      ) {
        await response.body?.cancel();
        throw new RequestFailure(502, "upstream");
      }
      let kind: FailureKind =
        response.status === 401 || response.status === 403 || response.status === 404 ? "not_found" : "upstream";
      try {
        const upstreamKind = readErrorKind(await readJson(response));
        if (upstreamKind) kind = upstreamKind;
      } catch (error) {
        if (deadline.aborted) throw deadline.reason;
        if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
        // The status mapping is the safe fallback for an unusable error body.
      }
      throw new RequestFailure(
        response.status === 404 ? 404 : response.status >= 500 ? 502 : response.status,
        kind,
        retryAfter(response.headers),
      );
    }
    return { value: await readJson(response), response };
  } catch (error) {
    if (headers.Authorization)
      console.warn(JSON.stringify({ event: "moenotes-profile-provider", upstreamStatus, noToken: false }));
    if (deadline.aborted) throw new RequestFailure(504, "timeout");
    if (error instanceof RequestFailure) throw error;
    const name = error instanceof Error ? error.name : "";
    if (name === "AbortError" || name === "TimeoutError") throw new RequestFailure(504, "timeout");
    throw new RequestFailure(502, "upstream");
  }
};

const normalizeProfileCard = (
  value: unknown,
  region: GameRecordsRegion,
  profileId: string | null,
): GameProfileCardDto | null => {
  const card = asObject(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const pages = asArray(card.thumbnailUrl).map((value, index) => {
    const sourceUrl = httpUrlOrNull(value);
    const page = index + 1;
    const imageUrl =
      sourceUrl && region === "jp" && profileId && /^[1-9][0-9]{0,18}$/u.test(profileId)
        ? `${RANKING_ORIGIN}/api/v1/jp/ranking/profile/${profileId}/card/${page}`
        : sourceUrl;
    const file = sourceUrl ? new URL(sourceUrl).pathname.split("/").pop() || "" : "";
    const downloadUrl = profileId && validCardFile(file, profileId)
      ? `${GAME_RECORDS_API_PREFIX}/${region}/players/${profileId}/cards/${page}/download?file=${encodeURIComponent(file)}`
      : null;
    return { page, sourceUrl, imageUrl, downloadUrl };
  });
  return {
    name: textOrNull(card.name),
    slot: safeInteger(card.slot),
    thumbnailUrls: pages.flatMap((page) => (page.imageUrl ? [page.imageUrl] : [])),
    pages,
  };
};

const normalizeCard = (value: unknown, index: number): SongRankingCardDto => {
  const entry = asObject(value);
  const member = asObject(entry.memberCard);
  const support = asObject(entry.supportCard);
  return {
    slot: safeInteger(entry.slotIndex) ?? index,
    memberCardId: safeInteger(member.cardId),
    memberExp: finiteNumber(member.exp),
    memberAwakeCount: safeInteger(member.awakeCount),
    memberRank: safeInteger(member.cardRank),
    supportCardId: safeInteger(support.cardId),
    supportExp: finiteNumber(support.exp),
    supportRank: safeInteger(support.rank),
  };
};

type RankedRow = SongRankingRowDto & { sourceIndex: number };

const normalizeRankingRow = (value: unknown, sourceIndex: number, region: GameRecordsRegion): RankedRow => {
  const entry = asObject(value);
  const player = asObject(entry.playerData);
  const deck = asObject(entry.highScoreDeck);
  const cards = asArray(deck.cards)
    .slice(0, 5)
    .map((card, index) => normalizeCard(card, index))
    .sort((a, b) => a.slot - b.slot);
  return {
    sourceIndex,
    rank: 0,
    tied: false,
    playerId: textOrNull(player.id),
    profileId: textOrNull(player.profileId),
    name: typeof player.name === "string" ? player.name : "",
    rankExp: finiteNumber(player.rankExp),
    favoriteMemberCardId: safeInteger(asObject(player.favoriteMemberCard).cardId),
    score: finiteNumber(entry.score),
    deckId: safeInteger(deck.id),
    deckName: textOrNull(deck.name),
    totalPower: finiteNumber(deck.totalPower),
    profileCard: normalizeProfileCard(player.profileCard, region, textOrNull(player.profileId)),
    cards,
  };
};

const normalizeRanking = (
  value: unknown,
  region: GameRecordsRegion,
  musicId: number,
  response: Response,
  responseOrder = false,
): SongRankingDto => {
  const root = asObject(value);
  if (!Array.isArray(root.players)) throw new RequestFailure(502, "upstream");
  const rows = root.players
    .map((player, index) => normalizeRankingRow(player, index, region))
    .sort((left, right) => {
      if (responseOrder) return left.sourceIndex - right.sourceIndex;
      if (left.score === null && right.score === null) return left.sourceIndex - right.sourceIndex;
      if (left.score === null) return 1;
      if (right.score === null) return -1;
      return right.score - left.score || left.sourceIndex - right.sourceIndex;
    });
  let previousScore: number | null = null;
  let previousRank = 0;
  rows.forEach((row, index) => {
    const tied = !responseOrder && row.score !== null && row.score === previousScore;
    row.rank = tied ? previousRank : index + 1;
    row.tied = !responseOrder && (tied || (row.score !== null && rows[index + 1]?.score === row.score));
    previousScore = row.score;
    previousRank = row.rank;
  });
  return {
    region,
    musicId,
    fetchedAtMs: headerEpochMillis(response.headers, "X-Fetched-At"),
    serverTimeMs: headerEpochMillis(response.headers, "X-Server-Time"),
    stale: response.headers.get("X-Stale") === "1" || response.headers.get("X-Refreshing") === "1",
    rows: rows.map(({ sourceIndex: _sourceIndex, ...row }) => row),
  };
};

const decimalId = (value: unknown): string | null => {
  const id = typeof value === "string" ? value : Number.isSafeInteger(value) ? String(value) : "";
  return /^[1-9][0-9]{0,18}$/u.test(id) ? id : null;
};

const normalizeTrackedEvent = (value: unknown, region: GameRecordsRegion, response: Response): EventTrackerDto => {
  const event = asObject(value);
  const id = decimalId(event.eventId);
  if (!id) throw new RequestFailure(502, "upstream");
  const points = asObject(event.pointRanking);
  return {
    region,
    fetchedAtMs: headerEpochMillis(response.headers, "X-Fetched-At") ?? epochMillis(event.lastFetchedAt),
    stale: event.stale === true || response.headers.get("X-Stale") === "1",
    event: {
      id,
      startAtMs: epochMillis(event.startAt),
      endAtMs: epochMillis(event.endAt),
      status: textOrNull(event.eventStatus) || "unknown",
      pointRankingEnabled:
        typeof points.enabled === "boolean"
          ? points.enabled
          : event.rankingDisabled !== true && event.collectStatus !== "disabled",
      pointRankingStatus: textOrNull(points.collectStatus) || textOrNull(event.collectStatus) || "unknown",
      challenges: asArray(event.challengeRankings).flatMap((value) => {
        const challenge = asObject(value);
        const challengeId = decimalId(challenge.challengeMusicId);
        const musicId = decimalId(challenge.musicId);
        if (!challengeId || !musicId) return [];
        return [
          {
            id: challengeId,
            musicId,
            enabled: challenge.rankingEnabled === true,
            status: textOrNull(challenge.collectStatus) || "unknown",
            startAtMs: epochMillis(challenge.effectiveStartAt) ?? epochMillis(event.startAt),
            endAtMs: epochMillis(challenge.effectiveEndAt) ?? epochMillis(event.endAt),
            rewardRanks: [
              ...new Set(
                asArray(challenge.rewardBands).flatMap((band) => {
                  const rank = safeInteger(asObject(band).rankEnd);
                  return rank !== null && rank > 0 ? [rank] : [];
                }),
              ),
            ].sort((a, b) => a - b),
          },
        ];
      }),
    },
  };
};

const normalizeEventPoints = (
  value: unknown,
  region: GameRecordsRegion,
  eventId: string,
  response: Response,
): EventRankingDto => {
  const root = asObject(value);
  if (!Array.isArray(root.rows)) throw new RequestFailure(502, "upstream");
  const rows = root.rows
    .flatMap((value) => {
      const entry = asObject(value);
      const rank = safeInteger(entry.rank);
      const score = finiteNumber(entry.point);
      if (rank === null || rank < 1 || score === null || score < 0) return [];
      const profile = asObject(entry.profile);
      return [
        {
          rank,
          tied: entry.dup === true,
          score,
          playerId: textOrNull(profile.id),
          profileId: textOrNull(profile.profileId),
          name: textOrNull(profile.name) || "",
          rankExp: null,
          favoriteMemberCardId: null,
          deckId: null,
          deckName: null,
          totalPower: null,
          profileCard: null,
          cards: [],
        },
      ];
    })
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 100);
  return {
    region,
    eventId,
    rows,
    fetchedAtMs: epochMillis(root.updatedAt) ?? headerEpochMillis(response.headers, "X-Fetched-At"),
    serverTimeMs: headerEpochMillis(response.headers, "X-Server-Time"),
    stale: root.stale === true || response.headers.get("X-Stale") === "1",
  };
};

const normalizeProfile = (
  value: unknown,
  region: GameRecordsRegion,
  profileId: string,
  response: Response,
): PlayerProfileDto => {
  const root = asObject(value);
  if (!Object.keys(root).length || (!root.playerProfile && !root.profile && !root.brief))
    throw new RequestFailure(502, "upstream");
  const profile = asObject(root.playerProfile ?? root.profile);
  if (root.playerProfile && !Object.keys(profile).length) throw new RequestFailure(404, "not_found");
  const brief = asObject(root.brief);
  const favorites = asObject(root.favorites);
  const protobufProfile = root.playerProfile !== undefined && root.playerProfile !== null;
  const profileNumber = (value: unknown) => value === undefined && protobufProfile ? 0 : finiteNumber(value);
  const profileInteger = (value: unknown) => value === undefined && protobufProfile ? 0 : safeInteger(value);
  const totalFavoriteExact =
    typeof favorites.totalFavorite === "string" && /^[0-9]{1,19}$/u.test(favorites.totalFavorite)
      ? favorites.totalFavorite
      : typeof favorites.totalFavorite === "number" &&
          Number.isSafeInteger(favorites.totalFavorite) && favorites.totalFavorite >= 0
        ? String(favorites.totalFavorite)
        : null;
  const favoriteMemberCard = asObject(profile.favoriteMemberCard);
  const favorite = Object.keys(favoriteMemberCard).length
    ? {
        cardId: safeInteger(favoriteMemberCard.cardId),
        exp: profileNumber(favoriteMemberCard.exp),
        awakeCount: profileInteger(favoriteMemberCard.awakeCount),
        cardRank: profileInteger(favoriteMemberCard.cardRank),
        liveSkillLevel: profileInteger(favoriteMemberCard.liveSkillLevel),
        performanceSkillLevel: profileInteger(favoriteMemberCard.performanceSkillLevel),
      }
    : null;
  return {
    region,
    profileId: decimalId(profile.profileId) ?? profileId,
    fetchedAtMs:
      headerEpochMillis(response.headers, "X-Moenotes-Fetched-At") ??
      headerEpochMillis(response.headers, "X-Fetched-At") ??
      epochMillis(root.fetchedAt),
    serverTimeMs: headerEpochMillis(response.headers, "X-Server-Time"),
    stale: response.headers.get("X-Stale") === "1" || response.headers.get("X-Refreshing") === "1",
    profile: {
      playerId: textOrNull(profile.id),
      name: textOrNull(profile.name),
      level: finiteNumber(brief.level),
      rankExp: profileNumber(profile.rankExp),
      totalFavorite: safeInteger(totalFavoriteExact),
      totalFavoriteExact,
      favoriteMemberCardMasterId: decimalId(profile.favoriteMemberCardMasterId),
      favoriteMemberCard: favorite,
      profileCard: normalizeProfileCard(profile.profileCard, region, profileId),
      lastUpdatedAtMs: epochMillis(profile.lastUpdatedAt, true),
    },
  };
};

const errorResponse = (
  request: Request,
  status: number,
  kind: string,
  retryAfterValue: number | null = null,
): Response =>
  new Response(request.method === "HEAD" ? null : JSON.stringify({ error: { kind, retryAfter: retryAfterValue } }), {
    status,
    headers: {
      ...CORS,
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });

const jsonResponse = (request: Request, body: string): Response =>
  new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers: { ...CORS, "Cache-Control": CACHE_CONTROL, "Content-Type": "application/json; charset=utf-8" },
  });

const cacheRequest = (request: Request): Request => {
  const url = new URL(request.url);
  url.search = "";
  if (url.pathname.startsWith(`${GAME_RECORDS_API_PREFIX}/jp/`))
    url.searchParams.set("schema", "jp-profile-v2");
  url.hash = "";
  return new Request(url, { method: "GET" });
};

const serveCached = async (
  request: Request,
  ctx: ExecutionContext,
  producer: () => Promise<CacheableJson>,
): Promise<Response> => {
  const key = cacheRequest(request);
  if (typeof caches !== "undefined") {
    const hit = await caches.default.match(key).catch(() => undefined);
    if (hit) {
      if (request.method === "HEAD") return new Response(null, { status: hit.status, headers: hit.headers });
      return hit;
    }
  }
  let result: CacheableJson;
  try {
    result = await producer();
  } catch (error) {
    if (error instanceof RequestFailure) return errorResponse(request, error.status, error.kind, error.retryAfter);
    return errorResponse(request, 502, "upstream");
  }
  const response = jsonResponse(request, result.body);
  if (request.method === "GET" && typeof caches !== "undefined") {
    ctx.waitUntil(caches.default.put(key, response.clone()).catch(() => undefined));
  }
  return response;
};

const rankingProfileIdPattern = (region: GameRecordsRegion): RegExp =>
  region === "jp"
    ? /^[0-9]{1,19}$/u
    : new RegExp(`^[${region === "tw" ? "2" : region === "en" ? "3" : "4"}][0-9]{10}$`, "u");

const isRegion = (value: string): value is GameRecordsRegion => REGIONS.includes(value as GameRecordsRegion);

const rankingUrl = (region: GameRecordsRegion, musicId: string): string =>
  `${RANKING_ORIGIN}/api/v1/${region}/music/${musicId}/ranking`;

const profileUrl = (region: GameRecordsRegion, profileId: string): string =>
  `${PROFILE_ORIGIN}/api/players/${region}/${profileId}`;

const authenticatedProfile = async (region: GameRecordsRegion, profileId: string, token: string) => {
  const headers = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "Mozilla/5.0",
  };
  const profile = await upstreamJson(`${MOENOTES_PROFILE_ORIGIN}/v1/${region}/profile/${profileId}`, headers);
  const playerId = textOrNull(asObject(asObject(profile.value).playerProfile).id);
  if (!playerId || playerId.length > 256) return profile;
  const favoritesUrl = new URL(`${MOENOTES_PROFILE_ORIGIN}/v1/${region}/profile/favorites`);
  favoritesUrl.searchParams.set("playerId", playerId);
  try {
    const favorites = await upstreamJson(favoritesUrl.href, headers);
    const value = asObject(favorites.value);
    if (
      favorites.value === null || typeof favorites.value !== "object" ||
      Array.isArray(favorites.value) || value.error
    )
      return profile;
    return {
      ...profile,
      value: { ...asObject(profile.value), favorites: { totalFavorite: value.totalFavorite ?? 0 } },
    };
  } catch {
    // Optional public favorites must not make an otherwise readable profile fail.
    return profile;
  }
};

const validCardFile = (file: string, profileId: string): boolean =>
  file.length > 0 && file.length <= 512 && file.startsWith(`${profileId}_`) &&
  /^[A-Za-z0-9_.-]+$/u.test(file) && !file.includes("..");

const cardImageBytes = async (response: Response, signal: AbortSignal): Promise<Uint8Array> => {
  const length = response.headers.get("Content-Length");
  if (length && /^[0-9]+$/u.test(length) && Number(length) > MAX_CARD_IMAGE_BYTES) {
    await response.body?.cancel();
    throw new RequestFailure(502, "upstream");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new RequestFailure(502, "upstream");
  const chunks: Uint8Array[] = [];
  let size = 0;
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_CARD_IMAGE_BYTES) {
        await reader.cancel();
        throw new RequestFailure(502, "upstream");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const signature = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
  const tail = [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];
  if (size < 45 || signature.some((byte, i) => bytes[i] !== byte) ||
    tail.some((byte, i) => bytes[size - tail.length + i] !== byte))
    throw new RequestFailure(502, "upstream");
  const view = new DataView(bytes.buffer);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 1 || height < 1 || width > 8192 || height > 8192)
    throw new RequestFailure(502, "upstream");
  return bytes;
};

const serveCardDownload = async (
  request: Request, env: GameRecordsBindings, region: GameRecordsRegion,
  profileId: string, page: string, file: string,
): Promise<Response> => {
  const token = env.MOENOTES_PROFILE_API_TOKEN?.trim();
  if (!token) return errorResponse(request, 502, "upstream");
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(CARD_DOWNLOAD_TIMEOUT_MS)]);
  let upstreamStatus: number | null = null;
  try {
    const upstream = await fetch(`${MOENOTES_PROFILE_ORIGIN}/v1/${region}/profile/${profileId}/card/${page}`, {
      method: "GET", redirect: "manual", signal,
      headers: { Accept: "image/png", Authorization: `Bearer ${token}`, "User-Agent": "Mozilla/5.0" },
    });
    upstreamStatus = upstream.status;
    if (upstream.status !== 200) {
      await upstream.body?.cancel();
      throw new RequestFailure(upstream.status === 404 ? 404 : 502, upstream.status === 404 ? "not_found" : "upstream");
    }
    const returnedFile = upstream.headers.get("X-Moenotes-Card-File");
    if (!returnedFile || returnedFile !== file) {
      await upstream.body?.cancel();
      throw new RequestFailure(returnedFile ? 409 : 502, returnedFile ? "stale_version" : "upstream");
    }
    if (upstream.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "image/png") {
      await upstream.body?.cancel();
      throw new RequestFailure(502, "upstream");
    }
    const bytes = await cardImageBytes(upstream, signal);
    return new Response(request.method === "HEAD" ? null : bytes, { headers: {
      ...CORS, "Content-Type": "image/png", "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `attachment; filename="profilecard-${region}-${profileId}-${page}.png"`,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    console.warn(JSON.stringify({ event: "moenotes-card-download", upstreamStatus, noToken: false }));
    if (signal.aborted) return errorResponse(request, 504, "timeout");
    if (error instanceof RequestFailure) return errorResponse(request, error.status, error.kind);
    return errorResponse(request, 502, "upstream");
  }
};

export async function handleGameRecordsApi(
  ctx: ExecutionContext,
  request: Request,
  url: URL,
  env: GameRecordsBindings = {},
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const download = new RegExp(`^${GAME_RECORDS_API_PREFIX}/([^/]+)/players/([^/]+)/cards/([^/]+)/download$`).exec(url.pathname);
  if (download) {
    const [_, region, profileId, page] = download;
    if (!region || !isRegion(region)) return errorResponse(request, 404, "not_found");
    const file = url.searchParams.get("file") || "";
    const pageNumber = safeInteger(page);
    if (!profileId || !rankingProfileIdPattern(region).test(profileId) || !decimalId(profileId) ||
      !page || !/^[1-9][0-9]{0,18}$/u.test(page) || pageNumber === null ||
      !validCardFile(file, profileId) || url.searchParams.getAll("file").length !== 1 ||
      [...url.searchParams.keys()].some((key) => key !== "file"))
      return errorResponse(request, 400, "invalid_request");
    return serveCardDownload(request, env, region, profileId, page, file);
  }
  const currentEvent = new RegExp(`^${GAME_RECORDS_API_PREFIX}/([^/]+)/events/current$`).exec(url.pathname);
  const challengeRanking = new RegExp(
    `^${GAME_RECORDS_API_PREFIX}/([^/]+)/events/([^/]+)/challenges/([^/]+)/ranking$`,
  ).exec(url.pathname);
  const pointRanking = new RegExp(`^${GAME_RECORDS_API_PREFIX}/([^/]+)/events/([^/]+)/latest$`).exec(url.pathname);
  const eventRoute = currentEvent || challengeRanking || pointRanking;
  if (eventRoute) {
    const region = eventRoute[1]!;
    if (!isRegion(region)) return errorResponse(request, 404, "not_found");
    if (currentEvent)
      return serveCached(request, ctx, async () => {
        try {
          const upstream = await upstreamJson(`${RANKING_ORIGIN}/api/v1/${region}/events/current`);
          return { body: JSON.stringify(normalizeTrackedEvent(upstream.value, region, upstream.response)) };
        } catch (error) {
          if (error instanceof RequestFailure && error.status === 404) {
            return {
              body: JSON.stringify({ region, event: null, fetchedAtMs: null, stale: false } satisfies EventTrackerDto),
            };
          }
          throw error;
        }
      });
    const eventId = decimalId(eventRoute[2]);
    const challengeId = challengeRanking ? decimalId(challengeRanking[3]) : null;
    if (!eventId || (challengeRanking && !challengeId)) return errorResponse(request, 400, "invalid_request");
    return serveCached(request, ctx, async () => {
      const path = challengeRanking ? `challenges/${challengeId}/ranking` : "latest";
      const upstream = await upstreamJson(`${RANKING_ORIGIN}/api/v1/${region}/events/${eventId}/${path}`);
      if (!challengeRanking)
        return { body: JSON.stringify(normalizeEventPoints(upstream.value, region, eventId, upstream.response)) };
      const { musicId: _musicId, ...ranking } = normalizeRanking(upstream.value, region, 0, upstream.response, true);
      return { body: JSON.stringify({ ...ranking, eventId, challengeId: challengeId! } satisfies EventRankingDto) };
    });
  }
  const ranking = new RegExp(`^${GAME_RECORDS_API_PREFIX}/([^/]+)/songs/([^/]+)/ranking$`).exec(url.pathname);
  const profile = new RegExp(`^${GAME_RECORDS_API_PREFIX}/([^/]+)/players/([^/]+)$`).exec(url.pathname);
  if (!ranking && !profile) return null;
  const rawRegion = ranking?.[1] ?? profile?.[1];
  if (!rawRegion || !isRegion(rawRegion)) return errorResponse(request, 404, "not_found");
  const region = rawRegion;
  if (ranking) {
    const musicIdText = ranking[2]!;
    const musicId = safeInteger(musicIdText);
    if (!/^[0-9]{1,19}$/u.test(musicIdText) || musicId === null || musicId < 1)
      return errorResponse(request, 400, "invalid_request");
    return serveCached(request, ctx, async () => {
      const upstream = await upstreamJson(rankingUrl(region, musicIdText));
      return { body: JSON.stringify(normalizeRanking(upstream.value, region, musicId, upstream.response)) };
    });
  }
  if (!profile) return null;
  const profileId = profile[2]!;
  if (!rankingProfileIdPattern(region).test(profileId)) return errorResponse(request, 400, "invalid_request");
  return serveCached(request, ctx, async () => {
    const token = env.MOENOTES_PROFILE_API_TOKEN?.trim();
    if (region === "jp" && !token) {
      console.warn(JSON.stringify({ event: "moenotes-profile-provider", upstreamStatus: null, noToken: true }));
      throw new RequestFailure(502, "upstream");
    }
    let upstream: Awaited<ReturnType<typeof upstreamJson>>;
    if (region === "jp") {
      upstream = await authenticatedProfile(region, profileId, token!);
    } else {
      try {
        upstream = await upstreamJson(profileUrl(region, profileId));
      } catch (error) {
        if (
          !(error instanceof RequestFailure) ||
          error.kind !== "not_found" ||
          ![401, 403, 404].includes(error.status) ||
          !token
        )
          throw error;
        upstream = await authenticatedProfile(region, profileId, token);
      }
    }
    return { body: JSON.stringify(normalizeProfile(upstream.value, region, profileId, upstream.response)) };
  });
}
