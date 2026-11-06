import { fetchCurrentTeamBuilderIdentity } from "../team-builder/data/fetch";
import type { CrossCatalogIdentity, CrossCatalogResource, OfficialCatalogServer } from "./catalog";
import { crossCatalogApi } from "./definitions";
import { visibleContentServers } from "../content-visibility";
import { isPublicReleaseServer } from "../temporary-public-routing";
import { eventSongReleases, type EventSongReleases } from "../event-song-release";

interface Pending {
  controller: AbortController;
  promise: Promise<unknown>;
  observers: number;
  settled: boolean;
}
interface CachedDocument {
  value: unknown;
  bytes: number;
}
interface CurrentIdentity {
  value: CrossCatalogIdentity;
  observedAt: number;
}
type PublicDocumentResource = CrossCatalogResource | "live-tools";
export interface CrossServerPublicCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  identityFreshMs?: number;
  identityStaleMs?: number;
  now?: () => number;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Public JSON only. Stored values stay private; every observer receives a clone. */
export class CrossServerPublicCache {
  private documents = new Map<string, CachedDocument>();
  private pending = new Map<string, Pending>();
  private identities = new Map<OfficialCatalogServer, CurrentIdentity>();
  private bytes = 0;
  private maxEntries: number;
  private maxBytes: number;
  private identityFreshMs: number;
  private identityStaleMs: number;
  private now: () => number;

  constructor(private fetcher: typeof fetch, options: CrossServerPublicCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 48;
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    this.identityFreshMs = options.identityFreshMs ?? 5000;
    this.identityStaleMs = options.identityStaleMs ?? 30000;
    this.now = options.now ?? Date.now;
    for (const value of [this.maxEntries, this.maxBytes, this.identityFreshMs, this.identityStaleMs])
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Invalid public cache limit");
    if (this.identityStaleMs < this.identityFreshMs) throw new RangeError("Invalid identity cache lifetime");
  }

  private observe(key: string, load: (signal: AbortSignal) => Promise<unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    let request = this.pending.get(key);
    if (!request || request.controller.signal.aborted) {
      if (this.pending.size >= 128) throw new Error("Public data request budget exceeded");
      const controller = new AbortController();
      const started: Pending = { controller, observers: 0, settled: false, promise: Promise.resolve() };
      started.promise = Promise.resolve().then(() => load(controller.signal)).finally(() => {
        started.settled = true;
        if (this.pending.get(key) === started) this.pending.delete(key);
      });
      this.pending.set(key, started);
      request = started;
    }
    const shared = request;
    shared.observers++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return false;
        finished = true;
        signal?.removeEventListener("abort", abort);
        shared.observers--;
        if (!shared.settled && shared.observers === 0) shared.controller.abort();
        return true;
      };
      const abort = () => { if (finish()) reject(signal!.reason); };
      signal?.addEventListener("abort", abort, { once: true });
      // Covers an abort between the initial check and listener registration.
      if (signal?.aborted) abort();
      shared.promise.then(
        (value) => {
          if (!finish()) return;
          try { resolve(structuredClone(value)); } catch (error) { reject(error); }
        },
        (error) => { if (finish()) reject(error); },
      );
    });
  }

  private store(key: string, value: unknown, bytes: number) {
    if (!this.maxEntries || bytes > this.maxBytes) return;
    const previous = this.documents.get(key);
    if (previous) { this.bytes -= previous.bytes; this.documents.delete(key); }
    this.documents.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.documents.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.documents.entries().next().value;
      if (!oldest) break;
      this.documents.delete(oldest[0]);
      this.bytes -= oldest[1].bytes;
    }
  }

  async readIdentity(server: OfficialCatalogServer, signal?: AbortSignal, revalidate = false): Promise<CrossCatalogIdentity> {
    if (!visibleContentServers([server]).length) throw new Error("Source access is unavailable");
    signal?.throwIfAborted();
    if (!isPublicReleaseServer(server)) {
      const value = await fetchCurrentTeamBuilderIdentity(server, signal, this.fetcher);
      signal?.throwIfAborted();
      if (!visibleContentServers([server]).length) throw new Error("Source access is unavailable");
      return { ...value, server };
    }
    const current = this.identities.get(server);
    const age = current ? this.now() - current.observedAt : Infinity;
    const load = async (sharedSignal: AbortSignal) => {
      const value = await fetchCurrentTeamBuilderIdentity(server, sharedSignal, this.fetcher);
      sharedSignal.throwIfAborted();
      const identity: CrossCatalogIdentity = { ...value, server };
      this.identities.set(server, { value: identity, observedAt: this.now() });
      return identity;
    };
    const key = JSON.stringify(["current", server]);
    if (current && age >= 0 && age < this.identityStaleMs) {
      if (age >= this.identityFreshMs) {
        if (revalidate) return await this.observe(key, load, signal) as CrossCatalogIdentity;
        // A background observer holds only this public identity request alive.
        void this.observe(key, load).catch(() => { /* The original observation expires after identityStaleMs. */ });
      }
      return structuredClone(current.value);
    }
    return await this.observe(key, load, signal) as CrossCatalogIdentity;
  }

  private async readDocument(resource: PublicDocumentResource, identity: CrossCatalogIdentity, id?: string, signal?: AbortSignal, ids?: readonly string[]) {
    if (!visibleContentServers([identity.server]).length) throw new Error("Source access is unavailable");
    signal?.throwIfAborted();
    const path = `/api/v1/servers/${identity.server}/${resource === "live-tools" ? resource : crossCatalogApi(resource)}${id === undefined ? "" : `/${encodeURIComponent(id)}`}`;
    const query = new URLSearchParams({ release: identity.releaseId });
    for (const value of ids || []) query.append("id", value);
    const key = JSON.stringify([identity.server, identity.releaseId, identity.sourceId, path, ids || []]);
    const publicSource = isPublicReleaseServer(identity.server);
    const cached = publicSource ? this.documents.get(key) : undefined;
    if (cached) {
      this.documents.delete(key);
      this.documents.set(key, cached);
      const value = structuredClone(cached.value);
      signal?.throwIfAborted();
      return value;
    }
    const load = async (requestSignal?: AbortSignal) => {
      const fetcher = this.fetcher;
      const response = await fetcher(`${path}?${query}`, {
        // Public pinned URLs may use the HTTP cache.
        signal: requestSignal,
        ...(publicSource ? {} : { cache: "no-store" as const }),
      });
      if (!response.ok) throw new Error(`Cross-server data unavailable:${path}/${response.status}`);
      if (response.headers.get("x-haneoka-release-id") !== identity.releaseId ||
          response.headers.get("x-haneoka-source-id") !== identity.sourceId)
        throw new Error("Cross-server data release mismatch");
      const text = await response.text();
      requestSignal?.throwIfAborted();
      const value: unknown = JSON.parse(text);
      if (!object(value) && !(id === undefined && Array.isArray(value))) throw new Error("Cross-server data must be an object");
      if (id !== undefined && !Object.keys(value).length) throw new Error("Cross-server entity is empty");
      requestSignal?.throwIfAborted();
      if (publicSource) this.store(key, value, new TextEncoder().encode(text).byteLength);
      else if (!visibleContentServers([identity.server]).length) throw new Error("Source access is unavailable");
      return value;
    };
    return publicSource ? this.observe(key, load, signal) : load(signal);
  }
  async readEventSongReleases(identity: CrossCatalogIdentity, signal?: AbortSignal): Promise<EventSongReleases> {
    if (!visibleContentServers([identity.server]).length) throw new Error("Source access is unavailable");
    signal?.throwIfAborted();
    const key = JSON.stringify(["event-song-releases", identity]);
    const cached = isPublicReleaseServer(identity.server) ? this.documents.get(key) : undefined;
    if (cached) return structuredClone(cached.value) as EventSongReleases;
    return await this.observe(key, async (requestSignal) => {
      const query = new URLSearchParams({ release: identity.releaseId, v: "4" });
      const fetcher = this.fetcher;
      let response = await fetcher(`/api/v1/servers/${identity.server}/song-release-times?release=${identity.releaseId}`, { signal: requestSignal });
      if (response.status === 404) {
        await response.body?.cancel();
        response = await fetcher(`/api/v1/team-builder/${identity.server}?${query}`, { signal: requestSignal });
      }
      if (!response.ok) throw new Error("Event songs are unavailable");
      const data = await response.json() as { identity: CrossCatalogIdentity; releases?: EventSongReleases; events?: unknown; challengeMusicTable?: { rows: unknown[] } };
      if (data.identity.server !== identity.server || data.identity.releaseId !== identity.releaseId || data.identity.sourceId !== identity.sourceId)
        throw new Error("Event song release mismatch");
      const releases = data.releases ?? eventSongReleases(data.events, data.challengeMusicTable?.rows);
      if (isPublicReleaseServer(identity.server)) this.store(key, releases, JSON.stringify(releases).length);
      return releases;
    }, signal) as EventSongReleases;
  }

  readCollection(resource: PublicDocumentResource, identity: CrossCatalogIdentity, signal?: AbortSignal) {
    return this.readDocument(resource, identity, undefined, signal);
  }
  readEntity(resource: CrossCatalogResource, identity: CrossCatalogIdentity, id: string, signal?: AbortSignal) {
    return this.readDocument(resource, identity, id, signal);
  }
  readEntities(resource: CrossCatalogResource, identity: CrossCatalogIdentity, ids: readonly string[], signal?: AbortSignal) {
    return this.readDocument(resource, identity, undefined, signal, ids);
  }
}

// Fetcher isolation keeps fixture providers and different hosts out of each other's cache.
const caches = new WeakMap<typeof fetch, CrossServerPublicCache>();
export function crossServerPublicCache(fetcher: typeof fetch = fetch) {
  let cache = caches.get(fetcher);
  if (!cache) { cache = new CrossServerPublicCache(fetcher); caches.set(fetcher, cache); }
  return cache;
}
