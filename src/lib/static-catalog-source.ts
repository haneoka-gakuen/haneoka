// L3 — GEB
// Input: 资源请求、server、可选固定 release 和构建环境。
// Output: 目录／实体 JSON、批量记录及来源一致性错误。
// Pos: [Map](L2-2.md)；构建期目录读取与固定身份边界。
// Effects/Dependencies: Node 文件读取、HTTP 请求与正文超时重试、内存请求缓存及静态输入捕获；回退受身份策略约束。
import {
  projectCriSources,
  mergeCriSourceTree,
  criSourceDescriptor,
  criSourceShard,
  type CriSourceProjection,
} from "./asset-page-data";
import { withUiMarksProjection } from "./ui-marks";
import { isPublicReleaseServer } from "./temporary-public-routing";
import { fnv1a32Shard } from "./hash-partition.ts";
import fs from "node:fs";
import nodePath from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { CapturedInputError, staticBuildJson } from "../server/static-input-store";
import { openReleaseCatalog, ReleaseCatalogError, type ReleaseCatalog } from "../server/release-catalog";
import { publicStampManifest } from "./stamp-maker/public-manifest";

/**
 * Build-time access to the release catalog API.
 *
 * A build first pins one immutable release per server through the release
 * endpoint. Every later request carries that release id, including batches,
 * so a current-pointer flip cannot mix documents from two releases.
 *
 * STATIC_CATALOG_ORIGIN points the fetches at another host (a workers.dev
 * mirror or an origin hostname outside edge mitigation); STATIC_CATALOG_TOKEN
 * is sent as `x-haneoka-build-token` for an edge rule that lets builds pass.
 */
const ORIGIN = (process.env.STATIC_CATALOG_ORIGIN || "https://haneoka.org").replace(/\/+$/, "");
const TOKEN = process.env.STATIC_CATALOG_TOKEN || "";
const BUST = `static-catalog-${Date.now()}`;
const RETRYABLE = new Set([403, 429, 500, 502, 503, 504]);
const RELEASE_ID_PATTERN = /^r-[a-f0-9]{20}$/u;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_ATTEMPTS = 3;
const ERROR_BODY_BYTES = 4096;
const ERROR_BODY_TIMEOUT_MS = 1000;

const headers = (): HeadersInit => ({
  accept: "application/json",
  ...(TOKEN ? { "x-haneoka-build-token": TOKEN } : {}),
});

export type RecordValue = Record<string, unknown>;

export interface StaticCatalogRelease {
  readonly server: string;
  readonly releaseId: string;
  readonly sourceId: string;
}

export interface OptionalStaticCatalogResult {
  readonly value: unknown | null;
  readonly reason?: string;
}

class StaticCatalogConsistencyError extends Error {}
export function assertStaticServer(server: string): void {
  if (!isPublicReleaseServer(server))
    throw new StaticCatalogConsistencyError("Static catalogs require a public release server");
}
type StaticCatalogHttpDiagnostics = Record<string, string | number | boolean>;
class StaticCatalogHttpError extends Error {
  constructor(
    readonly status: number,
    path: string,
    server: string,
    readonly diagnostics: StaticCatalogHttpDiagnostics,
  ) {
    super(
      `Static catalog request failed for ${server}/${path.split("?")[0]} (${status}) ${JSON.stringify(diagnostics)}`,
    );
  }
}

const releasePromises = new Map<string, Promise<StaticCatalogRelease>>();
const requestPromises = new Map<string, Promise<unknown>>();
const localCatalogs = new Map<string, ReleaseCatalog | null>();
const releaseEntries = new WeakMap<RecordValue, Map<string, RecordValue>>();
const blobMetrics = { hits: 0, fetches: 0, hitBytes: 0, fetchedBytes: 0 };
export const staticCatalogBlobMetrics = () => ({ ...blobMetrics });
const jsonMetrics = { httpRequests: 0, reusedBatches: 0, reusedCacheBytes: 0 };
export const staticCatalogJsonMetrics = () => ({ ...jsonMetrics });
const previousManifests = new Map<string, RecordValue | undefined>();

function releaseManifestEntry(manifest: RecordValue, relative: string): RecordValue | undefined {
  let entries = releaseEntries.get(manifest);
  if (!entries) {
    entries = new Map();
    for (const value of Array.isArray(manifest.entries) ? manifest.entries : []) {
      const entry = asRecord(value);
      if (typeof entry?.path === "string" && !entries.has(entry.path)) entries.set(entry.path, entry);
    }
    releaseEntries.set(manifest, entries);
  }
  return entries.get(relative);
}

function localCatalog(server: string): ReleaseCatalog | null {
  assertStaticServer(server);
  if (process.env.CATALOG_PAGE_RELEASE_ROOTS) {
    if (localCatalogs.has(server)) return localCatalogs.get(server) || null;
    const roots = JSON.parse(process.env.CATALOG_PAGE_RELEASE_ROOTS) as Record<string, string>;
    if (!roots[server]) throw new Error(`Missing snapshot release root: ${server}`);
    const catalog = openReleaseCatalog(server, { releaseRoot: roots[server] });
    localCatalogs.set(server, catalog);
    return catalog;
  }
  if (process.env.STATIC_CATALOG_SOURCE === "http") return null;
  if (localCatalogs.has(server)) return localCatalogs.get(server) || null;
  const pointer = nodePath.join(process.cwd(), "data", "servers", server, "current.json");
  const catalog = process.env.RESOURCE_RELEASE_ROOT || fs.existsSync(pointer) ? openReleaseCatalog(server) : null;
  localCatalogs.set(server, catalog);
  return catalog;
}
export const hasLocalStaticCatalog = (server: string): boolean => localCatalog(server) !== null;

const localCriSources = new WeakMap<ReleaseCatalog, CriSourceProjection>();
function readLocalCriSources(catalog: ReleaseCatalog): CriSourceProjection {
  let projection = localCriSources.get(catalog);
  if (!projection) {
    projection = projectCriSources(
      catalog.releaseEntry("metadata/cri.json") ? catalog.readReleaseJson("metadata/cri.json") : null,
    );
    localCriSources.set(catalog, projection);
  }
  return projection;
}

function readLocalPath(catalog: ReleaseCatalog, route: string): unknown {
  const url = new URL(route, "https://catalog.invalid/");
  const parts = url.pathname.slice(1).split("/").map(decodeURIComponent);
  const [resource, action, name, id] = parts;
  if (resource === "stamps" && action === "textless" && parts.length === 2)
    return publicStampManifest(catalog.readReleaseJson("runtime/stamp-maker/manifest.json"), {
      server: catalog.identity.server, sourceId: catalog.identity.sourceId,
      stampIds: new Set(Object.keys(catalog.readCollection("stamps") as Record<string, unknown>)),
    });
  if (resource === "ui-marks" && parts.length === 1) return catalog.readUiMarks();
  if (resource === "sources" && parts.length > 1) {
    const projection = readLocalCriSources(catalog);
    if (action === "tree" && parts.length === 2)
      return mergeCriSourceTree(
        catalog.readReleaseJson("metadata/source-index/tree.json") as Record<
          string,
          import("./source-tree-search").SourceNode
        >,
        projection.index.paths,
      );
    const path = parts.slice(1).join("/");
    const entry = projection.shards[criSourceShard(path)]![path];
    if (path.startsWith("CRI/") && entry) return criSourceDescriptor(path, entry);
    const descriptor = catalog.readSource(path);
    return entry
      ? { ...descriptor, outputs: [...((descriptor.outputs as unknown[]) || []), ...entry.outputs] }
      : descriptor;
  }
  if (resource === "catalog") {
    return action === "summary" ? catalog.readSummary() : catalog.manifest.document;
  }
  if (parts.length === 1) {
    const ids = url.searchParams.getAll("id");
    if (!ids.length) return catalog.readCollection(resource!);
    const batch = catalog.readEntities(resource!, ids);
    return { items: Object.fromEntries(batch.items), missing: batch.missing };
  }
  if (action === "views" && name) {
    if (id) return catalog.readViewEntity(resource!, name, id);
    const ids = url.searchParams.getAll("id");
    if (!ids.length) return catalog.readView(resource!, name);
    const items: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const key of ids) {
      const entity = catalog.readViewEntity(resource!, name, key);
      if (entity) items[key] = entity;
      else missing.push(key);
    }
    return { items, missing };
  }
  if (action === "relations" && name && id) return catalog.readRelation(resource!, name, id);
  if (parts.length === 2 && action) return catalog.requireEntity(resource!, action);
  throw new Error(`Unsupported build catalog route: ${route}`);
}

export function staticCatalogUrl(path: string, server = "intl", releaseId?: string): string {
  assertStaticServer(server);
  const url = new URL(`/api/v1/servers/${encodeURIComponent(server)}/${path.replace(/^\/+/, "")}`, ORIGIN);
  if (releaseId) url.searchParams.set("release", releaseId);
  else url.searchParams.set("__static_catalog_build", BUST);
  return withUiMarksProjection(url.toString());
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function releaseResponseBody(response: Response): Promise<void> {
  // Lit SSR installs node-fetch, whose body is a Node readable rather than a Web stream.
  const body = response.body as { destroy?: () => void; cancel?: () => Promise<void> } | null;
  if (!body) return;
  if (typeof body.destroy === "function") {
    body.destroy();
  } else if (!response.bodyUsed) {
    if (typeof body.cancel === "function") await body.cancel();
    else await response.arrayBuffer();
  }
}

const safeDiagnosticId = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value) ? value : undefined;

function errorBodyFields(value: unknown): StaticCatalogHttpDiagnostics {
  const error = asRecord(asRecord(value)?.error);
  const code = error?.code;
  const requestId = safeDiagnosticId(error?.requestId);
  return {
    ...(typeof code === "string" && /^[a-z][a-z0-9_]{0,79}$/u.test(code) ? { errorCode: code } : {}),
    ...(requestId ? { bodyRequestId: requestId } : {}),
  };
}

/** Read only a small complete JSON error; never include response text in logs. */
async function boundedErrorBody(response: Response): Promise<StaticCatalogHttpDiagnostics> {
  if (!response.body || !response.headers.get("content-type")?.includes("application/json"))
    return { errorBody: "not-json-or-empty" };
  const stream = response.body as ReadableStream<Uint8Array> | Readable;
  const reader = ("getReader" in stream ? stream : Readable.toWeb(stream)).getReader();
  const bytes = Buffer.alloc(ERROR_BODY_BYTES);
  let length = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, ERROR_BODY_TIMEOUT_MS);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) return { errorBody: "timeout" };
      if (done) return { errorBody: "json", ...errorBodyFields(JSON.parse(bytes.toString("utf8", 0, length))) };
      const chunk = value as Uint8Array;
      const take = Math.min(chunk.length, ERROR_BODY_BYTES - length);
      bytes.set(chunk.subarray(0, take), length);
      length += take;
      if (take < chunk.length || length === ERROR_BODY_BYTES) return { errorBody: "byte-limit" };
    }
  } catch {
    return { errorBody: "unreadable-or-invalid-json" };
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function httpDiagnostics(
  response: Response,
  path: string,
  releaseId?: string,
  sourceId?: string,
): StaticCatalogHttpDiagnostics {
  const route = new URL(path, "https://catalog.invalid/");
  const requestId = safeDiagnosticId(response.headers.get("x-request-id"));
  const ray = safeDiagnosticId(response.headers.get("cf-ray"));
  const observedReleaseId = response.headers.get("x-haneoka-release-id") || "";
  const observedSourceId = response.headers.get("x-haneoka-source-id") || "";
  return {
    routeHash: createHash("sha256").update(path).digest("hex"),
    idCount: route.searchParams.getAll("id").length,
    ...(releaseId && RELEASE_ID_PATTERN.test(releaseId) ? { expectedReleaseId: releaseId } : {}),
    ...(sourceId && SOURCE_ID_PATTERN.test(sourceId) ? { expectedSourceId: sourceId } : {}),
    ...(RELEASE_ID_PATTERN.test(observedReleaseId) ? { observedReleaseId } : {}),
    ...(SOURCE_ID_PATTERN.test(observedSourceId) ? { observedSourceId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(ray ? { cfRay: ray } : {}),
  };
}

async function fetchResponse<T>(
  path: string,
  server: string,
  read: (response: Response) => T | Promise<T>,
  releaseId?: string,
  method = "GET",
  sourceId?: string,
  absoluteUrl?: string,
): Promise<T> {
  for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
    const retry = attempt + 1 < REQUEST_ATTEMPTS;
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS * (attempt === 0 ? 1 : 2));
    let response: Response;
    try {
      response = await fetch(absoluteUrl || staticCatalogUrl(path, server, releaseId), {
        headers: headers(),
        method,
        signal,
      });
    } catch (error) {
      if (!retry) {
        throw new Error(`Static catalog request failed for ${server}/${path.split("?")[0]}`, { cause: error });
      }
      await wait(1500 * (attempt + 1));
      continue;
    }
    if (response.ok) {
      try {
        return await read(response);
      } catch (error) {
        if (!signal.aborted || !(error instanceof Error) || !["AbortError", "TimeoutError"].includes(error.name))
          throw error;
        if (!retry)
          throw new Error(`Static catalog response timed out for ${server}/${path.split("?")[0]}`, { cause: error });
      } finally {
        await releaseResponseBody(response);
      }
      await wait(1500 * (attempt + 1));
      continue;
    }
    let diagnostics: StaticCatalogHttpDiagnostics = {};
    try {
      if (response.status === 404 && response.headers.get("content-type")?.includes("application/json")) {
        const body = asRecord(await response.json());
        const error = asRecord(body?.error);
        if (typeof error?.code === "string" && error.code.startsWith("release_identity_")) {
          throw new StaticCatalogConsistencyError(
            `Static catalog release identity failed for ${server}/${path.split("?")[0]}: ${error.code}`,
          );
        }
        diagnostics = errorBodyFields(body);
      } else if (!retry || !RETRYABLE.has(response.status)) {
        diagnostics = await boundedErrorBody(response).catch(() => ({ errorBody: "unreadable" }));
      }
    } finally {
      await releaseResponseBody(response);
    }
    if (retry && RETRYABLE.has(response.status)) {
      await wait(1500 * (attempt + 1));
      continue;
    }
    throw new StaticCatalogHttpError(response.status, path, server, {
      ...httpDiagnostics(response, path, releaseId, sourceId),
      ...diagnostics,
    });
  }
  throw new Error(`Static catalog request exhausted retries for ${server}/${path.split("?")[0]}`);
}

function observedRelease(response: Response, expected?: StaticCatalogRelease): void {
  if (!expected) return;
  const releaseId = response.headers.get("x-haneoka-release-id");
  const sourceId = response.headers.get("x-haneoka-source-id");
  if (releaseId !== expected.releaseId) {
    throw new StaticCatalogConsistencyError(
      `Static catalog release mismatch: expected ${expected.releaseId}, received ${releaseId}`,
    );
  }
  if (sourceId !== expected.sourceId) {
    throw new StaticCatalogConsistencyError(
      `Static catalog source mismatch: expected ${expected.sourceId}, received ${sourceId}`,
    );
  }
}

function requestKey(path: string, server: string, release?: StaticCatalogRelease): string {
  assertStaticServer(server);
  return `${server}\u0000${release?.releaseId || "current"}\u0000${release?.sourceId || ""}\u0000${path}`;
}

async function fetchJson(
  path: string,
  server: string,
  release?: StaticCatalogRelease,
  absoluteUrl?: string,
): Promise<unknown> {
  const key = requestKey(path, server, release);
  let pending = requestPromises.get(key);
  if (!pending) {
    pending = staticBuildJson(`native-json:${key}`, "native-catalog", async () => {
      const cacheFile = release ? cachedResponseFile(path, release) : undefined;
      if (cacheFile && fs.existsSync(cacheFile)) {
        try {
          const cached = asRecord(JSON.parse(fs.readFileSync(cacheFile, "utf8")));
          if (
            cached?.path === path &&
            cached.releaseId === release?.releaseId &&
            cached.sourceId === release?.sourceId &&
            "value" in cached
          )
            return cached.value;
        } catch {
          // Interrupted cache writes are rebuilt from the same pinned release.
        }
        console.warn(`Static catalog: rebuilding invalid cache for ${server}/${path.split("?")[0]}`);
      }
      const reused = release && !absoluteUrl ? await reusableBatch(path, release) : undefined;
      if (!reused) jsonMetrics.httpRequests++;
      const value: unknown = reused ? reused.value : await fetchResponse(path, server, (response) => {
        observedRelease(response, release);
        return response.json();
      }, release?.releaseId, "GET", release?.sourceId, absoluteUrl);
      if (cacheFile && release) {
        const temporary = `${cacheFile}.${process.pid}.tmp`;
        try {
          fs.mkdirSync(nodePath.dirname(cacheFile), { recursive: true });
          fs.writeFileSync(
            temporary,
            JSON.stringify({ path, releaseId: release.releaseId, sourceId: release.sourceId, value }),
          );
          fs.renameSync(temporary, cacheFile);
        } catch (error) {
          console.warn(`Static catalog: could not save cache for ${server}/${path.split("?")[0]}`, error);
          try {
            fs.rmSync(temporary, { force: true });
          } catch {
            /* Cache persistence is optional. */
          }
        }
      }
      return value;
    });
    requestPromises.set(key, pending);
  }
  try {
    return await pending;
  } catch (error) {
    requestPromises.delete(key);
    throw error;
  }
}

/** Batch documents contain only the selected immutable entity-shard values. */
async function reusableBatch(
  route: string,
  release: StaticCatalogRelease,
): Promise<{ value: RecordValue } | undefined> {
  const url = new URL(route, "https://catalog.invalid/");
  const resource = url.pathname.slice(1),
    ids = url.searchParams.getAll("id");
  if (!/^[a-z][a-z0-9-]*$/u.test(resource) || !ids.length || [...url.searchParams.keys()].some((key) => key !== "id"))
    return undefined;
  const directory = nodePath.dirname(nodePath.dirname(cachedResponseFile(route, release)));
  if (!fs.existsSync(directory)) return undefined;
  const previous = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && RELEASE_ID_PATTERN.test(entry.name) && entry.name !== release.releaseId);
  if (!previous.length) return undefined;
  const catalog = asRecord(await fetchJson("catalog", release.server, release)),
    storage = asRecord(asRecord(asRecord(catalog?.resources)?.[resource])?.entities),
    prefix = storage?.prefix;
  if (
    catalog?.schema !== "haneoka-catalog-storage-v2" ||
    catalog.server !== release.server ||
    catalog.sourceId !== release.sourceId ||
    asRecord(catalog.partition)?.algorithm !== "fnv1a32-mod-256" ||
    asRecord(catalog.partition)?.shards !== 256 ||
    typeof prefix !== "string" ||
    !/^api\/v1\/catalog\/[a-z0-9-]+\/entities\/$/u.test(prefix) ||
    !Array.isArray(storage?.shards) ||
    ids.some((id) => !(storage.shards as unknown[]).includes(fnv1a32Shard(id)))
  )
    return undefined;
  const current = asRecord(await fetchJson("release", release.server, release));
  if (
    current?.server !== release.server ||
    current.releaseId !== release.releaseId ||
    current.sourceId !== release.sourceId
  )
    throw new StaticCatalogConsistencyError("Batch cache release manifest identity mismatch");
  const paths = ["api/v1/catalog/manifest.json", ...new Set(ids.map((id) => `${prefix}${fnv1a32Shard(id)}.json`))];
  for (const entry of previous) {
    const oldRelease = { server: release.server, releaseId: entry.name, sourceId: "" },
      file = cachedResponseFile(route, oldRelease);
    if (!fs.existsSync(file)) continue;
    const manifestFile = cachedResponseFile("release", oldRelease);
    if (!previousManifests.has(manifestFile)) {
      let manifest: RecordValue | undefined;
      try {
        const wrapper = asRecord(JSON.parse(fs.readFileSync(manifestFile, "utf8"))),
          value = asRecord(wrapper?.value);
        if (
          wrapper?.path === "release" &&
          wrapper.releaseId === entry.name &&
          wrapper.sourceId === value?.sourceId &&
          value?.server === release.server &&
          value.releaseId === entry.name &&
          Array.isArray(value.entries)
        )
          manifest = value;
      } catch {
        /* An unavailable historical cache is rebuilt through the current API. */
      }
      previousManifests.set(manifestFile, manifest);
    }
    const manifest = previousManifests.get(manifestFile);
    if (!manifest) continue;
    if (
      !paths.every((path) => {
        const old = releaseManifestEntry(manifest, path),
          now = releaseManifestEntry(current, path);
        return (
          old &&
          now &&
          typeof now.sha256 === "string" &&
          /^[a-f0-9]{64}$/u.test(now.sha256) &&
          Number.isSafeInteger(now.bytes) &&
          old.sha256 === now.sha256 &&
          old.bytes === now.bytes
        );
      })
    )
      continue;
    let cached: RecordValue | undefined, bytes: number;
    try {
      const body = fs.readFileSync(file);
      bytes = body.length;
      cached = asRecord(JSON.parse(body.toString("utf8")));
    } catch {
      continue;
    }
    const value = asRecord(cached?.value),
      items = asRecord(value?.items);
    if (
      cached?.path !== route ||
      cached.releaseId !== entry.name ||
      cached.sourceId !== manifest.sourceId ||
      !items ||
      !Array.isArray(value?.missing) ||
      value.missing.length ||
      ids.some((id) => !asRecord(items[id]))
    )
      continue;
    jsonMetrics.reusedBatches++;
    jsonMetrics.reusedCacheBytes += bytes;
    return { value: value! };
  }
  return undefined;
}

function cachedResponseFile(route: string, release: StaticCatalogRelease): string {
  const hash = createHash("sha256").update(route).digest("hex");
  if (!/^[a-z0-9-]+$/u.test(release.server) || !RELEASE_ID_PATTERN.test(release.releaseId))
    throw new StaticCatalogConsistencyError("Invalid cache release identity");
  return nodePath.join(
    process.cwd(),
    "data",
    "static-catalog",
    "v1",
    release.server,
    release.releaseId,
    `${hash}.json`,
  );
}

/** Pins the current release once. All static loaders share this promise. */
export async function staticCatalogRelease(server = "intl"): Promise<StaticCatalogRelease> {
  assertStaticServer(server);
  const existing = releasePromises.get(server);
  if (existing) return existing;
  const promise = staticBuildJson(`native-pin:${server}`, "native-pin", async () => {
    const local = localCatalog(server);
    if (local) return Object.freeze({ ...local.identity });
    return fetchResponse("release?projection=identity", server, (response) => {
      const releaseId = response.headers.get("x-haneoka-release-id") || "";
      const sourceId = response.headers.get("x-haneoka-source-id") || "";
      if (!RELEASE_ID_PATTERN.test(releaseId) || !SOURCE_ID_PATTERN.test(sourceId)) {
        throw new Error(`Static catalog returned an invalid release identity for ${server}`);
      }
      return Object.freeze({ server, releaseId, sourceId });
    }, undefined, "HEAD");
  }).then((pin) => Object.freeze(pin));
  releasePromises.set(server, promise);
  try {
    return await promise;
  } catch (error) {
    releasePromises.delete(server);
    throw error;
  }
}

/** Fetches a required API path from the pinned release. Failures abort the build. */
export async function fetchStaticCatalog(
  path: string,
  server = "intl",
  release?: StaticCatalogRelease,
): Promise<unknown> {
  const pinned = release || (await staticCatalogRelease(server));
  if (pinned.server !== server) {
    throw new StaticCatalogConsistencyError(
      `Static catalog server mismatch: expected ${server}, received ${pinned.server}`,
    );
  }
  const local = localCatalog(server);
  if (local) {
    if (local.identity.releaseId !== pinned.releaseId || local.identity.sourceId !== pinned.sourceId) {
      throw new StaticCatalogConsistencyError(
        `Local catalog identity differs from pinned ${server}/${pinned.releaseId}`,
      );
    }
    try {
      return await staticBuildJson(`native-local:${requestKey(path, server, pinned)}`, "native-catalog", async () =>
        readLocalPath(local, path),
      );
    } catch (error) {
      if (process.env.CATALOG_PAGE_RELEASE_ROOTS || !(error instanceof ReleaseCatalogError) || !error.fallbackToHttp) throw error;
    }
  }
  try {
    return await fetchJson(path, server, pinned);
  } catch (error) {
    const notFound = error instanceof StaticCatalogHttpError && error.status === 404
      || error instanceof CapturedInputError
        && error.message.startsWith(`Static catalog request failed for ${server}/stamps/textless (404) {`);
    if (path !== "stamps/textless" || !notFound)
      throw error;
    if (!(await fetchStaticReleaseEntry("runtime/stamp-maker/manifest.json", server, pinned))) throw error;
    const [manifest, stamps] = await Promise.all([
      fetchStaticReleaseJson("runtime/stamp-maker/manifest.json", server, pinned),
      fetchStaticCatalog("stamps", server, pinned),
    ]);
    return publicStampManifest(manifest, {
      server, sourceId: pinned.sourceId, stampIds: new Set(Object.keys(stamps as Record<string, unknown>)),
    });
  }
}

/** Application projections share the catalog's immutable pin, cache and retry policy. */
export async function fetchStaticApplicationJson(route: string, release: StaticCatalogRelease): Promise<unknown> {
  const url = new URL(route, ORIGIN);
  url.searchParams.set("release", release.releaseId);
  return fetchJson(url.pathname + url.search, release.server, release, url.toString());
}

/** One release file, verified against the release manifest's size and digest. */
async function releaseBytes(relative: string, server: string, pinned: StaticCatalogRelease): Promise<Buffer> {
  const local = localCatalog(server);
  if (local) {
    if (local.identity.releaseId !== pinned.releaseId || local.identity.sourceId !== pinned.sourceId)
      throw new StaticCatalogConsistencyError("Release file identity mismatch");
    return local.readReleaseBytes(relative);
  }
  const manifest = asRecord(await fetchJson("release", server, pinned));
  if (manifest?.server !== server || manifest.releaseId !== pinned.releaseId || manifest.sourceId !== pinned.sourceId)
    throw new StaticCatalogConsistencyError("Release file manifest identity mismatch");
  const entry = releaseManifestEntry(manifest, relative);
  if (
    !entry ||
    typeof entry.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
    !Number.isSafeInteger(entry.bytes)
  )
    throw new StaticCatalogConsistencyError(`Release file not declared: ${relative}`);
  const cacheFile = nodePath.join(
    process.cwd(),
    "data/static-catalog/blobs/v1",
    entry.sha256.slice(0, 2),
    entry.sha256,
  );
  if (fs.existsSync(cacheFile)) {
    try {
      const body = fs.readFileSync(cacheFile);
      if (body.length === entry.bytes && createHash("sha256").update(body).digest("hex") === entry.sha256) {
        blobMetrics.hits++;
        blobMetrics.hitBytes += body.length;
        return body;
      }
    } catch {
      /* Rebuild an unavailable immutable cache entry from the pinned release. */
    }
  }
  const [tree, ...parts] = relative.split("/");
  const url = new URL(`/${tree}/${encodeURIComponent(server)}/${parts.map(encodeURIComponent).join("/")}`, ORIGIN);
  url.searchParams.set("release", pinned.releaseId);
  const body = await fetchResponse(relative, server, async (response) => {
    observedRelease(response, pinned);
    return Buffer.from(await response.arrayBuffer());
  }, pinned.releaseId, "GET", pinned.sourceId, url.toString());
  blobMetrics.fetches++;
  if (body.length !== entry.bytes || createHash("sha256").update(body).digest("hex") !== entry.sha256)
    throw new StaticCatalogConsistencyError(`Release file hash mismatch: ${relative}`);
  blobMetrics.fetchedBytes += body.length;
  const temporary = `${cacheFile}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(nodePath.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(temporary, body);
    fs.renameSync(temporary, cacheFile);
  } catch (error) {
    console.warn(`Static catalog: could not cache release file ${entry.sha256}`, error);
  }
  return body;
}

/** Public file bytes (`assets/…`) verified against the same immutable release manifest. */
export async function fetchStaticReleaseBytes(
  relative: string,
  server: string,
  release: StaticCatalogRelease,
): Promise<Buffer> {
  if (!/^(assets|runtime|objects)\/(?!.*(?:^|\/)\.\.?\/)[^\\?#]+$/u.test(relative))
    throw new StaticCatalogConsistencyError("Invalid public release file path");
  if (release.server !== server) throw new StaticCatalogConsistencyError("Release file server mismatch");
  return releaseBytes(relative, server, release);
}

/** Public JSON bytes verified against the same immutable release manifest. */
export async function fetchStaticReleaseJson(
  relative: string,
  server = "intl",
  release?: StaticCatalogRelease,
): Promise<unknown> {
  if (!/^(assets|runtime|objects)\/(?!.*(?:^|\/)\.\.?\/)[^\\?#]+\.json$/u.test(relative))
    throw new StaticCatalogConsistencyError("Invalid public release JSON path");
  const pinned = release || (await staticCatalogRelease(server));
  if (pinned.server !== server) throw new StaticCatalogConsistencyError("Release JSON server mismatch");
  const key = requestKey(`release-file:${relative}`, server, pinned);
  let pending = requestPromises.get(key);
  if (!pending) {
    pending = staticBuildJson(`native-file:${key}`, "native-file", async () => {
      const local = localCatalog(server);
      if (local) {
        if (local.identity.releaseId !== pinned.releaseId || local.identity.sourceId !== pinned.sourceId)
          throw new StaticCatalogConsistencyError("Release JSON identity mismatch");
        return local.readReleaseJson(relative);
      }
      return JSON.parse((await releaseBytes(relative, server, pinned)).toString("utf8"));
    });
    requestPromises.set(key, pending);
  }
  try {
    return await pending;
  } catch (error) {
    requestPromises.delete(key);
    throw error;
  }
}

export async function fetchStaticReleaseEntry(
  relative: string,
  server = "intl",
  release?: StaticCatalogRelease,
): Promise<{ path: string; bytes: number; sha256: string } | undefined> {
  const pinned = release || (await staticCatalogRelease(server));
  if (
    pinned.server !== server ||
    !relative ||
    relative.startsWith("/") ||
    relative.split("/").some((part) => !part || part === "." || part === "..") ||
    /[\\?#]/u.test(relative)
  )
    throw new StaticCatalogConsistencyError("Invalid release entry identity");
  const local = localCatalog(server);
  if (local) {
    if (local.identity.releaseId !== pinned.releaseId || local.identity.sourceId !== pinned.sourceId)
      throw new StaticCatalogConsistencyError("Release entry identity mismatch");
    return local.releaseEntry(relative);
  }
  const manifest = asRecord(await fetchJson("release", server, pinned));
  if (manifest?.server !== server || manifest.releaseId !== pinned.releaseId || manifest.sourceId !== pinned.sourceId)
    throw new StaticCatalogConsistencyError("Release entry manifest identity mismatch");
  const entry = releaseManifestEntry(manifest, relative);
  if (!entry) return undefined;
  if (
    typeof entry.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
    typeof entry.bytes !== "number" ||
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes < 0
  )
    throw new StaticCatalogConsistencyError("Invalid release entry digest");
  return { path: relative, sha256: entry.sha256, bytes: entry.bytes };
}

/** Fetches an explicitly optional collection and records why it was absent. */
export async function fetchOptionalStaticCatalog(
  path: string,
  server = "intl",
  release?: StaticCatalogRelease,
): Promise<OptionalStaticCatalogResult> {
  assertStaticServer(server);
  const absent = (error: unknown): OptionalStaticCatalogResult => {
    if (!(error instanceof StaticCatalogHttpError || error instanceof ReleaseCatalogError) || error.status !== 404)
      throw error;
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`Static catalog: optional ${server}/${path.split("?")[0]} absent (${reason})`);
    return { value: null, reason };
  };
  let pinned: StaticCatalogRelease;
  try {
    pinned = release || (await staticCatalogRelease(server));
  } catch (error) {
    return absent(error);
  }
  return staticBuildJson(`native-optional:${requestKey(path, server, pinned)}`, "native-optional", async () => {
    try {
      return { value: await fetchStaticCatalog(path, server, pinned) };
    } catch (error) {
      return absent(error);
    }
  });
}

/**
 * Fetches entities by id through the release-pinned batch endpoint. A failed
 * chunk is a required build failure; it cannot silently remove SEO pages.
 */
export async function fetchStaticCatalogBatch(
  resource: string,
  ids: readonly string[],
  server = "intl",
  release?: StaticCatalogRelease,
): Promise<Map<string, Record<string, unknown>>> {
  assertStaticServer(server);
  const items = new Map<string, Record<string, unknown>>();
  if (!ids.length) return items;
  const pinned = release || (await staticCatalogRelease(server));
  const size = 80;
  const requestIds = ids
    .map((id) => ({ id, shard: fnv1a32Shard(id) }))
    .sort((left, right) => left.shard.localeCompare(right.shard, "en"))
    .map(({ id }) => id);
  const batches = Array.from({ length: Math.ceil(ids.length / size) }, (_, index) => index * size);
  const results = new Map<number, Record<string, unknown>>();
  let cursor = 0;
  const loadBatch = async () => {
    while (cursor < batches.length) {
      const start = batches[cursor++]!;
      const selected = requestIds.slice(start, start + size);
      const query = selected.map((id) => `id=${encodeURIComponent(id)}`).join("&");
      const document =
        process.env.STATIC_BUILD_INPUT_MODE === "frozen"
          ? {
              items: Object.fromEntries(
                await Promise.all(
                  [...new Set(selected)].sort().map(async (id) => [
                    id,
                    await staticBuildJson(
                      `native-entity:${requestKey(`${resource}/${encodeURIComponent(id)}`, server, pinned)}`,
                      "native-catalog",
                      async () => {
                        throw new Error("Frozen entity is missing");
                      },
                    ),
                  ]),
                ),
              ),
            }
          : asRecord(await fetchStaticCatalog(`${resource}?${query}`, server, pinned));
      if (!document || !asRecord(document.items)) {
        throw new Error(`Static catalog returned an invalid ${resource} batch response`);
      }
      const batch = asRecord(document.items)!;
      const missing = selected.filter((id) => !asRecord(batch[id]));
      if (missing.length)
        throw new StaticCatalogConsistencyError(`Static catalog ${resource} batch omitted: ${missing.join(", ")}`);
      results.set(start, batch);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, batches.length) }, loadBatch));
  for (const start of batches)
    for (const [id, value] of Object.entries(results.get(start)!)) {
      const record = asRecord(value);
      if (record) items.set(id, record);
    }
  // Cross-server page details request these same full entities after payload batches.
  // Seed only complete batches; keep the batch caller's objects independent.
  for (const id of new Set(ids)) {
    const key = requestKey(`${resource}/${encodeURIComponent(id)}`, server, pinned);
    if (process.env.STATIC_BUILD_INPUT_MODE === "capture") {
      for (const prefix of ["native-entity", "native-json", ...(localCatalog(server) ? ["native-local"] : [])])
        await staticBuildJson(`${prefix}:${key}`, "native-catalog", async () => items.get(id)!);
    }
    if (!requestPromises.has(key)) requestPromises.set(key, Promise.resolve(structuredClone(items.get(id)!)));
  }
  const ordered = new Map<string, Record<string, unknown>>();
  // Retain the API's sorted IDs and JSON integer-key order within each original batch.
  for (const start of batches) {
    const selected = [...new Set(ids.slice(start, start + size))].sort();
    for (const id of Object.keys(Object.fromEntries(selected.map((id) => [id, true])))) ordered.set(id, items.get(id)!);
  }
  return ordered;
}

export async function primeStaticCatalogBatch(
  resource: string,
  ids: readonly string[],
  server: string,
  release: StaticCatalogRelease,
): Promise<void> {
  assertStaticServer(server);
  const missing = ids.filter(
    (id) => !requestPromises.has(requestKey(`${resource}/${encodeURIComponent(id)}`, server, release)),
  );
  if (missing.length) await fetchStaticCatalogBatch(resource, missing, server, release);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
