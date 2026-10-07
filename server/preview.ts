import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import os, { type NetworkInterfaceInfo } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { SonolusLevelService } from "@haneoka/sonolus-core";
import {
  OUR_NOTES_LANE_SKIN_NAMES,
  OUR_NOTES_NOTE_EFFECT_SKIN_NAMES,
  OUR_NOTES_NOTE_SE_GROUP_NAMES,
  OUR_NOTES_NOTE_SKIN_NAMES,
  OUR_NOTES_STAGE_NAMES,
} from "@haneoka/cassiopeia-plugin-our-notes";
import {
  createOurNotesSonolusItemLabels,
  localizeSonolusDocument as localizeSonolusItemLabels,
  parseReleaseChartDataId,
  ReleaseChartCatalogProvider,
  ReleaseLevelTemplateProvider,
  RuntimeChartDataProvider,
} from "@haneoka/sonolus";
import { localReleaseFile, releaseWorkspace, type ReleaseWorkspace } from "./releaseWorkspace.ts";
import { sonolusShareRedirectTarget } from "../worker/sonolus-share.ts";
import { announcementDocumentRequest, rewriteAnnouncementDocument } from "../src/lib/announcement-document.ts";
import { eventArtworkIndex } from "../src/lib/event-artwork-index.ts";
import {
  isReleaseServer,
  legacyEntityRedirectTarget,
  legacyCollectionRedirectTarget,
  legacyHomeRedirectTarget,
  parseResourceRoute,
  resourcePath,
  storyCollectionPath,
  type ResourceKind,
  type ResourceRoute,
} from "../src/lib/resource-route.ts";

const OUR_NOTES_SONOLUS_ITEM_LABELS = createOurNotesSonolusItemLabels({
  noteSkins: OUR_NOTES_NOTE_SKIN_NAMES,
  laneSkins: OUR_NOTES_LANE_SKIN_NAMES,
  noteEffectSkins: OUR_NOTES_NOTE_EFFECT_SKIN_NAMES,
  stages: OUR_NOTES_STAGE_NAMES,
  noteSeGroups: OUR_NOTES_NOTE_SE_GROUP_NAMES,
});

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

interface JsonObject {
  readonly [key: string]: JsonValue;
}

interface WorkspaceSelection {
  workspace: Readonly<ReleaseWorkspace>;
  readonly pointerFile: string;
  pointerModifiedAt: number;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, ".output", "public");
const BESTDORI_RAW_MIRROR_ROOT = process.env.BESTDORI_RAW_MIRROR_ROOT
  ? path.resolve(process.env.BESTDORI_RAW_MIRROR_ROOT)
  : undefined;
if (BESTDORI_RAW_MIRROR_ROOT && !fs.statSync(BESTDORI_RAW_MIRROR_ROOT, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error(`BESTDORI_RAW_MIRROR_ROOT is not a directory: ${BESTDORI_RAW_MIRROR_ROOT}`);
}
const BESTDORI_PROVIDER_ORIGIN = configuredHttpOrigin("BESTDORI_PROVIDER_ORIGIN");
// CLOUD_DATA_ORIGIN (e.g. https://haneoka.org) lets a local preview read the
// deployed data: Application Worker routes go there unless a local Worker is
// configured, and release data for servers without a local workspace is
// proxied instead of answering 404.
const CLOUD_DATA_ORIGIN = configuredHttpOrigin("CLOUD_DATA_ORIGIN");
const APPLICATION_WORKER_ORIGIN = configuredHttpOrigin("APPLICATION_WORKER_ORIGIN") ?? CLOUD_DATA_ORIGIN;
const APPLICATION_WORKER_BROWSER_ORIGIN =
  configuredHttpOrigin("APPLICATION_WORKER_BROWSER_ORIGIN") ??
  (configuredHttpOrigin("APPLICATION_WORKER_ORIGIN") ? undefined : CLOUD_DATA_ORIGIN);
const RELEASE_SERVERS = (process.env.RELEASE_SERVERS ?? "intl,jp-cbt,intl-cbt")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const workspaceSelectionsAreFixed = Boolean(process.env.RESOURCE_BUILD_ROOT || process.env.RESOURCE_RELEASE_ROOT);
const WORKSPACES = new Map<string, WorkspaceSelection>(
  RELEASE_SERVERS.map((server): [string, WorkspaceSelection] => {
    const workspace = releaseWorkspace(server, ROOT);
    const pointerFile = path.join(workspace.serverRoot, "current.json");
    const pointerModifiedAt = fs.existsSync(pointerFile) ? fs.statSync(pointerFile).mtimeMs : 0;
    return [server, { workspace, pointerFile, pointerModifiedAt }];
  }),
);
const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = parsePort(process.env.PORT);
const sonolusLevelService = new SonolusLevelService(3);
const allowedMethods: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
const catalogRouteKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,255}$/u;
const releaseIdPattern = /^r-[a-f0-9]{20}$/u;
const releaseSourceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const latestCatalogReservedSegments = new Set([
  "game",
  "account",
  "admin",
  "auth",
  "catalog",
  "community",
  "garupa",
  "me",
  "release",
  "releases",
  "servers",
  "sources",
  "ui-marks",
]);
const releaseIdentitySchema = "haneoka-resource-release-identity-v1";
const releaseIdentityFilename = "release-identity.json";
const releaseIdentityKeys = ["releaseId", "schema", "server", "sourceId"] as const;
const BESTDORI_PROVIDER_API_PREFIX = "/api/v1/garupa/bestdori";
const BESTDORI_SONOLUS_LEVEL_PREFIX = "/sonolus/levels/bestdori-level-";
const BESTDORI_SONOLUS_PLAYLIST_PREFIX = "/sonolus/playlists/bestdori-playlist-";
// The raw mirror is a private upstream transport for the Worker. Keeping it
// below a provider-internal prefix means `/assets/jp/...` always remains an
// Our Notes release URL, including when a future Our Notes server is named jp.
const BESTDORI_RAW_MIRROR_PREFIX = "/_internal/providers/garupa/bestdori/raw";
const bestdoriRawPathPattern = /^\/(?:api(?:\/|$)|assets\/(?:jp|en|tw|cn|kr)(?:\/|$)|res(?:\/|$))/u;
const proxyExcludedHeaders = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const mime: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".glb": "model/gltf-binary",
  ".ktx2": "image/ktx2",
  ".txt": "text/plain; charset=utf-8",
  ".bytes": "application/octet-stream",
};

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid preview port: ${value ?? ""}`);
  }
  return port;
}

function configuredHttpOrigin(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) origin`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an HTTP(S) origin without credentials, a path, query, or fragment`);
  }
  return url.origin;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value) && Object.values(value).every(isJsonValue);
}

function readJsonFile(file: string): JsonValue {
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isJsonValue(value)) throw new Error(`Invalid JSON document: ${file}`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function json(
  res: ServerResponse,
  status: number,
  value: JsonValue,
  cache = "no-cache",
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": cache,
    ...extraHeaders,
  });
  res.end(res.req?.method === "HEAD" ? undefined : body);
}

function isBestdoriProviderApiRequest(url: URL): boolean {
  return url.pathname === BESTDORI_PROVIDER_API_PREFIX || url.pathname.startsWith(`${BESTDORI_PROVIDER_API_PREFIX}/`);
}

function isBestdoriSonolusRequest(url: URL): boolean {
  return (
    url.searchParams.get("type") === "bestdori" ||
    url.searchParams.get("source") === "bestdori" ||
    url.pathname.startsWith(BESTDORI_SONOLUS_LEVEL_PREFIX) ||
    url.pathname.startsWith(BESTDORI_SONOLUS_PLAYLIST_PREFIX)
  );
}

function isBestdoriRawMirrorRequest(pathname: string): boolean {
  return pathname === BESTDORI_RAW_MIRROR_PREFIX || pathname.startsWith(`${BESTDORI_RAW_MIRROR_PREFIX}/`);
}

function bestdoriRawMirrorPath(pathname: string): string | null {
  if (!pathname.startsWith(`${BESTDORI_RAW_MIRROR_PREFIX}/`)) return null;
  const rawPath = `/${pathname.slice(BESTDORI_RAW_MIRROR_PREFIX.length + 1)}`;
  return bestdoriRawPathPattern.test(rawPath) ? rawPath : null;
}

function bestdoriProviderUnavailable(req: IncomingMessage, res: ServerResponse, sonolus: boolean): void {
  const message =
    "Bestdori provider is not configured; set BESTDORI_PROVIDER_ORIGIN to a Worker/provider HTTP(S) origin";
  if (sonolus) {
    sonolusJson(req, res, 503, { message }, "no-store");
    return;
  }
  json(res, 503, { error: { code: "bestdori_provider_unavailable", message } }, "no-store");
}

function bestdoriProviderUnreachable(
  req: IncomingMessage,
  res: ServerResponse,
  sonolus: boolean,
  error: unknown,
): void {
  const message = `Bestdori provider is unavailable: ${errorMessage(error)}`;
  if (sonolus) {
    sonolusJson(req, res, 503, { message }, "no-store");
    return;
  }
  json(res, 503, { error: { code: "bestdori_provider_unreachable", message } }, "no-store");
}

function forwardedProviderHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ["accept", "if-none-match", "if-range", "range"] as const) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  return headers;
}

function isApplicationWorkerRequest(pathname: string): boolean {
  return [
    "/api/auth",
    "/api/v1/account",
    "/api/v1/admin",
    "/api/v1/announcements",
    "/api/v1/community",
    "/api/v1/garupa",
    "/api/v1/home",
    "/api/v1/game/records",
    "/api/v1/releases",
  ].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function forwardedApplicationHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const name of [
    "accept",
    "accept-language",
    "authorization",
    "cache-control",
    "content-type",
    "cookie",
    "if-match",
    "if-none-match",
    "if-unmodified-since",
    "idempotency-key",
    "origin",
    "referer",
    "user-agent",
    "x-captcha-response",
    "x-file-name",
    "x-reason-code",
  ] as const) {
    const value = req.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  if (APPLICATION_WORKER_BROWSER_ORIGIN) {
    const browserOrigin = new URL(APPLICATION_WORKER_BROWSER_ORIGIN);
    headers.set("host", browserOrigin.host);
    headers.set("x-forwarded-host", browserOrigin.host);
    headers.set("x-forwarded-proto", browserOrigin.protocol.slice(0, -1));
    if (headers.has("origin")) headers.set("origin", APPLICATION_WORKER_BROWSER_ORIGIN);
    const referer = headers.get("referer");
    if (referer) {
      const source = new URL(referer);
      headers.set(
        "referer",
        new URL(`${source.pathname}${source.search}${source.hash}`, APPLICATION_WORKER_BROWSER_ORIGIN).toString(),
      );
    }
  }
  return headers;
}

async function requestBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function isCloudDataRequest(pathname: string): boolean {
  if (!CLOUD_DATA_ORIGIN) return false;
  if (pathname.startsWith("/api/v1/team-builder/") && !WORKSPACES.size) return true;
  const match = /^\/(?:api\/v1\/servers|assets|runtime|objects)\/([^/]+)\//u.exec(pathname);
  return Boolean(match && !WORKSPACES.has(decodeURIComponent(match[1]!)));
}

async function proxyApplicationWorker(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  origin = APPLICATION_WORKER_ORIGIN,
): Promise<void> {
  if (!origin) {
    json(res, 503, {
      error: {
        code: "application_worker_unavailable",
        message: "Application Worker is not configured; set APPLICATION_WORKER_ORIGIN",
      },
    });
    return;
  }
  const target = new URL(`${url.pathname}${url.search}`, origin);
  const body = await requestBody(req);
  const headers = Object.fromEntries(forwardedApplicationHeaders(req));
  if (body !== undefined) headers["content-length"] = String(body.byteLength);
  await new Promise<void>((resolve) => {
    const transport = target.protocol === "https:" ? https : http;
    const upstream = transport.request(target, { method: req.method ?? "GET", headers }, (response) => {
      const responseHeaders: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined && !proxyExcludedHeaders.has(name.toLowerCase())) responseHeaders[name] = value;
      }
      res.writeHead(response.statusCode ?? 502, responseHeaders);
      response.once("error", (error) => res.destroy(error));
      response.once("end", resolve);
      response.pipe(res);
    });
    upstream.once("error", (error) => {
      if (!res.headersSent)
        json(res, 502, {
          error: {
            code: "application_worker_unreachable",
            message: `Application Worker is unavailable: ${errorMessage(error)}`,
          },
        });
      else res.destroy(error);
      resolve();
    });
    if (body) upstream.write(body);
    upstream.end();
  });
}

function proxiedResponseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers) {
    if (!proxyExcludedHeaders.has(name.toLowerCase())) headers[name] = value;
  }
  return headers;
}

async function sendBestdoriProviderResponse(
  req: IncomingMessage,
  res: ServerResponse,
  response: Response,
  localSonolusOrigin: string | undefined,
): Promise<void> {
  const headers = proxiedResponseHeaders(response);
  const contentType = response.headers.get("content-type") ?? "";
  if (localSonolusOrigin && req.method !== "HEAD" && contentType.includes("application/json")) {
    const body = await response.text();
    let localized = body;
    try {
      const document: unknown = JSON.parse(body);
      if (isJsonValue(document)) localized = JSON.stringify(localizeSonolusDocument(document, localSonolusOrigin));
    } catch {
      // Preserve a provider's non-JSON error body verbatim rather than turning
      // a transport proxy into an additional parser boundary.
    }
    headers["Content-Length"] = String(Buffer.byteLength(localized));
    res.writeHead(response.status, headers);
    res.end(localized);
    return;
  }

  res.writeHead(response.status, headers);
  if (req.method === "HEAD" || !response.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(response.body);
  body.once("error", (error) => res.destroy(error));
  body.pipe(res);
}

async function proxyBestdoriProvider(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  localSonolusOrigin: string | undefined,
): Promise<void> {
  const sonolus = localSonolusOrigin !== undefined;
  if (!BESTDORI_PROVIDER_ORIGIN) {
    bestdoriProviderUnavailable(req, res, sonolus);
    return;
  }
  const target = new URL(`${url.pathname}${url.search}`, BESTDORI_PROVIDER_ORIGIN);
  let response: Response;
  try {
    response = await fetch(target, {
      headers: forwardedProviderHeaders(req),
      method: req.method === "HEAD" ? "HEAD" : "GET",
      redirect: "manual",
    });
  } catch (error) {
    bestdoriProviderUnreachable(req, res, sonolus, error);
    return;
  }
  await sendBestdoriProviderResponse(req, res, response, localSonolusOrigin);
}

function decodePathPart(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function decodePath(value: string): string[] | null {
  const parts: string[] = [];
  for (const encodedPart of value.split("/")) {
    const part = decodePathPart(encodedPart);
    if (part === null) return null;
    parts.push(part);
  }
  return parts;
}

function safeFile(root: string, relative: string): string | null {
  const parts = decodePath(relative.split("/").filter(Boolean).join("/"));
  if (!parts) return null;
  const file = path.resolve(root, ...parts);
  return file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  cache = "public, max-age=300",
  extraHeaders: Readonly<Record<string, string>> = {},
  status = 200,
): void {
  const stat = fs.statSync(file);
  const range = (req.headers.range ?? "").match(/^bytes=(\d*)-(\d*)$/);
  if (range) {
    const requestedStart = range[1] ? Number(range[1]) : undefined;
    const requestedEnd = range[2] ? Number(range[2]) : undefined;
    const suffix = requestedStart === undefined;
    const start = suffix ? Math.max(0, stat.size - Number(requestedEnd ?? 0)) : requestedStart;
    const end = suffix ? stat.size - 1 : Math.min(stat.size - 1, requestedEnd ?? stat.size - 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Cache-Control": cache, ...extraHeaders });
      res.end();
      return;
    }
    res.writeHead(206, {
      "Content-Type": mime[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": cache,
      ...extraHeaders,
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }

  res.writeHead(status, {
    "Content-Type": mime[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
    "Cache-Control": cache,
    ...extraHeaders,
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
}

function ownJsonValue(document: JsonObject | null, key: string): JsonValue | undefined {
  return document && Object.prototype.hasOwnProperty.call(document, key) ? document[key] : undefined;
}

function fnv1a32Shard(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % 256).toString(16).padStart(2, "0");
}

function catalogStorageManifest(workspace: Readonly<ReleaseWorkspace>): JsonObject {
  const file = path.join(workspace.apiRoot, "manifest.json");
  if (!fs.existsSync(file)) throw new Error(`Catalog storage manifest is missing: ${file}`);
  const manifest = readJsonFile(file);
  if (
    !isJsonObject(manifest) ||
    manifest.schema !== "haneoka-catalog-storage-v2" ||
    manifest.server !== workspace.id ||
    !isJsonObject(manifest.resources)
  ) {
    throw new Error(`Invalid catalog storage manifest: ${file}`);
  }
  return manifest;
}

const DOCUMENT_RESOURCE_NAMES: Readonly<Partial<Record<ResourceKind, string>>> = {
  characters: "characters",
  songs: "songs",
  "member-cards": "cards",
  "support-cards": "support-cards",
  comics: "comics",
  stamps: "stamps",
  stickers: "stickers",
  backgrounds: "backgrounds",
  "band-items": "band-items",
  items: "items",
  events: "events",
  "real-lives": "real-lives",
  gacha: "gacha",
  "login-campaigns": "login-campaigns",
  shop: "shop",
  exchange: "exchange",
  circle: "circle",
  challenge: "challenge",
  passes: "passes",
  stories: "stories",
  missions: "missions",
  "tgw-card": "tgw-card",
  live2d: "live2d",
  spine: "spine",
  help: "help",
};

type StoryMode = "band" | "link" | "home" | "afterlive" | "tutorial";
const STORY_MODES: ReadonlySet<string> = new Set(["band", "link", "home", "afterlive", "tutorial"]);

function storyModeForEntity(entity: JsonObject): StoryMode | undefined {
  if (Number(entity.chapterId || 0) < 900_000) return "band";
  switch (entity.chapterKey) {
    case "asset_linkstory":
      return "link";
    case "asset_home":
      return "home";
    case "asset_afterlive":
      return "afterlive";
    case "asset_tutorial":
      return "tutorial";
    default:
      return undefined;
  }
}

interface DocumentEntityAvailability {
  entity: JsonObject;
  storyMode?: StoryMode;
}

function documentEntityAvailability(route: ResourceRoute & { id: string }): DocumentEntityAvailability | null {
  const resourceName = DOCUMENT_RESOURCE_NAMES[route.kind];
  if (!resourceName || !isReleaseServer(route.server)) return null;
  const workspace = selectedWorkspace(route.server);
  if (!workspace) return null;
  const resources = catalogStorageManifest(workspace).resources;
  if (!isJsonObject(resources)) return null;
  const resource = ownJsonValue(resources, resourceName);
  if (!isJsonObject(resource)) return null;
  const entity = ownJsonValue(catalogShardDocument(workspace, resource.entities, route.id), route.id);
  if (!isJsonObject(entity)) return null;
  const availability: DocumentEntityAvailability = { entity };
  if (route.kind === "stories") {
    const storyMode = storyModeForEntity(entity);
    if (storyMode) availability.storyMode = storyMode;
  }
  return availability;
}

function catalogStorageFile(workspace: Readonly<ReleaseWorkspace>, releasePath: JsonValue | undefined): string | null {
  const prefix = "api/v1/catalog/";
  if (typeof releasePath !== "string" || !releasePath.startsWith(prefix) || !releasePath.endsWith(".json")) {
    return null;
  }
  return safeFile(workspace.apiRoot, releasePath.slice(prefix.length));
}

function catalogShardDocument(
  workspace: Readonly<ReleaseWorkspace>,
  storage: JsonValue | undefined,
  key: string,
): JsonObject | null {
  if (!isJsonObject(storage) || typeof storage.prefix !== "string" || !Array.isArray(storage.shards)) return null;
  const shard = fnv1a32Shard(key);
  if (!storage.shards.includes(shard)) return null;
  const file = catalogStorageFile(workspace, `${storage.prefix}${shard}.json`);
  if (!file) return null;
  const document = readJsonFile(file);
  if (!isJsonObject(document)) throw new Error(`Invalid catalog shard: ${file}`);
  return document;
}

function catalogBatchIds(url: URL): string[] | null {
  const ids = url.searchParams.getAll("id");
  if (!ids.length || ids.some((id) => !catalogRouteKeyPattern.test(id))) return null;
  return [...new Set(ids)].sort();
}

function catalogBatchValue(
  workspace: Readonly<ReleaseWorkspace>,
  storage: JsonValue | undefined,
  ids: readonly string[],
): { items: Record<string, JsonValue>; missing: string[] } {
  const items: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  const missing: string[] = [];
  const shards = new Map<string, JsonObject | null>();
  for (const id of ids) {
    const shard = fnv1a32Shard(id);
    let document = shards.get(shard);
    if (document === undefined) {
      document = catalogShardDocument(workspace, storage, id);
      shards.set(shard, document);
    }
    const entity = ownJsonValue(document, id);
    if (entity === undefined) missing.push(id);
    else items[id] = entity;
  }
  return { items, missing };
}

function sendCatalogStorageFile(
  req: IncomingMessage,
  res: ServerResponse,
  workspace: Readonly<ReleaseWorkspace>,
  releasePath: JsonValue | undefined,
): boolean {
  const file = catalogStorageFile(workspace, releasePath);
  if (!file) return false;
  sendFile(req, res, file, "public, max-age=0, must-revalidate", releaseResponseHeaders(workspace));
  return true;
}

async function serveCatalogStorageApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  workspace: Readonly<ReleaseWorkspace>,
  tail: readonly string[],
): Promise<boolean> {
  const manifest = catalogStorageManifest(workspace);
  const manifestResources = manifest.resources;
  if (!isJsonObject(manifestResources)) throw new Error("Catalog storage resources are invalid");
  const writeJson = (status: number, value: JsonValue): void => releaseJson(res, status, value, workspace);

  if (tail.length === 1 && tail[0] === "catalog") {
    writeJson(200, manifest);
    return true;
  }
  if (tail.length === 2 && tail[0] === "catalog" && tail[1] === "summary") {
    if (!sendCatalogStorageFile(req, res, workspace, manifest.summary)) {
      writeJson(502, { error: { code: "catalog_missing", message: "Catalog summary is missing" } });
    }
    return true;
  }

  const resourceName = tail[0] ?? "";
  const resource = ownJsonValue(manifestResources, resourceName);
  if (!isJsonObject(resource)) {
    writeJson(404, { error: { code: "resource_not_found", message: "Catalog resource not found" } });
    return true;
  }

  if (tail.length === 1) {
    if (url.searchParams.has("id")) {
      const ids = catalogBatchIds(url);
      if (!ids) {
        writeJson(400, { error: { code: "invalid_batch", message: "Catalog batch contains an invalid entity id" } });
      } else {
        writeJson(200, catalogBatchValue(workspace, resource.entities, ids));
      }
    } else if (resourceName === "events") {
      const index = localReleaseJson(workspace, String(resource.index));
      if (!isJsonObject(index)) {
        writeJson(502, { error: { code: "catalog_missing", message: "Catalog index is missing" } });
      } else {
        const projected = await eventArtworkIndex(index, fnv1a32Shard, async (id) =>
          catalogShardDocument(workspace, resource.entities, id),
        );
        writeJson(200, projected as JsonObject);
      }
    } else if (!sendCatalogStorageFile(req, res, workspace, resource.index)) {
      writeJson(502, { error: { code: "catalog_missing", message: "Catalog index is missing" } });
    }
    return true;
  }

  if (tail.length === 2) {
    const id = tail[1] ?? "";
    const entity = catalogRouteKeyPattern.test(id)
      ? ownJsonValue(catalogShardDocument(workspace, resource.entities, id), id)
      : undefined;
    if (entity === undefined) {
      writeJson(404, { error: { code: "entity_not_found", message: "Catalog entity not found" } });
    } else {
      writeJson(200, entity);
    }
    return true;
  }

  if (tail[1] === "views") {
    const viewName = tail[2] ?? "";
    const views = isJsonObject(resource.views) ? resource.views : null;
    const view = ownJsonValue(views, viewName);
    if (!isJsonObject(view)) {
      writeJson(404, { error: { code: "view_not_found", message: "Catalog view not found" } });
      return true;
    }
    if (tail.length === 3) {
      if (url.searchParams.has("id")) {
        const ids = catalogBatchIds(url);
        if (!ids) {
          writeJson(400, { error: { code: "invalid_batch", message: "Catalog batch contains an invalid entity id" } });
        } else {
          writeJson(200, catalogBatchValue(workspace, view.entities, ids));
        }
      } else if (!sendCatalogStorageFile(req, res, workspace, view.index)) {
        writeJson(502, { error: { code: "catalog_missing", message: "Catalog view index is missing" } });
      }
      return true;
    }
    if (tail.length === 4) {
      const id = tail[3] ?? "";
      const entity = catalogRouteKeyPattern.test(id)
        ? ownJsonValue(catalogShardDocument(workspace, view.entities, id), id)
        : undefined;
      if (entity === undefined) {
        writeJson(404, { error: { code: "entity_not_found", message: "Catalog view entity not found" } });
      } else {
        writeJson(200, entity);
      }
      return true;
    }
    writeJson(404, { error: { code: "view_not_found", message: "Catalog view not found" } });
    return true;
  }

  if (tail.length === 4 && tail[1] === "relations") {
    const relationName = tail[2] ?? "";
    const relationKey = tail[3] ?? "";
    const relations = isJsonObject(resource.relations) ? resource.relations : null;
    const relation = ownJsonValue(relations, relationName);
    if (!isJsonObject(relation) || !catalogRouteKeyPattern.test(relationKey)) {
      writeJson(404, { error: { code: "relation_not_found", message: "Catalog relation not found" } });
      return true;
    }
    const value = ownJsonValue(catalogShardDocument(workspace, relation, relationKey), relationKey);
    if (value === undefined) {
      writeJson(200, {});
      return true;
    }
    if (relation.valueMode === "records") {
      if (!isJsonObject(value)) throw new Error(`Invalid catalog relation records: ${resourceName}:${relationName}`);
      writeJson(200, value);
      return true;
    }
    if (relation.valueMode !== "ids" || !Array.isArray(value) || value.some((id) => typeof id !== "string")) {
      throw new Error(`Invalid catalog relation ids: ${resourceName}:${relationName}`);
    }
    const result = catalogBatchValue(workspace, resource.entities, value as readonly string[]);
    if (result.missing.length) {
      throw new Error(`Catalog relation references missing entities: ${resourceName}:${relationName}`);
    }
    writeJson(200, result.items);
    return true;
  }

  writeJson(404, { error: { code: "resource_not_found", message: "Catalog resource not found" } });
  return true;
}

const historicalWorkspaces = new Map<string, Readonly<ReleaseWorkspace>>();

function selectedWorkspace(server: string, requestedReleaseId?: string): Readonly<ReleaseWorkspace> | undefined {
  const selection = WORKSPACES.get(server);
  if (!selection) return undefined;
  if (requestedReleaseId !== undefined) {
    if (!releaseIdPattern.test(requestedReleaseId)) return undefined;
    if (selection.workspace.releaseId === requestedReleaseId) return selection.workspace;
    if (workspaceSelectionsAreFixed) return undefined;
    const key = `${server}\u0000${requestedReleaseId}`;
    const cached = historicalWorkspaces.get(key);
    if (cached) return cached;
    const releaseRoot = path.join(selection.workspace.serverRoot, "releases", requestedReleaseId);
    try {
      const historical = releaseWorkspace(server, ROOT, {
        ...process.env,
        RESOURCE_RELEASE_ROOT: releaseRoot,
      });
      historicalWorkspaces.set(key, historical);
      return historical;
    } catch {
      return undefined;
    }
  }
  if (workspaceSelectionsAreFixed) return selection.workspace;
  const pointerModifiedAt = fs.existsSync(selection.pointerFile) ? fs.statSync(selection.pointerFile).mtimeMs : 0;
  if (pointerModifiedAt === selection.pointerModifiedAt) return selection.workspace;
  selection.workspace = releaseWorkspace(server, ROOT);
  selection.pointerModifiedAt = pointerModifiedAt;
  return selection.workspace;
}

const releaseResponseHeadersCache = new Map<string, Readonly<Record<string, string>>>();

function releaseIdentity(workspace: Readonly<ReleaseWorkspace>): JsonObject {
  const descriptorFile = path.join(workspace.releaseRoot, releaseIdentityFilename);
  if (fs.existsSync(descriptorFile)) {
    const descriptor = readJsonFile(descriptorFile);
    if (
      !isJsonObject(descriptor) ||
      Object.keys(descriptor).sort().join("\0") !== releaseIdentityKeys.join("\0") ||
      descriptor.schema !== releaseIdentitySchema ||
      descriptor.server !== workspace.id ||
      descriptor.releaseId !== workspace.releaseId ||
      typeof descriptor.sourceId !== "string" ||
      !releaseSourceIdPattern.test(descriptor.sourceId)
    ) {
      throw new Error(`Invalid release identity descriptor: ${descriptorFile}`);
    }
    return descriptor;
  }

  // Existing local current releases may predate the descriptor. The validated
  // current pointer is the only migration fallback; historical releases must
  // have their own descriptor and never borrow current identity.
  const selection = WORKSPACES.get(workspace.id);
  if (selection?.workspace.releaseId === workspace.releaseId && fs.existsSync(selection.pointerFile)) {
    const pointer = readJsonFile(selection.pointerFile);
    if (
      isJsonObject(pointer) &&
      pointer.schema === "haneoka-resource-pointer-v1" &&
      pointer.server === workspace.id &&
      pointer.releaseId === workspace.releaseId &&
      typeof pointer.sourceId === "string" &&
      releaseSourceIdPattern.test(pointer.sourceId)
    ) {
      return {
        schema: releaseIdentitySchema,
        server: workspace.id,
        releaseId: workspace.releaseId,
        sourceId: pointer.sourceId,
      };
    }
  }
  throw new Error(`Release identity descriptor is missing: ${descriptorFile}`);
}

function releaseResponseHeaders(workspace: Readonly<ReleaseWorkspace>): Readonly<Record<string, string>> {
  const key = `${workspace.id}\u0000${workspace.releaseId}`;
  const cached = releaseResponseHeadersCache.get(key);
  if (cached) return cached;
  const identity = releaseIdentity(workspace);
  const headers = Object.freeze({
    "X-Haneoka-Release-Id": workspace.releaseId,
    "X-Haneoka-Source-Id": String(identity.sourceId),
  });
  releaseResponseHeadersCache.set(key, headers);
  return headers;
}

function releaseJson(
  res: ServerResponse,
  status: number,
  value: JsonValue,
  workspace: Readonly<ReleaseWorkspace>,
  cache = "no-cache",
): void {
  json(res, status, value, cache, releaseResponseHeaders(workspace));
}

function localReleaseJson(workspace: Readonly<ReleaseWorkspace>, releasePath: string): JsonValue | null {
  const file = safeFile(workspace.releaseRoot, releasePath);
  return file ? readJsonFile(file) : null;
}

function localReleaseBytes(workspace: Readonly<ReleaseWorkspace>, releasePath: string): Uint8Array | null {
  const file = safeFile(workspace.releaseRoot, releasePath);
  return file ? new Uint8Array(fs.readFileSync(file)) : null;
}

function localizedReleasePaths(releasePath: string): readonly string[] {
  const match = /\((en|ko|zh-Hans|zh-Hant)\)(?=\.[^./]+$)/u.exec(releasePath);
  if (!match?.[1]) return [releasePath];
  const base = releasePath.replace(match[0], "");
  const alternate =
    match[1] === "zh-Hans"
      ? base.replace(/(?=\.[^./]+$)/u, "(zh-Hant)")
      : match[1] === "zh-Hant"
        ? base.replace(/(?=\.[^./]+$)/u, "(zh-Hans)")
        : "";
  return alternate ? [releasePath, alternate, base] : [releasePath, base];
}

interface LocalSonolusRelease {
  readonly server: string;
  readonly workspace: Readonly<ReleaseWorkspace>;
}

function localSonolusReleaseKey(release: { readonly releaseId: string; readonly server: string }): string {
  return `${release.server}\u0000${release.releaseId}`;
}

function localSonolusReleases(): readonly LocalSonolusRelease[] {
  const releases = new Map<string, LocalSonolusRelease>();
  for (const configuredServer of RELEASE_SERVERS) {
    const workspace = selectedWorkspace(configuredServer);
    if (workspace) releases.set(workspace.id, { server: workspace.id, workspace });
  }
  return Object.freeze([...releases.values()].sort((left, right) => left.server.localeCompare(right.server, "en")));
}

function localSonolusRevision(releases: readonly LocalSonolusRelease[], origin: string): string {
  if (!releases.length) throw new Error("No local Our Notes releases are available for Sonolus");
  return `${origin}:our-notes:${releases.map((release) => `${release.server}@${release.workspace.releaseId}`).join(",")}`;
}

function localSonolusCatalogProvider(releases: readonly LocalSonolusRelease[], origin: string, revision: string) {
  return {
    async load() {
      const catalogs = await Promise.all(
        releases.map(async (release) => {
          const catalog = await new ReleaseChartCatalogProvider({
            mediaBaseUrl: origin,
            onInvalidCharts: (names) => {
              console.warn(
                `Ignoring invalid local Sonolus charts from ${release.server}/${release.workspace.releaseId}`,
                names,
              );
            },
            readJson: async (releasePath) => localReleaseJson(release.workspace, releasePath),
            release: { releaseId: release.workspace.releaseId, server: release.server },
            revision: `${release.server}:${release.workspace.releaseId}`,
          }).load();
          return catalog;
        }),
      );
      const charts = new Map<string, (typeof catalogs)[number]["charts"][number]>();
      for (const catalog of catalogs) {
        for (const chart of catalog.charts) {
          const key = `${chart.songId}\u0000${chart.difficulty.toLocaleLowerCase("en-US")}`;
          if (!charts.has(key)) charts.set(key, chart);
        }
      }
      return { charts: [...charts.values()], revision: { id: revision } };
    },
  };
}

function localSonolusDataProvider(releases: readonly LocalSonolusRelease[]): RuntimeChartDataProvider {
  const releasesByKey = new Map(
    releases.map((release) => [
      localSonolusReleaseKey({ releaseId: release.workspace.releaseId, server: release.server }),
      release,
    ]),
  );
  return new RuntimeChartDataProvider({
    readBytes: async (dataId) => {
      const reference = parseReleaseChartDataId(dataId);
      if (!reference) return null;
      const release = releasesByKey.get(localSonolusReleaseKey(reference));
      return release ? localReleaseBytes(release.workspace, reference.path) : null;
    },
    onInvalidChart: (chart, error) => console.warn(`Ignoring invalid local Sonolus chart ${chart.name}`, error),
  });
}

function sonolusJson(req: IncomingMessage, res: ServerResponse, status: number, value: JsonValue, cache: string): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": cache,
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8",
    "Sonolus-Version": "1.1.4",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

function localSonolusAssetFile(workspace: Readonly<ReleaseWorkspace>, pathname: string): string | null {
  if (!pathname.startsWith("/sonolus/")) return null;
  return safeFile(workspace.runtimeRoot, pathname.slice(1));
}

// The engine + presentation payload is a shared global asset built once (via
// `pnpm sonolus:build`) rather than per release. Prefer it for the engine
// template, repository blobs, and licenses; fall back to a per-release runtime
// tree only while the global payload is absent.
const GLOBAL_SONOLUS_ROOT = path.resolve(ROOT, "data/sonolus/current/sonolus");

function globalSonolusReleaseJson(releasePath: string): JsonValue | null {
  const prefix = "runtime/sonolus/";
  if (!releasePath.startsWith(prefix)) return null;
  const file = safeFile(GLOBAL_SONOLUS_ROOT, releasePath.slice(prefix.length));
  return file ? readJsonFile(file) : null;
}

function globalSonolusAssetFile(pathname: string): string | null {
  if (!pathname.startsWith("/sonolus/")) return null;
  return safeFile(GLOBAL_SONOLUS_ROOT, pathname.slice("/sonolus/".length));
}

function localizeSonolusDocument(value: JsonValue, localOrigin: string): JsonValue {
  if (typeof value === "string") {
    return value
      .replace(/^https:\/\/sonolus\.haneoka\.org(?=\/|$)/u, localOrigin)
      .replace(/^https:\/\/haneoka\.org(?=\/|$)/u, localOrigin);
  }
  if (Array.isArray(value)) return value.map((entry) => localizeSonolusDocument(entry, localOrigin));
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, localizeSonolusDocument(entry, localOrigin)]),
  );
}

// Preview has no D1 resource-server administration data, so hand-list the labels
// for known CBT servers (matching the Worker's resource_server seed rows) instead
// of showing the bare slug. Unknown servers fall back to the slug-derived form.
const LOCAL_RELEASE_LABELS: Readonly<Record<string, { displayName: string; region: string }>> = {
  intl: { displayName: "Our Notes", region: "global" },
  "jp-cbt": { displayName: "Japan CBT", region: "jp" },
  "intl-cbt": { displayName: "Global CBT", region: "global" },
};

function localReleaseRegistry(): JsonObject {
  return {
    releases: RELEASE_SERVERS.map((id) => {
      const label = LOCAL_RELEASE_LABELS[id];
      return {
        id,
        // Keep the same public registry shape as the Worker, so the client
        // never invents a Bestdori pseudo-server.
        displayName: label?.displayName ?? id,
        region: label?.region ?? id.split("-", 1)[0] ?? "global",
      };
    }),
  };
}

function serveCanonicalResourceDocument(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const announcement = announcementDocumentRequest(url.pathname);
  if (announcement) {
    const file = safeFile(DIST, `${announcement.shellPath.slice(1)}index.html`);
    if (!file) {
      json(res, 404, { error: { code: "document_not_found", message: "Announcement document not found" } });
      return true;
    }
    const body = rewriteAnnouncementDocument(fs.readFileSync(file, "utf8"), announcement.id);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  }
  const route = parseResourceRoute(url.pathname);
  if (!route) return false;

  const candidates = (pathname: string): string[] => {
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    return pathname === "/" ? [relative] : [relative, `${relative}/index.html`, `${relative}.html`];
  };
  if (route.id) {
    if (route.kind === "stories" && STORY_MODES.has(route.id)) {
      const file = candidates(url.pathname)
        .map((candidate) => safeFile(DIST, candidate))
        .find(Boolean);
      if (file) sendFile(req, res, file, "no-cache");
      else json(res, 404, { error: { code: "document_not_found", message: "Story collection not found" } });
      return true;
    }
    for (const candidate of candidates(url.pathname)) {
      const file = safeFile(DIST, candidate);
      if (file) {
        sendFile(req, res, file, "no-cache");
        return true;
      }
    }
    const availability = documentEntityAvailability(route as ResourceRoute & { id: string });
    if (!availability) {
      json(res, 404, { error: { code: "entity_not_found", message: "Resource entity not found" } });
      return true;
    }
    const shellPath =
      route.kind === "stories" && availability.storyMode
        ? storyCollectionPath({ server: route.server, locale: route.locale, mode: availability.storyMode })
        : resourcePath({ server: route.server, locale: route.locale, kind: route.kind });
    const shell = safeFile(DIST, `${shellPath.slice(1)}index.html`);
    if (shell) {
      sendFile(req, res, shell, "no-cache");
      return true;
    }
    json(res, 404, { error: { code: "document_not_found", message: "Resource document not found" } });
    return true;
  }

  for (const candidate of candidates(url.pathname)) {
    const file = safeFile(DIST, candidate);
    if (file) {
      sendFile(req, res, file, "no-cache");
      return true;
    }
  }
  json(res, 404, { error: { code: "document_not_found", message: "Resource collection not found" } });
  return true;
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://preview.invalid");
  const legacyEntityTarget =
    legacyEntityRedirectTarget(url.pathname, url.search) ??
    legacyCollectionRedirectTarget(url.pathname, url.search) ??
    legacyHomeRedirectTarget(url.pathname, url.search);
  if (legacyEntityTarget && ((req.method ?? "GET") === "GET" || (req.method ?? "GET") === "HEAD")) {
    res.writeHead(308, { Location: legacyEntityTarget, "Cache-Control": "public, max-age=86400" });
    res.end();
    return;
  }
  if (isApplicationWorkerRequest(url.pathname) && APPLICATION_WORKER_ORIGIN) {
    await proxyApplicationWorker(req, res, url);
    return;
  }
  if (isCloudDataRequest(url.pathname)) {
    await proxyApplicationWorker(req, res, url, CLOUD_DATA_ORIGIN);
    return;
  }
  if (!allowedMethods.has(req.method ?? "GET")) {
    json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Range, If-Range, If-None-Match, Content-Type",
      "Access-Control-Expose-Headers":
        "Accept-Ranges, Content-Length, Content-Range, ETag, X-Haneoka-Garupa-Snapshot-Id, X-Haneoka-Release-Id, X-Haneoka-Source-Id, X-Request-Id",
    });
    res.end();
    return;
  }
  // Sonolus "Share" links address `/{type}/{name}` on the server address and
  // land on open.sonolus.com, exactly as the production worker answers them.
  const sonolusShareTarget =
    (req.method ?? "GET") === "GET" || req.method === "HEAD"
      ? sonolusShareRedirectTarget(url.pathname, url.search, "haneoka.org")
      : undefined;
  if (sonolusShareTarget) {
    res.writeHead(302, { Location: sonolusShareTarget, "Cache-Control": "public, max-age=3600" });
    res.end();
    return;
  }
  // Locale-prefixed paths are the built pages; anything else that looks like
  // a page address moves to the visitor's locale — the same negotiation the
  // production worker performs (cookie, then Accept-Language, then English).
  // The asset explorer's SPA sub-routes are the one worker-first prefix whose
  // unprefixed document addresses still negotiate, matching the worker.
  const localePattern = /^\/(?:ja|en|zh-TW|zh-CN|ko)(?:\/|$)/u;
  const serverFirstParts = url.pathname.split("/").filter(Boolean);
  const serverFirstDocument =
    serverFirstParts.length >= 2 &&
    isReleaseServer(serverFirstParts[0]) &&
    /^(?:ja|en|zh-TW|zh-CN|ko)$/u.test(serverFirstParts[1] ?? "");
  const lastSegment = url.pathname.split("/").pop() ?? "";
  if (isReleaseServer(serverFirstParts[0]) && serverFirstParts.length >= 2) {
    if (!serverFirstDocument) {
      json(res, 404, { error: { code: "document_not_found", message: "Invalid resource locale" } });
      return;
    }
    if (serverFirstParts.length === 2 && !url.pathname.endsWith("/")) {
      res.writeHead(308, { Location: `${url.pathname}/${url.search}` });
      res.end();
      return;
    }
  }
  const unprefixedAppPrefixes = [
    "/api/",
    "/artifacts/",
    "/assets/",
    "/assets",
    "/game-client/",
    "/objects/",
    "/runtime/",
    "/sonolus/",
    "/auth",
  ];
  if (
    !localePattern.test(url.pathname) &&
    !serverFirstDocument &&
    ((req.method ?? "GET") === "GET" || req.method === "HEAD") &&
    !lastSegment.includes(".") &&
    !unprefixedAppPrefixes.some((prefix) => url.pathname.startsWith(prefix))
  ) {
    const cookieLocale = /(?:^|;\s*)haneoka\.locale=([^;]+)/u.exec(req.headers.cookie ?? "")?.[1];
    const languageTag = (tag: string): string | null => {
      const value = tag.trim().replaceAll("_", "-").toLowerCase();
      if (!value) return null;
      if (value === "ja" || value === "en" || value === "ko") return value;
      if (value.startsWith("zh")) return /^(?:zh-hant|zh-tw|zh-hk|zh-mo)/u.test(value) ? "zh-TW" : "zh-CN";
      return null;
    };
    let locale: string | null = null;
    if (cookieLocale && localePattern.test(`/${decodeURIComponent(cookieLocale)}/`))
      locale = decodeURIComponent(cookieLocale);
    // A stored locale wins outright, as it does in the worker; the header is
    // only consulted when no cookie is present.
    if (!locale)
      for (const part of (req.headers["accept-language"] ?? "").split(",")) {
        locale = languageTag(part.split(";")[0] ?? "");
        if (locale) break;
      }
    const resolved = locale ?? "en";
    const target = new URL(url);
    if (isReleaseServer(serverFirstParts[0]) && serverFirstParts.length === 1) {
      target.pathname = `/${serverFirstParts[0]}/${resolved}/`;
    } else if (url.pathname === "/") {
      const server = url.searchParams.get("server");
      target.pathname = `/${isReleaseServer(server) ? server : "intl"}/${resolved}/`;
      target.searchParams.delete("server");
    } else target.pathname = `/${resolved}${url.pathname.replace(/\/+$/, "")}/`;
    res.writeHead(302, {
      Location: `${target.pathname}${target.search}${target.hash}`,
      "Cache-Control": "no-store",
      Vary: "Cookie, Accept-Language",
    });
    res.end();
    return;
  }

  if (serveCanonicalResourceDocument(req, res, url)) return;

  // The transformed Garupa API belongs to a configured provider/Worker. It is
  // never a file in a raw Bestdori mirror, even when a mirror is available for
  // that Worker to use as its upstream.
  if (isBestdoriProviderApiRequest(url)) {
    await proxyBestdoriProvider(req, res, url, undefined);
    return;
  }

  // Bestdori Sonolus is a separate catalog, not a release-server member of
  // the local Our Notes union. Its details/data routes retain their source in
  // the path, while initial list/info routes retain it in the query.
  if (url.pathname.startsWith("/sonolus/") && isBestdoriSonolusRequest(url)) {
    const localOrigin = `http://${req.headers.host ?? `127.0.0.1:${PORT}`}`;
    await proxyBestdoriProvider(req, res, url, localOrigin);
    return;
  }

  // Raw Bestdori data is a Worker-only upstream transport. It never occupies
  // a top-level application path, so Our Notes release media owns `/assets`
  // without depending on route priority or a special server-slug exclusion.
  if (isBestdoriRawMirrorRequest(url.pathname)) {
    const rawPath = bestdoriRawMirrorPath(url.pathname);
    if (!rawPath) {
      json(res, 404, { error: { code: "bestdori_raw_path_not_found", message: "Bestdori raw path not found" } });
      return;
    }
    if (!BESTDORI_RAW_MIRROR_ROOT) {
      json(res, 503, {
        error: {
          code: "bestdori_raw_mirror_unavailable",
          message: "Bestdori raw mirror is not configured; set BESTDORI_RAW_MIRROR_ROOT",
        },
      });
      return;
    }
    const file = safeFile(BESTDORI_RAW_MIRROR_ROOT, rawPath.slice(1));
    if (file) sendFile(req, res, file, "no-cache");
    else json(res, 404, { error: { code: "mirror_not_found", message: "Bestdori mirror object not found" } });
    return;
  }

  if (url.pathname.startsWith("/sonolus/")) {
    const releases = localSonolusReleases();
    const canonicalRelease = releases[0];
    if (!canonicalRelease) {
      sonolusJson(req, res, 404, { message: "Not found" }, "no-store");
      return;
    }
    const localOrigin = `http://${req.headers.host ?? `127.0.0.1:${PORT}`}`;
    const revision = localSonolusRevision(releases, localOrigin);
    const readJson = async (releasePath: string) =>
      globalSonolusReleaseJson(releasePath) ?? localReleaseJson(canonicalRelease.workspace, releasePath);
    const projected = await sonolusLevelService.handle({
      catalogProvider: localSonolusCatalogProvider(releases, localOrigin, revision),
      dataProvider: localSonolusDataProvider(releases),
      levelTemplateProvider: new ReleaseLevelTemplateProvider({ readJson }),
      pathname: url.pathname,
      randomIndex: (length) => Math.floor(Math.random() * length),
      revision,
      searchParams: url.searchParams,
      sonolusBaseUrl: localOrigin,
    });
    if (projected?.kind === "document") {
      sonolusJson(
        req,
        res,
        projected.status,
        localizeSonolusDocument(
          localizeSonolusItemLabels(
            projected.body,
            url.searchParams.get("localization"),
            OUR_NOTES_SONOLUS_ITEM_LABELS,
          ),
          localOrigin,
        ),
        projected.cacheControl,
      );
      return;
    }
    if (projected?.kind === "data") {
      const headers: Record<string, string | number> = {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": projected.cacheControl,
        "Content-Length": projected.body.byteLength,
        "Content-Type": projected.contentType,
        "Sonolus-Version": "1.1.4",
      };
      if (projected.etag) headers.ETag = projected.etag;
      res.writeHead(projected.status, headers);
      res.end(req.method === "HEAD" ? undefined : Buffer.from(projected.body));
      return;
    }

    const repository = url.pathname.startsWith("/sonolus/repository/");
    const license = url.pathname.startsWith("/sonolus/licenses/");
    const file =
      globalSonolusAssetFile(url.pathname) ?? localSonolusAssetFile(canonicalRelease.workspace, url.pathname);
    if (!file) {
      sonolusJson(req, res, 404, { message: "Not found" }, "no-store");
      return;
    }
    if (!repository && !license) {
      const document = readJsonFile(file);
      const localized = localizeSonolusDocument(
        localizeSonolusItemLabels(document, url.searchParams.get("localization"), OUR_NOTES_SONOLUS_ITEM_LABELS),
        localOrigin,
      );
      sonolusJson(req, res, 200, localized, "public, max-age=600");
      return;
    }
    sendFile(req, res, file, repository ? "public, max-age=31536000, immutable" : "public, max-age=600", {
      "Access-Control-Allow-Origin": "*",
      "Sonolus-Version": "1.1.4",
    });
    return;
  }

  if (url.pathname === "/api/v1/releases") {
    json(res, 200, localReleaseRegistry(), "public, max-age=86400, stale-while-revalidate=604800");
    return;
  }

  const latest = url.pathname.match(/^\/api\/v1\/([^/]+)(?:\/(.*))?$/u);
  if (latest) {
    const encodedResource = latest[1] ?? "";
    const rawTail = latest[2] ?? "";
    const resource = decodePathPart(encodedResource);
    if (resource && !latestCatalogReservedSegments.has(resource)) {
      const serverValues = url.searchParams.getAll("server");
      if (serverValues.length > 1) {
        json(res, 400, { error: { code: "invalid_server", message: "Server must be specified once" } });
        return;
      }
      const server = serverValues[0] || "intl";
      if (!WORKSPACES.has(server)) {
        json(res, 404, { error: { code: "server_not_found", message: "Server not found" } });
        return;
      }
      url.searchParams.delete("server");
      // Public aliases are latest-only. Historical release selection remains
      // available through the explicit scoped route below.
      url.searchParams.delete("release");
      url.pathname = `/api/v1/servers/${encodeURIComponent(server)}/${encodedResource}${rawTail ? `/${rawTail}` : ""}`;
    }
  }

  const api = url.pathname.match(/^\/api\/v1\/servers\/([^/]+)\/(.+)$/);
  if (api) {
    const encodedServer = api[1];
    const encodedTail = api[2];
    if (!encodedServer || !encodedTail) {
      json(res, 400, { error: { code: "invalid_path", message: "Invalid URL path" } });
      return;
    }
    const server = decodePathPart(encodedServer);
    if (!server) {
      json(res, 400, { error: { code: "invalid_path", message: "Invalid URL encoding" } });
      return;
    }
    const releaseValues = url.searchParams.getAll("release");
    if (releaseValues.length > 1 || (releaseValues[0] !== undefined && !releaseIdPattern.test(releaseValues[0]))) {
      json(res, 400, { error: { code: "invalid_release", message: "Release must be a valid immutable release id" } });
      return;
    }
    const requestedReleaseId = releaseValues[0];
    const workspace = selectedWorkspace(server, requestedReleaseId);
    if (!workspace) {
      const knownServer = WORKSPACES.has(server);
      json(res, 404, {
        error: {
          code: knownServer && requestedReleaseId ? "release_not_found" : "server_not_found",
          message: knownServer && requestedReleaseId ? "Requested release is not available" : "Server not found",
        },
      });
      return;
    }
    const tail = decodePath(encodedTail);
    if (!tail) {
      json(res, 400, { error: { code: "invalid_path", message: "Invalid URL encoding" } });
      return;
    }
    if (tail.length === 1 && tail[0] === "release") {
      const projections = url.searchParams.getAll("projection");
      if (projections.length > 1 || (projections[0] !== undefined && projections[0] !== "identity")) {
        releaseJson(
          res,
          400,
          { error: { code: "invalid_projection", message: "Release projection must be identity" } },
          workspace,
        );
        return;
      }
      if (projections[0] === "identity") {
        releaseJson(res, 200, releaseIdentity(workspace), workspace);
        return;
      }
      sendFile(
        req,
        res,
        path.join(workspace.releaseRoot, "release.json"),
        "public, max-age=0, must-revalidate",
        releaseResponseHeaders(workspace),
      );
      return;
    }
    if (tail.length === 1 && tail[0] === "ui-marks") {
      const file = path.join(
        workspace.metadataRoot,
        "sources/Assets/AddressableResources/UI/Atlas/FixUiSpriteAtlas.spriteatlasv2.json",
      );
      const descriptor = JSON.parse(fs.readFileSync(file, "utf8")) as JsonObject;
      const projected: Record<string, JsonValue> = {};
      for (const value of Array.isArray(descriptor.outputs) ? descriptor.outputs : []) {
        if (!isJsonObject(value) || value.type !== "Sprite" || typeof value.path !== "string") continue;
        const filename = value.path.split("/").pop() || "";
        const logical = filename.replace(/--Sprite-?-?\d+\.png$/u, ".png");
        if (
          /^(?:RarityIconCenter_(?:R|SR|SSR|EX|BD)|CardType-(?:Red|Blue|Green|Yellow|Purple)|sp_icon_live_music_type_(?:1|2|3|4|5|99))\.png$/u.test(
            logical,
          )
        )
          projected[logical] = value.path;
      }
      json(res, 200, projected, "public, max-age=0, must-revalidate", releaseResponseHeaders(workspace));
      return;
    }
    if (tail[0] === "sources" && tail[1] === "tree" && tail.length === 2) {
      const sourceTreeFile = path.join(workspace.metadataRoot, "source-index", "tree.json");
      if (!fs.existsSync(sourceTreeFile)) throw new Error(`Source tree is missing: ${sourceTreeFile}`);
      sendFile(req, res, sourceTreeFile, undefined, releaseResponseHeaders(workspace));
      return;
    }
    if (tail[0] === "sources" && tail[1] !== undefined && ["Assets", "Packages"].includes(tail[1])) {
      const file = safeFile(path.join(workspace.metadataRoot, "sources"), `${tail.slice(1).join("/")}.json`);
      if (file) {
        sendFile(req, res, file, undefined, releaseResponseHeaders(workspace));
      } else {
        releaseJson(
          res,
          404,
          {
            error: { code: "source_not_found", message: "Unity source not found" },
          },
          workspace,
        );
      }
      return;
    }

    await serveCatalogStorageApi(req, res, url, workspace, tail);
    return;
  }

  const media = url.pathname.match(/^\/(assets|runtime|objects)\/([^/]+)\/(.+)$/);
  if (media) {
    const encodedServer = media[2];
    if (!encodedServer) {
      json(res, 400, { error: { code: "invalid_path", message: "Invalid URL path" } });
      return;
    }
    const server = decodePathPart(encodedServer);
    if (!server) {
      json(res, 400, { error: { code: "invalid_path", message: "Invalid URL encoding" } });
      return;
    }
    const workspace = selectedWorkspace(server);
    const file = workspace
      ? localizedReleasePaths(url.pathname)
          .map((candidate) => localReleaseFile(workspace, candidate))
          .find((candidate): candidate is string => Boolean(candidate && fs.existsSync(candidate))) || null
      : null;
    if (file && fs.existsSync(file)) {
      // Current-release media keeps a stable URL when the pointer changes.
      sendFile(req, res, file, "public, max-age=0, must-revalidate");
    } else {
      json(res, 404, { error: { code: "not_found", message: "Object not found" } });
    }
    return;
  }

  if (
    ["/api", "/asset", "/assets", "/runtime", "/objects"].some(
      (prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
    )
  ) {
    if (CLOUD_DATA_ORIGIN) {
      await proxyApplicationWorker(req, res, url, CLOUD_DATA_ORIGIN);
      return;
    }
    json(res, 404, { error: { code: "not_found", message: "Route not found" } });
    return;
  }

  const documentPath =
    serverFirstDocument && serverFirstParts[2] === "assets" && serverFirstParts.length > 3
      ? `/${serverFirstParts[0]}/${serverFirstParts[1]}/assets/`
      : url.pathname;
  const relativePath = documentPath === "/" ? "index.html" : documentPath.slice(1);
  // Resolve prerendered pages emitted as either ${path}.html or ${path}/index.html.
  // (directory style) or ${path}.html, then fall back to the generic SPA shell.
  const candidates = [relativePath];
  if (url.pathname !== "/") {
    candidates.push(`${relativePath}/index.html`, `${relativePath}.html`);
  }
  for (const candidate of candidates) {
    const file = safeFile(DIST, candidate);
    if (file) {
      sendFile(req, res, file, "no-cache");
      return;
    }
  }
  // SPA sub-routes of the tools are served through their locale-prefixed entry
  // page. The address reaching this fallback carries the visitor's locale
  // prefix, so try that entry first instead of a fixed order.
  const prefixLocale = url.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
  if (
    localePattern.test(url.pathname) &&
    (url.pathname.includes("/catalog/assets/") || url.pathname.includes("/community/"))
  ) {
    const locales = ["ja", "en", "zh-TW", "zh-CN", "ko"].filter((locale) => locale !== prefixLocale);
    for (const locale of [prefixLocale, ...locales]) {
      const entryPath = url.pathname.includes("/catalog/assets/")
        ? `${locale}/catalog/assets/index.html`
        : `${locale}/community/index.html`;
      const entry = safeFile(DIST, entryPath);
      if (entry) {
        sendFile(req, res, entry, "no-cache");
        return;
      }
    }
  }
  const notFound = safeFile(DIST, "404.html");
  if (notFound) {
    sendFile(req, res, notFound, "no-cache", {}, 404);
  } else {
    json(res, 404, { error: { code: "not_found", message: "Build the web app first" } });
  }
}

function isExternalIpv4(address: NetworkInterfaceInfo | undefined): address is NetworkInterfaceInfo {
  return address !== undefined && address.family === "IPv4" && !address.internal;
}

http
  .createServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      json(res, 500, { error: { code: "internal_error", message: errorMessage(error) } });
    });
  })
  .listen(PORT, HOST, () => {
    const addresses = Object.values(os.networkInterfaces())
      .flat()
      .filter(isExternalIpv4)
      .map((address) => address.address);
    const hosts = HOST === "0.0.0.0" ? ["127.0.0.1", ...new Set(addresses)] : [HOST];

    console.log(`Preview listening on ${HOST}:${PORT} (${RELEASE_SERVERS.join(", ")})`);
    for (const host of hosts) console.log(`  http://${host}:${PORT}`);
    if (BESTDORI_PROVIDER_ORIGIN) console.log(`  Bestdori provider: ${BESTDORI_PROVIDER_ORIGIN}`);
    if (APPLICATION_WORKER_ORIGIN) console.log(`  Application Worker: ${APPLICATION_WORKER_ORIGIN}`);
    if (APPLICATION_WORKER_BROWSER_ORIGIN)
      console.log(`  Application browser origin: ${APPLICATION_WORKER_BROWSER_ORIGIN}`);
  });
