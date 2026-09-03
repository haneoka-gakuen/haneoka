import type { Locale } from "../i18n/locales";
import { group, t } from "../i18n/messages";

export type PageKind = "home" | "index" | "catalog" | "legal" | "notice";
export interface RouteDefinition {
  route: string;
  kind: PageKind;
  key: string;
  titleKey?: string;
  resource?: string;
  page?: string;
}

const catalogs: Array<[string, string, string?]> = [
  ["member-cards", "memberCards", "cards"],
  ["support-cards", "supportCards"],
  ["characters", "characters"],
  ["comics", "comics"],
  ["stamps", "stamps"],
  ["live2d", "live2d"],
  ["songs", "songs"],
  ["band-items", "bandItems"],
  ["spine", "spine"],
  ["stories", "stories"],
  ["items", "items"],
  ["help", "help"],
];
const notices: Array<[string, string]> = [
  ["events", "events"],
  ["gacha", "gacha"],
  ["login-campaigns", "loginCampaigns"],
  ["shop", "shop"],
  ["exchange", "exchange"],
  ["circle", "circle"],
  ["challenge", "challenge"],
];
const appPages: Array<[string, string]> = [
  ["/account", "account"],
  ["/account/reset-password", "resetPassword"],
  ["/settings", "settings"],
  ["/community", "community"],
  ["/community/feeds", "feed"],
  ["/community/mine", "mine"],
  ["/community/bookmarks", "bookmarks"],
  ["/community/notifications", "notifications"],
  ["/community/activity", "myComments"],
  ["/community/tags", "tags"],
  ["/community/playlists", "playlists"],
  ["/community/songs-bestdori", "bestdoriSongs"],
  ["/community/stories-bestdori", "bestdoriStories"],
];

export const ROUTES: RouteDefinition[] = [
  { route: "/", kind: "home", key: "home", titleKey: "homePage.overview" },
  { route: "/catalog", kind: "index", key: "catalog", titleKey: "catalog" },
  ...catalogs.map(([key, titleKey, resource]) => ({
    route: `/catalog/${key}`,
    kind: "catalog" as const,
    key,
    titleKey,
    resource: resource ?? key,
  })),
  ...["band", "link", "home", "afterlive", "tutorial"].map((key) => ({
    route: `/catalog/stories/${key}`,
    kind: "catalog" as const,
    key: `stories-${key}`,
    titleKey: `storyNavigation.${key}`,
    resource: "stories",
  })),
  ...["characters", "outfits", "shop", "goods", "decorations", "staff", "customers", "tasks", "guide", "fever"].map(
    (key) => ({
      route: `/catalog/anon-tokyo/${key}`,
      kind: "catalog" as const,
      key: `anon-${key}`,
      titleKey: `anonTokyoPage.${key === "outfits" ? "dressingRoom" : key}`,
      resource: `anon-tokyo/${key}`,
    }),
  ),
  ...notices.map(([key, titleKey]) => ({ route: `/catalog/${key}`, kind: "notice" as const, key, titleKey })),
  { route: "/catalog/assets", kind: "notice", key: "assets", titleKey: "assets" },
  ...appPages.map(([route, titleKey]) => ({
    route,
    kind: "notice" as const,
    key: route.slice(1).replaceAll("/", "-"),
    titleKey,
  })),
  { route: "/about", kind: "legal", key: "about", page: "aboutPage", titleKey: "aboutPage.title" },
  { route: "/terms", kind: "legal", key: "terms", page: "termsPage", titleKey: "termsPage.title" },
  { route: "/privacy", kind: "legal", key: "privacy", page: "privacyPage", titleKey: "privacyPage.title" },
];

export const titleOf = (route: RouteDefinition, locale: Locale): string => {
  if (route.page) return String(group<Record<string, unknown>>(locale, route.page).title ?? route.key);
  return t(locale, route.titleKey ?? route.key, route.key.replaceAll("-", " "));
};
export const findRoute = (route: string) => ROUTES.find((item) => item.route === route);
