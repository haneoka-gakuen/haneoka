import {
  createHaneokaClient,
  type HaneokaLocale,
  type HaneokaPage,
  type HaneokaReleaseIdentity,
} from "../../../packages/api-client/src/haneoka";
import type { EmbedFetcher } from "../../../packages/embed-core/src/types";
import { readBytes } from "../../../packages/embed-core/src/io";
import { importSs } from "../../../packages/chart-editor/src/formats/ss";
import { resolveLocalizedText } from "../localized-text";
import { AUDIO_LIMITS } from "./audio";
import { structuredCloneValue } from "../../../packages/chart-editor/src/model";

export interface PublicSongSourceOptions {
  apiBase?: string;
  fetcher?: EmbedFetcher;
}
export interface PublicCreationDifficulty extends Record<string, unknown> {
  difficultyName: string;
  file: string;
  displayLevel?: number;
  playLevel?: number;
}
export interface PublicCreationSong extends Record<string, unknown> {
  musicId: number;
  musicTitle: unknown;
  bandName: unknown;
  musicUrl: string;
  jacketUrl?: string;
  jacketThumbUrl?: string;
  bandId?: number;
  bandIds?: number[];
  musicType?: number;
  vocalCharacterIds?: number[];
  difficulty: PublicCreationDifficulty[];
}
function song(value: unknown): PublicCreationSong {
  if (!value || typeof value !== "object") throw new Error("invalid_song");
  const row = value as PublicCreationSong;
  if (
    !Number.isSafeInteger(row.musicId) ||
    typeof row.musicUrl !== "string" ||
    !Array.isArray(row.difficulty) ||
    row.difficulty.some((entry) => !entry || typeof entry.difficultyName !== "string" || typeof entry.file !== "string")
  )
    throw new Error("invalid_song");
  return row;
}

/** URL identities follow the public server/release contract, including runtime audio. */
export function pinnedPublicUrl(
  path: string,
  identity: HaneokaReleaseIdentity,
  options: PublicSongSourceOptions = {},
): string {
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(identity.server) ||
    !/^r-[a-f0-9]{20}$/u.test(identity.releaseId) ||
    !identity.sourceId
  )
    throw new Error("invalid_release");
  const base = new URL(options.apiBase ?? "https://haneoka.org/api/v1/"),
    url = new URL(path, base);
  const server = encodeURIComponent(identity.server),
    apiPath = `${base.pathname.replace(/\/?$/u, "/")}servers/${server}/`;
  if (
    url.origin !== base.origin ||
    !(
      url.pathname.startsWith(`/assets/${server}/`) ||
      url.pathname.startsWith(`/runtime/${server}/`) ||
      url.pathname.startsWith(apiPath)
    )
  )
    throw new Error("resource_source_mismatch", { cause: { origin: url.origin, path: url.pathname } });
  url.searchParams.set("release", identity.releaseId);
  return url.href;
}
export function createPinnedPublicFetcher(
  identity: HaneokaReleaseIdentity,
  options: PublicSongSourceOptions = {},
): EmbedFetcher {
  const fetcher = options.fetcher ?? fetch;
  return async (request) => {
    if (/^(blob|data):/u.test(request.url)) return fetcher(request);
    const response = await fetcher(
      new Request(pinnedPublicUrl(request.url, identity, options), {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
      }),
    );
    if (
      response.ok &&
      (response.headers.get("x-haneoka-release-id") !== identity.releaseId ||
        response.headers.get("x-haneoka-source-id") !== identity.sourceId)
    ) {
      await response.body?.cancel();
      throw new Error("resource_release_mismatch");
    }
    return response;
  };
}
async function bytes(response: Response, signal: AbortSignal, maxBytes: number) {
  return readBytes(response, { signal, maxBytes, locale: "en", fetcher: fetch, progress: () => {} });
}
function client(
  options: PublicSongSourceOptions,
  identity?: HaneokaReleaseIdentity,
  observeResponse?: (response: Response) => void,
) {
  const transport = identity ? createPinnedPublicFetcher(identity, options) : (options.fetcher ?? fetch);
  return createHaneokaClient({
    baseUrl: options.apiBase ?? "https://haneoka.org/api/v1/",
    transport: async (request) => {
      const response = await transport(request);
      try {
        observeResponse?.(response);
      } catch (error) {
        await response.body?.cancel();
        throw error;
      }
      const data = await readBytes(
        response,
        { signal: request.signal, maxBytes: 8 * 1024 * 1024, locale: "en", fetcher: transport, progress: () => {} },
        false,
      );
      return new Response(data, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  });
}

/** First page observes current; further pages and chosen assets reuse that exact snapshot. */
export async function listPublicCreationSongs(
  options: PublicSongSourceOptions & {
    server: string;
    locale: HaneokaLocale;
    signal: AbortSignal;
    limit?: number;
    cursor?: string;
    identity?: HaneokaReleaseIdentity;
  },
): Promise<HaneokaPage<PublicCreationSong>> {
  if (options.identity && options.identity.server !== options.server) throw new Error("resource_source_mismatch");
  return client(options, options.identity).page("songs", {
    server: options.server,
    locale: options.locale,
    signal: options.signal,
    limit: options.limit ?? 20,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.identity ? { release: options.identity.releaseId } : {}),
    decode: song,
  });
}

export interface PublicCreationCatalogue {
  items: { id: string; value: PublicCreationSong }[];
  total: number;
  nextCursor: null;
  release: HaneokaReleaseIdentity;
}
export type PublicCreationCatalogueOptions = PublicSongSourceOptions & {
  server: string;
  locale: HaneokaLocale;
  signal: AbortSignal;
  identity?: HaneokaReleaseIdentity;
};
interface CataloguePending {
  controller: AbortController;
  promise: Promise<PublicCreationCatalogue>;
  waiters: number;
  settled: boolean;
}
interface CatalogueCache {
  values: Map<string, PublicCreationCatalogue>;
  current: Map<string, { key: string; expires: number }>;
  pending: Map<string, CataloguePending>;
}
const catalogueCaches = new WeakMap<EmbedFetcher, CatalogueCache>();
function catalogueCache(fetcher: EmbedFetcher) {
  let cache = catalogueCaches.get(fetcher);
  if (!cache) {
    cache = { values: new Map(), current: new Map(), pending: new Map() };
    catalogueCaches.set(fetcher, cache);
  }
  return cache;
}
function catalogueScope(options: PublicCreationCatalogueOptions) {
  const base = new URL(options.apiBase ?? "https://haneoka.org/api/v1/");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return `${base.href}\0${options.server}\0${options.locale}`;
}
function cataloguePin(scope: string, identity: HaneokaReleaseIdentity) {
  return `${scope}\0${identity.releaseId}\0${identity.sourceId}`;
}
function catalogueIdentity(response: Response, server: string): HaneokaReleaseIdentity {
  const releaseId = response.headers.get("x-haneoka-release-id"),
    sourceId = response.headers.get("x-haneoka-source-id");
  if (
    !releaseId ||
    !/^r-[a-f0-9]{20}$/.test(releaseId) ||
    !sourceId ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sourceId)
  )
    throw new Error("catalogue_release_identity_missing");
  return { schema: "haneoka-resource-release-identity-v1", server, releaseId, sourceId };
}
function awaitCatalogue(pending: CataloguePending, signal: AbortSignal) {
  pending.waiters++;
  return new Promise<PublicCreationCatalogue>((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal.removeEventListener("abort", abort);
      if (--pending.waiters === 0 && !pending.settled)
        pending.controller.abort(new DOMException("Aborted", "AbortError"));
    };
    const abort = () => {
      release();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    pending.promise.then(
      (value) => {
        if (signal.aborted) {
          abort();
          return;
        }
        release();
        resolve(structuredCloneValue(value));
      },
      (error) => {
        release();
        reject(error);
      },
    );
  });
}
/** One bounded metadata GET reads the complete compact index. No chart or audio prefetch. */
export function listPublicCreationSongCatalogue(
  options: PublicCreationCatalogueOptions,
): Promise<PublicCreationCatalogue> {
  options.signal.throwIfAborted();
  if (options.identity && options.identity.server !== options.server) throw new Error("resource_source_mismatch");
  const cache = catalogueCache(options.fetcher ?? fetch),
    scope = catalogueScope(options),
    key = options.identity ? cataloguePin(scope, options.identity) : scope;
  const alias = cache.current.get(scope),
    pinned = options.identity ? key : alias && alias.expires > Date.now() ? alias.key : undefined;
  const cached = pinned ? cache.values.get(pinned) : undefined;
  if (cached) return Promise.resolve(structuredCloneValue(cached));
  let pending = cache.pending.get(key);
  if (!pending || pending.controller.signal.aborted) {
    const controller = new AbortController();
    let release: HaneokaReleaseIdentity | undefined;
    const promise = (async () => {
      const index = await client(options, options.identity, (response) => {
        if (response.ok) release = catalogueIdentity(response, options.server);
      }).index<Record<string, PublicCreationSong>>("songs", {
        server: options.server,
        locale: options.locale,
        signal: controller.signal,
        ...(options.identity ? { release: options.identity.releaseId } : {}),
        decode: (value) => {
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error("invalid_complete_song_index");
          return Object.fromEntries(Object.entries(value).map(([id, value]) => [id, song(value)]));
        },
      });
      controller.signal.throwIfAborted();
      if (!release) throw new Error("catalogue_release_identity_missing");
      const value: PublicCreationCatalogue = {
        items: Object.entries(index).map(([id, value]) => ({ id, value })),
        total: Object.keys(index).length,
        nextCursor: null,
        release,
      };
      const completeKey = cataloguePin(scope, release);
      cache.values.delete(completeKey);
      cache.values.set(completeKey, structuredCloneValue(value));
      while (cache.values.size > 4) cache.values.delete(cache.values.keys().next().value!);
      if (!options.identity) cache.current.set(scope, { key: completeKey, expires: Date.now() + 60000 });
      while (cache.current.size > 10) cache.current.delete(cache.current.keys().next().value!);
      return value;
    })();
    pending = { controller, promise, waiters: 0, settled: false };
    cache.pending.set(key, pending);
    const active = pending;
    void promise.then(
      () => {
        active.settled = true;
        if (cache.pending.get(key) === active) cache.pending.delete(key);
      },
      () => {
        active.settled = true;
        if (cache.pending.get(key) === active) cache.pending.delete(key);
      },
    );
  }
  return awaitCatalogue(pending, options.signal);
}
/** Picker-owned generation rejects late server/source/provider responses even if a transport ignores abort. */
export class PublicCreationCatalogueReader {
  private generation = 0;
  private controller: AbortController | undefined;
  async load(options: PublicCreationCatalogueOptions) {
    this.cancel();
    const generation = this.generation,
      controller = (this.controller = new AbortController());
    const signal = AbortSignal.any([options.signal, controller.signal]);
    const value = await listPublicCreationSongCatalogue({ ...options, signal });
    signal.throwIfAborted();
    if (generation !== this.generation) throw new DOMException("Superseded catalogue", "AbortError");
    return value;
  }
  cancel() {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
  }
}

export async function loadPublicCreationSong(
  options: PublicSongSourceOptions & {
    identity: HaneokaReleaseIdentity;
    songId: string;
    difficulty: string;
    locale: HaneokaLocale;
    signal: AbortSignal;
  },
) {
  const { identity, signal } = options;
  const metadata = await client(options, identity).entity("songs", options.songId, {
    server: identity.server,
    release: identity.releaseId,
    locale: options.locale,
    signal,
    decode: song,
  });
  const difficulty = metadata.difficulty.find((entry) => entry.difficultyName === options.difficulty);
  if (!difficulty) throw new Error("song_difficulty_missing");
  const fetcher = createPinnedPublicFetcher(identity, options);
  const sourceUrl = pinnedPublicUrl(difficulty.file, identity, options),
    audioUrl = pinnedPublicUrl(metadata.musicUrl, identity, options);
  const sourceBytes = await bytes(await fetcher(new Request(sourceUrl, { signal })), signal, 2 * 1024 * 1024);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes),
    imported = importSs(text);
  const audioResponse = await fetcher(new Request(audioUrl, { signal }));
  const audioBytes = await bytes(audioResponse, signal, AUDIO_LIMITS.bytes);
  signal.throwIfAborted();
  const fileName = decodeURIComponent(new URL(audioUrl).pathname.split("/").at(-1) ?? "audio");
  const audio = new File([audioBytes], fileName, {
    type: audioResponse.headers.get("content-type")?.split(";")[0] ?? "audio/mpeg",
  });
  imported.project.meta.title = resolveLocalizedText(metadata.musicTitle, options.locale).text;
  imported.project.meta.artist = resolveLocalizedText(metadata.bandName, options.locale).text;
  imported.project.meta.difficulty = options.difficulty;
  imported.project.meta.level = String(difficulty.displayLevel ?? "");
  imported.project.extensions.haneoka = {
    server: identity.server,
    releaseId: identity.releaseId,
    sourceId: identity.sourceId,
    songId: options.songId,
    difficulty: options.difficulty,
    sourceUrl,
    audioUrl,
  };
  return {
    identity,
    metadata,
    project: imported.project,
    warnings: imported.warnings,
    audio,
    source: { name: decodeURIComponent(new URL(sourceUrl).pathname.split("/").at(-1) ?? "chart.ss.json"), text },
  };
}
