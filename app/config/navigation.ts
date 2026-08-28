import type { ArchiveMessageKey } from "~/i18n/messages";

export interface NavigationLeafDefinition {
  id: string;
  icon: string;
  messageKey: ArchiveMessageKey;
  route: string;
}

export type ShellNavigationDestinationId =
  "about" | "account" | "catalog" | "community" | "home" | "settings" | "tools";

export const shellNavigationIcons = {
  about: "info",
  account: "account_circle",
  catalog: "category",
  community: "forum",
  home: "home",
  settings: "settings",
  tools: "construction",
} as const satisfies Readonly<Record<ShellNavigationDestinationId, string>>;

type DrawerCapabilityId =
  | "anon-tokyo"
  | "asset-explorer"
  | "band-items"
  | "challenge"
  | "characters"
  | "chart-editor"
  | "circle"
  | "comics"
  | "community-activity"
  | "community-bookmarks"
  | "community-mine"
  | "community-notifications"
  | "community-playlists"
  | "community-posts"
  | "community-songs"
  | "community-stories"
  | "community-tags"
  | "events"
  | "exchange"
  | "gacha"
  | "help"
  | "items"
  | "live2d"
  | "login-campaigns"
  | "member-cards"
  | "shop"
  | "spine"
  | "songs"
  | "stamps"
  | "stories"
  | "story-editor"
  | "support-cards";

export const capabilityNavigationIcons = {
  songs: "library_music",
  "member-cards": "style",
  "support-cards": "collections",
  characters: "group",
  stories: "auto_stories",
  "anon-tokyo": "storefront",
  comics: "menu_book",
  stamps: "emoji_emotions",
  live2d: "animation",
  spine: "accessibility_new",
  "asset-explorer": "folder_open",
  items: "inventory_2",
  "band-items": "piano",
  help: "help",
  events: "event",
  gacha: "redeem",
  "login-campaigns": "event_available",
  shop: "storefront",
  exchange: "swap_horiz",
  circle: "diversity_3",
  challenge: "emoji_events",
  "chart-editor": "edit_note",
  "story-editor": "edit_document",
  "community-posts": "dynamic_feed",
  "community-mine": "person",
  "community-bookmarks": "bookmarks",
  "community-notifications": "notifications",
  "community-playlists": "queue_music",
  "community-activity": "comment",
  "community-tags": "sell",
  "community-songs": "library_music",
  "community-stories": "auto_stories",
} as const satisfies Readonly<Record<DrawerCapabilityId, string>>;

export const capabilityNavigationIcon = (id: string): string => {
  if (!(id in capabilityNavigationIcons)) throw new Error(`Missing Material navigation icon for capability: ${id}`);
  return capabilityNavigationIcons[id as DrawerCapabilityId];
};

export const nestedNavigationLeaves: Readonly<Record<string, readonly NavigationLeafDefinition[]>> = {
  stories: [
    {
      id: "stories-band",
      icon: "groups",
      messageKey: "storyNavigation.band",
      route: "/catalog/stories/band",
    },
    {
      id: "stories-link",
      icon: "diversity_1",
      messageKey: "storyNavigation.link",
      route: "/catalog/stories/link",
    },
    {
      id: "stories-home",
      icon: "home",
      messageKey: "storyNavigation.home",
      route: "/catalog/stories/home",
    },
    {
      id: "stories-afterlive",
      icon: "celebration",
      messageKey: "storyNavigation.afterlive",
      route: "/catalog/stories/afterlive",
    },
    {
      id: "stories-tutorial",
      icon: "school",
      messageKey: "storyNavigation.tutorial",
      route: "/catalog/stories/tutorial",
    },
  ],
  "anon-tokyo": [
    {
      id: "anon-tokyo-characters",
      icon: "group",
      messageKey: "anonTokyoPage.characters",
      route: "/catalog/anon-tokyo/characters",
    },
    {
      id: "anon-tokyo-fashion",
      icon: "checkroom",
      messageKey: "anonTokyoPage.dressingRoom",
      route: "/catalog/anon-tokyo/outfits",
    },
    {
      id: "anon-tokyo-shop",
      icon: "chair",
      messageKey: "anonTokyoPage.shop",
      route: "/catalog/anon-tokyo/shop",
    },
    {
      id: "anon-tokyo-staff",
      icon: "badge",
      messageKey: "anonTokyoPage.staffSection",
      route: "/catalog/anon-tokyo/staff",
    },
    {
      id: "anon-tokyo-customers",
      icon: "group",
      messageKey: "anonTokyoPage.customersPage",
      route: "/catalog/anon-tokyo/customers",
    },
    {
      id: "anon-tokyo-goods",
      icon: "sell",
      messageKey: "anonTokyoPage.goodsEconomy",
      route: "/catalog/anon-tokyo/goods",
    },
    {
      id: "anon-tokyo-decorations",
      icon: "chair",
      messageKey: "anonTokyoPage.decorations",
      route: "/catalog/anon-tokyo/decorations",
    },
    {
      id: "anon-tokyo-tasks",
      icon: "fact_check",
      messageKey: "anonTokyoPage.tasks",
      route: "/catalog/anon-tokyo/tasks",
    },
    {
      id: "anon-tokyo-guide",
      icon: "menu_book",
      messageKey: "anonTokyoPage.guide",
      route: "/catalog/anon-tokyo/guide",
    },
    {
      id: "anon-tokyo-fever",
      icon: "music_note",
      messageKey: "anonTokyoPage.fever",
      route: "/catalog/anon-tokyo/fever",
    },
  ],
  "community-stories": [
    {
      id: "community-stories-event",
      icon: "event",
      messageKey: "storyNavigation.bestdoriEvent",
      route: "/community/stories-bestdori/event",
    },
    {
      id: "community-stories-band",
      icon: "groups",
      messageKey: "storyNavigation.bestdoriBand",
      route: "/community/stories-bestdori/band",
    },
    {
      id: "community-stories-main",
      icon: "home",
      messageKey: "storyNavigation.bestdoriMain",
      route: "/community/stories-bestdori/main",
    },
    {
      id: "community-stories-afterlive",
      icon: "celebration",
      messageKey: "storyNavigation.bestdoriAfterlive",
      route: "/community/stories-bestdori/afterlive",
    },
    {
      id: "community-stories-card",
      icon: "style",
      messageKey: "storyNavigation.bestdoriCard",
      route: "/community/stories-bestdori/card",
    },
  ],
};
