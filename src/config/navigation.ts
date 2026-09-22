export interface NavItem {
  route: string;
  icon: string;
  label: string;
  children?: NavItem[];
}
/** A headed section of the navigation drawer (Material 3 "section headline"). */
export interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
  /** Long sections collapse behind a disclosure so the drawer stays scannable. */
  collapsible?: boolean;
}
/** A top-level destination shown in the navigation rail and navigation bar. */
export interface PrimaryDestination {
  id: string;
  route: string;
  icon: string;
  label: string;
  /** Route prefixes that make this destination current. */
  match: string[];
  /** Prefixes that belong to a more specific destination and must not match here. */
  exclude?: string[];
}

const STORY_ROUTES = ["band", "link", "home", "afterlive", "tutorial"] as const;
const STORY_ICONS: Record<(typeof STORY_ROUTES)[number], string> = {
  band: "groups",
  link: "diversity_1",
  home: "home",
  afterlive: "celebration",
  tutorial: "school",
};

export const PRIMARY_DESTINATIONS: PrimaryDestination[] = [
  { id: "home", route: "/", icon: "home", label: "home", match: ["/"] },
  {
    id: "catalog",
    route: "/catalog",
    icon: "category",
    label: "catalog",
    match: ["/catalog"],
    exclude: ["/catalog/stories"],
  },
  { id: "stories", route: "/catalog/stories", icon: "auto_stories", label: "stories", match: ["/catalog/stories"] },
  { id: "community", route: "/community/feeds", icon: "forum", label: "community", match: ["/community"] },
  { id: "settings", route: "/settings", icon: "settings", label: "settings", match: ["/settings"] },
];

export const NAV_SECTIONS: NavSection[] = [
  {
    id: "library",
    label: "library",
    items: [
      { route: "/catalog/songs", icon: "library_music", label: "songs" },
      { route: "/catalog/member-cards", icon: "style", label: "memberCards" },
      { route: "/catalog/support-cards", icon: "collections", label: "supportCards" },
      { route: "/catalog/characters", icon: "group", label: "characters" },
    ],
  },
  {
    id: "stories",
    label: "stories",
    items: STORY_ROUTES.map((key) => ({
      route: `/catalog/stories/${key}`,
      icon: STORY_ICONS[key],
      label: `storyNavigation.${key}`,
    })),
  },
  {
    id: "collection",
    label: "collection",
    items: [
      { route: "/catalog/stamps", icon: "emoji_emotions", label: "stamps" },
      { route: "/catalog/comics", icon: "menu_book", label: "comics" },
      { route: "/catalog/items", icon: "inventory_2", label: "items" },
      { route: "/catalog/band-items", icon: "piano", label: "bandItems" },
    ],
  },
  {
    id: "tools",
    label: "tools",
    items: [
      { route: "/catalog/live2d", icon: "animation", label: "live2d" },
      { route: "/catalog/spine", icon: "accessibility_new", label: "spine" },
      { route: "/catalog/assets", icon: "folder_open", label: "assets" },
      { route: "/catalog/help", icon: "help", label: "help" },
    ],
  },
  {
    id: "game",
    label: "gameSystems",
    collapsible: true,
    items: [
      { route: "/catalog/events", icon: "event", label: "events" },
      { route: "/catalog/gacha", icon: "redeem", label: "gacha" },
      { route: "/catalog/login-campaigns", icon: "event_available", label: "loginCampaigns" },
      { route: "/catalog/shop", icon: "storefront", label: "shop" },
      { route: "/catalog/exchange", icon: "swap_horiz", label: "exchange" },
      { route: "/catalog/circle", icon: "diversity_3", label: "circle" },
      { route: "/catalog/challenge", icon: "emoji_events", label: "challenge" },
    ],
  },
  {
    id: "anon-tokyo",
    label: "anonTokyo",
    collapsible: true,
    items: [
      { route: "/catalog/anon-tokyo/characters", icon: "group", label: "anonTokyoPage.characters" },
      { route: "/catalog/anon-tokyo/outfits", icon: "checkroom", label: "anonTokyoPage.dressingRoom" },
      { route: "/catalog/anon-tokyo/shop", icon: "storefront", label: "anonTokyoPage.shop" },
      { route: "/catalog/anon-tokyo/goods", icon: "sell", label: "anonTokyoPage.goodsEconomy" },
      { route: "/catalog/anon-tokyo/decorations", icon: "chair", label: "anonTokyoPage.decorations" },
      { route: "/catalog/anon-tokyo/staff", icon: "badge", label: "anonTokyoPage.staffSection" },
      { route: "/catalog/anon-tokyo/customers", icon: "group", label: "anonTokyoPage.customersPage" },
      { route: "/catalog/anon-tokyo/tasks", icon: "fact_check", label: "anonTokyoPage.tasks" },
      { route: "/catalog/anon-tokyo/guide", icon: "menu_book", label: "anonTokyoPage.guide" },
      { route: "/catalog/anon-tokyo/fever", icon: "music_note", label: "anonTokyoPage.fever" },
    ],
  },
  {
    id: "community",
    label: "community",
    items: [
      { route: "/community/feeds", icon: "dynamic_feed", label: "communityPage.feed" },
      { route: "/community/mine", icon: "person", label: "communityPage.mine" },
      { route: "/community/bookmarks", icon: "bookmarks", label: "communityPage.bookmarks" },
      { route: "/community/notifications", icon: "notifications", label: "communityPage.notifications" },
      { route: "/community/activity", icon: "comment", label: "communityPage.activity" },
      { route: "/community/tags", icon: "sell", label: "communityPage.tags" },
      { route: "/community/playlists", icon: "queue_music", label: "communityPage.playlistPage.title" },
      { route: "/community/songs-bestdori", icon: "library_music", label: "communityPage.songsBestDori" },
      { route: "/community/stories-bestdori", icon: "auto_stories", label: "communityPage.storiesBestDori" },
    ],
  },
];

/** Catalog hub cards: every browsable collection with the catalog resource that counts it. */
export const CATALOG_HUB: Array<NavItem & { resource?: string; countKey?: string }> = [
  { route: "/catalog/songs", icon: "library_music", label: "songs", resource: "songs" },
  { route: "/catalog/member-cards", icon: "style", label: "memberCards", resource: "cards" },
  { route: "/catalog/support-cards", icon: "collections", label: "supportCards", resource: "support-cards" },
  { route: "/catalog/characters", icon: "group", label: "characters", resource: "characters" },
  { route: "/catalog/stories", icon: "auto_stories", label: "stories", resource: "stories", countKey: "episodes" },
  { route: "/catalog/stamps", icon: "emoji_emotions", label: "stamps", resource: "stamps" },
  { route: "/catalog/comics", icon: "menu_book", label: "comics", resource: "comics" },
  { route: "/catalog/items", icon: "inventory_2", label: "items", resource: "items" },
  { route: "/catalog/band-items", icon: "piano", label: "bandItems", resource: "band-items" },
  { route: "/catalog/live2d", icon: "animation", label: "live2d", resource: "live2d" },
  { route: "/catalog/spine", icon: "accessibility_new", label: "spine", resource: "spine" },
  { route: "/catalog/assets", icon: "folder_open", label: "assets" },
  { route: "/catalog/help", icon: "help", label: "help", resource: "help" },
  { route: "/catalog/anon-tokyo/characters", icon: "storefront", label: "anonTokyo" },
];

/** Routes whose page is a full-bleed viewer; the compact navigation bar yields its space to them. */
export const IMMERSIVE_PREFIXES = [
  "/catalog/live2d",
  "/catalog/spine",
  "/catalog/assets",
  "/catalog/anon-tokyo/outfits",
];

export const isRouteActive = (target: string, route: string) =>
  target === "/" ? route === "/" : route === target || route.startsWith(`${target}/`);

export const isDestinationActive = (destination: PrimaryDestination, route: string) =>
  destination.match.some((prefix) => isRouteActive(prefix, route)) &&
  !(destination.exclude ?? []).some((prefix) => isRouteActive(prefix, route));
