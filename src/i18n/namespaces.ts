import type { MessageCatalog, MessageNode } from "@haneoka/i18n";
import {
  NAV_SECTIONS,
  PRIMARY_DESTINATIONS,
  UTILITY_DESTINATIONS,
  INFORMATION_DESTINATIONS,
  type NavItem,
} from "../config/navigation";
import { LABEL_ENTRIES } from "../config/catalog-labels";
import { catalogLookupKeys } from "./message-paths";
import { localeFromPath } from "./locales";
import { releaseServerFromPath } from "../lib/resource-route";

/** Logical views over the one flat, authoritative public/i18n catalog. */
export const COMMON_I18N_NAMESPACE = "common" as const;
export const CATALOG_I18N_NAMESPACE = "catalog" as const;
export const HOME_I18N_NAMESPACE = "home" as const;
export const CALENDAR_I18N_NAMESPACE = "calendar" as const;
export const STORY_I18N_NAMESPACE = "story" as const;
export const VOICE_I18N_NAMESPACE = "voice" as const;
export const ACCOUNT_I18N_NAMESPACE = "account" as const;
export const COMMUNITY_I18N_NAMESPACE = "community" as const;
export const EDITOR_I18N_NAMESPACE = "editor" as const;
export const LEGAL_I18N_NAMESPACE = "legal" as const;
export const ADMIN_I18N_NAMESPACE = "admin" as const;
export const ANON_I18N_NAMESPACE = "anon" as const;
export const SPINE_I18N_NAMESPACE = "spine" as const;
export const LIVE2D_I18N_NAMESPACE = "live2d" as const;
export const HELP_I18N_NAMESPACE = "help" as const;
export const STAMP_MAKER_I18N_NAMESPACE = "stampMaker" as const;
export const TEAM_BUILDER_I18N_NAMESPACE = "teamBuilder" as const;

export const I18N_NAMESPACES = [
  COMMON_I18N_NAMESPACE,
  CATALOG_I18N_NAMESPACE,
  HOME_I18N_NAMESPACE,
  CALENDAR_I18N_NAMESPACE,
  STORY_I18N_NAMESPACE,
  VOICE_I18N_NAMESPACE,
  ACCOUNT_I18N_NAMESPACE,
  COMMUNITY_I18N_NAMESPACE,
  EDITOR_I18N_NAMESPACE,
  LEGAL_I18N_NAMESPACE,
  ADMIN_I18N_NAMESPACE,
  ANON_I18N_NAMESPACE,
  SPINE_I18N_NAMESPACE,
  LIVE2D_I18N_NAMESPACE,
  HELP_I18N_NAMESPACE,
  STAMP_MAKER_I18N_NAMESPACE,
  TEAM_BUILDER_I18N_NAMESPACE,
] as const;

export type MainI18nNamespace = (typeof I18N_NAMESPACES)[number];

const COMMON_FLAT_KEYS = [
  "importPose",
  "exportPose",
  "resetTransform",
  "invalidModelPackage",
  "emptyModelResource",
  "seo.siteTitle",
  "calendar.title",
  "refresh",
  "settings",
  "search",
  "filter",
  "sort",
  "ascending",
  "descending",
  "all",
  "clear",
  "remove",
  "reset",
  "open",
  "close",
  "back",
  "cancel",
  "menu",
  "download",
  "import",
  "export",
  "play",
  "pause",
  "previous",
  "next",
  "replay",
  "skip",
  "loading",
  "empty",
  "unavailable",
  "error",
  "retry",
  "requestTimedOut",
  "errorPage",
  "primaryNavigation",
  "breadcrumb",
  "section",
  "playback",
  "musicPlayer",
  "playbackPosition",
  "mute",
  "unmute",
  "repeatQueue",
  "repeatTrack",
  "playInOrder",
  "expandPlayer",
  "clearQueue",
  "volume",
  "queue",
  "shuffle",
  "reorder",
  "collapse",
  "morePlaybackControls",
  "tracks",
  "content",
  "current",
  "target",
  "required",
  "source",
  "relationships.speakerNameSeparator",
  "conditions",
  "effects",
  "themeLight",
  "themeSystem",
  "themeDark",
  "language",
  "server",
  "releaseServer",
  "catalogJapanOnly",
  "catalogInternationalOnly",
  "catalogViewingServerData",
  "songTitles",
  "metaNativeScore",
  "metaScoreFactor",
  "forceJapaneseTitles",
  "showDifficultyEstimates",
  "grid",
  "list",
  "table",
  "portrait",
  "previousImage",
  "nextImage",
  "originalImage",
] as const;

const CATALOG_ROOT_KEYS = [
  "announcements",
  "searchPage",
  "playerProfile",
  "catalog",
  "catalogCompat",
  "chartPlayer",
  "itemsPage",
  "bandItemsPage",
  "liveMusicTypes",
  "songTypes",
  "songRanking",
  "eventTracker",
] as const;

const HOME_ROOT_KEYS = [
  "announcements",
  "homePage",
  "catalogCompat.banners",
  "catalogCompat.noBanner",
  "catalogCompat.noEndDate",
  "catalogCompat.noEvent",
  "catalogCompat.spanDays",
  "catalogCompat.spanHours",
  "catalogCompat.spanMinutes",
  "catalogCompat.startsIn",
  "catalogCompat.endsIn",
  "catalogCompat.releasedToday",
  "catalogCompat.releasedAgo",
  "catalogCompat.releasesIn",
  "catalogCompat.voicesRole",
] as const;
const STORY_ROOT_KEYS = [
  "story",
  "stories",
  "bandStories",
  "afterlive",
  "storyNavigation",
  "homeStories",
  "linkStories",
  "tutorial",
  "storyViewer",
  "storyText",
  "voice",
  "catalogCompat.story",
] as const;
const VOICE_ROOT_KEYS = ["voice", "voiceActor", "voices", "catalogCompat.voice"] as const;
const ACCOUNT_ROOT_KEYS = ["account", "accountPage", "publicProfilePage"] as const;
// GBP story readers share community routes and use the central text-view label.
const COMMUNITY_ROOT_KEYS = ["community", "communityPage", "storyText"] as const;
const EDITOR_ROOT_KEYS = ["chartEditor", "chartEditorPage", "storyEditor", "storyEditorPage", "chartPlayer", "liveMusicTypes", "songTypes"] as const;
const LEGAL_ROOT_KEYS = ["about", "aboutPage", "privacyPage", "termsPage", "licensePage"] as const;
const ADMIN_ROOT_KEYS = ["adminPage"] as const;
const ANON_ROOT_KEYS = ["anonTokyo", "anonTokyoPage"] as const;
const SPINE_ROOT_KEYS = ["spine", "spinePage"] as const;
const LIVE2D_ROOT_KEYS = [
  "live2d",
  "story",
  "assetImages",
  "assetAudio",
  "assetVideo",
  "assetModels",
  "assetData",
  "assetOther",
] as const;
const HELP_ROOT_KEYS = ["help", "helpPage"] as const;
const STAMP_MAKER_ROOT_KEYS = ["stampMaker"] as const;

const namespaceRootKeys: Readonly<Record<MainI18nNamespace, readonly string[]>> = {
  common: COMMON_FLAT_KEYS,
  catalog: CATALOG_ROOT_KEYS,
  home: HOME_ROOT_KEYS,
  calendar: ["calendar"],
  story: STORY_ROOT_KEYS,
  voice: VOICE_ROOT_KEYS,
  account: ACCOUNT_ROOT_KEYS,
  community: COMMUNITY_ROOT_KEYS,
  editor: EDITOR_ROOT_KEYS,
  legal: LEGAL_ROOT_KEYS,
  admin: ADMIN_ROOT_KEYS,
  anon: ANON_ROOT_KEYS,
  spine: SPINE_ROOT_KEYS,
  live2d: LIVE2D_ROOT_KEYS,
  help: HELP_ROOT_KEYS,
  stampMaker: STAMP_MAKER_ROOT_KEYS,
  teamBuilder: ["teamBuilder", "liveMusicTypes", "songTypes", "character", "characters", "genre"],
};

const FEATURE_SCALAR_EXCLUSIONS = new Set<string>([
  ...COMMON_FLAT_KEYS,
  "home",
  "catalog",
  "tools",
  "chartEditor",
  "anonTokyo",
  "spine",
  "storyEditor",
  "about",
  "account",
  "community",
  "story",
  "stories",
  "bandStories",
  "afterlive",
  "homeStories",
  "linkStories",
  "tutorial",
  "storyViewer",
  "storyText",
  "voice",
  "voiceActor",
  "voices",
  "live2d",
  "assets",
  "assetImages",
  "assetAudio",
  "assetVideo",
  "assetModels",
  "assetData",
  "assetOther",
  "privacy",
  "terms",
  "license",
]);

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

const commonPaths = (): readonly string[] =>
  [...COMMON_FLAT_KEYS, ...navigationMessagePaths()].flatMap(catalogLookupKeys);

/**
 * The page feature represented by a route. The route is intentionally a
 * pathname only; release-server and authored-content fallback stay separate.
 */
export const featureNamespaceForRoute = (route = "/"): MainI18nNamespace => {
  const pathname = route.split(/[?#]/u, 1)[0] || "/";
  if (pathname === "/" || pathname === "") return HOME_I18N_NAMESPACE;
  const calendarLocale = localeFromPath(pathname);
  const calendarPath = calendarLocale
    ? `/${pathname
        .split("/")
        .filter(Boolean)
        .slice(releaseServerFromPath(pathname) ? 2 : 1)
        .join("/")}`
    : pathname;
  if (calendarPath === "/calendar" || calendarPath.startsWith("/calendar/")) return CALENDAR_I18N_NAMESPACE;
  if (pathname === "/about" || pathname === "/terms" || pathname === "/privacy" || pathname === "/license") {
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

/** Common shell plus the feature namespace needed by the current route. */
export const requiredNamespacesForRoute = (route = "/"): readonly MainI18nNamespace[] => {
  const feature = featureNamespaceForRoute(route);
  return feature === COMMON_I18N_NAMESPACE ? [COMMON_I18N_NAMESPACE] : [COMMON_I18N_NAMESPACE, feature];
};

export const namespacePaths = (namespace: MainI18nNamespace): readonly string[] => {
  const paths = namespace === COMMON_I18N_NAMESPACE ? commonPaths() : namespaceRootKeys[namespace];
  if (namespace === CATALOG_I18N_NAMESPACE) return [...paths, ...LABEL_ENTRIES.map(([, key]) => key)];
  // Account forms use a small number of community labels; keep those leaves
  // local to the account seed without pulling the community body in.
  if (namespace === ACCOUNT_I18N_NAMESPACE) {
    return [
      ...paths,
      "communityPage.appeal",
      "communityPage.appealStatement",
      "communityPage.submitAppeal",
      "communityPage.appealSubmitted",
      "communityPage.appealFailed",
      "homePage.privacy",
      "homePage.terms",
    ];
  }
  return paths;
};

/** Project one logical namespace from the authoritative flat catalog. */
export const extractNamespace = (source: MessageCatalog, namespace: MainI18nNamespace): MessageCatalog => {
  const result: Record<string, MessageNode> = {};
  const paths = new Set(namespacePaths(namespace));
  // Most catalogue/workspace labels are intentionally flat in the source.
  // Include those scalar leaves in the active feature, but never pull a
  // separate page body (aboutPage/communityPage/adminPage/etc.) into it.
  if (namespace !== COMMON_I18N_NAMESPACE && namespace !== LEGAL_I18N_NAMESPACE && namespace !== ADMIN_I18N_NAMESPACE) {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === "string" && !FEATURE_SCALAR_EXCLUSIONS.has(key)) paths.add(key);
    }
  }
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
