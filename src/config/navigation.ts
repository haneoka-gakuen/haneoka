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
/** A top-level destination shown in the navigation rail and drawer. */
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
/** Bestdori's story sections, served by worker/bestdori.ts. */
const BESTDORI_STORY_ROUTES = ["event", "band", "main", "afterlive", "card"] as const;
const BESTDORI_STORY_ICONS: Record<(typeof BESTDORI_STORY_ROUTES)[number], string> = {
  event: "event",
  band: "groups",
  main: "auto_stories",
  afterlive: "celebration",
  card: "style",
};

export const PRIMARY_DESTINATIONS: PrimaryDestination[] = [
  { id: "home", route: "/", icon: "home", label: "home", match: ["/"] },
  {
    id: "catalog",
    route: "/catalog",
    icon: "category",
    label: "catalog",
    match: ["/catalog", "/community/stories-bestdori", "/community/songs-bestdori", "/community/playlists"],
  },
  {
    id: "community",
    route: "/community/feeds",
    icon: "forum",
    label: "community",
    match: ["/community"],
    exclude: ["/community/stories-bestdori", "/community/songs-bestdori", "/community/playlists"],
  },
];

const sections: NavSection[] = [
  {
    id: "library",
    label: "library",
    items: [
      { route: "/catalog/songs", icon: "library_music", label: "songs" },
      { route: "/catalog/characters", icon: "group", label: "characters" },
      { route: "/catalog/member-cards", icon: "style", label: "memberCards" },
      { route: "/catalog/support-cards", icon: "collections", label: "supportCards" },
      { route: "/catalog/comics", icon: "menu_book", label: "comics" },
      { route: "/catalog/events", icon: "event", label: "events" },
      { route: "/catalog/real-lives", icon: "festival", label: "realLives" },
      { route: "/catalog/gacha", icon: "redeem", label: "gacha" },
      { route: "/catalog/login-campaigns", icon: "event_available", label: "loginCampaigns" },
      { route: "/catalog/missions", icon: "fact_check", label: "systemNavMissions" },
      { route: "/catalog/passes", icon: "workspace_premium", label: "systemNavPasses" },
      { route: "/catalog/tgw-card", icon: "credit_card", label: "tgwCard" },
      { route: "/catalog/shop", icon: "storefront", label: "shop" },
      { route: "/catalog/exchange", icon: "swap_horiz", label: "exchange" },
      { route: "/catalog/circle", icon: "diversity_3", label: "circle" },
      { route: "/catalog/challenge", icon: "emoji_events", label: "challenge" },
      { route: "/catalog/stamps", icon: "emoji_emotions", label: "stamps" },
      { route: "/catalog/stickers", icon: "style", label: "stickers" },
      { route: "/catalog/backgrounds", icon: "wallpaper", label: "backgrounds" },
      { route: "/catalog/items", icon: "inventory_2", label: "items" },
      { route: "/catalog/band-items", icon: "piano", label: "bandItems" },
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
    ],
  },
  /**
   * A separate source, not community posts. Playlists come from the game's
   * own master data and the Bestdori pages mirror an external archive; none
   * of them is user-generated, so grouping them under "community" implied a
   * relationship that does not exist.
   */
  {
    id: "mirrors",
    label: "mirrors",
    collapsible: true,
    items: [
      { route: "/community/playlists", icon: "queue_music", label: "communityPage.playlistPage.title" },
      { route: "/community/songs-bestdori", icon: "library_music", label: "communityPage.songsBestDori" },
      /**
       * Every Bestdori story section is listed, exactly as the archive's own
       * story sections are listed above. The page used to carry a pill tab bar
       * for these five, which meant one sidebar entry and a second, different
       * navigation control inside the page for the same axis. Sections are
       * routes; routes belong in the navigation.
       */
      ...BESTDORI_STORY_ROUTES.map((key) => ({
        route: `/community/stories-bestdori/${key}`,
        icon: BESTDORI_STORY_ICONS[key],
        label: `storyNavigation.bestdori${key.charAt(0).toUpperCase()}${key.slice(1)}`,
      })),
    ],
  },
];

// The library list is flat on purpose: collection and game entries are part
// of the same catalogue, not a separate wing with its own headline. The order
// is editorial: the archive's spine first (songs, characters, cards), then
// the dated game systems, then the economies, then collectibles and materials.
export const NAV_SECTIONS = sections;

/** Catalog hub cards: every browsable collection with the catalog resource that counts it. */
export const CATALOG_HUB: Array<NavItem & { resource?: string; countKey?: string }> = [
  { route: "/catalog/songs", icon: "library_music", label: "songs", resource: "songs" },
  { route: "/catalog/characters", icon: "group", label: "characters", resource: "characters" },
  { route: "/catalog/member-cards", icon: "style", label: "memberCards", resource: "cards" },
  { route: "/catalog/support-cards", icon: "collections", label: "supportCards", resource: "support-cards" },
  { route: "/catalog/stories", icon: "auto_stories", label: "stories", resource: "stories", countKey: "episodes" },
  { route: "/catalog/comics", icon: "menu_book", label: "comics", resource: "comics" },
  { route: "/catalog/events", icon: "event", label: "events", resource: "events" },
  { route: "/catalog/real-lives", icon: "festival", label: "realLives", resource: "real-lives" },
  { route: "/catalog/gacha", icon: "redeem", label: "gacha", resource: "gacha" },
  { route: "/catalog/login-campaigns", icon: "event_available", label: "loginCampaigns", resource: "login-campaigns" },
  { route: "/catalog/missions", icon: "fact_check", label: "systemNavMissions", resource: "missions" },
  { route: "/catalog/passes", icon: "workspace_premium", label: "systemNavPasses", resource: "passes" },
  { route: "/catalog/tgw-card", icon: "credit_card", label: "tgwCard", resource: "tgw-card" },
  { route: "/catalog/shop", icon: "storefront", label: "shop", resource: "shop" },
  { route: "/catalog/exchange", icon: "swap_horiz", label: "exchange", resource: "exchange" },
  { route: "/catalog/circle", icon: "diversity_3", label: "circle", resource: "circle" },
  { route: "/catalog/challenge", icon: "emoji_events", label: "challenge", resource: "challenge" },
  { route: "/catalog/stamps", icon: "emoji_emotions", label: "stamps", resource: "stamps" },
  { route: "/catalog/stickers", icon: "style", label: "stickers", resource: "stickers" },
  { route: "/catalog/backgrounds", icon: "wallpaper", label: "backgrounds", resource: "backgrounds" },
  { route: "/catalog/items", icon: "inventory_2", label: "items", resource: "items" },
  { route: "/catalog/band-items", icon: "piano", label: "bandItems", resource: "band-items" },
  { route: "/catalog/live2d", icon: "animation", label: "live2d", resource: "live2d" },
  { route: "/catalog/spine", icon: "accessibility_new", label: "spine", resource: "spine" },
  { route: "/catalog/assets", icon: "folder_open", label: "assets" },
  { route: "/catalog/help", icon: "help", label: "help", resource: "help" },
  { route: "/catalog/anon-tokyo/characters", icon: "storefront", label: "anonTokyo" },
];

export const isRouteActive = (target: string, route: string) =>
  target === "/" ? route === "/" : route === target || route.startsWith(`${target}/`);

export const isDestinationActive = (destination: PrimaryDestination, route: string) =>
  destination.match.some((prefix) => isRouteActive(prefix, route)) &&
  !(destination.exclude ?? []).some((prefix) => isRouteActive(prefix, route));
