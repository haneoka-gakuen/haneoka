export const SEARCH_SCOPES = ["all", "catalog", "stories", "help", "community"] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];
export const isSearchScope = (value: unknown): value is SearchScope =>
  typeof value === "string" && SEARCH_SCOPES.some((scope) => scope === value);

export interface SearchCategory {
  section: Exclude<SearchScope, "all" | "community">;
  kind: string;
  labelKey: string;
}

const categories: Record<string, string> = {
  songs: "songs", characters: "characters", "member-cards": "cards", "support-cards": "cards",
  cards: "cards", events: "events", gacha: "gacha", stamps: "stamps", stickers: "stamps",
  comics: "comics", items: "items", "band-items": "bandItems",
};

/** Shared by the index builder and the result UI, including legacy catalogue routes. */
export function searchCategory(path: string): SearchCategory {
  if (/^https?:\/\//u.test(path)) {
    try { path = new URL(path).pathname; } catch { /* Treat invalid input as an unclassified path. */ }
  }
  const segments = path.split(/[?#]/u, 1)[0]!.split(/[\\/]/u).filter(Boolean);
  if (["jp", "intl", "intl-test", "jp-cbt", "intl-cbt"].includes(segments[0] || "")) segments.shift();
  if (["ja", "en", "zh-CN", "zh-TW", "ko"].includes(segments[0] || "")) segments.shift();
  if (segments[0] === "catalog") segments.shift();
  const resource = segments[0] || "";
  if (resource === "stories") return { section: "stories", kind: "stories", labelKey: "stories" };
  if (["help", "docs", "about", "guide", "guides"].includes(resource))
    return { section: "help", kind: "help", labelKey: "help" };
  const labelKey = categories[resource] || "catalog";
  return { section: "catalog", kind: labelKey, labelKey };
}
