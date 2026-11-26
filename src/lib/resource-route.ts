// L3 — GEB
// Input: 服务器、语言、资源类型、实体 ID 与 URL 状态。
// Output: 规范资源地址、缺失前缀补全、解析结果和旧地址实体选择。
// Pos: [Map](L2-2.md)；站点与服务共享的资源路由契约。
// Effects/Dependencies: 依赖基础 locale 定义；路径构造／解析本身不发请求。
import { isLocale, type Locale } from "@haneoka/i18n";
import { englishInterfacePath, interfaceLanguageFromPath, interfacePath } from "../i18n/interface-route.ts";
import { CONTENT_SOURCE_IDS, isContentSourceId } from "./content-sources.ts";
import { communityStoryPath, legacyCommunityStoryRedirectTarget } from "./community-story-route.ts";
import { communityChartPath, legacyCommunityChartRedirectTarget } from "./community-chart-route.ts";

export const RELEASE_SERVERS = ["jp", "intl"] as const;
export type ReleaseServer = string;
export const isReleaseServer = (
  value: unknown,
  sources: readonly string[] = CONTENT_SOURCE_IDS,
): value is ReleaseServer => isContentSourceId(value) && sources.includes(value);

export const RELEASE_SERVER_COOKIE = "haneoka.release-server";
export function releaseServerFromCookie(cookie: string): ReleaseServer | undefined {
  const encoded = /(?:^|;\s*)haneoka\.release-server=([^;]*)/u.exec(cookie)?.[1];
  if (!encoded) return undefined;
  try {
    const value = decodeURIComponent(encoded);
    return isReleaseServer(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function releaseServerFromPath(
  pathname: string,
  sources: readonly string[] = CONTENT_SOURCE_IDS,
): ReleaseServer | undefined {
  const prefix = pathname.split("/")[1];
  return isReleaseServer(prefix, sources) ? prefix : undefined;
}

export const RESOURCE_KINDS = [
  "community-stories",
  "charts",
  "characters",
  "songs",
  "member-cards",
  "support-cards",
  "stories",
  "comics",
  "stamps",
  "stickers",
  "backgrounds",
  "chat-customizations",
  "band-items",
  "items",
  "events",
  "arena",
  "gacha",
  "login-campaigns",
  "shop",
  "exchange",
  "circle",
  "challenge",
  "passes",
  "missions",
  "tgw-card",
  "live2d",
  "spine",
  "help",
  "skills",
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** First-party story collections, in drawer order. */
export const STORY_MODES = ["event", "band", "link", "birthday", "home", "afterlive", "tutorial"] as const;
export type StoryMode = (typeof STORY_MODES)[number];

/**
 * The interactive screen derives the mode from the chapter: event-owned
 * chapters are event stories, native birthday categories come next, other
 * numbered chapters (below the synthetic 900000 range) are band stories,
 * and the rest map by key.
 */
export function storyModeOf(episode: {chapterId?: unknown; chapterKey?: unknown; storyCategory?: unknown}, eventChapterIds: ReadonlySet<string>): StoryMode | undefined {
  const chapterId = String(episode.chapterId || "");
  if (eventChapterIds.has(chapterId)) return "event";
  if (episode.storyCategory === "birthday") return "birthday";
  if (Number(episode.chapterId || 0) < 900000) return "band";
  switch (episode.chapterKey) {
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


/** First-party ANON TOKYO views. These are auxiliary collections rather than resource kinds. */
export const ANON_TOKYO_MODES = [
  "characters",
  "outfits",
  "shop",
  "goods",
  "decorations",
  "staff",
  "customers",
  "tasks",
  "guide",
  "fever",
] as const;
export type AnonTokyoMode = (typeof ANON_TOKYO_MODES)[number];

export const CHARACTER_DETAIL_SECTIONS = ["profile", "cards", "stamps", "voices", "story", "friendships", "missions", "live2d", "songs"] as const;
export type CharacterDetailSection = (typeof CHARACTER_DETAIL_SECTIONS)[number];
export function isCharacterDetailSection(value: unknown): value is CharacterDetailSection {
  return typeof value === "string" && (CHARACTER_DETAIL_SECTIONS as readonly string[]).includes(value);
}

export interface ResourceRoute {
  server: ReleaseServer;
  locale: Locale;
  kind: ResourceKind;
  id?: string;
  /** A child view rendered below an entity's canonical resource page. */
  view?: "chart" | "ranking" | "story";
  section?: CharacterDetailSection;
}

export interface EntityLink {
  href: string;
  title?: string;
}

export interface EntityRouteContext {
  kind: ResourceKind;
  id: string;
  href: string;
  backHref: string;
  previous?: EntityLink;
  next?: EntityLink;
}

export interface EntitySelection {
  route: ResourceRoute & { id: string };
  source: "canonical" | "legacy";
  returnTo?: string;
}

const isResourceKind = (value: unknown): value is ResourceKind =>
  typeof value === "string" && (RESOURCE_KINDS as readonly string[]).includes(value);

export const isStoryMode = (value: unknown): value is StoryMode =>
  typeof value === "string" && STORY_MODES.includes(value as StoryMode);

export const isAnonTokyoMode = (value: unknown): value is AnonTokyoMode =>
  typeof value === "string" && ANON_TOKYO_MODES.includes(value as AnonTokyoMode);

const isResourceId = (value: string): boolean =>
  value.length > 0 && value !== "." && value !== ".." && !/[\\/\u0000-\u001f\u007f]/u.test(value);

/** Public resource addresses contain identity; community charts are shared across servers. */
export function resourcePath({ server, locale, kind, id, section, view }: ResourceRoute): string {
  if (!isContentSourceId(server) || !isLocale(locale) || !isResourceKind(kind))
    throw new TypeError("Invalid resource route");
  if (id !== undefined && !isResourceId(id)) throw new TypeError("Invalid resource identity");
  if (kind === "community-stories") return communityStoryPath(server, locale, id);
  if (kind === "charts") return communityChartPath(server, locale, id);
  const child = kind === "stories" && view === "story" ? "story" : section !== "profile" ? section : undefined;
  return `/${server}/${locale}/${kind}/${id === undefined ? "" : `${encodeURIComponent(id)}/`}${child ? `${child}/` : ""}`;
}

export function homePath(server: ReleaseServer, locale: Locale): string {
  if (!isContentSourceId(server) || !isLocale(locale)) throw new TypeError("Invalid home route");
  return `/${server}/${locale}/`;
}

export function legacyHomeRedirectTarget(pathname: string, search = ""): string | undefined {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 1 || !isLocale(parts[0])) return undefined;
  const query = new URLSearchParams(search);
  const server = query.get("server");
  query.delete("server");
  return `${homePath(isReleaseServer(server) ? server : "intl", parts[0])}${query.size ? `?${query}` : ""}`;
}

/** Public chart player address for a canonical song entity. */
export function chartPath({ server, locale, id }: { server: ReleaseServer; locale: Locale; id: string }): string {
  return `${resourcePath({ server, locale, kind: "songs", id })}chart/`;
}

/** Public song-ranking address for a canonical song entity. */
export function rankingPath({ server, locale, id }: { server: ReleaseServer; locale: Locale; id: string }): string {
  return `${resourcePath({ server, locale, kind: "songs", id })}ranking/`;
}

/** Public collection address for one first-party story section. */
export function storyCollectionPath({
  server,
  locale,
  mode,
}: {
  server: ReleaseServer;
  locale: Locale;
  mode: StoryMode;
}): string {
  if (!isStoryMode(mode)) throw new TypeError("Invalid story collection");
  return `${resourcePath({ server, locale, kind: "stories" })}${mode}/`;
}

/** Alias for callers that need to make the canonical-vs-legacy distinction explicit. */
export const formatResourceRoute = resourcePath;

export function parseResourceRoute(
  pathname: string,
  sources: readonly string[] = CONTENT_SOURCE_IDS,
): ResourceRoute | undefined {
  if (!pathname.startsWith("/") || pathname.includes("?") || pathname.includes("#")) return undefined;
  const parts = englishInterfacePath(pathname).slice(1).replace(/\/$/u, "").split("/");
  if (parts.length !== 3 && parts.length !== 4 && parts.length !== 5) return undefined;
  const [server, locale, kind, encodedId, child] = parts;
  if (!isReleaseServer(server, sources) || !isLocale(locale) || !isResourceKind(kind)) return undefined;
  if (kind === "events" && encodedId === "tracker") return undefined;
  const section = kind === "characters" && isCharacterDetailSection(child) ? child : undefined;
  const view = kind === "songs" && (child === "chart" || child === "ranking") || kind === "stories" && child === "story" ? child : undefined;
  if (parts.length === 5 && !section && !view) return undefined;
  if (encodedId === undefined) return { server, locale, kind };
  try {
    const id = decodeURIComponent(encodedId);
    return isResourceId(id)
      ? { server, locale, kind, id, ...(section ? { section } : {}), ...(view ? { view } : {}) }
      : undefined;
  } catch {
    return undefined;
  }
}

const COLLECTION_KIND_ALIASES: Readonly<Record<string, ResourceKind>> = {
  cards: "member-cards",
  "member-cards": "member-cards",
  "support-cards": "support-cards",
  "song-meta": "songs",
};

const SELECTION_PARAMS: Readonly<Partial<Record<ResourceKind, string>>> = {
  characters: "character",
  songs: "song",
  "member-cards": "card",
  "support-cards": "snap",
  comics: "comic",
  stamps: "stamp",
  stickers: "sticker",
  backgrounds: "background",
  "chat-customizations": "entry",
  "band-items": "item",
  items: "item",
  events: "entry",
  missions: "entry",
  gacha: "entry",
  "login-campaigns": "entry",
  shop: "entry",
  exchange: "entry",
  circle: "entry",
  challenge: "entry",
  passes: "entry",
  stories: "story",
  live2d: "model",
  spine: "model",
  help: "topic",
  skills: "skill",
};

export function selectionParamForKind(kind: ResourceKind): string | undefined {
  return SELECTION_PARAMS[kind];
}

export function resourceKindForCollection(collection: string): ResourceKind | undefined {
  const value = COLLECTION_KIND_ALIASES[collection] ?? collection;
  return isResourceKind(value) ? value : undefined;
}

function queryStringWithoutSelection(search: string, kind: ResourceKind): string {
  const params = new URLSearchParams(search);
  const selection = selectionParamForKind(kind);
  if (selection) params.delete(selection);
  const value = params.toString();
  return value ? `?${value}` : "";
}

/**
 * Resolve a previously published locale-first detail address to the one
 * server-first identity. Old public SSR was generated from Intl, so aliases
 * intentionally always target `intl`, regardless of localStorage.
 */
export function legacyEntityRoute(
  pathname: string,
  search = "",
  server: ReleaseServer = "intl",
): (ResourceRoute & { id: string }) | undefined {
  if (!pathname.startsWith("/") || pathname.includes("#")) return undefined;
  const parts = pathname.replace(/^\/+|\/+$/gu, "").split("/");
  const locale = parts[0];
  if (!isLocale(locale) || parts[1] !== "catalog") return undefined;
  if (parts[2] === "events" && parts[3] === "tracker") return undefined;

  let kind: ResourceKind | undefined;
  let id: string | undefined;
  if (parts[2] === "stories" && parts.length >= 3 && parts.length <= 5) {
    kind = "stories";
    id = parts.length === 5 ? parts[4] : undefined;
  } else if (parts.length === 3 || parts.length === 4) {
    kind = resourceKindForCollection(parts[2] || "");
    id = parts[3];
  }
  if (!kind) return undefined;
  if (id) {
    try {
      id = decodeURIComponent(id);
    } catch {
      return undefined;
    }
  }

  const selection = selectionParamForKind(kind);
  const query = new URLSearchParams(search);
  if (!id && selection) id = query.get(selection) || undefined;
  if (!id || !isResourceId(id)) return undefined;
  const explicitServer = query.get("server");
  return { server: isReleaseServer(explicitServer) ? explicitServer : server, locale, kind, id };
}

export function legacyEntityRedirectTarget(pathname: string, search = ""): string | undefined {
  const collection = parseResourceRoute(pathname);
  const param = collection ? selectionParamForKind(collection.kind) : undefined;
  const params = new URLSearchParams(search);
  const selected = param ? params.get(param) : undefined;
  const mode = params.get("mode");
  if (collection?.kind === "stories" && !collection.id && !selected && isStoryMode(mode)) {
    params.delete("mode");
    const target = storyCollectionPath({ ...collection, mode });
    const language = interfaceLanguageFromPath(pathname);
    return (language ? interfacePath(target, language.value) : target) + (params.size ? `?${params}` : "");
  }
  const story = collection?.kind === "stories" && collection.id && (params.has("mode") || params.get("playback") === "play")
    ? collection : undefined;
  const route =
    story ?? (collection && !collection.id && selected && isResourceId(selected)
      ? { ...collection, id: selected }
      : legacyEntityRoute(pathname, search));
  if (!route) return undefined;
  const query = new URLSearchParams(queryStringWithoutSelection(search, route.kind));
  query.delete("server");
  if (route.kind === "stories") {
    if (query.get("playback") === "play") route.view = "story";
    query.delete("mode");
    query.delete("playback");
  }
  const target = resourcePath(route);
  const language = interfaceLanguageFromPath(pathname);
  return `${language ? interfacePath(target, language.value) : target}${query.size ? `?${query}` : ""}`;
}

/** Map logical catalogue destinations to the selected server's collections. */
export function resourceCollectionHref(route: string, server: ReleaseServer, locale: Locale): string | undefined {
  const source = new URL(route, "https://route.invalid");
  if (source.pathname === "/community/stories") return `${communityStoryPath(server, locale)}${source.search}`;
  if (source.pathname === "/community/charts") return `${communityChartPath(server, locale)}${source.search}`;
  const parts = source.pathname.replace(/^\/+|\/+$/gu, "").split("/");
  if (parts.length === 1 && parts[0] === "charts") return `${communityChartPath(server, locale)}${source.search}`;
  if (parts.length === 1 && parts[0] === "calendar")
    return `/${server}/${locale}/calendar/${source.search}`;
  if (parts[0] !== "catalog") return undefined;
  if (parts.length === 1) {
    const target = new URL(`/${server}/${locale}/catalog/`, source);
    target.search = source.search;
    return `${target.pathname}${target.search}`;
  }
  const collection = parts[1] || "";
  if (collection === "events" && parts[2] === "tracker" && parts.length === 3)
    return `/${server}/${locale}/events/tracker/${source.search}`;
  if (collection === "stories" && parts[2] === "search" && parts.length === 3)
    return `/${server}/${locale}/stories/search/${source.search}`;
  if (parts.length > 2 && !(collection === "stories" || collection === "anon-tokyo")) return undefined;
  if (collection === "skills") {
    return parts.length === 2 ? `/${server}/${locale}/skills/${source.search}` : undefined;
  }
  if (collection === "studio") return parts.length === 2 ? `/${server}/${locale}/studio/${source.search}` : undefined;
  if (collection === "player-ranks" || collection === "friendship-ranks" || collection === "band-rating" || collection === "high-score-rating")
    return parts.length === 2 ? `/${server}/${locale}/${collection}/${source.search}` : undefined;
  if (collection === "song-meta") {
    if (parts.length !== 2) return undefined;
    const target = new URL(`/${server}/${locale}/song-meta/`, source);
    target.search = source.search;
    return `${target.pathname}${target.search}`;
  }
  if (collection === "assets") {
    if (parts.length !== 2) return undefined;
    const target = new URL(`/${server}/${locale}/assets/`, source);
    target.search = source.search;
    return `${target.pathname}${target.search}`;
  }
  if (collection === "anon-tokyo") {
    if (parts.length !== 3 || !isAnonTokyoMode(parts[2])) return undefined;
    const target = new URL(`/${server}/${locale}/anon-tokyo/${parts[2]}/`, source);
    target.search = source.search;
    return `${target.pathname}${target.search}`;
  }
  const kind = resourceKindForCollection(collection);
  if (!kind || (parts.length > 2 && kind !== "stories")) return undefined;
  if (kind === "stories" && parts[2]) {
    if (!isStoryMode(parts[2])) return undefined;
    const target = new URL(storyCollectionPath({ server, locale, mode: parts[2] }), source);
    target.search = source.search;
    // The section is in the pathname; carrying the old selector query would
    // make a canonical category link look like a mode override.
    target.searchParams.delete("mode");
    return `${target.pathname}${target.search}`;
  }
  const target = new URL(resourcePath({ server, locale, kind }), source);
  target.search = source.search;
  return `${target.pathname}${target.search}`;
}

/** Resolve a catalog data link in its owning server and current locale. */
export function catalogResourceHref(value: string, server: ReleaseServer, locale: Locale): string {
  if (!value.startsWith("/catalog")) return value;
  const target = resourceCollectionHref(value, server, locale);
  if (!target) return value;
  const url = new URL(target, "https://route.invalid");
  return legacyEntityRedirectTarget(url.pathname, url.search) || target;
}

/**
 * Resolve an old locale-first collection address to its server-first page.
 * Entity redirects run before this helper; this intentionally accepts only
 * exact collection paths so an entity id can never be swallowed as a section.
 */
export function legacyCollectionRedirectTarget(pathname: string, search = ""): string | undefined {
  if (!pathname.startsWith("/") || pathname.includes("#")) return undefined;
  const parts = pathname.replace(/^\/+|\/+$/gu, "").split("/");
  const locale = parts[0];
  if (!isLocale(locale) || parts[1] !== "catalog") return undefined;
  // Request handlers normally call the entity redirect first. Keep this
  // helper pure as well when it is used independently by a preview or test.
  if (legacyEntityRoute(pathname, search)) return undefined;

  const query = new URLSearchParams(search);
  const serverParam = query.get("server");
  const server = isReleaseServer(serverParam) ? serverParam : "intl";
  query.delete("server");
  const suffix = () => (query.size ? `?${query}` : "");
  const prefix = `/${server}/${locale}`;

  if (parts.length === 2) return `${prefix}/catalog/${suffix()}`;
  const collection = parts[2] || "";
  if (collection === "events" && parts[3] === "tracker" && parts.length === 4)
    return `${prefix}/events/tracker/${suffix()}`;
  if (collection === "assets") {
    const path = parts.slice(3).join("/");
    return `${prefix}/assets/${path ? `${path}/` : ""}${suffix()}`;
  }
  if (parts.length > 4) return undefined;
  if (collection === "skills") return parts.length === 3 ? `${prefix}/skills/${suffix()}` : undefined;
  if (collection === "song-meta") return parts.length === 3 ? `${prefix}/song-meta/${suffix()}` : undefined;
  if (collection === "studio") return parts.length === 3 ? `${prefix}/studio/${suffix()}` : undefined;
  if (collection === "player-ranks" || collection === "friendship-ranks" || collection === "band-rating" || collection === "high-score-rating")
    return parts.length === 3 ? `${prefix}/${collection}/${suffix()}` : undefined;
  if (collection === "anon-tokyo") {
    return parts.length === 4 && isAnonTokyoMode(parts[3]) ? `${prefix}/anon-tokyo/${parts[3]}/${suffix()}` : undefined;
  }
  if (collection === "stories") {
    if (parts.length === 4 && parts[3] === "search") return `${prefix}/stories/search/${suffix()}`;
    const mode = parts.length === 4 ? parts[3] : query.get("mode");
    if (mode !== null && !isStoryMode(mode)) return parts.length === 4 ? undefined : `${prefix}/stories/${suffix()}`;
    if (mode) {
      query.delete("mode");
      return `${prefix}/stories/${mode}/${query.size ? `?${query}` : ""}`;
    }
    return parts.length === 3 ? `${prefix}/stories/${suffix()}` : undefined;
  }

  const kind = resourceKindForCollection(collection);
  return kind && parts.length === 3 ? `${resourcePath({ server, locale, kind })}${suffix()}` : undefined;
}

const SERVER_DOCUMENT_ROOTS = new Set<string>([
  ...RESOURCE_KINDS,
  "cards", "catalog", "assets", "song-meta", "studio", "announcements", "calendar", "anon-tokyo",
  "player-ranks", "friendship-ranks", "band-rating", "high-score-rating",
]);
const LOCALE_DOCUMENT_ROOTS = new Set([
  "account", "settings", "tools", "games", "community", "search", "team-builder", "saves", "song-progress",
  "gacha-history", "song-puzzle", "song-guess", "stamp-maker", "chart-editor", "story-editor", "story-creation",
  "admin", "download", "about", "join", "sponsor", "license", "terms", "privacy", "sonolus",
]);

/** Complete page prefixes without reading a catalogue or changing asset/API addresses. */
export function documentPrefixRedirectTarget(
  pathname: string,
  search: string,
  preferredLocale: () => Locale,
  preferredServer: () => ReleaseServer | undefined,
): { href: string; negotiated: boolean; serverPreference: boolean } | undefined {
  const parts = pathname.split("/").filter(Boolean);
  let server = isReleaseServer(parts[0]) ? parts.shift() : undefined;
  const locale = isLocale(parts[0]) ? parts.shift() as Locale : undefined;
  if (server && locale && parts[0] !== "catalog" && parts[0] !== "cards" && !LOCALE_DOCUMENT_ROOTS.has(parts[0] || ""))
    return undefined;
  if (!server && locale && isReleaseServer(parts[0])) server = parts.shift();
  const root = parts[0] || "";
  const native = !root || SERVER_DOCUMENT_ROOTS.has(root);
  if (!native && !LOCALE_DOCUMENT_ROOTS.has(root)) return undefined;
  if (!server && locale && !native) return undefined;
  if (!server && !locale && ((root === "assets" && parts.length > 1) || root === "sonolus")) return undefined;
  if (!native && parts.at(-1)?.includes(".")) return undefined;

  const language = locale ?? preferredLocale();
  const query = new URLSearchParams(search);
  const hadServer = query.has("server");
  const queryServer = query.get("server");
  const serverPreference = native && !server && !isReleaseServer(queryServer);
  let target: string;
  let suffix = search;
  if (native) {
    const selected = server ?? (isReleaseServer(queryServer) ? queryServer : preferredServer() ?? "intl");
    if (root === "catalog") {
      query.set("server", selected);
      target = `/${language}/${parts.join("/")}/`;
    } else {
      if (root === "cards") parts[0] = "member-cards";
      target = `/${selected}/${language}/${parts.length ? `${parts.join("/")}/` : ""}`;
      query.delete("server");
    }
    if (root === "catalog" || hadServer)
      suffix = query.size ? `?${query}` : "";
  } else {
    target = `/${language}/${parts.join("/")}/`;
    if (server) {
      query.set("server", server);
      suffix = `?${query}`;
    }
  }
  const href = legacyCommunityStoryRedirectTarget(target, suffix) ?? legacyCommunityChartRedirectTarget(target, suffix)
    ?? legacyEntityRedirectTarget(target, suffix) ?? legacyCollectionRedirectTarget(target, suffix)
    ?? legacyHomeRedirectTarget(target, suffix) ?? `${target}${suffix}`;
  const needsServerPreference = serverPreference && !!releaseServerFromPath(href);
  return href === `${pathname}${search}` ? undefined : {
    href, negotiated: !locale || needsServerPreference,
    serverPreference: needsServerPreference,
  };
}

/** A first visit migrates the existing browser preference before selecting a server. */
export function documentPrefixResponse(
  target: NonNullable<ReturnType<typeof documentPrefixRedirectTarget>>,
  savedServer: ReleaseServer | undefined,
  htmlNavigation: boolean,
): Response {
  const headers = { "Cache-Control": target.negotiated ? "no-store" : "public, max-age=86400",
    ...(target.negotiated ? { Vary: "Cookie, Accept-Language" } : {}) };
  if (target.serverPreference && !savedServer && htmlNavigation) {
    const href = JSON.stringify(target.href).replaceAll("<", "\\u003c");
    const fallback = target.href.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
    const body = `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><script>let s;try{s=localStorage.getItem("${RELEASE_SERVER_COOKIE}")}catch{}s=s==="jp"?"jp":"intl";try{document.cookie="${RELEASE_SERVER_COOKIE}="+s+";Path=/;Max-Age=31536000;SameSite=Lax"+(location.protocol==="https:"?";Secure":"")}catch{}const u=new URL(${href},location.href);u.pathname=u.pathname.replace(/^\\/(?:jp|intl)\\//,"/"+s+"/");u.hash=location.hash;location.replace(u.href);</script><noscript><meta http-equiv="refresh" content="0;url=${fallback}"></noscript>`;
    return new Response(body, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex" } });
  }
  return new Response(null, { status: target.negotiated ? 302 : 308, headers: { ...headers, Location: target.href } });
}

let entityReturnLink: ((href: string, returnTo?: string) => string) | undefined;
/** The browser installs tab-local return memory; server renderers emit plain links. */
export function setEntityReturnLink(handler: (href: string, returnTo?: string) => string): void {
  entityReturnLink = handler;
}
export function navigationReturnHref(href: string, returnTo?: string): string {
  return entityReturnLink ? entityReturnLink(href, returnTo) : href;
}
export function entityHref(options: {
  server: ReleaseServer;
  locale: Locale;
  kind: ResourceKind;
  id: string;
  view?: "story";
  returnTo?: string;
  query?: string | URLSearchParams | Readonly<Record<string, string>>;
}): string {
  const target = new URL(resourcePath(options), "https://route.invalid");
  if (options.query) {
    const query =
      typeof options.query === "string"
        ? new URLSearchParams(options.query)
        : options.query instanceof URLSearchParams
          ? options.query
          : new URLSearchParams(Object.entries(options.query));
    for (const [key, value] of query) target.searchParams.append(key, value);
  }
  const href = `${target.pathname}${target.search}`;
  return navigationReturnHref(href, options.returnTo);
}

export function parseEntitySelection(pathname: string, search = ""): EntitySelection | undefined {
  const canonical = parseResourceRoute(pathname);
  if (canonical?.kind === "stories" && isStoryMode(canonical.id)) return undefined;
  if (canonical?.id) return { route: canonical as ResourceRoute & { id: string }, source: "canonical" };
  const legacy = legacyEntityRoute(pathname, search);
  if (!legacy) return undefined;
  const returnTo = `${pathname}${queryStringWithoutSelection(search, legacy.kind)}`;
  return returnTo === pathname ? { route: legacy, source: "legacy" } : { route: legacy, source: "legacy", returnTo };
}

export function returnStateFromLocation(pathname: string, search: string, kind: ResourceKind): string {
  return `${pathname}${queryStringWithoutSelection(search, kind)}`;
}
