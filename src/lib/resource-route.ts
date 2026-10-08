import { isLocale, type Locale } from "@haneoka/i18n";

export const RELEASE_SERVERS = ["jp", "intl", "intl-test", "jp-cbt", "intl-cbt"] as const;
export type ReleaseServer = (typeof RELEASE_SERVERS)[number];
export const isReleaseServer = (value: unknown): value is ReleaseServer =>
  typeof value === "string" && RELEASE_SERVERS.includes(value as ReleaseServer);

export function releaseServerFromPath(pathname: string): ReleaseServer | undefined {
  const prefix = pathname.split("/")[1];
  return isReleaseServer(prefix) ? prefix : undefined;
}

export const RESOURCE_KINDS = [
  "characters",
  "songs",
  "member-cards",
  "support-cards",
  "stories",
  "comics",
  "stamps",
  "stickers",
  "backgrounds",
  "band-items",
  "items",
  "events",
  "real-lives",
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
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** First-party story collections, in drawer order. */
export const STORY_MODES = ["event", "band", "link", "birthday", "home", "afterlive", "tutorial"] as const;
export type StoryMode = (typeof STORY_MODES)[number];

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

export interface ResourceRoute {
  server: ReleaseServer;
  locale: Locale;
  kind: ResourceKind;
  id?: string;
  /** A child view rendered below an entity's canonical resource page. */
  view?: "chart" | "ranking";
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

/** Public resource addresses contain identity; content revisions belong in data URLs. */
export function resourcePath({ server, locale, kind, id }: ResourceRoute): string {
  if (!isReleaseServer(server) || !isLocale(locale) || !isResourceKind(kind))
    throw new TypeError("Invalid resource route");
  if (id !== undefined && !isResourceId(id)) throw new TypeError("Invalid resource identity");
  return `/${server}/${locale}/${kind}/${id === undefined ? "" : `${encodeURIComponent(id)}/`}`;
}

export function homePath(server: ReleaseServer, locale: Locale): string {
  if (!isReleaseServer(server) || !isLocale(locale)) throw new TypeError("Invalid home route");
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

export function parseResourceRoute(pathname: string): ResourceRoute | undefined {
  if (!pathname.startsWith("/") || pathname.includes("?") || pathname.includes("#")) return undefined;
  const parts = pathname.slice(1).replace(/\/$/u, "").split("/");
  if (parts.length !== 3 && parts.length !== 4 && parts.length !== 5) return undefined;
  const [server, locale, kind, encodedId, child] = parts;
  if (!isReleaseServer(server) || !isLocale(locale) || !isResourceKind(kind)) return undefined;
  if (kind === "events" && encodedId === "tracker") return undefined;
  if (parts.length === 5 && !(kind === "songs" && (child === "chart" || child === "ranking"))) return undefined;
  if (encodedId === undefined) return { server, locale, kind };
  try {
    const id = decodeURIComponent(encodedId);
    return isResourceId(id)
      ? { server, locale, kind, id, ...(child ? { view: child as "chart" | "ranking" } : {}) }
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
  "band-items": "item",
  items: "item",
  events: "entry",
  "real-lives": "entry",
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
  const selected = param ? new URLSearchParams(search).get(param) : undefined;
  const route =
    collection && !collection.id && selected && isResourceId(selected)
      ? { ...collection, id: selected }
      : legacyEntityRoute(pathname, search);
  if (!route) return undefined;
  const query = new URLSearchParams(queryStringWithoutSelection(search, route.kind));
  query.delete("server");
  return `${resourcePath(route)}${query.size ? `?${query}` : ""}`;
}

/** Map logical catalogue destinations to the selected server's collections. */
export function resourceCollectionHref(route: string, server: ReleaseServer, locale: Locale): string | undefined {
  const source = new URL(route, "https://route.invalid");
  const parts = source.pathname.replace(/^\/+|\/+$/gu, "").split("/");
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
  if (parts.length > 2 && !(collection === "stories" || collection === "anon-tokyo")) return undefined;
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
  if (collection === "song-meta") return parts.length === 3 ? `${prefix}/song-meta/${suffix()}` : undefined;
  if (collection === "anon-tokyo") {
    return parts.length === 4 && isAnonTokyoMode(parts[3]) ? `${prefix}/anon-tokyo/${parts[3]}/${suffix()}` : undefined;
  }
  if (collection === "stories") {
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

export function entityHref(options: {
  server: ReleaseServer;
  locale: Locale;
  kind: ResourceKind;
  id: string;
  returnTo?: string;
  query?: string | URLSearchParams | Readonly<Record<string, string>>;
}): string {
  const target = new URL(resourcePath(options), "https://route.invalid");
  if (options.returnTo) target.searchParams.set("return", options.returnTo);
  if (options.query) {
    const query =
      typeof options.query === "string"
        ? new URLSearchParams(options.query)
        : options.query instanceof URLSearchParams
          ? options.query
          : new URLSearchParams(Object.entries(options.query));
    for (const [key, value] of query) target.searchParams.append(key, value);
  }
  return `${target.pathname}${target.search}`;
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
