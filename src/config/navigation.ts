export interface NavItem {
  route: string;
  icon: string;
  label: string;
  children?: NavItem[];
}
export interface NavGroup {
  id: string;
  icon: string;
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "catalog",
    icon: "category",
    label: "catalog",
    items: [
      { route: "/catalog/songs", icon: "library_music", label: "songs" },
      { route: "/catalog/member-cards", icon: "style", label: "memberCards" },
      { route: "/catalog/support-cards", icon: "collections", label: "supportCards" },
      { route: "/catalog/stamps", icon: "emoji_emotions", label: "stamps" },
      { route: "/catalog/comics", icon: "menu_book", label: "comics" },
      {
        route: "/catalog/stories",
        icon: "auto_stories",
        label: "stories",
        children: [
          { route: "/catalog/stories/band", icon: "groups", label: "storyNavigation.band" },
          { route: "/catalog/stories/link", icon: "diversity_1", label: "storyNavigation.link" },
          { route: "/catalog/stories/home", icon: "home", label: "storyNavigation.home" },
          { route: "/catalog/stories/afterlive", icon: "celebration", label: "storyNavigation.afterlive" },
          { route: "/catalog/stories/tutorial", icon: "school", label: "storyNavigation.tutorial" },
        ],
      },
      {
        route: "/catalog/anon-tokyo/characters",
        icon: "storefront",
        label: "anonTokyo",
        children: [
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
      { route: "/catalog/items", icon: "inventory_2", label: "items" },
      { route: "/catalog/band-items", icon: "piano", label: "bandItems" },
      { route: "/catalog/characters", icon: "group", label: "characters" },
      { route: "/catalog/live2d", icon: "animation", label: "live2d" },
      { route: "/catalog/spine", icon: "accessibility_new", label: "spine" },
      { route: "/catalog/assets", icon: "folder_open", label: "assets" },
      { route: "/catalog/help", icon: "help", label: "help" },
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
    id: "community",
    icon: "forum",
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
