import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os, { type NetworkInterfaceInfo } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { SonolusLevelService } from "@haneoka/sonolus-core";
import {
  parseReleaseChartDataId,
  ReleaseChartCatalogProvider,
  ReleaseLevelTemplateProvider,
  RuntimeChartDataProvider,
} from "@haneoka/sonolus";
import { localReleaseFile, releaseWorkspace, type ReleaseWorkspace } from "./releaseWorkspace.ts";

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
const RELEASE_SERVERS = (process.env.RELEASE_SERVERS ?? "jp-cbt")
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
const allowedMethods: ReadonlySet<string> = new Set(["GET", "HEAD"]);
const catalogRouteKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,255}$/u;
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
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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

function json(res: ServerResponse, status: number, value: JsonValue, cache = "no-cache"): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": cache,
  });
  res.end(body);
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

  res.writeHead(200, {
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
  sendFile(req, res, file);
  return true;
}

function serveCatalogStorageApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  workspace: Readonly<ReleaseWorkspace>,
  tail: readonly string[],
): boolean {
  const manifest = catalogStorageManifest(workspace);
  const manifestResources = manifest.resources;
  if (!isJsonObject(manifestResources)) throw new Error("Catalog storage resources are invalid");

  if (tail.length === 1 && tail[0] === "catalog") {
    json(res, 200, manifest);
    return true;
  }
  if (tail.length === 2 && tail[0] === "catalog" && tail[1] === "summary") {
    if (!sendCatalogStorageFile(req, res, workspace, manifest.summary)) {
      json(res, 502, { error: { code: "catalog_missing", message: "Catalog summary is missing" } });
    }
    return true;
  }

  const resourceName = tail[0] ?? "";
  const resource = ownJsonValue(manifestResources, resourceName);
  if (!isJsonObject(resource)) {
    json(res, 404, { error: { code: "resource_not_found", message: "Catalog resource not found" } });
    return true;
  }

  if (tail.length === 1) {
    if (url.searchParams.has("id")) {
      const ids = catalogBatchIds(url);
      if (!ids) {
        json(res, 400, { error: { code: "invalid_batch", message: "Catalog batch contains an invalid entity id" } });
      } else {
        json(res, 200, catalogBatchValue(workspace, resource.entities, ids));
      }
    } else if (!sendCatalogStorageFile(req, res, workspace, resource.index)) {
      json(res, 502, { error: { code: "catalog_missing", message: "Catalog index is missing" } });
    }
    return true;
  }

  if (tail.length === 2) {
    const id = tail[1] ?? "";
    const entity = catalogRouteKeyPattern.test(id)
      ? ownJsonValue(catalogShardDocument(workspace, resource.entities, id), id)
      : undefined;
    if (entity === undefined) {
      json(res, 404, { error: { code: "entity_not_found", message: "Catalog entity not found" } });
    } else {
      json(res, 200, entity);
    }
    return true;
  }

  if (tail[1] === "views") {
    const viewName = tail[2] ?? "";
    const views = isJsonObject(resource.views) ? resource.views : null;
    const view = ownJsonValue(views, viewName);
    if (!isJsonObject(view)) {
      json(res, 404, { error: { code: "view_not_found", message: "Catalog view not found" } });
      return true;
    }
    if (tail.length === 3) {
      if (url.searchParams.has("id")) {
        const ids = catalogBatchIds(url);
        if (!ids) {
          json(res, 400, { error: { code: "invalid_batch", message: "Catalog batch contains an invalid entity id" } });
        } else {
          json(res, 200, catalogBatchValue(workspace, view.entities, ids));
        }
      } else if (!sendCatalogStorageFile(req, res, workspace, view.index)) {
        json(res, 502, { error: { code: "catalog_missing", message: "Catalog view index is missing" } });
      }
      return true;
    }
    if (tail.length === 4) {
      const id = tail[3] ?? "";
      const entity = catalogRouteKeyPattern.test(id)
        ? ownJsonValue(catalogShardDocument(workspace, view.entities, id), id)
        : undefined;
      if (entity === undefined) {
        json(res, 404, { error: { code: "entity_not_found", message: "Catalog view entity not found" } });
      } else {
        json(res, 200, entity);
      }
      return true;
    }
    json(res, 404, { error: { code: "view_not_found", message: "Catalog view not found" } });
    return true;
  }

  if (tail.length === 4 && tail[1] === "relations") {
    const relationName = tail[2] ?? "";
    const relationKey = tail[3] ?? "";
    const relations = isJsonObject(resource.relations) ? resource.relations : null;
    const relation = ownJsonValue(relations, relationName);
    if (!isJsonObject(relation) || !catalogRouteKeyPattern.test(relationKey)) {
      json(res, 404, { error: { code: "relation_not_found", message: "Catalog relation not found" } });
      return true;
    }
    const value = ownJsonValue(catalogShardDocument(workspace, relation, relationKey), relationKey);
    if (value === undefined) {
      json(res, 200, {});
      return true;
    }
    if (relation.valueMode === "records") {
      if (!isJsonObject(value)) throw new Error(`Invalid catalog relation records: ${resourceName}:${relationName}`);
      json(res, 200, value);
      return true;
    }
    if (relation.valueMode !== "ids" || !Array.isArray(value) || value.some((id) => typeof id !== "string")) {
      throw new Error(`Invalid catalog relation ids: ${resourceName}:${relationName}`);
    }
    const result = catalogBatchValue(workspace, resource.entities, value as readonly string[]);
    if (result.missing.length) {
      throw new Error(`Catalog relation references missing entities: ${resourceName}:${relationName}`);
    }
    json(res, 200, result.items);
    return true;
  }

  json(res, 404, { error: { code: "resource_not_found", message: "Catalog resource not found" } });
  return true;
}

function selectedWorkspace(server: string): Readonly<ReleaseWorkspace> | undefined {
  const selection = WORKSPACES.get(server);
  if (!selection || workspaceSelectionsAreFixed) return selection?.workspace;
  const pointerModifiedAt = fs.existsSync(selection.pointerFile) ? fs.statSync(selection.pointerFile).mtimeMs : 0;
  if (pointerModifiedAt === selection.pointerModifiedAt) return selection.workspace;
  selection.workspace = releaseWorkspace(server, ROOT);
  selection.pointerModifiedAt = pointerModifiedAt;
  return selection.workspace;
}

function localReleaseJson(workspace: Readonly<ReleaseWorkspace>, releasePath: string): JsonValue | null {
  const file = safeFile(workspace.releaseRoot, releasePath);
  return file ? readJsonFile(file) : null;
}

function localReleaseBytes(workspace: Readonly<ReleaseWorkspace>, releasePath: string): Uint8Array | null {
  const file = safeFile(workspace.releaseRoot, releasePath);
  return file ? new Uint8Array(fs.readFileSync(file)) : null;
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
    "Sonolus-Version": "1.1.2",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

function localSonolusAssetFile(workspace: Readonly<ReleaseWorkspace>, pathname: string): string | null {
  if (!pathname.startsWith("/sonolus/repository/") && !pathname.startsWith("/sonolus/licenses/")) return null;
  return safeFile(workspace.runtimeRoot, pathname.slice(1));
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

function localReleaseRegistry(): JsonObject {
  return {
    releases: RELEASE_SERVERS.map((id) => ({
      id,
      // Preview has no D1 resource-server administration data. Keep this
      // intentionally minimal while preserving the same public registry shape
      // as the Worker, so the client never invents a Bestdori pseudo-server.
      displayName: id,
      region: id.split("-", 1)[0] || "global",
    })),
  };
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://preview.invalid");
  if (!allowedMethods.has(req.method ?? "GET")) {
    json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
    return;
  }

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
    const readJson = async (releasePath: string) => localReleaseJson(canonicalRelease.workspace, releasePath);
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
        localizeSonolusDocument(projected.body, localOrigin),
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
        "Sonolus-Version": "1.1.2",
      };
      if (projected.etag) headers.ETag = projected.etag;
      res.writeHead(projected.status, headers);
      res.end(req.method === "HEAD" ? undefined : Buffer.from(projected.body));
      return;
    }

    const file = localSonolusAssetFile(canonicalRelease.workspace, url.pathname);
    if (!file) {
      sonolusJson(req, res, 404, { message: "Not found" }, "no-store");
      return;
    }
    const repository = url.pathname.startsWith("/sonolus/repository/");
    sendFile(req, res, file, repository ? "public, max-age=31536000, immutable" : "public, max-age=600", {
      "Access-Control-Allow-Origin": "*",
      "Sonolus-Version": "1.1.2",
    });
    return;
  }

  if (url.pathname === "/api/v1/releases") {
    json(res, 200, localReleaseRegistry(), "public, max-age=86400, stale-while-revalidate=604800");
    return;
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
    const workspace = selectedWorkspace(server);
    if (!workspace) {
      json(res, 404, { error: { code: "server_not_found", message: "Server not found" } });
      return;
    }
    const tail = decodePath(encodedTail);
    if (!tail) {
      json(res, 400, { error: { code: "invalid_path", message: "Invalid URL encoding" } });
      return;
    }
    if (tail.length === 1 && tail[0] === "release") {
      sendFile(req, res, path.join(workspace.releaseRoot, "release.json"));
      return;
    }
    if (tail[0] === "sources" && tail[1] === "tree" && tail.length === 2) {
      const sourceTreeFile = path.join(workspace.metadataRoot, "source-index", "tree.json");
      if (!fs.existsSync(sourceTreeFile)) throw new Error(`Source tree is missing: ${sourceTreeFile}`);
      sendFile(req, res, sourceTreeFile);
      return;
    }
    if (tail[0] === "sources" && tail[1] !== undefined && ["Assets", "Packages"].includes(tail[1])) {
      const file = safeFile(path.join(workspace.metadataRoot, "sources"), `${tail.slice(1).join("/")}.json`);
      if (file) {
        sendFile(req, res, file);
      } else {
        json(res, 404, {
          error: { code: "source_not_found", message: "Unity source not found" },
        });
      }
      return;
    }

    serveCatalogStorageApi(req, res, url, workspace, tail);
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
    const file = workspace ? localReleaseFile(workspace, url.pathname) : null;
    if (file && fs.existsSync(file)) {
      sendFile(req, res, file, "public, max-age=604800");
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
    json(res, 404, { error: { code: "not_found", message: "Route not found" } });
    return;
  }

  const staticFile = safeFile(DIST, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
  if (staticFile) {
    sendFile(req, res, staticFile, "no-cache");
    return;
  }
  const applicationEntry = safeFile(DIST, "index.html");
  if (applicationEntry) {
    sendFile(req, res, applicationEntry, "no-cache");
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
  });
