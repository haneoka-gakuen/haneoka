// L3 — GEB
// Input: Shared navigation destinations and collection labels.
// Output: Semantically sized mosaic entries, including related-action blocks.
// Pos: [Map](../L2.md); curation shared by home and destination pages.
// Effects/Dependencies: Pure configuration; navigation owns routes and labels.
import { NAV_SECTIONS, PRIMARY_DESTINATIONS, type NavItem } from "./navigation";

export type HubId = "catalog" | "stories" | "tools" | "games" | "community";
export type HubVisual =
  | "portraits"
  | "landscape"
  | "jackets"
  | "banners"
  | "models"
  | "stamps"
  | "friendship"
  | "team"
  | "chart"
  | "sonolus"
  | "puzzle"
  | "guess"
  | "discussion"
  | "personal"
  | "icon";
export interface HubTile {
  route: string;
  visual: HubVisual;
  columns: 3 | 4 | 6;
  rows: 2 | 3 | 4;
  limit?: number;
  related?: string[];
}
const tile = (
  route: string,
  visual: HubVisual,
  columns: HubTile["columns"],
  rows: HubTile["rows"],
  limit = 3,
): HubTile => ({ route, visual, columns, rows, limit });
export type HubLook = "arc" | "records" | "cookies" | "polaroid" | "panels" | "bleed" | "capsule" | "scatter" | "shelf" | "stage" | "burst" | "scene";
/** Each destination's composition in the collage, showing what it holds. */
const looks: Record<string, HubLook> = {
  "/catalog/member-cards": "arc",
  "/catalog/songs": "records",
  "/catalog/characters": "cookies",
  "/catalog/stamps": "scatter",
  "/catalog/support-cards": "polaroid",
  "/catalog/comics": "panels",
  "/catalog/events": "bleed",
  "/catalog/gacha": "capsule",
  "/catalog/backgrounds": "bleed",
  "/catalog/stickers": "scatter",
  "/catalog/items": "shelf",
  "/catalog/band-items": "shelf",
  "/catalog/real-lives": "bleed",
  "/catalog/stories/band": "capsule",
  "/catalog/stories/event": "bleed",
  "/catalog/stories/link": "scene",
  "/catalog/stories/birthday": "cookies",
  "/catalog/stories/home": "bleed",
  "/catalog/stories/afterlive": "cookies",
  "/catalog/stories/tutorial": "bleed",
  "/team-builder": "scene",
  "/stamp-maker": "scatter",
  "/chart-editor/create": "scene",
  "/catalog/live2d": "stage",
  "/catalog/spine": "stage",
  "/catalog/assets": "polaroid",
  "/catalog/help": "bleed",
  "/sonolus": "scene",
  "/song-puzzle": "scene",
  "/song-guess": "scene",
  "/community/feeds": "scene",
  "/community/playlists": "records",
  "/community/charts": "scene",
  "/community/mine": "scene",
};
export const hubLook = (route: string): HubLook => looks[route] ?? "burst";
const curated: Record<HubId, HubTile[]> = {
  catalog: [
    tile("/catalog/member-cards", "portraits", 6, 3, 5),
    tile("/catalog/songs", "jackets", 3, 3, 6),
    tile("/catalog/characters", "models", 3, 3, 3),
    tile("/catalog/stamps", "stamps", 3, 2, 2),
    tile("/catalog/support-cards", "landscape", 6, 3),
    tile("/catalog/comics", "landscape", 3, 3),
    tile("/catalog/events", "banners", 6, 2),
    tile("/catalog/gacha", "banners", 6, 2),
    tile("/catalog/backgrounds", "landscape", 6, 3),
    tile("/catalog/stickers", "stamps", 6, 2, 3),
    tile("/catalog/items", "stamps", 3, 2, 3),
    tile("/catalog/band-items", "stamps", 3, 2, 3),
    tile("/catalog/real-lives", "landscape", 3, 2),
  ],
  stories: [
    tile("/catalog/stories/band", "banners", 6, 3, 2),
    tile("/catalog/stories/event", "banners", 6, 3, 2),
    tile("/catalog/stories/link", "friendship", 6, 4),
    tile("/catalog/stories/birthday", "banners", 6, 2),
    tile("/catalog/stories/home", "landscape", 6, 2),
    tile("/catalog/stories/afterlive", "stamps", 6, 2),
    tile("/catalog/stories/tutorial", "landscape", 6, 2),
  ],
  tools: [
    tile("/team-builder", "team", 6, 3, 5),
    tile("/stamp-maker", "stamps", 6, 3, 5),
    tile("/chart-editor/create", "chart", 6, 3),
    tile("/catalog/live2d", "models", 3, 3, 3),
    tile("/song-progress", "icon", 3, 2),
    tile("/player-profile", "icon", 3, 2),
    tile("/gacha-history", "icon", 3, 2),
    tile("/catalog/spine", "models", 3, 3, 3),
    tile("/catalog/assets", "landscape", 6, 3, 1),
    tile("/catalog/help", "landscape", 6, 3),
  ],
  games: [tile("/sonolus", "sonolus", 6, 3), tile("/song-puzzle", "puzzle", 3, 3), tile("/song-guess", "guess", 3, 3)],
  community: [
    {
      ...tile("/community/feeds", "discussion", 6, 3),
      related: ["/community/latest", "/community/forums", "/community/tags"],
    },
    tile("/community/playlists", "jackets", 3, 3, 6),
    tile("/community/charts", "chart", 3, 3),
    {
      ...tile("/community/mine", "personal", 6, 3),
      related: ["/community/following", "/community/bookmarks", "/community/notifications", "/community/activity"],
    },
  ],
};
const sectionIds: Record<HubId, string[]> = {
  catalog: ["library"],
  stories: ["stories"],
  tools: ["tools"],
  games: ["games"],
  community: ["community", "mirrors", "sekai"],
};
const entries = NAV_SECTIONS.flatMap((section) => section.items.flatMap((item) => [item, ...(item.children ?? [])]));
const byRoute = new Map(entries.map((item) => [item.route, item]));
const mosaicLabels: Record<string, string> = {
  "/community/feeds": "recommended",
  "/community/latest": "latest",
  "/community/forums": "forums",
  "/community/tags": "tags",
  "/community/mine": "mine",
  "/community/following": "following",
  "/community/bookmarks": "bookmarks",
  "/community/notifications": "notifications",
  "/community/activity": "activity",
};
export function hubEntry(route: string): NavItem {
  const entry = byRoute.get(route);
  if (!entry) throw new Error(`Missing hub navigation entry: ${route}`);
  return mosaicLabels[route] ? { ...entry, label: `navigation.mosaic.${mosaicLabels[route]}` } : entry;
}
export function hubDestination(id: HubId) {
  return PRIMARY_DESTINATIONS.find((destination) => destination.id === id)!;
}
export function hubTiles(id: HubId): HubTile[] {
  const featured = curated[id];
  const used = new Set(featured.flatMap((entry) => [entry.route, ...(entry.related ?? [])]));
  const remaining = NAV_SECTIONS.filter((section) => sectionIds[id].includes(section.id))
    .flatMap((section) => section.items.flatMap((entry) => [entry, ...(entry.children ?? [])]))
    .filter((entry) => !used.has(entry.route));
  return [...featured, ...remaining.map((entry) => tile(entry.route, "icon", 3, 2))];
}
export function homeHubTiles(): HubTile[] {
  const all = (["tools", "catalog", "stories", "games", "community"] as const).flatMap(hubTiles);
  const priorities = [
    "/team-builder",
    "/stamp-maker",
    "/catalog/member-cards",
    "/catalog/songs",
    "/catalog/stories/band",
    "/sonolus",
    "/community/feeds",
  ];
  const ordered = [
    ...priorities.map((route) => all.find((entry) => entry.route === route)!),
    ...all.filter((entry) => !priorities.includes(entry.route)),
  ];
  const used = new Set<string>();
  return ordered.filter((entry) => {
    if (used.has(entry.route)) return false;
    for (const route of [entry.route, ...(entry.related ?? [])]) used.add(route);
    return true;
  });
}
