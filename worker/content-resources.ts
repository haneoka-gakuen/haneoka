// L3 — GEB
// Input: Complete immutable catalog indexes, resource requests and their display context.
// Output: Authorized media or a filtered, versioned JSON representation.
// Pos: [Map](L2.md); shared public-resource response boundary.
// Effects/Dependencies: Uses internal edge caches after resolving current permissions; source objects remain immutable.
import {
  criSourceShard,
  projectCriSources,
  type CriSourceEntry,
  type CriSourceIndex,
  type CriSourceProjection,
} from "../src/lib/asset-page-data";

import { contentPublished } from "../src/lib/content-publication";
import { contentVisible, filterContentData, type ContentReference } from "../src/lib/content-view";
import { VISIBILITY_TYPES, visibilityType, type VisibilityType } from "../src/lib/content-visibility-policy";
import { UI_MARK_NAMES } from "../src/lib/ui-marks";
import { publicChartAsset } from "./chart-assets";
import {
  requestContentView,
  inheritContentView,
  privateContentResponse,
  isContentBuildRequest,
  type RequestContentView,
} from "./content-view";
import { decodePageData } from "../src/lib/page-data-codec";

export interface ContentResourceIndex {
  server?: string;
  releaseId?: string;
  sourceId?: string;
  records: Record<string, ContentReference>;
  assets: Record<string, string[][]>;
  previewAssets?: string[];
  publications?: Record<string, Record<string, unknown>>;
  assetShards?: { prefix: string; count: number };
}
const publicationTimelines = new WeakMap<ContentResourceIndex, number[]>();
export function contentCacheEpoch(index: ContentResourceIndex | null | undefined, now: number): string {
  if (!index) return `minute-${Math.floor(now / 60_000)}`;
  let timeline = publicationTimelines.get(index);
  if (!timeline) {
    const times = new Set<number>();
    const collect = (value: Record<string, unknown>) => {
      for (const field of ["publicStartAt", "releasedAt", "publishedAt", "releaseAt", "startAt", "eventPublishedAt"]) {
        const raw = value[field],
          first = Array.isArray(raw) ? raw.find((at) => Number(at) > 0) : raw;
        const at = typeof first === "string" && !Number.isFinite(Number(first)) ? Date.parse(first) : Number(first);
        if (Number.isFinite(at) && at > 0) times.add(at);
      }
      if (value.catalogMetadata && typeof value.catalogMetadata === "object")
        collect(value.catalogMetadata as Record<string, unknown>);
    };
    Object.values(index.records).forEach((reference) => collect(reference.publication));
    timeline = [...times].sort((a, b) => a - b);
    publicationTimelines.set(index, timeline);
  }
  let low = 0,
    high = timeline.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (timeline[middle]! <= now) low = middle + 1;
    else high = middle;
  }
  return `${index.releaseId ?? "legacy"}-${timeline[low - 1] ?? 0}`;
}
export function nextContentPublication(
  index: ContentResourceIndex | null | undefined,
  now: number,
): number | undefined {
  if (!index) return undefined;
  contentCacheEpoch(index, now);
  const timeline = publicationTimelines.get(index)!;
  let low = 0,
    high = timeline.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (timeline[middle]! <= now) low = middle + 1;
    else high = middle;
  }
  return timeline[low];
}
export type ContentIndexReader = (
  server: string,
  release?: string,
  assetPath?: string,
) => Promise<ContentResourceIndex | null>;
export const unrestricted = (view: RequestContentView, kinds: readonly VisibilityType[] = VISIBILITY_TYPES): boolean =>
  kinds.every((kind) => {
    const rule = view.policy.types[kind];
    return (
      contentVisible(view, kind, { __publicationPending: true }) &&
      (!rule?.hide.length || (view.override && rule.allowOverride))
    );
  });
const notPublic = () =>
  new Response(JSON.stringify({ error: { code: "content_unpublished", message: "Content is not public" } }), {
    status: 403,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      Vary: "Cookie, Authorization",
      "Access-Control-Allow-Origin": "*",
    },
  });
function assetOwners(index: ContentResourceIndex, path: string): string[][] | undefined {
  return (
    index.assets[path] ??
    index.assets[
      path
        .replace(/^(assets|runtime)\/(ja|en|ko|zh-CN|zh-TW)\//u, "$1/")
        .replace(/\((en|ko|zh-Hans|zh-Hant)\)(?=\.[^/]+$)/u, "")
    ]
  );
}
function publicInterfaceAsset(path: string): boolean {
  if (publicChartAsset(path)) return true;
  if (/^(?:objects\/|runtime\/unity-json\/)/u.test(path)) return true;
  if (/^assets\/Assets\/AddressableResources\/Adv\/(?:Transition\/adv_transition_0001\/texture\.png|PostEffect\/)/u.test(path))
    return true;
  if (/^assets\/Assets\/AddressableResources\/UI\/Texture\/BandRank\/ImgScorerank_(?:SS|S|A|B|C|D|E)\.png$/u.test(path))
    return true;
  const sprite =
    /^runtime\/unity\/Assets\/AddressableResources\/(UI\/Atlas\/FixUiSpriteAtlas|Live\/Images\/Atlas\/LiveAtlas)\.spriteatlasv2\/([^/]+)--Sprite--?\d+\.png$/u.exec(
      path,
    );
  return Boolean(
    sprite &&
    (sprite[1] === "UI/Atlas/FixUiSpriteAtlas"
      ? UI_MARK_NAMES.test(`${sprite[2]}.png`) || /^(?:WhiteRect|NormalButtonFrame_H96(?:_Blue)?|sp_adv_next|sp_adv_text_alt_edge|sp_adv_line|IconTapNext(?:Glow)?)$/u.test(sprite[2]!)
      : /^Icon_gekisou_(?:combo|luck|just)$/u.test(sprite[2]!)),
  );
}
function mayReadAsset(
  index: ContentResourceIndex,
  path: string,
  view: RequestContentView,
): { allowed: boolean; public: boolean } {
  const owners = assetOwners(index, path);
  if (!owners?.length || owners.some((chain) => chain.some((id) => !index.records[id])))
    return { allowed: true, public: true };
  const publicAsset = owners.some((chain) =>
    chain.every((id) => {
      const ref = index.records[id];
      return (
        ref &&
        contentVisible(
          {
            ...view,
            group: "guest",
            spoilers: false,
            override: false,
            policy: { eventChallengeSongs: true, types: {} },
          },
          ref.kind,
          ref.publication,
          ref.id,
        )
      );
    }),
  );
  const allowed =
    publicAsset ||
    owners.some((chain) =>
      chain.every((id) => {
        const ref = index.records[id];
        return ref && contentVisible(view, ref.kind, ref.publication, ref.id);
      }),
    );
  const preview =
    !allowed &&
    view.spoilers &&
    index.previewAssets?.includes(path) &&
    owners.some((chain) =>
      chain.every((id) => {
        const ref = index.records[id];
        return (
          ref &&
          (contentVisible(view, ref.kind, ref.publication, ref.id) ||
            view.policy.types[ref.kind]?.restrictedDisplay === "unpublished")
        );
      }),
    );
  return { allowed: allowed || Boolean(preview), public: publicAsset };
}
export async function contentResourceBoundary(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  readIndex: ContentIndexReader,
  serve: (request: Request) => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  const imageEntity = /^\/api\/v1\/(live2d|spine)\/([^/]+)\/image\.png$/u.exec(url.pathname);
  if (!["GET", "HEAD"].includes(request.method) && !imageEntity) return serve(request);
  const api = /^\/api\/v1\/(?:servers|team-builder|meta-reference)\/(jp|intl)(?:\/(.*))?$/u.exec(url.pathname);
  const sourceBrowser =
    /^\/api\/v1\/servers\/(?:jp|intl)\/sources\//u.test(url.pathname) ||
    /^\/asset-static\/(?:jp|intl)\/.*\.json$/u.test(url.pathname);
  const media = /^\/(assets|runtime|objects)\/(jp|intl)\/(.+)$/u.exec(url.pathname);
  const bulk = /^\/(?:game-client|artifacts)\/(jp|intl)\//u.exec(url.pathname);
  const packed = url.pathname.startsWith("/provider-static/content/");
  const staticJson = /^\/(?:static-views|provider-static|asset-static|playlist-static)\/.*\.json$/u.test(url.pathname);
  const search = url.pathname === "/api/v1/search";
  const chartImage = /^\/api\/v1\/charts\/.*\/image/u.test(url.pathname);
  if (!api && !media && !bulk && !packed && !staticJson && !chartImage && !search && !imageEntity)
    return serve(request);
  if (sourceBrowser || (media && url.searchParams.get("asset") === "1")) return serve(request);
  const tail = api?.[2] ?? "";
  const functional = api && (
    ["story-runtime", "chart-assets", "ui-marks", "song-release-times", "options"].includes(tail) ||
    (tail === "release" && url.searchParams.get("projection") === "identity") ||
    (url.searchParams.get("asset") === "1" && /^(?:(?:live2d|spine)\/[^/]+|voices|options)$/u.test(tail))
  );
  if (functional || (imageEntity && url.searchParams.get("asset") === "1")) return serve(request);
  if (api && (
    /^\/api\/v1\/(?:team-builder|meta-reference)\//u.test(url.pathname) ||
    (!visibilityType(tail.split("/")[0]!) && !/^(?:catalog|release)(?:\/|$)/u.test(tail))
  )) return serve(request);
  if (media && publicInterfaceAsset(`${media[1]}/${decodeURIComponent(media[3]!)}`)) return serve(request);
  if (await isContentBuildRequest(request, env)) {
    const response = privateContentResponse(await serve(request));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
  const server =
    api?.[1] ??
    media?.[2] ??
    bulk?.[1] ??
    (search || imageEntity ? (url.searchParams.get("server") ?? "intl") : undefined);
  let mediaIndex: ContentResourceIndex | null | undefined;
  if (media && server) {
    mediaIndex = await readIndex(
      server,
      url.searchParams.get("release") ?? undefined,
      `${media[1]}/${decodeURIComponent(media[3]!)}`,
    ).catch(() => null);
    if (!mediaIndex) return serve(request);
    if (mediaIndex) {
      const owners = assetOwners(mediaIndex, `${media[1]}/${decodeURIComponent(media[3]!)}`);
      if (!owners?.length || owners.some((chain) => chain.some((id) => !mediaIndex!.records[id])))
        return serve(request);
      if (
        owners?.some((chain) =>
          chain.every((id) => mediaIndex!.records[id] && contentPublished(mediaIndex!.records[id]!.publication)),
        )
      )
        return serve(request);
    }
  }
  const offlineAuthorization =
    api && tail === "stories" && url.searchParams.get("projection") === "offline-authorization";
  const offlineIndex =
    offlineAuthorization && server ? await readIndex(server, url.searchParams.get("release") ?? undefined) : null;
  const offlinePublications =
    offlineIndex &&
    Object.entries(offlineIndex.publications ?? {}).filter(
      ([key]) =>
        /^(stories|characters|bands):/u.test(key) && `${key.slice(0, key.indexOf(":"))}:${key}` in offlineIndex.records,
    );
  const authorizationResponse = (publicContent: boolean) =>
    new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "private, no-store",
        Vary: "Cookie, Authorization",
        "X-Haneoka-Content-Authorization": "v1",
        "X-Haneoka-Public-Content": publicContent ? "1" : "0",
      },
    });
  if (offlinePublications?.length && offlinePublications.every(([, publication]) => contentPublished(publication)))
    return authorizationResponse(true);
  const view = await requestContentView(request, env);
  if (offlineAuthorization) {
    if (
      !offlinePublications?.length ||
      offlinePublications.some(
        ([key, publication]) =>
          !contentVisible(view, visibilityType(key.split(":")[0]!)!, publication, key.slice(key.indexOf(":") + 1)),
      )
    ) {
      const denied = notPublic();
      denied.headers.set("X-Haneoka-Content-Authorization", "v1");
      return denied;
    }
    return authorizationResponse(false);
  }
  const identityOnly =
    api &&
    ((tail === "release" && url.searchParams.get("projection") === "identity") ||
      tail === "song-release-times" ||
      tail === "chart-assets" ||
      tail === "ui-marks");
  const pageData = api && tail === "release" && url.searchParams.get("projection") === "page-data";
  const raw = Boolean(
    packed || bulk || (api && (tail.startsWith("sources/") || (tail === "release" && !identityOnly && !pageData))),
  );
  if (raw && !unrestricted(view)) return notPublic();
  if (packed) return privateContentResponse(await serve(request));
  if (imageEntity) {
    const kind = visibilityType(imageEntity[1]!)!,
      id = decodeURIComponent(imageEntity[2]!);
    const index = await readIndex(server!, url.searchParams.get("release") ?? undefined);
    const publication = index?.publications?.[`${kind}:${id}`];
    if (!publication || !contentVisible(view, kind, publication, id)) return notPublic();
    return privateContentResponse(await serve(request));
  }
  if (pageData) {
    const kind = visibilityType(url.searchParams.get("resource") ?? ""),
      id = url.searchParams.get("id") ?? "";
    if (kind && id) {
      const index = await readIndex(server!, url.searchParams.get("release") ?? undefined);
      const publication = index?.publications?.[`${kind}:${id}`];
      if (publication && !contentVisible(view, kind, publication, id)) return notPublic();
    }
  }
  if (api && tail.split("/").length >= 2 && !["views", "relations"].includes(tail.split("/")[1]!)) {
    const kind = visibilityType(tail.split("/")[0]!);
    if (kind) {
      const id = decodeURIComponent(tail.split("/")[1]!);
      const index = await readIndex(server!, url.searchParams.get("release") ?? undefined);
      const refs = Object.values(index?.records ?? {}).filter((ref) => ref.kind === kind && ref.id === id);
      if (refs.length && !refs.some((ref) => contentVisible(view, kind, ref.publication, id))) return notPublic();
    }
  }
  if (api && /^live2d\/[^/]+$/u.test(tail) && unrestricted(view, ["live2d", "characters", "bands"]))
    return privateContentResponse(await serve(request));
  if (media && server) {
    const index = mediaIndex;
    if (!index) return serve(request);
    const access = mayReadAsset(index, `${media[1]}/${decodeURIComponent(media[3]!)}`, view);
    if (!access.allowed) return notPublic();
    const response = await serve(request);
    if (access.public) return response;
    const result = privateContentResponse(response);
    if (response.ok || response.status === 304) {
      result.headers.set("Cache-Control", "private, max-age=21600");
      result.headers.set("Date", new Date().toUTCString());
      result.headers.delete("Age");
      if (url.searchParams.get("cv") === view.key) result.headers.set("Vary", "Accept-Encoding");
    }
    return result;
  }
  if (identityOnly) return serve(request);
  // JSON source caches are shared internally. Conditional validation applies to
  // the filtered representation, whose identity includes the display policy.
  const headers = new Headers(request.headers);
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  headers.delete("Range");
  const source = new Request(request, { method: "GET", headers });
  inheritContentView(source, request);
  const contentIndex = server ? await readIndex(server, url.searchParams.get("release") ?? undefined) : undefined;
  const epoch = contentCacheEpoch(contentIndex, view.now);
  const cacheUrl = new URL(url);
  cacheUrl.searchParams.delete("spoiler");
  cacheUrl.searchParams.delete("__content");
  cacheUrl.searchParams.delete("cv");
  cacheUrl.searchParams.sort();
  cacheUrl.searchParams.set("__content-view", `${view.key}:${epoch}`);
  const key = new Request(cacheUrl, { method: "GET" });
  const hit = await caches.default.match(key);
  let response = hit;
  if (!response) {
    const input = await serve(source);
    if (!input.ok || !input.headers.get("Content-Type")?.includes("json") || raw) return privateContentResponse(input);
    const data: unknown = decodePageData(await input.json());
    if (
      data &&
      typeof data === "object" &&
      "schema" in data &&
      typeof data.schema === "string" &&
      /^haneoka-asset-(page|view)-/u.test(data.schema) &&
      !unrestricted(view)
    )
      return notPublic();
    const index = contentIndex;
    const filtered = filterContentData(
      data,
      view,
      pageData ? (url.searchParams.get("resource") ?? undefined) : api ? tail.split("/")[0] : undefined,
      Boolean(api && !pageData && !/^[^/]+\/[^/]+$/u.test(tail)),
      index?.publications,
    );
    if (filtered.value === null) return notPublic();
    const body = JSON.stringify(filtered.value);
    const out = new Headers(input.headers);
    out.delete("Content-Encoding");
    out.delete("Content-Length");
    const revision = input.headers.get("X-Haneoka-Release-Id") ?? "static";
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
    const hash = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
    out.set("ETag", `"${revision}-${view.key}-${hash}"`);
    out.set("Cache-Control", contentIndex ? "public, max-age=600" : "public, max-age=60");
    out.delete("Vary");
    response = new Response(body, { headers: out });
    ctx.waitUntil(caches.default.put(key, response.clone()).catch(() => undefined));
  }
  const result = privateContentResponse(response);
  if (request.headers.get("If-None-Match") === result.headers.get("ETag") || request.method === "HEAD") {
    await result.body?.cancel();
    return new Response(null, {
      status:
        request.method !== "HEAD" || request.headers.get("If-None-Match") === result.headers.get("ETag") ? 304 : 200,
      headers: result.headers,
    });
  }
  return result;
}

const CACHE_ORIGIN = "https://cri-sources.haneoka.internal/v1/";
const CACHE_TTL = 86_400;
const PART_LIMIT = 12;
const parts = new Map<string, Promise<unknown>>();
const projections = new Map<string, Promise<CriSourceProjection>>();

export interface CriSourceRelease {
  server: string;
  releaseId: string;
}
export type CriManifestLoader = () => Promise<unknown>;

const partUrl = (release: CriSourceRelease, name: string) =>
  `${CACHE_ORIGIN}${encodeURIComponent(release.server)}/${release.releaseId}/${name}.json`;

function project(
  release: CriSourceRelease,
  load: CriManifestLoader,
  ctx: ExecutionContext,
): Promise<CriSourceProjection> {
  let pending = projections.get(release.releaseId);
  if (!pending) {
    pending = load().then((manifest) => {
      const projection = projectCriSources(manifest);
      const values: [string, unknown][] = [["index", projection.index], ...Object.entries(projection.shards)];
      ctx.waitUntil(
        Promise.all(
          values.map(([name, value]) =>
            caches.default.put(
              partUrl(release, name),
              new Response(JSON.stringify(value), {
                headers: { "Cache-Control": `public, max-age=${CACHE_TTL}`, "Content-Type": "application/json" },
              }),
            ),
          ),
        ).catch(() => undefined),
      );
      return projection;
    });
    projections.set(release.releaseId, pending);
    pending.finally(() => projections.delete(release.releaseId)).catch(() => undefined);
  }
  return pending;
}

function part<T>(
  release: CriSourceRelease,
  name: string,
  load: CriManifestLoader,
  ctx: ExecutionContext,
  pick: (projection: CriSourceProjection) => T,
): Promise<T> {
  const url = partUrl(release, name);
  let pending = parts.get(url) as Promise<T> | undefined;
  if (!pending) {
    pending = (async () => {
      const hit = await caches.default.match(url);
      return hit ? ((await hit.json()) as T) : pick(await project(release, load, ctx));
    })();
    parts.set(url, pending);
    pending.catch(() => parts.delete(url));
    while (parts.size > PART_LIMIT) parts.delete(parts.keys().next().value!);
  }
  return pending;
}

export function criSourceIndex(
  release: CriSourceRelease,
  load: CriManifestLoader,
  ctx: ExecutionContext,
): Promise<CriSourceIndex> {
  return part(release, "index", load, ctx, (projection) => projection.index);
}

export async function criSourceEntry(
  release: CriSourceRelease,
  key: string,
  load: CriManifestLoader,
  ctx: ExecutionContext,
): Promise<CriSourceEntry | undefined> {
  const shard = criSourceShard(key);
  return (await part(release, shard, load, ctx, (projection) => projection.shards[shard]!))[key];
}
