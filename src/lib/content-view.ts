// L3 — GEB
// Input: Resource data and the current rendering context.
// Output: Visibility decisions and compatible document data.
// Pos: [Map](L2-2.md); shared content presentation boundary.
// Effects/Dependencies: Projects catalogue metadata for preview rows and checks detail access separately.
import { withEventSongRelease } from "./event-song-release";
import { contentPublished, publicationFields } from "./content-publication";
import { homeEventBonuses } from "./home-event-display";
import {
  inferredVisibilityType,
  isCardVisibilityType,
  isSpecialCard,
  isModelVisibilityType,
  visibilityId,
  visibilityRuleFor,
  visibilityType,
  type ContentVisibilityPolicy,
  type VisibilityRule,
  type VisibilityType,
} from "./content-visibility-policy";
import { isPublicReleaseServer } from "./temporary-public-routing";
import type { UserGroup } from "./user-roles";

export interface ContentView {
  policy: ContentVisibilityPolicy;
  group: UserGroup;
  spoilers: boolean;
  override: boolean;
  now: number;
  previewOnly?: boolean;
}
export type ContentReference = { kind: VisibilityType; id: string; publication: Record<string, unknown> };
export { spoilerOverrideEnabled as explicitContentOverride } from "./spoiler-cookie";
function unpublishedVisible(
  view: ContentView, rule: VisibilityRule, kind: VisibilityType | undefined, id: string,
): boolean {
  const matches = (ids: readonly string[]) => ids.includes(id) ||
    (isCardVisibilityType(kind) && ids.includes(`${kind}:${id}`));
  if (view.override && rule.allowOverride) return true;
  if (!rule.groups.includes(view.group) || matches(rule.hide)) return false;
  if (matches(rule.show) || rule.mode === "visible") return true;
  return view.spoilers;
}

/** Reject an upgrade only when no unpublished entry could be visible. */
export function maySeeUnpublishedType(view: Pick<ContentView, "policy" | "group" | "spoilers" | "override">, kind: VisibilityType): boolean {
  const permits = (rule: VisibilityRule) =>
    (view.override && rule.allowOverride) ||
    (view.spoilers && rule.restrictedDisplay === "unpublished") ||
    (rule.groups.includes(view.group) && (rule.mode === "visible" || rule.show.length > 0 || view.spoilers));
  return permits(visibilityRuleFor(view.policy, kind)) ||
    (isCardVisibilityType(kind) && permits(visibilityRuleFor(view.policy, "special-cards")));
}

export function contentVisible(view: ContentView, kind: VisibilityType | undefined, value: unknown, id = ""): boolean {
  if (isModelVisibilityType(kind) || contentPublished(value, view.now)) return true;
  if (view.previewOnly) return false;
  const rule = visibilityRuleFor(view.policy, isSpecialCard(kind, value) ? "special-cards" : kind);
  return unpublishedVisible(view, rule, kind, id);
}

function listedChallengeEvents(view: ContentView, events: unknown): Record<string, unknown>[] {
  if (!Array.isArray(events)) return [];
  return events.filter((event) => object(event) && typeof event.id === "string" &&
    typeof event.startAt === "number" && event.startAt > 0 && contentListing(view, "events", event, event.id) !== "hidden");
}

export function contentListing(view: ContentView, kind: VisibilityType, value: unknown, id = ""): "full" | "preview" | "hidden" {
  if (contentVisible(view, kind, value, id)) return "full";
  const rule = visibilityRuleFor(view.policy, isSpecialCard(kind, value) ? "special-cards" : kind);
  if (!view.spoilers) return "hidden";
  if (rule.restrictedDisplay === "unpublished") return "preview";
  if (kind === "songs" && !rule.hide.includes(id) && object(value) && listedChallengeEvents(view, value.challengeEvents).length)
    return "preview";
  return "hidden";
}

export function contentReference(kind: VisibilityType, value: Record<string, unknown>, id?: string): ContentReference {
  const publication = publicationFields(value);
  if (isCardVisibilityType(kind) && value.rarity !== undefined) publication.rarity = value.rarity;
  return { kind, id: id ?? visibilityId(kind, value), publication };
}

const aliases: Record<string, string> = {
  episodes: "stories",
  chapters: "stories",
  storyEvents: "stories",
  homeSpots: "stories",
  supportCards: "support-cards",
  memberCards: "cards",
  members: "cards",
  snapshots: "support-cards",
  gameItems: "items",
  live2dModels: "live2d",
};
export function contentFieldType(field: string): VisibilityType | undefined {
  return visibilityType(aliases[field] ?? field);
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const hasPublication = (value: Record<string, unknown>): boolean => Object.keys(publicationFields(value)).length > 0;
const dependencyFields = new Set([
  "assets", "runtime", "commands", "resolvedSkills", "progression", "growth",
  "master", "masterData", "tables", "rules",
]);
const previewFields = [
  "id", "_key", "key", "kind", "cardId", "supportCardId", "musicId", "songId", "storyId", "storyKey",
  "chapterId", "comicId", "stampId", "stickerId", "backgroundId", "bandItemId", "itemId", "characterId",
  "bandId", "live2dKey", "helpSubcategoryId", "tipId", "name", "title", "cardName", "prefix",
  "musicTitle", "characterName", "bandName", "image", "thumbnail", "thumbnailImage", "faceImage",
  "jacketUrl", "jacketThumbUrl", "rarity", "attribute", "type", "mode", "category", "endAt", "displayOrder",
  "characterIds", "bandIds",
] as const;
const cardPreviewFields = ["cardType", "performance", "technique", "visual"];
const songPreviewFields = [
  "musicType", "musicCategories", "artistName", "vocalCharacterIds", "composer", "lyricist", "arranger",
  "ruby", "phonetic", "sortOrder",
];
const chartPreviewFields = ["firstBpm", "minBpm", "maxBpm", "time", "n", "noteCount", "canonicalNoteCount", "nps", "score", "eff", "sr"];
const resourcePreviewFields: Partial<Record<VisibilityType, readonly string[]>> = {
  "anon-tokyo": [
    "rawId", "displayName", "text", "nameKey", "categoryId", "subType", "customerKind", "taskTabId",
    "taskTypeId", "levelLimit", "level", "isShow", "pageIndex", "cueName", "durationSeconds", "description",
    "size", "customerCount", "exp", "point",
  ],
  arena: ["seasonId", "rankingEndAt", "timeZone"],
  bands: ["englishName", "shortName", "description", "official", "memberCharacterIds", "memberBandIds", "memberNames", "color"],
  backgrounds: ["description"],
  challenge: ["band"],
  "chat-customizations": ["initialOwnership"],
  characters: ["school", "bandPart", "birthday", "colorCode", "firstName", "nickname"],
  comics: ["subTitle", "characters"],
  events: ["backgroundImage", "logo", "eventType"],
  items: ["description", "itemTypeName", "max", "value"],
  missions: ["group", "groupId", "groupCategory", "releaseDay", "priority", "goal", "missionType"],
  skills: ["family", "skillName", "icon"],
  stickers: ["description", "closedAt"],
  "tgw-card": ["rank", "pointsRequired"],
  stories: [
    "chapterName", "episodeNumber", "storyCategory", "description", "caption", "duration", "storySort",
    "unlockCharacterFriendshipLevel", "isAnotherEpisode", "isExtraEpisode", "perspectiveCharacterId", "banner", "episodeImage",
  ],
};

const pickPreviewFields = (value: unknown, fields: readonly string[]): Record<string, unknown> =>
  object(value) ? Object.fromEntries(fields.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]])) : {};

/** Listing metadata only. Related records and playable assets have their own access checks. */
export function contentPreview(value: Record<string, unknown>, kind: VisibilityType): Record<string, unknown> {
  const preview: Record<string, unknown> = {
    ...pickPreviewFields(value, previewFields),
    ...pickPreviewFields(value, resourcePreviewFields[kind] ?? []),
    ...publicationFields(value),
    __contentPreview: true,
  };
  if (object(value.images) && value.images.thumbnail) preview.images = { thumbnail: value.images.thumbnail };
  if (isCardVisibilityType(kind)) {
    Object.assign(preview, pickPreviewFields(value, cardPreviewFields));
    if (object(value.stat)) preview.stat = pickPreviewFields(value.stat, ["performance", "technique", "visual"]);
    if (object(value.resolvedSkills)) {
      const summary = (skill: unknown) => pickPreviewFields(skill, ["id", "skillName", "icon"]);
      preview.resolvedSkills = Object.fromEntries(
        Object.entries(value.resolvedSkills).map(([role, skill]) => [role, Array.isArray(skill) ? skill.map(summary) : summary(skill)]),
      );
    }
  }
  if (kind === "songs") {
    Object.assign(preview, pickPreviewFields(value, songPreviewFields));
    if (Array.isArray(value.difficulty))
      preview.difficulty = value.difficulty.map((row) => pickPreviewFields(row, ["difficulty", "difficultyName", "playLevel", "displayLevel", "sortLevel"]));
    if (object(value.gekisou)) preview.gekisou = pickPreviewFields(value.gekisou, ["missionTypes", "missionPattern"]);
    for (const [difficulty, metrics] of Object.entries(value)) {
      if (!/^\d+$/u.test(difficulty) || !object(metrics) || !object(metrics.chart)) continue;
      const chart = pickPreviewFields(metrics.chart, chartPreviewFields);
      if (object(metrics.chart.profiles))
        chart.profiles = Object.fromEntries(
          Object.entries(metrics.chart.profiles).map(([key, profile]) => [key, pickPreviewFields(profile, ["score", "eff", "sr"])]),
        );
      preview[difficulty] = {
        chart,
        ...(object(metrics.gekisou) ? {
          gekisou: {
            ...pickPreviewFields(metrics.gekisou, ["score", "eff", "justableTotal", "justableRate"]),
            ...(Array.isArray(metrics.gekisou.segments) ? {
              segments: metrics.gekisou.segments.map((segment) => pickPreviewFields(segment, ["luckExpected", "timing"])),
            } : {}),
          },
        } : {}),
      };
    }
  }
  if (kind === "anon-tokyo") {
    Object.assign(preview, pickPreviewFields(value, ["icon", "avatar", "preview"]));
    if (object(value.popularity)) preview.popularity = pickPreviewFields(value.popularity, ["count"]);
    if (object(value.values)) preview.values = pickPreviewFields(value.values, ["customerLv"]);
    if (object(value.reward)) preview.reward = pickPreviewFields(value.reward, ["raw"]);
    else if (typeof value.reward === "string") preview.reward = value.reward;
  }
  if (kind === "arena" && Array.isArray(value.leagues))
    preview.leagues = value.leagues.filter(object).map((league) => ({
      ...pickPreviewFields(league, ["id", "bandId", "name", "image"]),
      rules: Array.isArray(league.rules)
        ? league.rules.map((rule) => pickPreviewFields(rule, ["id", "leagueId", "startAt", "endAt", "musicType", "missions"]))
        : [],
      songs: [],
    }));
  if (kind === "events") Object.assign(preview, homeEventBonuses(value));
  if (kind === "skills") {
    if (Array.isArray(value.effects)) preview.effects = value.effects.map((effect) => pickPreviewFields(effect, ["id", "name"]));
    if (Array.isArray(value.levels)) preview.levels = value.levels.map((level) => pickPreviewFields(level, ["level"]));
    if (Array.isArray(value.cards)) preview.cardCount = value.cards.length;
    else if (typeof value.cardCount === "number") preview.cardCount = value.cardCount;
  }
  if (kind === "missions" && Array.isArray(value.rewards))
    preview.rewards = value.rewards.map((reward) => pickPreviewFields(reward, ["kind", "resourceType", "resourceId", "name", "image", "count"]));
  if (kind === "tgw-card" && object(value.artwork))
    preview.artwork = pickPreviewFields(value.artwork, ["kind", "face", "plate", "badge"]);
  if (kind === "stories" && Array.isArray(value.episodes))
    preview.episodes = value.episodes.filter((episode) => typeof episode === "string" || typeof episode === "number");
  if (kind === "shop") {
    if (object(value.payment))
      preview.payment = pickPreviewFields(value.payment, ["advertisement", "paymentType", "prices", "price", "currencyImage", "currency", "storePurchase"]);
    if (object(value.starRewards))
      preview.starRewards = pickPreviewFields(value.starRewards, ["paid", "free", "pass", "days", "total"]);
  }
  const imageVariants = value.imageVariants;
  if (object(imageVariants)) {
    const artwork = [
      preview.image, preview.thumbnail, preview.thumbnailImage, preview.faceImage, preview.jacketUrl,
      preview.jacketThumbUrl, preview.backgroundImage, preview.logo, preview.banner, preview.episodeImage,
      object(preview.images) ? preview.images.thumbnail : undefined,
    ];
    const variants = Object.fromEntries(artwork.flatMap((source) => {
      if (typeof source !== "string") return [];
      const known = imageVariants[source] ?? imageVariants[source.split("?")[0]!];
      return object(known) ? [[source, known]] : [];
    }));
    if (Object.keys(variants).length) preview.imageVariants = variants;
  }
  return preview;
}
export interface FilteredContent {
  value: unknown;
  changed: boolean;
}
export type ContentPublicationsByServer = Record<string, Record<string, Record<string, unknown>>>;
export function filterContentData(
  value: unknown,
  view: ContentView,
  resource?: string,
  previews = false,
  publications: Record<string, Record<string, unknown>> = {},
  publicationsByServer?: ContentPublicationsByServer,
  omitted?: ContentReference[],
): FilteredContent {
  if (object(value) && (value.schema === "haneoka-team-builder-page-v1" || value.schema === "haneoka-team-builder-data-v1"))
    return { value, changed: false };
  const sourceServer = (node: Record<string, unknown>, inherited?: string): string | undefined => {
    const identity = object(node.identity) ? node.identity : undefined;
    return typeof identity?.server === "string" ? identity.server : typeof node.server === "string" ? node.server : inherited;
  };
  const own = object(value) ? ((object(value.identity) ? value.identity.server : undefined) ?? value.server) : undefined;
  const publicationFor = (key: string, server?: string): Record<string, unknown> | undefined =>
    publicationsByServer && server !== undefined ? publicationsByServer[server]?.[key] : publications[key];
  /**
   * Without the per-server registry, `publications` belong to the payload's own
   * server: a row from another source keeps its own dates and takes only the
   * fields it lacks.
   */
  const withPublication = (row: Record<string, unknown>, key: string, server?: string): Record<string, unknown> => {
    const publication = publicationFor(key, server);
    if (!publication) return row;
    const foreign = !publicationsByServer && server !== undefined && typeof own === "string" && server !== own;
    if (foreign) return { ...publication, ...row };
    return { ...row, ...publication, ...(row.rarity === undefined ? {} : { rarity: row.rarity }) };
  };
  if (object(value)) {
    const identity = String(value.id ?? value.entityId ?? "");
    const episode = object(value.episodes) && object(value.episodes[identity]) ? value.episodes[identity] : undefined;
    const primary = object(value.item)
      ? value.item
      : object(value.model)
        ? value.model
        : (episode ?? (value.entityId && object(value.document) ? value.document : undefined));
    const kind = visibilityType(resource ?? String(value.resource ?? value.kind ?? (episode ? "stories" : "")));
    if (primary && kind && identity) {
      const publication = withPublication(primary, `${kind}:${identity}`, sourceServer(value));
      if (!contentVisible(view, kind, publication, identity)) {
        omitted?.push(contentReference(kind, publication, identity));
        return { value: null, changed: true };
      }
    }
  }
  let changed = false;
  const drop = Symbol();
  const primaryFields = ["item", "row", "model"];
  // `songMeta` is keyed by music id, or by source and then music id in collection payloads.
  const fieldType = (field: string): VisibilityType | undefined =>
    field === "songMeta" ? "songs" : contentFieldType(field);
  /** A resource document that is a bare id → row map. */
  const rowMap = (node: Record<string, unknown>): boolean =>
    !inferredVisibilityType(node) &&
    !hasPublication(node) &&
    !node.schema &&
    !node.entries &&
    !node.items &&
    !Object.keys(node).some((field) => contentFieldType(field));
  const members = (
    node: Record<string, unknown>,
    kind: VisibilityType | undefined,
    server: string | undefined,
    keyed = true,
  ): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(node).flatMap(([id, entry]) => {
        const item = walk(entry, kind, keyed ? id : undefined, true, Boolean(kind), server);
        return item === drop ? [] : [[id, item]];
      }),
    );
  /**
   * `forceKind` marks an entity boundary: a member of a typed collection, a
   * primary `item`/`row`/`model`, or a cross-server variant row. Only such
   * boundaries and rows with their own identity fields are matched against the
   * publication registry; other nested objects answer for their own dates only.
   * `envelope` marks a resource document, whose `items`/`entries` hold rows of
   * that resource rather than game items.
   */
  const walk = (
    node: unknown,
    inherited?: VisibilityType,
    key?: string,
    row = false,
    forceKind = false,
    inheritedServer?: string,
    envelope = false,
  ): unknown | typeof drop => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node))
      return node.flatMap((child) => {
        const result = walk(child, inherited, undefined, true, forceKind, inheritedServer);
        return result === drop ? [] : [result];
      });
    let input = node as Record<string, unknown>;
    if (input.schema === "haneoka-team-builder-page-v1" || input.schema === "haneoka-team-builder-data-v1") return input;
    const server = sourceServer(input,
      publicationsByServer && key && Object.hasOwn(publicationsByServer, key) ? key : inheritedServer);
    if (object(input.value) && typeof input.id === "string" && row) {
      const result = walk(input.value, inherited, input.id, true, forceKind, server);
      return result === drop ? drop : { ...input, value: result };
    }
    if (input.perServer && object(input.perServer) && input.resource) return crossServer(input);
    if (envelope && inherited && rowMap(input) && Object.values(input).every(object))
      return members(input, inherited, server);
    const inferred = inferredVisibilityType(input);
    const boundary = forceKind || primaryFields.includes(key ?? "") || (node === value && hasPublication(input));
    const kind = inherited && (boundary || (node === value && inferred)) ? inherited : (inferred ?? inherited);
    const entity = Boolean(kind) && (boundary || inferred !== undefined);
    const identity = kind && entity
      ? visibilityId(kind, input) || (forceKind && key !== undefined && !primaryFields.includes(key) ? key : "")
      : "";
    if (entity && identity) input = withPublication(input, `${kind}:${identity}`, server);
    if (kind === "songs" && input.musicId !== undefined && Number(input.eventPublishedAt) > 0) {
      const { eventPublishedAt, ...song } = input;
      input = withEventSongRelease(song, { [String(input.musicId)]: Number(eventPublishedAt) });
    }
    if (kind && entity) {
      const access = previews
        ? contentListing(view, kind, input, identity)
        : contentVisible(view, kind, input, identity) ? "full" : "hidden";
      if (access !== "full") {
        changed = true;
        omitted?.push(contentReference(kind, input, identity));
        if (access !== "preview") return drop;
        const preview = contentPreview(input, kind);
        if (kind === "songs" && Array.isArray(input.challengeEvents))
          preview.challengeEvents = listedChallengeEvents(view, input.challengeEvents);
        return preview;
      }
    }
    const ownKind = typeof input.resource === "string" ? visibilityType(input.resource) : kind;
    const document = envelope || node === value || typeof input.schema === "string" || typeof input.resource === "string";
    const output: Record<string, unknown> = {};
    for (const [field, child] of Object.entries(input)) {
      if (kind === "songs" && field === "challengeEvents") {
        const events = listedChallengeEvents(view, child);
        output[field] = events;
        if (!Array.isArray(child) || events.length !== child.length) changed = true;
        continue;
      }
      if (field === "catalogMetadata" || dependencyFields.has(field)) {
        output[field] = child;
        continue;
      }
      if (field === "tierDetails" && object(child) && object(input.catalog) && Array.isArray(input.catalog.entries)) {
        output[field] = Object.fromEntries(input.catalog.entries.flatMap((entry) => {
          if (!object(entry) || !object(entry.perServer) || typeof entry.key !== "string") return [];
          const displayServer = String(entry.displayServer);
          const variant = entry.perServer[displayServer];
          const detail = child[entry.key];
          if (!object(variant) || !object(detail)) return [];
          const result = walk(detail, "tgw-card", String(variant.id), true, true, displayServer);
          return result === drop ? [] : [[entry.key, result]];
        }));
        continue;
      }
      // Cross-server catalogues key `documents` by source; team-builder keys them by resource.
      if (field === "documents" && object(child) && !Object.keys(child).some((source) => contentFieldType(source))) {
        output[field] = Object.fromEntries(
          Object.entries(child).flatMap(([source, entry]) => {
            const result = walk(entry, ownKind, source, false, false, server, true);
            return result === drop ? [] : [[source, result]];
          }),
        );
        continue;
      }
      const typed = document && (field === "items" || field === "entries") ? undefined : fieldType(field);
      const nextKind = typed ?? ownKind;
      const nested = object(child) && typeof child.schema === "string";
      const collection = object(child) && !nested && !inferredVisibilityType(child) && !hasPublication(child);
      let result: unknown;
      if (collection && (typed || ["entries", "items", "episodes", "chapters"].includes(field))) {
        const sources = Object.keys(child);
        // A source-keyed collection holds one map per server; chapter keys are chapter ids, not story ids.
        result =
          typed && sources.length && sources.every(isPublicReleaseServer) && Object.values(child).every(object)
            ? Object.fromEntries(
                sources.map((source) => [
                  source,
                  members(child[source] as Record<string, unknown>, nextKind, source),
                ]),
              )
            : members(child, nextKind, server, field !== "chapters");
      } else
        result = walk(
          child,
          nextKind,
          field,
          primaryFields.includes(field),
          !nested && (Boolean(typed) || primaryFields.includes(field)),
          server,
          field === "document",
        );
      if (result !== drop) output[field] = result;
    }
    return output;
  };
  /**
   * Cross-server catalogue entries and details. Every copy of a variant row —
   * `perServer`, the detail `row` and `ownershipVariant` — is filtered against
   * its own server; hidden variants leave the entry together with the peer
   * names and content merged from them.
   */
  const crossServer = (input: Record<string, unknown>): unknown | typeof drop => {
    const kind = visibilityType(String(input.resource));
    const variants = input.perServer as Record<string, unknown>;
    const perServer: Record<string, Record<string, unknown>> = {};
    for (const [server, variant] of Object.entries(variants)) {
      if (!object(variant) || !object(variant.row)) continue;
      const result = walk(variant.row, kind, String(variant.id), true, true, server);
      if (result !== drop)
        perServer[server] = { ...variant, row: result, ...(object(result) && result.__contentPreview ? { assets: {} } : {}) };
    }
    const servers = Object.keys(perServer);
    if (!servers.length) return drop;
    const removed = servers.length !== Object.keys(variants).length;
    const previewed = Object.values(perServer).some((variant) => object(variant.row) && variant.row.__contentPreview);
    const output: Record<string, unknown> = { ...input, perServer };
    if (removed || previewed) {
      changed = true;
      const reset: Record<string, unknown> = {
        displayServer: servers.includes(String(input.displayServer)) ? input.displayServer : servers[0],
        inSelectedServer: servers.includes(String(input.selectedServer)),
        sourceIds: servers,
        serverAvailability: Object.fromEntries(servers.map((server) => [server, true])),
        nameOverrides: {},
        nameFallbacks: [],
        content: { overrides: {}, supplements: [], fields: [] },
        variantGroups: servers.map((server) => [server]),
      };
      for (const [field, next] of Object.entries(reset)) if (Object.hasOwn(input, field)) output[field] = next;
    }
    if (object(input.row)) {
      const identity = object(input.identity) ? input.identity : {};
      const active = perServer[String(input.activeServer ?? identity.server)];
      if (!active) return drop;
      const row = removed || previewed ? active.row : walk(input.row, kind, String(active.id), true, true, String(input.activeServer ?? identity.server));
      if (row === drop) return drop;
      output.row = row;
    }
    if (object(input.ownershipVariant)) {
      const identity = object(input.ownershipVariant.identity) ? input.ownershipVariant.identity : {};
      output.ownershipVariant = perServer[String(identity.server)] ?? null;
    }
    return output;
  };
  const kind = resource && visibilityType(resource);
  const result =
    object(value) && kind && rowMap(value)
      ? members(value, kind, sourceServer(value))
      : walk(value, kind || undefined, undefined, false, Array.isArray(value) && Boolean(kind));
  return { value: result === drop ? null : result, changed };
}
