import type { MessageCatalog, MessageNode } from "@haneoka/i18n";
import {
  NAV_SECTIONS,
  PRIMARY_DESTINATIONS,
  UTILITY_DESTINATIONS,
  INFORMATION_DESTINATIONS,
  type NavItem,
} from "../config/navigation";
import { LABEL_ENTRIES } from "../config/catalog-labels";
import { localeFromPath } from "./locales";
import { releaseServerFromPath } from "../lib/resource-route";

/** Logical views over the semantic, authoritative public/i18n catalog. */
export const COMMON_I18N_NAMESPACE = "common" as const;
export const CATALOG_I18N_NAMESPACE = "catalog" as const;
export const HOME_I18N_NAMESPACE = "home" as const;
export const CALENDAR_I18N_NAMESPACE = "calendar" as const;
export const STORY_I18N_NAMESPACE = "story" as const;
export const VOICE_I18N_NAMESPACE = "voice" as const;
export const MEDIA_I18N_NAMESPACE = "media" as const;
export const ACCOUNT_I18N_NAMESPACE = "account" as const;
export const COMMUNITY_I18N_NAMESPACE = "community" as const;
export const EDITOR_I18N_NAMESPACE = "editor" as const;
export const LEGAL_I18N_NAMESPACE = "legal" as const;
export const ADMIN_I18N_NAMESPACE = "admin" as const;
export const ANON_I18N_NAMESPACE = "anon" as const;
export const SPINE_I18N_NAMESPACE = "spine" as const;
export const LIVE2D_I18N_NAMESPACE = "live2d" as const;
export const HELP_I18N_NAMESPACE = "help" as const;
export const SONG_PUZZLE_I18N_NAMESPACE = "songSlidePuzzle" as const;
export const STAMP_MAKER_I18N_NAMESPACE = "stampMaker" as const;
export const TEAM_BUILDER_I18N_NAMESPACE = "teamBuilder" as const;

export const I18N_NAMESPACES = [
  COMMON_I18N_NAMESPACE,
  CATALOG_I18N_NAMESPACE,
  HOME_I18N_NAMESPACE,
  CALENDAR_I18N_NAMESPACE,
  STORY_I18N_NAMESPACE,
  VOICE_I18N_NAMESPACE,
  MEDIA_I18N_NAMESPACE,
  ACCOUNT_I18N_NAMESPACE,
  COMMUNITY_I18N_NAMESPACE,
  EDITOR_I18N_NAMESPACE,
  LEGAL_I18N_NAMESPACE,
  ADMIN_I18N_NAMESPACE,
  ANON_I18N_NAMESPACE,
  SPINE_I18N_NAMESPACE,
  LIVE2D_I18N_NAMESPACE,
  HELP_I18N_NAMESPACE,
  SONG_PUZZLE_I18N_NAMESPACE,
  STAMP_MAKER_I18N_NAMESPACE,
  TEAM_BUILDER_I18N_NAMESPACE,
] as const;

export type MainI18nNamespace = (typeof I18N_NAMESPACES)[number];

/** Explicit semantic domains; feature payloads never inject unrelated scalar leaves. */
const namespaceRootKeys: Readonly<Record<MainI18nNamespace, readonly string[]>> = {
  common: ["common", "navigation", "settings", "media.audio", "media.images.actions", "media.capture", "catalog.bands.names"],
  catalog: ["catalog", "editors.chart.labels.notes", "editors.chart.labels.combo"],
  home: ["home"],
  calendar: ["tools.calendar"],
  story: ["story"],
  voice: ["media.voice", "media.audio"],
  media: ["media"],
  account: ["account", "community.page.appeal", "community.page.appealStatement", "community.page.submitAppeal", "community.page.appealSubmitted", "community.page.appealFailed", "home.dashboard.privacy", "home.dashboard.terms"],
  community: ["community"],
  editor: ["editors"],
  legal: ["legal"],
  admin: ["admin"],
  anon: ["catalog.anonTokyo"],
  spine: ["media.spine"],
  live2d: ["media.models"],
  help: ["common.help"],
  songSlidePuzzle: ["tools.songPuzzle"],
  stampMaker: ["tools.stampMaker"],
  teamBuilder: ["tools.teamBuilder"],
};

const pathValue = (source: MessageCatalog, path: string): MessageNode | undefined => {
  let value: MessageNode | undefined = source;
  for (const segment of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as MessageCatalog)[segment];
  }
  return value;
};

const setPath = (target: Record<string, MessageNode>, path: string, value: MessageNode): void => {
  const segments = path.split(".");
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      const child: Record<string, MessageNode> = {};
      cursor[segment] = child;
      cursor = child;
    } else {
      cursor = existing as MessageCatalog as Record<string, MessageNode>;
    }
  }
  cursor[segments[segments.length - 1]!] = value;
};

const visitNavItem = (item: NavItem, paths: Set<string>): void => {
  paths.add(item.label);
  for (const child of item.children ?? []) visitNavItem(child, paths);
};

/** Labels used by the shell, including nested labels declared by navigation. */
export const navigationMessagePaths = (): readonly string[] => {
  const paths = new Set<string>();
  for (const destination of PRIMARY_DESTINATIONS) paths.add(destination.label);
  for (const destination of [...UTILITY_DESTINATIONS, ...INFORMATION_DESTINATIONS]) paths.add(destination.label);
  for (const section of NAV_SECTIONS) {
    paths.add(section.label);
    for (const item of section.items) visitNavItem(item, paths);
  }
  return [...paths];
};

/**
 * The page feature represented by a route. The route is intentionally a
 * pathname only; release-server and authored-content fallback stay separate.
 */
export const featureNamespaceForRoute = (route = "/"): MainI18nNamespace => {
  const rawPathname = route.split(/[?#]/u, 1)[0] || "/";
  const pathLocale = localeFromPath(rawPathname);
  const pathname = pathLocale
    ? `/${rawPathname
        .split("/")
        .filter(Boolean)
        .slice(releaseServerFromPath(rawPathname) ? 2 : 1)
        .join("/")}`
    : rawPathname;
  if (pathname === "/" || pathname === "") return HOME_I18N_NAMESPACE;
  if (pathname === "/calendar" || pathname.startsWith("/calendar/")) return CALENDAR_I18N_NAMESPACE;
  if (pathname === "/about" || pathname === "/join" || pathname === "/terms" || pathname === "/privacy" || pathname === "/license") {
    return LEGAL_I18N_NAMESPACE;
  }
  if (pathname === "/account" || pathname.startsWith("/account/")) return ACCOUNT_I18N_NAMESPACE;
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return COMMON_I18N_NAMESPACE;
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return ADMIN_I18N_NAMESPACE;
  if (pathname === "/community" || pathname.startsWith("/community/")) return COMMUNITY_I18N_NAMESPACE;
  if (
    pathname === "/stamp-maker" || pathname.startsWith("/stamp-maker/") ||
    pathname === "/tools/stamp-maker" || pathname.startsWith("/tools/stamp-maker/")
  )
    return STAMP_MAKER_I18N_NAMESPACE;
  if (pathname === "/song-puzzle" || pathname.startsWith("/song-puzzle/")) return SONG_PUZZLE_I18N_NAMESPACE;
  if (pathname === "/team-builder" || pathname.startsWith("/team-builder/")) return TEAM_BUILDER_I18N_NAMESPACE;
  if (pathname.includes("anon-tokyo")) return ANON_I18N_NAMESPACE;
  if (pathname.includes("chart-editor") || pathname.includes("story-editor")) return EDITOR_I18N_NAMESPACE;
  if (pathname.includes("stories")) return STORY_I18N_NAMESPACE;
  if (pathname.includes("live2d")) return LIVE2D_I18N_NAMESPACE;
  if (pathname.includes("spine")) return SPINE_I18N_NAMESPACE;
  if (pathname.includes("help")) return HELP_I18N_NAMESPACE;
  if (pathname.includes("voice")) return VOICE_I18N_NAMESPACE;
  return CATALOG_I18N_NAMESPACE;
};

/** Transitive feature dependencies are explicit and shared by SSR and client loading. */
const namespaceDependencies: Partial<Record<MainI18nNamespace, readonly MainI18nNamespace[]>> = {
  catalog: ["media"],
  home: ["catalog", "media"], calendar: ["catalog"], story: ["catalog", "media"],
  voice: ["catalog", "media"], editor: ["catalog", "media", "story"],
  anon: ["catalog", "media"], spine: ["catalog", "media"], live2d: ["catalog", "media"],
  songSlidePuzzle: ["catalog"], stampMaker: ["catalog", "media"], teamBuilder: ["catalog", "media"],
  community: ["catalog", "media", "story"], admin: ["catalog", "community"],
};
export const namespaceDependencyClosure = (requested: readonly MainI18nNamespace[]): readonly MainI18nNamespace[] => {
  const paths = new Set<MainI18nNamespace>([COMMON_I18N_NAMESPACE]);
  const include = (namespace: MainI18nNamespace) => {
    if (paths.has(namespace)) return;
    paths.add(namespace);
    for (const dependency of namespaceDependencies[namespace] ?? []) include(dependency);
  };
  for (const namespace of requested) include(namespace);
  return [...paths];
};
export const requiredNamespacesForRoute = (route = "/"): readonly MainI18nNamespace[] =>
  namespaceDependencyClosure([featureNamespaceForRoute(route)]);
export const namespacePaths = (namespace: MainI18nNamespace): readonly string[] =>
  namespace === COMMON_I18N_NAMESPACE
    ? [...namespaceRootKeys.common, ...navigationMessagePaths()]
    : namespace === CATALOG_I18N_NAMESPACE
      ? [...namespaceRootKeys.catalog, ...LABEL_ENTRIES.map(([, key]) => key)]
      : namespaceRootKeys[namespace];

/** Project only the registered semantic paths. */
export const extractNamespace = (source: MessageCatalog, namespace: MainI18nNamespace): MessageCatalog => {
  const result: Record<string, MessageNode> = {};
  const paths = new Set(namespacePaths(namespace));
  for (const path of paths) {
    const segments = path.split(".");
    if (segments.some((_, index) => index > 0 && paths.has(segments.slice(0, index).join(".")))) continue;
    const value = pathValue(source, path);
    if (value !== undefined) setPath(result, path, value);
  }
  return result;
};

const missingNode = (
  preferred: MessageNode | undefined,
  fallback: MessageNode | undefined,
): MessageNode | undefined => {
  if (fallback === undefined) return undefined;
  if (preferred === undefined) return fallback;
  if (Array.isArray(preferred) && Array.isArray(fallback)) {
    const missing = fallback.map((value, index) => missingNode(preferred[index], value));
    return missing.some((value) => value !== undefined) ? missing.map((value) => value ?? {}) : undefined;
  }
  if (
    preferred &&
    fallback &&
    typeof preferred === "object" &&
    typeof fallback === "object" &&
    !Array.isArray(preferred) &&
    !Array.isArray(fallback)
  ) {
    const result: Record<string, MessageNode> = {};
    for (const key of Object.keys(fallback)) {
      const value = missingNode((preferred as MessageCatalog)[key], (fallback as MessageCatalog)[key]);
      if (value !== undefined) result[key] = value;
    }
    return Object.keys(result).length ? result : undefined;
  }
  return undefined;
};

/** Japanese leaves absent from the requested locale, retaining provenance. */
export const missingFallbackNamespace = (preferred: MessageCatalog, fallback: MessageCatalog): MessageCatalog =>
  (missingNode(preferred, fallback) as MessageCatalog | undefined) ?? {};
