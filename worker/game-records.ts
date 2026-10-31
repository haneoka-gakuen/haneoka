// L3 — GEB
// Input: Region, event, player and card requests, with saved event history and player records.
// Output: Archived event boards and profile card downloads from our own stored data.
// Pos: [Map](L2.md); records that outlive the live official boards.
// Effects/Dependencies: Reads D1 and R2; fetches public card images from the game's regional CDN.
import { latestEventHistory, readEventHistory } from "./game-event-history";
import { readOfficialCardImage, readOfficialPlayer, type OfficialRankingStoreBindings } from "./official-ranking-store";
import type { GameRecordsRegion } from "../src/lib/game-records";

const GAME_RECORDS_API_PREFIX = "/api/v1/game/records";
const REGIONS = ["jp", "tw", "en", "kr"] as const;
const CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";
const MAX_CARD_IMAGE_BYTES = 8 * 1024 * 1024;
const CARD_DOWNLOAD_TIMEOUT_MS = 12_000;

export interface GameRecordsBindings extends OfficialRankingStoreBindings {
  DB?: D1Database;
}
type FailureKind = "invalid_request" | "not_found" | "pending" | "timeout" | "upstream";

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

const safeInteger = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const decimalId = (value: unknown): string | null => {
  const id = typeof value === "string" ? value : Number.isSafeInteger(value) ? String(value) : "";
  return /^[1-9][0-9]{0,18}$/u.test(id) ? id : null;
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
    headers: {
      ...CORS,
      "Cache-Control": CACHE_CONTROL,
      "Content-Type": "application/json; charset=utf-8",
    },
  });

const rankingProfileIdPattern = (region: GameRecordsRegion): RegExp =>
  region === "jp"
    ? /^[0-9]{1,19}$/u
    : new RegExp(`^[${region === "tw" ? "2" : region === "en" ? "3" : "4"}][0-9]{10}$`, "u");

const isRegion = (value: string): value is GameRecordsRegion => REGIONS.includes(value as GameRecordsRegion);

const validCardFile = (file: string, profileId: string): boolean =>
  file.length > 0 &&
  file.length <= 512 &&
  file.startsWith(`${profileId}_`) &&
  /^[A-Za-z0-9_.-]+$/u.test(file) &&
  !file.includes("..");

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
  if (
    size < 45 ||
    signature.some((byte, i) => bytes[i] !== byte) ||
    tail.some((byte, i) => bytes[size - tail.length + i] !== byte)
  )
    throw new RequestFailure(502, "upstream");
  const view = new DataView(bytes.buffer);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 1 || height < 1 || width > 8192 || height > 8192) throw new RequestFailure(502, "upstream");
  return bytes;
};

const cardDownload = (request: Request, region: GameRecordsRegion, profileId: string, page: string, bytes: Uint8Array) =>
  new Response(request.method === "HEAD" ? null : bytes, {
    headers: {
      ...CORS,
      "Content-Type": "image/png",
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `attachment; filename="profilecard-${region}-${profileId}-${page}.png"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

const serveCardDownload = async (
  request: Request,
  env: GameRecordsBindings,
  region: GameRecordsRegion,
  profileId: string,
  page: string,
  file: string,
): Promise<Response> => {
  if (region === "jp") {
    const stored = await readOfficialCardImage(env, region, file).catch(() => null);
    if (!stored) return errorResponse(request, 404, "not_found");
    return cardDownload(request, region, profileId, page, new Uint8Array(await stored.arrayBuffer()));
  }
  const record = await readOfficialPlayer(env, region, profileId).catch(() => null);
  const urls = (record?.profile?.profile_card as { thumbnail_url?: unknown } | undefined)?.thumbnail_url;
  const source = Array.isArray(urls) ? urls[Number(page) - 1] : null;
  if (typeof source !== "string" || !source.startsWith("https://")) return errorResponse(request, 404, "not_found");
  if (new URL(source).pathname.split("/").pop() !== file) return errorResponse(request, 409, "stale_version");
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(CARD_DOWNLOAD_TIMEOUT_MS)]);
  try {
    const upstream = await fetch(source, { redirect: "manual", signal });
    if (upstream.status !== 200) {
      await upstream.body?.cancel();
      throw new RequestFailure(upstream.status === 404 ? 404 : 502, upstream.status === 404 ? "not_found" : "upstream");
    }
    return cardDownload(request, region, profileId, page, await cardImageBytes(upstream, signal));
  } catch (error) {
    if (signal.aborted) return errorResponse(request, 504, "timeout");
    if (error instanceof RequestFailure) return errorResponse(request, error.status, error.kind);
    return errorResponse(request, 502, "upstream");
  }
};

export async function handleGameRecordsApi(request: Request, url: URL, env: GameRecordsBindings = {}): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const history = new RegExp(
    `^${GAME_RECORDS_API_PREFIX}/([^/]+)/events/([^/]+)/(?:challenges/([^/]+)/)?history$`,
  ).exec(url.pathname);
  if (history) {
    const region = history[1]!,
      eventId = decimalId(history[2]),
      challengeId = history[3] ? decimalId(history[3]) : "";
    if (!isRegion(region)) return errorResponse(request, 404, "not_found");
    const snapshot = url.searchParams.get("snapshot") || undefined,
      before = url.searchParams.get("before") || undefined;
    if (
      !eventId ||
      challengeId === null ||
      (snapshot && !/^[a-f0-9]{64}$/u.test(snapshot)) ||
      (before && !/^[a-f0-9]{64}$/u.test(before)) ||
      (snapshot && before) ||
      [...url.searchParams.keys()].some((key) => key !== "snapshot" && key !== "before")
    )
      return errorResponse(request, 400, "invalid_request");
    if (!env.DB) return errorResponse(request, 503, "pending");
    try {
      const result = await readEventHistory(env, region, eventId, challengeId, snapshot, before);
      return result === null ? errorResponse(request, 404, "not_found") : jsonResponse(request, JSON.stringify(result));
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "event-history-read",
          region,
          eventId,
          error: error instanceof Error ? error.name : "unknown",
        }),
      );
      return errorResponse(request, 503, "upstream");
    }
  }
  const download = new RegExp(`^${GAME_RECORDS_API_PREFIX}/([^/]+)/players/([^/]+)/cards/([^/]+)/download$`).exec(
    url.pathname,
  );
  if (download) {
    const [_, region, profileId, page] = download;
    if (!region || !isRegion(region)) return errorResponse(request, 404, "not_found");
    const file = url.searchParams.get("file") || "";
    const pageNumber = safeInteger(page);
    if (
      !profileId ||
      !rankingProfileIdPattern(region).test(profileId) ||
      !decimalId(profileId) ||
      !page ||
      !/^[1-9][0-9]{0,18}$/u.test(page) ||
      pageNumber === null ||
      !validCardFile(file, profileId) ||
      url.searchParams.getAll("file").length !== 1 ||
      [...url.searchParams.keys()].some((key) => key !== "file")
    )
      return errorResponse(request, 400, "invalid_request");
    return serveCardDownload(request, env, region, profileId, page, file);
  }
  const points = new RegExp(`^${GAME_RECORDS_API_PREFIX}/([^/]+)/events/([^/]+)/latest$`).exec(url.pathname);
  if (points) {
    const region = points[1]!;
    const eventId = decimalId(points[2]);
    if (!isRegion(region)) return errorResponse(request, 404, "not_found");
    if (!eventId) return errorResponse(request, 400, "invalid_request");
    if (!env.DB) return errorResponse(request, 503, "pending");
    const saved = await latestEventHistory(env, region, eventId, "").catch(() => null);
    return saved ? jsonResponse(request, JSON.stringify(saved)) : errorResponse(request, 404, "not_found");
  }
  return null;
}
