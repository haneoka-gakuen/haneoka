export const VISIBILITY_TYPES = [
  "cards",
  "support-cards",
  "songs",
  "characters",
  "bands",
  "stories",
  "events",
  "arena",
  "gacha",
  "comics",
  "stamps",
  "stickers",
  "backgrounds",
  "chat-customizations",
  "band-items",
  "items",
  "missions",
  "shop",
  "exchange",
  "login-campaigns",
  "passes",
  "challenge",
  "circle",
  "real-lives",
  "live2d",
  "spine",
  "help",
  "help-tips",
  "tgw-card",
  "skills",
  "anon-tokyo",
] as const;
export type VisibilityType = (typeof VISIBILITY_TYPES)[number];
export const VISIBILITY_MODES = ["spoiler", "released", "visible", "hidden"] as const;
export type VisibilityMode = (typeof VISIBILITY_MODES)[number];
export type VisibilityRule = {
  mode: VisibilityMode;
  show: string[];
  hide: string[];
};
export type ContentVisibilityPolicy = {
  eventChallengeSongs: boolean;
  types: Partial<Record<VisibilityType, VisibilityRule>>;
};
export type ContentVisibilitySettings = {
  policy: ContentVisibilityPolicy;
  version: number;
  updatedAt: number;
};
export const DEFAULT_VISIBILITY_RULE: VisibilityRule = { mode: "spoiler", show: [], hide: [] };
export const DEFAULT_VISIBILITY_POLICY: ContentVisibilityPolicy = { eventChallengeSongs: true, types: {} };
export const VISIBILITY_WORKSPACES = [
  "catalog-screen",
  "story-workspace",
  "team-builder",
  "live2d-workspace",
  "spine-workspace",
  "mission-workspace",
  "calendar-page",
  "stamp-maker",
  "song-slide-puzzle",
  "skills-workspace",
  "tgw-card-workspace",
  "anon-tokyo-workspace",
  "help-workspace",
] as const;

export function visibilityType(value: string): VisibilityType | undefined {
  const kind =
    value === "member-cards"
      ? "cards"
      : value === "song-meta"
        ? "songs"
        : value.startsWith("anon-tokyo/")
          ? "anon-tokyo"
          : value;
  return (VISIBILITY_TYPES as readonly string[]).includes(kind) ? (kind as VisibilityType) : undefined;
}

export function parseVisibilityPolicy(value: unknown): ContentVisibilityPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const policy = value as Record<string, unknown>;
  if (
    typeof policy.eventChallengeSongs !== "boolean" ||
    !policy.types ||
    typeof policy.types !== "object" ||
    Array.isArray(policy.types)
  )
    return null;
  const types: ContentVisibilityPolicy["types"] = {};
  for (const [kind, value] of Object.entries(policy.types)) {
    if (visibilityType(kind) !== kind || !value || typeof value !== "object" || Array.isArray(value)) return null;
    const rule = value as Record<string, unknown>;
    if (!(VISIBILITY_MODES as readonly unknown[]).includes(rule.mode)) return null;
    const validIds = (ids: unknown): ids is string[] =>
      Array.isArray(ids) &&
      ids.length <= 100 &&
      ids.every((id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)) &&
      new Set(ids).size === ids.length;
    if (!validIds(rule.show) || !validIds(rule.hide)) return null;
    if (rule.mode !== "spoiler" || rule.show.length || rule.hide.length)
      types[kind as VisibilityType] = { mode: rule.mode as VisibilityMode, show: [...rule.show], hide: [...rule.hide] };
  }
  return { eventChallengeSongs: policy.eventChallengeSongs, types };
}

const ID_FIELDS: Partial<Record<VisibilityType, readonly string[]>> = {
  cards: ["cardId"],
  "support-cards": ["supportCardId"],
  songs: ["musicId", "songId"],
  characters: ["characterId"],
  bands: ["bandId"],
  stories: ["storyId", "storyKey"],
  comics: ["comicId"],
  stamps: ["stampId"],
  stickers: ["stickerId"],
  backgrounds: ["backgroundId"],
  "band-items": ["bandItemId", "itemId"],
  items: ["itemId"],
  live2d: ["live2dKey", "key"],
  help: ["helpSubcategoryId"],
  "help-tips": ["tipId"],
};
export function visibilityId(kind: VisibilityType, row: Record<string, unknown>): string {
  return String([...(ID_FIELDS[kind] || []), "id", "_key"].map((key) => row[key]).find((id) => id !== undefined) ?? "");
}
export function inferredVisibilityType(row: Record<string, unknown>): VisibilityType | undefined {
  for (const kind of [
    "cards",
    "support-cards",
    "songs",
    "stories",
    "comics",
    "stamps",
    "stickers",
    "backgrounds",
    "band-items",
    "items",
    "live2d",
    "help",
    "help-tips",
  ] as const)
    if (ID_FIELDS[kind]?.some((field) => row[field] !== undefined)) return kind;
  if (row.kind === "game-event") return "events";
  if (row.kind === "arena-season") return "arena";
  return typeof row.kind === "string"
    ? visibilityType(row.kind)
    : row.characterId !== undefined
      ? "characters"
      : row.bandId !== undefined
        ? "bands"
        : undefined;
}
