import {
  readPrivatePageData,
  readStaticDocumentSnapshot,
  staticPublicationContext,
  type PrivatePageDataEntry,
} from "./static-documents";
import { unrestricted } from "./content-resources";
import { inheritContentView, requestContentView, type RequestContentView } from "./content-view";
import { applySiteSettings, type DocumentContentContext } from "./site-settings";
import { DEFAULT_VISIBILITY_RULE, VISIBILITY_TYPES, type VisibilityType } from "../src/lib/content-visibility-policy";
import { coreStaticDocumentPath } from "../src/lib/static-documents";
import { parseResourceRoute } from "../src/lib/resource-route";
import { isCommunityPagePath } from "../src/lib/site-community";

export const PUBLIC_STATIC_VIEW_PATH = "/api/v1/content-view";
/** Same publication context the document route passes to `applySiteSettings` for `request.url`. */
export type PublicStaticDocumentContext = (request: Request, view: RequestContentView) => Promise<DocumentContentContext>;

const MAX_AGE = 6 * 60 * 60;
const LOCALE = /^(?:ja|en|ko|zh-CN|zh-TW)$/u;
const PRIVATE_GLOBAL_SECTIONS = new Set([
  "404",
  "account",
  "admin",
  "auth",
  "catalog",
  "chart-editor",
  "community",
  "gacha-history",
  "player-profile",
  "saves",
  "settings",
  "story-editor",
]);

/** Canonical pages the static host may serve in their public view. */
export function publicStaticViewPath(path: string): boolean {
  if (isCommunityPagePath(path)) return false;
  if (path.length > 512 || !path.endsWith("/") || !coreStaticDocumentPath(path)) return false;
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "jp" || parts[0] === "intl") {
    if (parts.length === 2 && LOCALE.test(parts[1]!)) return true;
    const route = parseResourceRoute(path);
    return Boolean(route && (!route.view || (route.kind === "songs" && route.view === "chart")));
  }
  return LOCALE.test(parts[0] || "") && parts.length > 1 && !PRIVATE_GLOBAL_SECTIONS.has(parts[1]!);
}

/** Whether this viewer may see any unpublished entry of a type. */
function permitted(view: RequestContentView, kind: VisibilityType): boolean {
  const rule = view.policy.types[kind] ?? DEFAULT_VISIBILITY_RULE;
  if (view.override && rule.allowOverride) return true;
  if (view.spoilers && rule.restrictedDisplay === "unpublished") return true;
  if (!rule.groups.includes(view.group)) return false;
  return rule.mode === "visible" || rule.show.length > 0 || view.spoilers;
}

function viewHeaders(view: RequestContentView, freshUntil: number | undefined): Headers {
  const ttl = freshUntil === undefined ? MAX_AGE : Math.max(0, Math.min(MAX_AGE, Math.floor((freshUntil - Date.now()) / 1000)));
  const headers = new Headers({
    "Cache-Control": `private, max-age=${ttl}`,
    Vary: "Cookie, Authorization, Accept-Encoding",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
    "X-Haneoka-Content-View": view.key,
    "X-Haneoka-Content-Group": view.group,
    "X-Haneoka-Content-Version": String(view.settings.version),
  });
  const policy = encodeURIComponent(JSON.stringify(view.settings.policy));
  if (policy.length <= 6000) headers.set("X-Haneoka-Content-Policy", policy);
  if (freshUntil !== undefined) headers.set("X-Haneoka-Content-Until", String(freshUntil));
  return headers;
}

const encoder = new TextEncoder();
let secret: { token: string; key: Promise<CryptoKey> } | undefined;
async function derive(token: string, purpose: string, sha256 = ""): Promise<Uint8Array> {
  if (secret?.token !== token)
    secret = { token, key: crypto.subtle.importKey("raw", encoder.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]) };
  const message = encoder.encode(`static-page-data-v1\0${purpose}\0${sha256}`);
  return new Uint8Array(await crypto.subtle.sign("HMAC", await secret.key, message));
}
const hex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");

/** The root attributes the document route writes for this view; page-data adoption copies them. */
function displayAttributes(view: RequestContentView): Record<string, string> {
  return {
    "data-spoiler-content": view.override || view.spoilers ? "1" : "0",
    "data-content-visibility-policy": JSON.stringify(view.settings.policy),
    "data-content-visibility-version": String(view.settings.version),
    "data-content-visibility-at": String(Date.now()),
    "data-content-group": view.group,
    "data-content-response-key": view.key,
  };
}

/**
 * Keys for a page's encrypted complete page data, only when the viewer may
 * see every type the public page omits. `null` keeps the filtered document.
 */
async function pageDataGrant(
  request: Request,
  env: Env,
  entry: PrivatePageDataEntry,
  path: string,
  view: RequestContentView,
  headers: Headers,
): Promise<Response | null> {
  const token = env.CONTENT_BUILD_TOKEN;
  if (!token || !unrestricted(view, entry.types as VisibilityType[])) return null;
  if (entry.kid !== hex(await derive(token, "kid")).slice(0, 32)) return null;
  const identity = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(entry.scripts.map((script) => script.url).join(","))))).slice(0, 24);
  const etag = `W/"page-data-v1-${identity}-${view.key}"`;
  headers.set("ETag", etag);
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
  if (request.method === "HEAD") return new Response(null, { headers });
  const scripts = await Promise.all(
    entry.scripts.map(async (script) => ({ ...script, key: base64url(await derive(token, "key", script.sha256)) })),
  );
  const body = { schema: "haneoka-page-data-grant-v1", path, build: entry.build, attributes: { ...displayAttributes(view), "data-web-build-id": entry.build }, scripts };
  return new Response(JSON.stringify(body), { headers });
}

/**
 * `null` for other paths. The response is never a credential or account
 * record: only build-produced documents filtered by the current policy, or
 * with `projection=data` the keys to complete page data the viewer may see.
 */
export async function handlePublicStaticViewRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  documentContext: PublicStaticDocumentContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PUBLIC_STATIC_VIEW_PATH) return null;
  const reject = (status: number) =>
    new Response(null, { status, headers: { "Cache-Control": "no-store", ...(status === 405 ? { Allow: "GET, HEAD" } : {}) } });
  if (request.method !== "GET" && request.method !== "HEAD") return reject(405);
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") return reject(403);
  const path = url.searchParams.get("path") || "";
  const spoiler = url.searchParams.get("spoiler");
  const types = (url.searchParams.get("types") || "").split(",").filter(Boolean);
  const since = url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined;
  const projection = url.searchParams.get("projection");
  if (
    (projection !== null && projection !== "data") ||
    (since !== undefined && !(Number.isFinite(since) && since > 0)) ||
    !publicStaticViewPath(path) ||
    (spoiler !== null && spoiler.length > 32) ||
    types.some((type) => !(VISIBILITY_TYPES as readonly string[]).includes(type))
  )
    return reject(400);
  const view = await requestContentView(request, env);
  const target = new URL(path, url);
  if (spoiler !== null) target.searchParams.set("spoiler", spoiler);
  const headers = new Headers();
  for (const name of ["Cookie", "Authorization", "If-None-Match", "User-Agent"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const canonical = new Request(target, { method: request.method, headers });
  inheritContentView(canonical, request);
  let metadata = viewHeaders(view, undefined);
  if (url.searchParams.get("cv") === view.key) metadata.set("Vary", "Accept-Encoding");
  if (/^\/(?:en|ja|ko|zh-CN|zh-TW)\/team-builder\/$/u.test(path))
    return new Response(null, { status: 204, headers: metadata });
  const kinds = (types.length ? types : VISIBILITY_TYPES) as readonly VisibilityType[];
  // Content published since the public page was built is public even when nothing private is permitted.
  const published = since !== undefined && since <= view.now;
  if (!published && !kinds.some((kind) => permitted(view, kind))) {
    const etag = `W/"content-view-none-${view.key}"`;
    metadata.set("ETag", etag);
    return new Response(null, { status: request.headers.get("If-None-Match") === etag ? 304 : 204, headers: metadata });
  }
  const { publicationId, webBuildId } = await staticPublicationContext(request, env);
  if (projection === "data") {
    const build = url.searchParams.get("build");
    const entry = await readPrivatePageData(request, env, path, publicationId);
    const grant =
      entry && (!build || entry.build === build)
        ? await pageDataGrant(request, env, entry, path, view, new Headers(metadata))
        : null;
    if (grant) return grant;
  }
  const context = await documentContext(canonical, view);
  metadata = viewHeaders(view, context.freshUntil);
  if (url.searchParams.get("cv") === view.key) metadata.set("Vary", "Accept-Encoding");
  const cacheUrl = new URL("/.haneoka-content-view/v1", url);
  cacheUrl.search = new URLSearchParams({
    path, publication: publicationId ?? webBuildId, view: view.key,
    epoch: context.epoch ?? String(Math.floor(view.now / 60_000)),
  }).toString();
  const cacheKey = new Request(cacheUrl);
  let rendered = await caches.default.match(cacheKey);
  if (!rendered) {
    const snapshot = await readStaticDocumentSnapshot(canonical, env, ctx, path, publicationId);
    if (!snapshot) return reject(404);
    if (!snapshot.ok) return snapshot;
    rendered = await applySiteSettings(canonical, snapshot, webBuildId, env, context);
    if (rendered.status === 200 && request.method === "GET") {
      const stored = new Headers(rendered.headers);
      stored.delete("Vary");
      stored.set("Cache-Control", metadata.get("Cache-Control")!.replace("private", "public"));
      ctx.waitUntil(caches.default.put(cacheKey, new Response(rendered.clone().body, { headers: stored })).catch(() => undefined));
    }
  }
  const etag = rendered.headers.get("ETag");
  metadata.set("Content-Type", rendered.headers.get("Content-Type") || "text/html; charset=utf-8");
  if (etag) metadata.set("ETag", etag);
  if (rendered.status === 304 || (etag && request.headers.get("If-None-Match") === etag) || request.method === "HEAD") {
    await rendered.body?.cancel();
    return new Response(null, { status: rendered.status === 304 || request.headers.get("If-None-Match") === etag ? 304 : rendered.status, headers: metadata });
  }
  return new Response(rendered.body, { status: rendered.status, headers: metadata });
}
