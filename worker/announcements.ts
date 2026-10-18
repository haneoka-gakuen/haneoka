import { normalizeAuthorLocale } from "@haneoka/i18n";
import { negotiateRequestLocale } from "../src/i18n/negotiation";
import { selectAnnouncementLocale } from "../src/lib/announcements";

const CORS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-Range, If-None-Match, Content-Type",
  "Access-Control-Expose-Headers": "Content-Length, ETag, X-Haneoka-Announcement-Fetched-At",
};

const SERVER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  avif: "image/avif",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export interface AnnouncementResourceServer {
  resourcePrefix: string;
  slug: string;
}

export type AnnouncementServerResolver = (slug: string) => Promise<AnnouncementResourceServer | null>;

function errorResponse(request: Request, status: number, code: string, message: string): Response {
  const requestId = request.headers.get("cf-ray") || crypto.randomUUID();
  return new Response(request.method === "HEAD" ? null : JSON.stringify({ error: { code, message, requestId } }), {
    status,
    headers: {
      ...CORS,
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Request-Id": requestId,
    },
  });
}

function jsonResponse(request: Request, value: JsonValue, fetchedAt: string | null): Response {
  const headers = new Headers({
    ...CORS,
    "Cache-Control": "public, max-age=60, must-revalidate",
    "Content-Type": "application/json; charset=utf-8",
  });
  if (!new URL(request.url).searchParams.has("locale")) headers.set("Vary", "Accept-Language, Cookie");
  if (fetchedAt) headers.set("X-Haneoka-Announcement-Fetched-At", fetchedAt);
  return new Response(request.method === "HEAD" ? null : JSON.stringify(value), { status: 200, headers });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function canonicalMediaUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "haneoka.org" || url.search || url.hash) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function publicRecord(value: unknown, full: boolean): JsonObject | null {
  if (!isObject(value)) return null;
  const id = readInteger(value.id);
  const category = readInteger(value.category);
  const title = readString(value.title);
  const startAt = readInteger(value.startAt);
  const endAt = readInteger(value.endAt);
  const updatedAt = readInteger(value.updatedAt);
  if (
    id === null ||
    id < 1 ||
    category === null ||
    !title ||
    startAt === null ||
    endAt === null ||
    updatedAt === null
  ) {
    return null;
  }
  const record: JsonObject = { id, category, title, startAt, endAt, updatedAt };
  if (value.pinned === true) record.pinned = true;
  for (const field of ["bodyImage", "banner"] as const) {
    const url = canonicalMediaUrl(value[field]);
    if (url) {
      record[field] = url;
      for (const dimension of ["Width", "Height"] as const) {
        const size = readInteger(value[field + dimension]);
        if (size && size > 0) record[field + dimension] = size;
      }
    }
  }
  const sourceLanguage = readString(value.sourceLanguage);
  if (sourceLanguage) record.sourceLanguage = sourceLanguage;
  if (value.sourceRegion !== undefined || value.sourceId !== undefined) {
    const sourceRegion = readString(value.sourceRegion);
    const sourceId = readInteger(value.sourceId);
    if (
      !sourceRegion ||
      !/^[a-z0-9-]{1,32}$/u.test(sourceRegion) ||
      sourceId === null ||
      sourceId < 1
    ) {
      return null;
    }
    record.sourceRegion = sourceRegion;
    record.sourceId = sourceId;
  }
  if (full) {
    const html = readString(value.html);
    if (html) record.html = html;
  }
  return record;
}

interface AnnouncementSnapshot {
  available: boolean;
  fetchedAt: string | null;
  records: JsonObject[];
}

async function readJson(env: Env, key: string): Promise<unknown | null> {
  const object = await env.ASSET_BUCKET.get(key);
  if (!object?.body) return null;
  return JSON.parse(await new Response(object.body).text()) as unknown;
}

function parseSnapshot(value: unknown, server: string): AnnouncementSnapshot {
  if (!isObject(value) || value.server !== server || typeof value.available !== "boolean") {
    throw new Error("invalid announcement snapshot identity");
  }
  const fetchedAt = value.fetchedAt === null ? null : readString(value.fetchedAt);
  if (value.fetchedAt !== null && fetchedAt === null) throw new Error("invalid announcement snapshot timestamp");
  if (!Array.isArray(value.announcements)) {
    throw new Error("invalid announcement snapshot records");
  }
  const records = value.announcements.map((record) => publicRecord(record, true));
  if (records.some((record): record is null => record === null)) throw new Error("invalid announcement record");
  return { available: value.available, fetchedAt, records: records as JsonObject[] };
}

async function snapshot(env: Env, server: AnnouncementResourceServer): Promise<AnnouncementSnapshot | null> {
  const value = await readJson(env, `${server.resourcePrefix}/operation/announcements.json`);
  return value === null ? null : parseSnapshot(value, server.slug);
}

function selectedServer(request: Request): string | Response {
  const url = new URL(request.url);
  const values = url.searchParams.getAll("server");
  if (values.length > 1) return errorResponse(request, 400, "invalid_server", "Server must be specified once");
  const server = values[0] || "intl";
  if (!SERVER_PATTERN.test(server)) return errorResponse(request, 404, "server_not_found", "Server not found");
  return server;
}

function listLimit(request: Request): number | undefined | Response {
  const value = new URL(request.url).searchParams.get("limit");
  if (value === null || value === "") return undefined;
  if (!/^\d+$/u.test(value))
    return errorResponse(request, 400, "invalid_limit", "Limit must be an integer from 1 to 100");
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= 100
    ? limit
    : errorResponse(request, 400, "invalid_limit", "Limit must be an integer from 1 to 100");
}

async function serveMedia(request: Request, env: Env, key: string, extensionName: string): Promise<Response> {
  const contentType = MEDIA_TYPES[extensionName];
  if (request.method === "HEAD") {
    const object = await env.ASSET_BUCKET.head(key);
    if (!object) return errorResponse(request, 404, "media_not_found", "Announcement media not found");
    const headers = new Headers(CORS);
    object.writeHttpMetadata(headers);
    headers.set("Content-Type", contentType || "application/octet-stream");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    headers.set("ETag", object.httpEtag);
    headers.set("Content-Length", String(object.size));
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(null, { status: 200, headers });
  }
  const object = await env.ASSET_BUCKET.get(key);
  if (!object) return errorResponse(request, 404, "media_not_found", "Announcement media not found");
  const headers = new Headers(CORS);
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", contentType || "application/octet-stream");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("ETag", object.httpEtag);
  headers.set("Content-Length", String(object.size));
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}

export async function handleAnnouncementsRequest(
  request: Request,
  env: Env,
  resolveServer: AnnouncementServerResolver,
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  const listMatch = url.pathname === "/api/v1/announcements";
  const detailMatch = /^\/api\/v1\/announcements\/(\d+)$/u.exec(url.pathname);
  const mediaMatch = /^\/api\/v1\/announcements\/media\/([^/]+)\/([a-f0-9]{64})\.(avif|gif|jpe?g|png|webp)$/u.exec(
    url.pathname,
  );
  if (!listMatch && !detailMatch && !mediaMatch) return null;

  if (mediaMatch) {
    const rawServer = mediaMatch[1] || "";
    const digest = mediaMatch[2] || "";
    const extensionName = mediaMatch[3] || "";
    if (!SERVER_PATTERN.test(rawServer) || !HASH_PATTERN.test(digest)) {
      return errorResponse(request, 404, "media_not_found", "Announcement media not found");
    }
    const server = await resolveServer(rawServer);
    if (!server) return errorResponse(request, 404, "server_not_found", "Server not found");
    return serveMedia(
      request,
      env,
      `${server.resourcePrefix}/operation/announcements/media/${digest}.${extensionName}`,
      extensionName,
    );
  }

  const serverValue = selectedServer(request);
  if (serverValue instanceof Response) return serverValue;
  const server = await resolveServer(serverValue);
  if (!server) return errorResponse(request, 404, "server_not_found", "Server not found");
  const localeValues = url.searchParams.getAll("locale");
  const requestedLocale = localeValues.length ? normalizeAuthorLocale(localeValues[0] || "")
    : negotiateRequestLocale(request.headers.get("cookie") || "", request.headers.get("accept-language") || "");
  if (localeValues.length > 1 || !requestedLocale)
    return errorResponse(request, 400, "invalid_locale", "Locale must be one valid language tag");
  const current = await snapshot(env, server);
  const selection = selectAnnouncementLocale(current?.records || [], requestedLocale);

  if (listMatch) {
    const limit = listLimit(request);
    if (limit instanceof Response) return limit;
    const full = url.searchParams.get("include") === "body";
    const records = selection.entries.slice(0, limit).map((record) => publicRecord(record, full));
    if (records?.some((record): record is null => record === null)) {
      throw new Error("invalid announcement summary");
    }
    return jsonResponse(
      request,
      {
        server: server.slug,
        available: current?.available === true,
        fetchedAt: current?.fetchedAt ?? null,
        requestedLocale,
        actualSourceLocale: selection.actualSourceLocale,
        availableSourceLocales: selection.availableSourceLocales,
        ...(full ? { includesBody: true } : {}),
        announcements: (records || []).map((record) => ({ ...record, actualSourceLocale: selection.actualSourceLocale })) as JsonObject[],
      },
      current?.fetchedAt ?? null,
    );
  }

  const announcementId = Number(detailMatch?.[1] || "0");
  const record = selection.entries.find((value) => value.id === announcementId);
  if (!record) return errorResponse(request, 404, "announcement_not_found", "Announcement not found");
  return jsonResponse(
    request,
    {
      server: server.slug,
      available: current?.available === true,
      fetchedAt: current?.fetchedAt ?? null,
      ...publicRecord(record, true),
      requestedLocale,
      actualSourceLocale: selection.actualSourceLocale,
    },
    current?.fetchedAt ?? null,
  );
}
