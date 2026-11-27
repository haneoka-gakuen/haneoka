import { cardRarityName } from "./card-rarity.ts";
import { USER_GROUPS, isUserGroup, type UserGroup } from "./user-roles.ts";

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
export type VisibilitySettingType = Exclude<VisibilityType, "support-cards" | "real-lives"> | "special-cards";
export const VISIBILITY_SETTING_TYPES: readonly VisibilitySettingType[] = [
  "cards",
  "special-cards",
  ...VISIBILITY_TYPES.filter((kind) => kind !== "cards" && kind !== "support-cards" && kind !== "real-lives"),
];
export function isModelVisibilityType(kind: VisibilityType | undefined): boolean {
  return kind === "live2d" || kind === "spine";
}
export const VISIBILITY_MODES = ["spoiler", "visible"] as const;
export type VisibilityMode = (typeof VISIBILITY_MODES)[number];
export const RESTRICTED_CONTENT_DISPLAYS = ["hidden", "unpublished"] as const;
export type VisibilityRule = {
  mode: VisibilityMode;
  show: string[];
  hide: string[];
  groups: UserGroup[];
  restrictedDisplay: (typeof RESTRICTED_CONTENT_DISPLAYS)[number];
  allowOverride: boolean;
};
export function isCardVisibilityType(kind: VisibilityType | undefined): boolean {
  return kind === "cards" || kind === "support-cards";
}
export function isSpecialCard(kind: VisibilityType | undefined, row: unknown): boolean {
  if (!isCardVisibilityType(kind) || !row || typeof row !== "object" || !("rarity" in row)) return false;
  const rarity = cardRarityName(row.rarity);
  return rarity === "BD" || rarity === "EX";
}

export type ContentVisibilityPolicy = {
  eventChallengeSongs: boolean;
  types: Partial<Record<VisibilitySettingType, VisibilityRule>>;
  cardRulesVersion?: 2;
};
export type ContentVisibilitySettings = {
  policy: ContentVisibilityPolicy;
  version: number;
  updatedAt: number;
};
export const DEFAULT_VISIBILITY_RULE: VisibilityRule = {
  mode: "spoiler",
  show: [],
  hide: [],
  groups: [...USER_GROUPS],
  restrictedDisplay: "hidden",
  allowOverride: true,
};
export const DEFAULT_VISIBILITY_POLICY: ContentVisibilityPolicy = { eventChallengeSongs: true, types: {} };

export function visibilityRuleFor(
  policy: ContentVisibilityPolicy,
  kind: VisibilityType | VisibilitySettingType | undefined,
): VisibilityRule {
  if (!kind || kind === "real-lives") return DEFAULT_VISIBILITY_RULE;
  return policy.types[kind === "support-cards" ? "cards" : kind] ?? DEFAULT_VISIBILITY_RULE;
}

export function visibilityType(value: string): VisibilityType | undefined {
  const kind =
    value === "voices"
      ? "characters"
      : value === "member-cards"
      ? "cards"
      : value === "song-meta"
        ? "songs"
        : value.startsWith("anon-tokyo/")
          ? "anon-tokyo"
          : value;
  return (VISIBILITY_TYPES as readonly string[]).includes(kind) ? (kind as VisibilityType) : undefined;
}

function parseVisibilityRule(value: unknown, cardIds: boolean): VisibilityRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rule = value as Record<string, unknown>;
  const mode = rule.mode === "released" || rule.mode === "hidden" ? "spoiler" : rule.mode;
  if (mode !== "spoiler" && mode !== "visible") return null;
  const validId = cardIds ? /^(?:(?:cards|support-cards):)?[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u : /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
  const validIds = (ids: unknown): ids is string[] =>
    Array.isArray(ids) &&
    ids.length <= (cardIds ? 200 : 100) &&
    ids.every((id) => typeof id === "string" && validId.test(id)) &&
    new Set(ids).size === ids.length;
  if (!validIds(rule.show) || !validIds(rule.hide)) return null;
  const groups = rule.groups === undefined ? USER_GROUPS : rule.groups;
  if (!Array.isArray(groups) || !groups.every(isUserGroup) || new Set(groups).size !== groups.length) return null;
  const restrictedDisplay = rule.restrictedDisplay === undefined ? "hidden" : rule.restrictedDisplay;
  if (restrictedDisplay !== "hidden" && restrictedDisplay !== "unpublished") return null;
  const allowOverride = rule.allowOverride === undefined ? true : rule.allowOverride;
  if (typeof allowOverride !== "boolean") return null;
  return {
    mode,
    show: [...rule.show],
    hide: [...rule.hide],
    groups: USER_GROUPS.filter((group) => groups.includes(group)),
    restrictedDisplay,
    allowOverride,
  };
}

function isDefaultRule(rule: VisibilityRule): boolean {
  return rule.mode === "spoiler" && !rule.show.length && !rule.hide.length &&
    rule.groups.length === USER_GROUPS.length && rule.restrictedDisplay === "hidden" && rule.allowOverride;
}

function mergeLegacyCardRules(member: VisibilityRule, snapshot: VisibilityRule): VisibilityRule {
  const scopedIds = (field: "show" | "hide") => [
    ...member[field].map((id) => `cards:${id}`),
    ...snapshot[field].map((id) => `support-cards:${id}`),
  ];
  return {
    mode: member.mode === "visible" && snapshot.mode === "visible" ? "visible" : "spoiler",
    groups: member.groups.filter((group) => snapshot.groups.includes(group)),
    show: scopedIds("show"),
    hide: scopedIds("hide"),
    restrictedDisplay: member.restrictedDisplay === "unpublished" && snapshot.restrictedDisplay === "unpublished"
      ? "unpublished"
      : "hidden",
    allowOverride: member.allowOverride && snapshot.allowOverride,
  };
}

export function parseVisibilityPolicy(value: unknown): ContentVisibilityPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const policy = value as Record<string, unknown>;
  if (
    typeof policy.eventChallengeSongs !== "boolean" ||
    !policy.types ||
    typeof policy.types !== "object" ||
    Array.isArray(policy.types) ||
    (policy.cardRulesVersion !== undefined && policy.cardRulesVersion !== 2)
  )
    return null;
  const types: ContentVisibilityPolicy["types"] = {};
  let snapshotRule: VisibilityRule | undefined;
  for (const [kind, value] of Object.entries(policy.types)) {
    if (kind !== "special-cards" && visibilityType(kind) !== kind) return null;
    if (kind === "real-lives") continue;
    const canonicalCardIds = kind === "special-cards" || (kind === "cards" && policy.cardRulesVersion === 2);
    const rule = parseVisibilityRule(value, canonicalCardIds);
    if (!rule) return null;
    if (kind === "support-cards") {
      if (policy.cardRulesVersion === 2) return null;
      snapshotRule = rule;
    } else if (kind === "special-cards" || !isDefaultRule(rule)) {
      types[kind as VisibilitySettingType] = rule;
    }
  }
  if (policy.cardRulesVersion === undefined && (types.cards || snapshotRule)) {
    const shared = mergeLegacyCardRules(types.cards ?? DEFAULT_VISIBILITY_RULE, snapshotRule ?? DEFAULT_VISIBILITY_RULE);
    if (isDefaultRule(shared)) delete types.cards;
    else {
      types.cards = shared;
      types["special-cards"] ??= shared;
    }
  }
  return {
    eventChallengeSongs: true,
    types,
    ...(types.cards || types["special-cards"] ? { cardRulesVersion: 2 as const } : {}),
  };
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
  if (typeof row.voiceKey === "string" && Array.isArray(row.characterIds)) return "characters";
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
