import type { ArchiveMessageKey } from "./messages";

type Translate = (key: ArchiveMessageKey) => string;

/**
 * One translation contract for capability IDs. Capabilities retain a plain
 * English fallback for non-UI consumers, while every rendered navigation
 * surface resolves through this map.
 */
const capabilityMessageKeys = {
  home: "home",
  "home-overview": "homePage.overview",
  "home-schedule": "homePage.scheduleTitle",
  "home-birthdays": "homePage.birthdaysTitle",
  "home-community": "homePage.communityTitle",
  "home-updates": "homePage.updatesTitle",
  catalog: "catalog",
  songs: "songs",
  "member-cards": "memberCards",
  "support-cards": "supportCards",
  characters: "characters",
  stories: "stories",
  comics: "comics",
  stamps: "stamps",
  live2d: "live2d",
  "asset-explorer": "assets",
  items: "items",
  "band-items": "bandItems",
  help: "help",
  events: "events",
  gacha: "gacha",
  "login-campaigns": "loginCampaigns",
  shop: "shop",
  exchange: "exchange",
  circle: "circle",
  challenge: "challenge",
  tools: "tools",
  "chart-editor": "chartEditor",
  "story-editor": "storyEditor",
  community: "community",
  "community-posts": "communityPage.feed",
  "community-mine": "communityPage.mine",
  "community-bookmarks": "communityPage.bookmarks",
  "community-notifications": "communityPage.notifications",
  "community-activity": "communityPage.activity",
  "community-tags": "communityPage.tags",
  "community-playlists": "communityPage.playlistPage.title",
  "community-songs": "communityPage.songsBestDori",
  "community-stories": "communityPage.storiesBestDori",
  "community-charts": "communityPage.customCharts",
  "community-users": "adminPage.sections.users",
  admin: "adminPage.title",
  "admin-overview": "adminPage.sections.overview",
  "admin-users": "adminPage.sections.users",
  "admin-posts": "adminPage.sections.posts",
  "admin-reports": "adminPage.sections.reports",
  "admin-appeals": "adminPage.sections.appeals",
  "admin-operations": "adminPage.sections.operations",
  chart: "chart",
} as const satisfies Record<string, ArchiveMessageKey>;

const isCapabilityMessageId = (id: string): id is keyof typeof capabilityMessageKeys =>
  Object.hasOwn(capabilityMessageKeys, id);

export const capabilityLabel = (id: string, t: Translate, fallback: string): string => {
  const key = isCapabilityMessageId(id) ? capabilityMessageKeys[id] : undefined;
  return key ? t(key) : fallback;
};
