import type { Locale } from "../i18n/locales";
import { group, t } from "../i18n/messages";

export type PageKind =
  "home" | "index" | "catalog" | "tgw-card" | "studio" | "missions" | "event-tracker" | "song-puzzle" | "stamp-maker" | "legal" | "notice";
export interface RouteDefinition {
  route: string;
  kind: PageKind;
  key: string;
  titleKey?: string;
  resource?: string;
  page?: string;
  staticRedirect?: string;
}

const catalogs: Array<[string, string, string?]> = [
  ["member-cards", "navigation.memberCards", "cards"],
  ["support-cards", "navigation.supportCards"],
  ["characters", "navigation.characters"],
  ["comics", "navigation.comics"],
  ["stamps", "navigation.stamps"],
  ["stickers", "navigation.stickers"],
  ["backgrounds", "navigation.backgrounds"],
  ["live2d", "navigation.live2d"],
  ["songs", "navigation.songs"],
  ["song-meta", "catalog.songs.fields.songMeta"],
  ["band-items", "navigation.bandItems"],
  ["spine", "navigation.spine"],
  ["stories", "navigation.stories"],
  ["items", "navigation.items"],
  ["help", "navigation.help"],
  // The rotating game systems are ordinary catalogue collections: same list,
  // filter, view-switch and detail contract as every other resource.
  ["events", "navigation.events"],
  ["real-lives", "navigation.realLives"],
  ["gacha", "navigation.gacha"],
  ["login-campaigns", "navigation.loginCampaigns"],
  ["shop", "navigation.shop"],
  ["exchange", "navigation.exchange"],
  ["passes", "navigation.systemNavPasses"],
];
const appPages: Array<[string, string]> = [
  ["/account", "navigation.account"],
  ["/account/reset-password", "account.page.resetPasswordTitle"],
  ["/settings", "navigation.settings"],
  ["/community", "navigation.community"],
  ["/community/feeds", "community.page.feedRecommended"],
  ["/community/latest", "community.page.feedLatest"],
  ["/community/following", "community.page.feedFollowing"],
  ["/community/mine", "community.page.mine"],
  ["/community/bookmarks", "community.page.bookmarks"],
  ["/community/notifications", "community.page.notifications"],
  ["/community/activity", "community.page.activity"],
  ["/community/tags", "community.page.tags"],
  ["/community/playlists", "community.page.playlistPage.title"],
  ["/community/songs-bestdori", "community.page.songsBestDori"],
  // Bestdori stories are one route per section, rendered by <story-workspace>.
  ...(["event", "band", "main", "afterlive", "card"] as const).map(
    (section) =>
      [
        `/community/stories-bestdori/${section}`,
        `story.navigation.bestdori${section.charAt(0).toUpperCase()}${section.slice(1)}`,
      ] as [string, string],
  ),
];

export const ROUTES: RouteDefinition[] = [
  { route: "/", kind: "home", key: "home", titleKey: "home.dashboard.overview" },
  { route: "/catalog", kind: "index", key: "catalog", titleKey: "navigation.catalog" },
  ...catalogs.map(([key, titleKey, resource]) => ({
    route: `/catalog/${key}`,
    kind: "catalog" as const,
    key,
    titleKey,
    resource: resource ?? key,
  })),
  ...(["event", "band", "link", "birthday", "home", "afterlive", "tutorial"] as const).map((key) => ({
    route: `/catalog/stories/${key}`,
    kind: "catalog" as const,
    key: `stories-${key}`,
    titleKey: key === "birthday" ? "story.labels.birthdayStory" : `story.navigation.${key}`,
    resource: "stories",
  })),
  ...["characters", "outfits", "shop", "goods", "decorations", "staff", "customers", "tasks", "guide", "fever"].map(
    (key) => ({
      route: `/catalog/anon-tokyo/${key}`,
      kind: "catalog" as const,
      key: `anon-${key}`,
      titleKey: `catalog.anonTokyo.${key === "outfits" ? "dressingRoom" : key}`,
      resource: `anon-tokyo/${key}`,
    }),
  ),
  { route: "/catalog/tgw-card", kind: "tgw-card", key: "tgw-card", titleKey: "catalog.tgwCard.card", resource: "tgw-card" },
  { route: "/catalog/studio", kind: "studio", key: "studio", titleKey: "catalog.studio.title", resource: "studio" },
  {
    route: "/catalog/missions",
    kind: "missions",
    key: "missions",
    titleKey: "navigation.systemNavMissions",
    resource: "missions",
  },
  { route: "/catalog/assets", kind: "notice", key: "assets", titleKey: "navigation.assets" },
  { route: "/catalog/events/tracker", kind: "event-tracker", key: "event-tracker", titleKey: "tools.eventTracker.title" },
  { route: "/song-puzzle", kind: "song-puzzle", key: "song-puzzle", titleKey: "tools.songPuzzle.title" },
  { route: "/tools/song-puzzle", kind: "song-puzzle", key: "song-puzzle-legacy", titleKey: "tools.songPuzzle.title", staticRedirect: "/song-puzzle" },
  { route: "/stamp-maker", kind: "stamp-maker", key: "stamp-maker", titleKey: "tools.stampMaker.title" },
  {
    route: "/tools/stamp-maker",
    kind: "stamp-maker",
    key: "stamp-maker-legacy",
    titleKey: "tools.stampMaker.title",
    staticRedirect: "/stamp-maker",
  },
  ...appPages.map(([route, titleKey]) => ({
    route,
    kind: "notice" as const,
    key: route.slice(1).replaceAll("/", "-"),
    titleKey,
  })),
  { route: "/about", kind: "legal", key: "about", page: "aboutPage", titleKey: "legal.about.title" },
  { route: "/join", kind: "legal", key: "join", page: "joinPage", titleKey: "legal.join.title" },
  { route: "/license", kind: "legal", key: "license", page: "licensePage", titleKey: "legal.license.title" },
  { route: "/terms", kind: "legal", key: "terms", page: "termsPage", titleKey: "legal.terms.title" },
  { route: "/privacy", kind: "legal", key: "privacy", page: "privacyPage", titleKey: "legal.privacy.title" },
];

const LEGAL_PAGE_MESSAGES: Readonly<Record<string, string>> = {
  aboutPage: "legal.about",
  joinPage: "legal.join",
  licensePage: "legal.license",
  termsPage: "legal.terms",
  privacyPage: "legal.privacy",
};
/** Component dispatch names stay separate from their message groups. */
export const legalPageMessageRoot = (page: string): string => LEGAL_PAGE_MESSAGES[page] ?? page;

export const titleOf = (route: RouteDefinition, locale: Locale): string => {
  if (route.page) return String(group<Record<string, unknown>>(locale, legalPageMessageRoot(route.page)).title ?? route.key);
  const fallback = route.key.replaceAll("-", " ");
  return route.titleKey ? t(locale, route.titleKey, fallback) : fallback;
};
export const findRoute = (route: string) => ROUTES.find((item) => item.route === route);
