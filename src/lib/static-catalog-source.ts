import fs from "node:fs";
import nodePath from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { openReleaseCatalog, ReleaseCatalogError, type ReleaseCatalog } from "../server/release-catalog";

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
type StaticCatalogHttpDiagnostics = Record<string, string | number | boolean>;
class StaticCatalogHttpError extends Error {
  constructor(
    readonly status: number,
    path: string,
    server: string,
    readonly diagnostics: StaticCatalogHttpDiagnostics,
  ) {
    super(`Static catalog request failed for ${server}/${path.split("?")[0]} (${status}) ${JSON.stringify(diagnostics)}`);
  }
}

const releasePromises = new Map<string, Promise<StaticCatalogRelease>>();
const requestPromises = new Map<string, Promise<unknown>>();
const localCatalogs = new Map<string, ReleaseCatalog | null>();

function localCatalog(server: string): ReleaseCatalog | null {
  if (process.env.STATIC_CATALOG_SOURCE === "http") return null;
  if (localCatalogs.has(server)) return localCatalogs.get(server) || null;
  const pointer = nodePath.join(process.cwd(), "data", "servers", server, "current.json");
  const catalog = process.env.RESOURCE_RELEASE_ROOT || fs.existsSync(pointer) ? openReleaseCatalog(server) : null;
  localCatalogs.set(server, catalog);
  return catalog;
}

function readLocalPath(catalog: ReleaseCatalog, route: string): unknown {
  const url = new URL(route, "https://catalog.invalid/");
  const parts = url.pathname.slice(1).split("/").map(decodeURIComponent);
  const [resource, action, name, id] = parts;
  if (resource === "ui-marks" && parts.length === 1) return catalog.readUiMarks();
  if (resource === "sources" && parts.length > 1) return catalog.readSource(parts.slice(1).join("/"));
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
  const url = new URL(`/api/v1/servers/${encodeURIComponent(server)}/${path.replace(/^\/+/, "")}`, ORIGIN);
  if (releaseId) url.searchParams.set("release", releaseId);
  else url.searchParams.set("__static_catalog_build", BUST);
  return url.toString();
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

async function fetchResponse(
  path: string,
  server: string,
  releaseId?: string,
  method = "GET",
  sourceId?: string,
): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(staticCatalogUrl(path, server, releaseId), {
        headers: headers(),
        method,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt > 0) {
        throw new Error(`Static catalog request failed for ${server}/${path.split("?")[0]}`, { cause: error });
      }
      await wait(1500);
      continue;
    }
    if (response.ok) return response;
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
      } else if (attempt > 0 || !RETRYABLE.has(response.status)) {
        diagnostics = await boundedErrorBody(response).catch(() => ({ errorBody: "unreadable" }));
      }
    } finally {
      await releaseResponseBody(response);
    }
    if (attempt === 0 && RETRYABLE.has(response.status)) {
      await wait(1500);
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
  return `${server}\u0000${release?.releaseId || "current"}\u0000${release?.sourceId || ""}\u0000${path}`;
}

async function fetchJson(path: string, server: string, release?: StaticCatalogRelease): Promise<unknown> {
  const key = requestKey(path, server, release);
  let pending = requestPromises.get(key);
  if (!pending) {
    pending = (async () => {
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
      const response = await fetchResponse(path, server, release?.releaseId, "GET", release?.sourceId);
      try {
        observedRelease(response, release);
        const value: unknown = await response.json();
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
      } catch (error) {
        await releaseResponseBody(response);
        throw error;
      }
    })();
    requestPromises.set(key, pending);
  }
  try {
    return await pending;
  } catch (error) {
    requestPromises.delete(key);
    throw error;
  }
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
  const existing = releasePromises.get(server);
  if (existing) return existing;
  const promise = (async () => {
    const local = localCatalog(server);
    if (local) return Object.freeze({ ...local.identity });
    const response = await fetchResponse("release?projection=identity", server, undefined, "HEAD");
    try {
      const releaseId = response.headers.get("x-haneoka-release-id") || "";
      const sourceId = response.headers.get("x-haneoka-source-id") || "";
      if (!RELEASE_ID_PATTERN.test(releaseId) || !SOURCE_ID_PATTERN.test(sourceId)) {
        throw new Error(`Static catalog returned an invalid release identity for ${server}`);
      }
      return Object.freeze({ server, releaseId, sourceId });
    } finally {
      await releaseResponseBody(response);
    }
  })();
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
      return readLocalPath(local, path);
    } catch (error) {
      if (!(error instanceof ReleaseCatalogError) || !error.fallbackToHttp) throw error;
    }
  }
  return fetchJson(path, server, pinned);
}

/** Fetches an explicitly optional collection and records why it was absent. */
export async function fetchOptionalStaticCatalog(
  path: string,
  server = "intl",
  release?: StaticCatalogRelease,
): Promise<OptionalStaticCatalogResult> {
  try {
    return { value: await fetchStaticCatalog(path, server, release) };
  } catch (error) {
    if (!(error instanceof StaticCatalogHttpError || error instanceof ReleaseCatalogError) || error.status !== 404)
      throw error;
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`Static catalog: optional ${server}/${path.split("?")[0]} absent (${reason})`);
    return { value: null, reason };
  }
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
  const items = new Map<string, Record<string, unknown>>();
  if (!ids.length) return items;
  const pinned = release || (await staticCatalogRelease(server));
  const size = 80;
  for (let start = 0; start < ids.length; start += size) {
    const query = ids
      .slice(start, start + size)
      .map((id) => `id=${encodeURIComponent(id)}`)
      .join("&");
    const document = asRecord(await fetchStaticCatalog(`${resource}?${query}`, server, pinned));
    if (!document || !asRecord(document.items)) {
      throw new Error(`Static catalog returned an invalid ${resource} batch response`);
    }
    for (const [id, value] of Object.entries(asRecord(document.items) || {})) {
      const record = asRecord(value);
      if (record) items.set(id, record);
    }
    const missing = ids.slice(start, start + size).filter((id) => !items.has(id));
    if (missing.length)
      throw new StaticCatalogConsistencyError(`Static catalog ${resource} batch omitted: ${missing.join(", ")}`);
  }
  // Cross-server page details request these same full entities after payload batches.
  // Seed only complete batches; keep the batch caller's objects independent.
  if (["cards", "support-cards", "songs", "events"].includes(resource)) {
    for (const id of new Set(ids)) {
      const key = requestKey(`${resource}/${encodeURIComponent(id)}`, server, pinned);
      if (!requestPromises.has(key)) requestPromises.set(key, Promise.resolve(structuredClone(items.get(id)!)));
    }
  }
  return items;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
