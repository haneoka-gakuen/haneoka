import { isTemporarilyHiddenRoute } from "../lib/temporary-public-routing";

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
  hideHeading?: boolean;
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

const STORY_ROUTES = ["event", "band", "link", "birthday", "home", "afterlive", "tutorial"] as const;
const STORY_ICONS: Record<(typeof STORY_ROUTES)[number], string> = {
  event: "local_activity",
  band: "groups",
  link: "diversity_1",
  birthday: "cake",
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

/** Project Sekai story sections, in the game's story menu order. */
export const SEKAI_STORY_SECTIONS = ["event", "unit", "character", "card", "area", "special", "mysekai", "live"] as const;
const SEKAI_STORY_ICONS: Record<(typeof SEKAI_STORY_SECTIONS)[number], string> = {
  event: "event",
  unit: "groups",
  character: "person",
  card: "style",
  area: "map",
  special: "auto_awesome",
  mysekai: "chair",
  live: "mic",
};

export const UTILITY_DESTINATIONS = [
  { route: "/account", icon: "account_circle", label: "navigation.account" },
  { route: "/settings", icon: "settings", label: "navigation.settings" },
  { route: "/about", icon: "info", label: "navigation.about" },
] as const;

export const INFORMATION_DESTINATIONS = [
  { route: "/license", label: "legal.license.title" },
  { route: "/terms", label: "legal.terms.title" },
  { route: "/privacy", label: "legal.privacy.title" },
] as const;

export const PRIMARY_DESTINATIONS: PrimaryDestination[] = [
  { id: "home", route: "/", icon: "home", label: "navigation.home", match: ["/", "/announcements", "/calendar", "/join", "/sponsor", "/download"] },
  {
    id: "catalog",
    route: "/catalog",
    icon: "category",
    label: "navigation.catalog",
    match: ["/catalog"],
    exclude: ["/catalog/stories", "/catalog/live2d", "/catalog/spine", "/catalog/assets", "/catalog/help"],
  },
  { id: "stories", route: "/catalog/stories", icon: "auto_stories", label: "navigation.stories", match: ["/catalog/stories"] },
  {
    id: "tools",
    route: "/tools",
    icon: "construction",
    label: "navigation.tools",
    match: [
      "/tools",
      "/team-builder",
      "/song-progress",
      "/gacha-history",
      "/player-profile",
      "/stamp-maker",
      "/chart-editor",
      "/catalog/live2d",
      "/catalog/spine",
      "/catalog/assets",
      "/catalog/help",
    ],
    exclude: ["/tools/song-puzzle"],
  },
  {
    id: "games",
    route: "/games",
    icon: "sports_esports",
    label: "navigation.games",
    match: ["/games", "/sonolus", "/song-puzzle", "/song-guess", "/tools/song-puzzle"],
  },
  { id: "community", route: "/community", icon: "forum", label: "navigation.community", match: ["/community"] },
  { id: "search", route: "/search", icon: "search", label: "common.actions.search", match: ["/search"] },
];

const sections: NavSection[] = [
  {
    id: "home",
    label: "navigation.home",
    items: [
      { route: "/announcements", icon: "newspaper", label: "home.announcements.title" },
      { route: "/calendar", icon: "calendar_month", label: "tools.calendar.title" },
      { route: "/join", icon: "handshake", label: "legal.join.title" },
      { route: "/sponsor", icon: "favorite", label: "legal.sponsor.title" },
      { route: "/download", icon: "download", label: "download.title" },
    ],
  },
  {
    id: "library",
    label: "navigation.library",
    items: [
      { route: "/catalog/songs", icon: "library_music", label: "navigation.songs" },
      { route: "/catalog/song-meta", icon: "monitoring", label: "catalog.songs.fields.songMeta" },
      { route: "/catalog/events", icon: "event", label: "navigation.events" },
      { route: "/catalog/events/tracker", icon: "leaderboard", label: "tools.eventTracker.title" },
      { route: "/catalog/arena", icon: "emoji_events", label: "navigation.arena" },
      { route: "/catalog/characters", icon: "group", label: "navigation.characters" },
      { route: "/catalog/member-cards", icon: "style", label: "navigation.memberCards" },
      { route: "/catalog/support-cards", icon: "collections", label: "navigation.supportCards" },
      { route: "/catalog/skills", icon: "bolt", label: "catalog.cards.fields.skills" },
      { route: "/catalog/comics", icon: "menu_book", label: "navigation.comics" },
      { route: "/catalog/gacha", icon: "redeem", label: "navigation.gacha" },
      { route: "/catalog/login-campaigns", icon: "event_available", label: "navigation.loginCampaigns" },
      { route: "/catalog/missions", icon: "fact_check", label: "navigation.systemNavMissions" },
      { route: "/catalog/passes", icon: "workspace_premium", label: "navigation.systemNavPasses" },
      { route: "/catalog/tgw-card", icon: "credit_card", label: "catalog.tgwCard.card" },
      { route: "/catalog/studio", icon: "piano", label: "catalog.studio.title" },
      { route: "/catalog/player-ranks", icon: "trending_up", label: "catalog.progression.playerRank" },
      { route: "/catalog/friendship-ranks", icon: "diversity_1", label: "catalog.progression.friendshipRank" },
      { route: "/catalog/band-rating", icon: "monitoring", label: "catalog.progression.bandRating" },
      { route: "/catalog/high-score-rating", icon: "leaderboard", label: "catalog.progression.highScoreRating" },
      { route: "/catalog/shop", icon: "storefront", label: "navigation.shop" },
      { route: "/catalog/exchange", icon: "swap_horiz", label: "navigation.exchange" },
      { route: "/catalog/stamps", icon: "emoji_emotions", label: "navigation.stamps" },
      { route: "/catalog/stickers", icon: "style", label: "navigation.stickers" },
      { route: "/catalog/backgrounds", icon: "wallpaper", label: "navigation.backgrounds" },
      { route: "/catalog/chat-customizations", icon: "chat", label: "navigation.chatCustomizations" },
      { route: "/catalog/items", icon: "inventory_2", label: "navigation.items" },
      { route: "/catalog/band-items", icon: "piano", label: "navigation.bandItems" },
      { route: "/catalog/real-lives", icon: "festival", label: "navigation.realLives" },
    ],
  },
  {
    id: "stories",
    label: "navigation.stories",
    items: STORY_ROUTES.map((key) => ({
      route: `/catalog/stories/${key}`,
      icon: STORY_ICONS[key],
      label: key === "birthday" ? "story.labels.birthdayStory" : `story.navigation.${key}`,
    })),
  },
  {
    id: "tools",
    label: "navigation.tools",
    items: [
      { route: "/catalog/live2d", icon: "animation", label: "navigation.live2d" },
      { route: "/catalog/spine", icon: "accessibility_new", label: "navigation.spine" },
      { route: "/catalog/assets", icon: "folder_open", label: "navigation.assets" },
      { route: "/catalog/help", icon: "help", label: "navigation.help" },
      { route: "/player-profile", icon: "person_search", label: "tools.playerProfile.title" },
      { route: "/team-builder", icon: "groups", label: "tools.teamBuilder.title" },
      { route: "/song-progress", icon: "check_circle", label: "catalog.songProgress.title" },
      { route: "/gacha-history", icon: "history", label: "catalog.gachaHistory.title" },
      { route: "/stamp-maker", icon: "image", label: "tools.stampMaker.title" },
      { route: "/chart-editor/create", icon: "edit", label: "navigation.chartEditor" },
    ],
  },
  {
    id: "games",
    label: "navigation.games",
    items: [
      { route: "/sonolus", icon: "sports_esports", label: "catalog.sonolus.title" },
      { route: "/song-puzzle", icon: "extension", label: "tools.songPuzzle.title" },
      { route: "/song-guess", icon: "help", label: "catalog.songGuess.title" },
    ],
  },
  {
    id: "anon-tokyo",
    label: "navigation.anonTokyo",
    collapsible: true,
    items: [
      { route: "/catalog/anon-tokyo/characters", icon: "group", label: "catalog.anonTokyo.characters" },
      { route: "/catalog/anon-tokyo/outfits", icon: "checkroom", label: "catalog.anonTokyo.dressingRoom" },
      { route: "/catalog/anon-tokyo/shop", icon: "storefront", label: "catalog.anonTokyo.shop" },
      { route: "/catalog/anon-tokyo/goods", icon: "sell", label: "catalog.anonTokyo.goodsEconomy" },
      { route: "/catalog/anon-tokyo/decorations", icon: "chair", label: "catalog.anonTokyo.decorations" },
      { route: "/catalog/anon-tokyo/staff", icon: "badge", label: "catalog.anonTokyo.staffSection" },
      { route: "/catalog/anon-tokyo/customers", icon: "group", label: "catalog.anonTokyo.customersPage" },
      { route: "/catalog/anon-tokyo/tasks", icon: "fact_check", label: "catalog.anonTokyo.tasks" },
      { route: "/catalog/anon-tokyo/guide", icon: "menu_book", label: "catalog.anonTokyo.guide" },
      { route: "/catalog/anon-tokyo/fever", icon: "music_note", label: "catalog.anonTokyo.fever" },
    ],
  },
  {
    id: "community",
    label: "navigation.community",
    hideHeading: true,
    items: [
      { route: "/community/feeds", icon: "dynamic_feed", label: "community.page.feedRecommended", children: [
        { route: "/community/latest", icon: "schedule", label: "community.page.feedLatest" },
        { route: "/community/tags", icon: "sell", label: "community.page.tags" },
      ] },
      { route: "/community/mine", icon: "person", label: "community.page.navigation.mine", children: [
        { route: "/community/following", icon: "group", label: "community.page.feedFollowing" },
        { route: "/community/bookmarks", icon: "bookmarks", label: "community.page.bookmarks" },
        { route: "/community/notifications", icon: "notifications", label: "community.page.notifications" },
        { route: "/community/activity", icon: "comment", label: "community.page.activity" },
      ] },
      { route: "/community/playlists", icon: "queue_music", label: "community.page.playlistPage.title" },
      { route: "/community/charts", icon: "music_note", label: "community.charts.title" },
      // Last in the tree: its boards are a live directory that loads after
      // the page, and at the end it can grow without moving any row.
      { route: "/community/forums", icon: "forum", label: "community.page.forums" },
    ],
  },
  /** Pages mirrored from Bestdori's Girls Band Party archive. */
  {
    id: "mirrors",
    label: "navigation.gbpArchive",
    collapsible: true,
    items: [
      { route: "/community/gbp/songs", icon: "library_music", label: "community.page.songsBestDori" },
      /**
       * Every Bestdori story section is listed, exactly as the archive's own
       * story sections are listed above. The page used to carry a pill tab bar
       * for these five, which meant one sidebar entry and a second, different
       * navigation control inside the page for the same axis. Sections are
       * routes; routes belong in the navigation.
       */
      ...BESTDORI_STORY_ROUTES.map((key) => ({
        route: `/community/gbp/stories/${key}`,
        icon: BESTDORI_STORY_ICONS[key],
        label: `story.navigation.bestdori${key.charAt(0).toUpperCase()}${key.slice(1)}`,
      })),
    ],
  },
  /** Project Sekai songs from Sekai Viewer's data, charts shown with Cassiopeia. */
  {
    id: "sekai",
    label: "navigation.projectSekai",
    collapsible: true,
    items: [
      { route: "/community/sekai/songs", icon: "library_music", label: "community.page.sekai.title" },
      ...SEKAI_STORY_SECTIONS.map((key) => ({
        route: `/community/sekai/stories/${key}`,
        icon: SEKAI_STORY_ICONS[key],
        label: `community.page.sekai.stories.${key}`,
      })),
    ],
  },
];

// The library list is flat on purpose: collection and game entries are part
// of the same catalogue, not a separate wing with its own headline. The order
// is editorial: the archive's spine first (songs, characters, cards), then
// the dated game systems, then the economies, then collectibles and materials.
export const NAV_SECTIONS = sections.filter((section) => section.id !== "anon-tokyo");

/** Catalog hub cards: every browsable collection with the catalog resource that counts it. */
const catalogHub: Array<NavItem & { resource?: string; countKey?: string }> = [
  { route: "/catalog/songs", icon: "library_music", label: "navigation.songs", resource: "songs" },
  { route: "/catalog/characters", icon: "group", label: "navigation.characters", resource: "characters" },
  { route: "/catalog/member-cards", icon: "style", label: "navigation.memberCards", resource: "cards" },
  { route: "/catalog/support-cards", icon: "collections", label: "navigation.supportCards", resource: "support-cards" },
  { route: "/catalog/stories", icon: "auto_stories", label: "navigation.stories", resource: "stories", countKey: "episodes" },
  { route: "/catalog/comics", icon: "menu_book", label: "navigation.comics", resource: "comics" },
  { route: "/catalog/events", icon: "event", label: "navigation.events", resource: "events" },
  { route: "/catalog/arena", icon: "emoji_events", label: "navigation.arena", resource: "arena" },
  { route: "/catalog/gacha", icon: "redeem", label: "navigation.gacha", resource: "gacha" },
  { route: "/catalog/login-campaigns", icon: "event_available", label: "navigation.loginCampaigns", resource: "login-campaigns" },
  { route: "/catalog/missions", icon: "fact_check", label: "navigation.systemNavMissions", resource: "missions" },
  { route: "/catalog/passes", icon: "workspace_premium", label: "navigation.systemNavPasses", resource: "passes" },
  { route: "/catalog/tgw-card", icon: "credit_card", label: "catalog.tgwCard.card", resource: "tgw-card" },
  { route: "/catalog/player-ranks", icon: "trending_up", label: "catalog.progression.playerRank" },
  { route: "/catalog/friendship-ranks", icon: "diversity_1", label: "catalog.progression.friendshipRank" },
  { route: "/catalog/band-rating", icon: "monitoring", label: "catalog.progression.bandRating" },
  { route: "/catalog/high-score-rating", icon: "leaderboard", label: "catalog.progression.highScoreRating" },
  { route: "/catalog/shop", icon: "storefront", label: "navigation.shop", resource: "shop" },
  { route: "/catalog/exchange", icon: "swap_horiz", label: "navigation.exchange", resource: "exchange" },
  { route: "/catalog/stamps", icon: "emoji_emotions", label: "navigation.stamps", resource: "stamps" },
  { route: "/catalog/stickers", icon: "style", label: "navigation.stickers", resource: "stickers" },
  { route: "/catalog/backgrounds", icon: "wallpaper", label: "navigation.backgrounds", resource: "backgrounds" },
  { route: "/catalog/chat-customizations", icon: "chat", label: "navigation.chatCustomizations", resource: "chat-customizations" },
  { route: "/catalog/items", icon: "inventory_2", label: "navigation.items", resource: "items" },
  { route: "/catalog/band-items", icon: "piano", label: "navigation.bandItems", resource: "band-items" },
  { route: "/catalog/live2d", icon: "animation", label: "navigation.live2d", resource: "live2d" },
  { route: "/catalog/spine", icon: "accessibility_new", label: "navigation.spine", resource: "spine" },
  { route: "/catalog/assets", icon: "folder_open", label: "navigation.assets" },
  { route: "/catalog/help", icon: "help", label: "navigation.help", resource: "help" },
  { route: "/catalog/anon-tokyo/characters", icon: "storefront", label: "navigation.anonTokyo" },
  { route: "/catalog/real-lives", icon: "festival", label: "navigation.realLives", resource: "real-lives" },
];

export const CATALOG_HUB = catalogHub.filter((item) => !isTemporarilyHiddenRoute(item.route));

export const isRouteActive = (target: string, route: string) =>
  target === "/"
    ? route === "/"
    : (route === target || route.startsWith(`${target}/`)) &&
      !(target === "/catalog/events" && route.startsWith("/catalog/events/tracker"));

export const isDestinationActive = (destination: PrimaryDestination, route: string) =>
  destination.match.some((prefix) => isRouteActive(prefix, route)) &&
  !(destination.exclude ?? []).some((prefix) => isRouteActive(prefix, route));
