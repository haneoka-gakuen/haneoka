import { projectHaneokaTranscript } from "@haneoka/vega-plugin-haneoka/transcript";
import { resolveSongPerformer } from "./song-performer";
import { itemRelations } from "../server/item-relations";
import {gekisouMissionIcons} from "./gekisou";
import {
  associatedReward,
  characterRankAssociations,
  entityReference,
  skillDisplay,
  upgradeSteps,
  type ReferenceResolver,
} from "./entity-associations";
/** Build-time, release-pinned data closures consumed by static and interactive entity views. */
import {
  asRecord,
  fetchOptionalStaticCatalog,
  fetchStaticCatalog,
  fetchStaticCatalogBatch,
  staticCatalogRelease,
  type RecordValue,
  type StaticCatalogRelease,
} from "./static-catalog-source";
import { searchableCatalogPages } from "./searchable-catalog";
import { searchableStoryPages } from "./searchable-stories";
import { RELEASE_SERVERS, type ReleaseServer } from "./resource-route";
import { PUBLIC_RELEASE_SERVERS } from "./temporary-public-routing";

let previewPageServers: Promise<ReleaseServer[]> | undefined;

/** Preview routes exist after an immutable preview release is available. Settings stays formal-only. */
export async function staticCatalogPageServers(configuredOnly = false): Promise<ReleaseServer[]> {
  if (!configuredOnly) return [...PUBLIC_RELEASE_SERVERS];
  if (!previewPageServers) previewPageServers = staticCatalogRelease("intl-test")
    .then(() => ["intl-test"] as ReleaseServer[])
    .catch(() => []);
  const formal = staticResourceServers().filter((server) => server === "jp" || server === "intl");
  return [...formal, ...await previewPageServers];
}

export const ENTITY_PAYLOAD_SCHEMA = "haneoka-entity-payload-v1";

/** Catalog resources whose entity pages are served from a build-time payload. */
export const ENTITY_PAYLOAD_RESOURCES = [
  "cards",
  "support-cards",
  "characters",
  "songs",
  "band-items",
  "items",
  "stamps",
  "stickers",
  "comics",
  "backgrounds",
  "events",
  "real-lives",
  "gacha",
  "login-campaigns",
  "shop",
  "exchange",
  "circle",
  "challenge",
  "passes",
] as const;
export type EntityPayloadResource = (typeof ENTITY_PAYLOAD_RESOURCES)[number];

export const isEntityPayloadResource = (value: string): value is EntityPayloadResource =>
  (ENTITY_PAYLOAD_RESOURCES as readonly string[]).includes(value);

/**
 * The document shape `<catalog-screen>` consumes. Every field mirrors a value
 * the screen previously assembled from its own requests, restricted to what
 * this entity needs.
 */
export interface EntityPayload {
  schema: typeof ENTITY_PAYLOAD_SCHEMA;
  server: ReleaseServer;
  releaseId: string;
  /** The producer always supplies the source of this frozen release; optional for historical payloads. */
  sourceId?: string;
  resource: EntityPayloadResource;
  id: string;
  /** The complete entity detail record (the `/{resource}/{id}` document). */
  item: RecordValue;
  /** Referenced characters and bands, compact. */
  characters: RecordValue[];
  bands: RecordValue[];
  /** Logical game-sprite name → runtime path, as `/ui-marks` returns it. */
  marks: Record<string, string>;
  /** Game items this entity names (rank-up piece, item detail). */
  gameItems: RecordValue[];
  /** Collection-level document fields a detail reads (item reward sources). */
  document?: RecordValue;
  /** Per-difficulty chart metrics for songs (`/song-meta/{id}`). */
  songMeta?: RecordValue;
  /** The `detailAux` sections, pre-filtered to this entity. */
  aux: RecordValue;
  /** Lists deliberately left out of the payload, and where to load them. */
  deferred?: Record<string, { url: string; count: number }>;
}

type Rows = RecordValue[];

const rows = (value: unknown, key?: string): Rows => {
  const source = key ? asRecord(value)?.[key] : value;
  if (Array.isArray(source)) return source.flatMap((row) => (asRecord(row) ? [row as RecordValue] : []));
  const record = asRecord(source);
  return record ? Object.values(record).flatMap((row) => (asRecord(row) ? [row as RecordValue] : [])) : [];
};

const entries = (value: unknown, key?: string): Array<[string, RecordValue]> => {
  const source = asRecord(key ? asRecord(value)?.[key] : value);
  return source ? Object.entries(source).flatMap(([id, row]) => (asRecord(row) ? [[id, row as RecordValue]] : [])) : [];
};

const numbers = (value: unknown): number[] =>
  (Array.isArray(value) ? value : value == null ? [] : [value])
    .map(Number)
    .filter((entry) => Number.isFinite(entry) && entry > 0);

const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)];

const pick = (source: RecordValue, keys: readonly string[]): RecordValue => {
  const output: RecordValue = {};
  for (const key of keys) if (source[key] !== undefined) output[key] = source[key];
  return output;
};

const rawOf = (row: RecordValue): RecordValue => asRecord(row.raw) || row;
const field = (row: RecordValue, ...keys: string[]): unknown => {
  const raw = rawOf(row);
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
    if (raw[key] !== undefined && raw[key] !== null) return raw[key];
  }
  return undefined;
};
const numberField = (row: RecordValue, ...keys: string[]): number => Number(field(row, ...keys) ?? Number.NaN);

/** Fields of a character record that detail views and tiles read. */
const CHARACTER_FIELDS = [
  "characterId",
  "characterName",
  "englishName",
  "bandId",
  "colorCode",
  "faceImage",
  "thumbnailImage",
] as const;
const BAND_FIELDS = ["bandId", "bandName", "description", "shortName", "englishName", "logo", "icon", "color", "colorCode"] as const;
const ITEM_FIELDS = ["itemId", "name", "image", "description", "itemTypeName", "max"] as const;

// Tile projections of related entities on a character page.
const CARD_TILE_FIELDS = ["cardId", "characterId", "prefix", "rarity", "cardType", "images"] as const;
const SUPPORT_TILE_FIELDS = [
  "supportCardId",
  "characterId",
  "characterIds",
  "prefix",
  "cardName",
  "rarity",
  "cardType",
  "images",
] as const;
const STAMP_TILE_FIELDS = ["stampId", "name", "image", "characterIds"] as const;
const SONG_TILE_FIELDS = [
  "musicId",
  "musicTitle",
  "bandId",
  "bandIds",
  "artistId",
  "artistName",
  "bandName",
  "vocalCharacterIds",
  "characterIds",
  "musicType",
  "musicCategories",
  "jacketThumbUrl",
  "jacketUrl",
] as const;
const LIVE2D_TILE_FIELDS = [
  "live2dKey",
  "assetId",
  "id",
  "live2dName",
  "name",
  "assetName",
  "characterId",
  "characterKey",
  "characterName",
  "title",
  "faceImage",
  "thumbnailImage",
  "preview",
  "live",
] as const;
const STORY_TILE_FIELDS = [
  "storyId",
  "storyKey",
  "storyCategory",
  "birthday",
  "isSpecialStory",
  "publishedAt",
  "title",
  "chapterId",
  "chapterKey",
  "chapterName",
  "storySort",
  "characterIds",
  "bandId",
  "banner",
  "image",
  "unlockCharacterFriendshipLevel",
  "playerRank",
  "bandRank",
  "characterRank",
  "perspectiveCharacterId",
  "unlockEpisodeNumber",
  "unlockEpisodeStoryId",
  "unlockEpisodeStatus",
  "unlockConditions",
] as const;
const CHAPTER_FIELDS = ["chapterId", "chapterName", "storyCategory", "birthday", "isSpecialStory", "publishedAt", "bandId", "banner", "image", "episodes"] as const;

interface Graph {
  server: ReleaseServer;
  release: StaticCatalogRelease;
  characters: Map<number, RecordValue>;
  bands: Map<number, RecordValue>;
  marks: Record<string, string>;
  items: Map<number, RecordValue>;
  itemRewards: RecordValue;
  progression: RecordValue;
  views: Record<string, Rows>;
  skillReference: RecordValue;
  songMeta: Map<string, RecordValue>;
  missionIcons: Record<string,string>;
  collections: Map<string, Array<[string, RecordValue]>>;
  stories: RecordValue;
  live2d: Array<[string, RecordValue]>;
  friendships: Array<[string, RecordValue]>;
  missionCount: number;
}

const graphs = new Map<ReleaseServer, Promise<Graph>>();

async function loadGraph(server: ReleaseServer): Promise<Graph> {
  const release = await staticCatalogRelease(server);
  const required = (path: string) => fetchStaticCatalog(path, server, release);
  const [
    characters,
    bands,
    marks,
    items,
    progression,
    memberLevels,
    awakeResources,
    skillResources,
    supportLevels,
    skillReference,
    songMeta,
    cards,
    supportCards,
    stamps,
    stickers,
    songs,
    missionAtlas,
    stories,
    live2d,
    friendships,
    missions,
  ] = await Promise.all([
    required("characters"),
    required("bands"),
    required("ui-marks"),
    required("items"),
    required("progression"),
    required("progression/views/member-card-levels"),
    required("progression/views/member-card-awake-resources"),
    required("progression/views/skill-level-resources"),
    required("progression/views/support-card-levels"),
    required("skill-reference"),
    required("song-meta"),
    required("cards"),
    required("support-cards"),
    required("stamps"),
    required("stickers"),
    required("songs?projection=4"),
    fetchOptionalStaticCatalog("sources/Assets/AddressableResources/Live/Images/Atlas/LiveAtlas.spriteatlasv2",server,release),
    required("stories?projection=4"),
    required("live2d"),
    required("friendships"),
    fetchOptionalStaticCatalog("character-missions", server, release),
  ]);
  return {
    server,
    release,
    characters: new Map(entries(characters).map(([key, row]) => [Number(row.characterId ?? key), row])),
    bands: new Map(entries(bands).map(([key, row]) => [Number(row.bandId ?? key), row])),
    marks: Object.fromEntries(
      Object.entries(asRecord(marks) || {}).flatMap(([name, path]) => (typeof path === "string" ? [[name, path]] : [])),
    ),
    items: new Map(entries(items, "items").map(([key, row]) => [Number(row.itemId ?? key), row])),
    itemRewards: asRecord(asRecord(items)?.rewards) || {},
    progression: asRecord(progression) || {},
    views: {
      "member-card-levels": rows(memberLevels),
      "member-card-awake-resources": rows(awakeResources),
      "skill-level-resources": rows(skillResources),
      "support-card-levels": rows(supportLevels),
    },
    skillReference: asRecord(skillReference) || {},
    songMeta: new Map(entries(songMeta)),
    missionIcons:gekisouMissionIcons(missionAtlas.value,server),
    collections: new Map([
      ["cards", entries(cards)],
      ["support-cards", entries(supportCards)],
      ["stamps", entries(stamps)],
      ["stickers", entries(stickers, "entries")],
      ["songs", entries(songs)],
    ]),
    stories: asRecord(stories) || {},
    live2d: entries(live2d),
    friendships: entries(friendships, "friendships"),
    missionCount: rows(missions.value, "missions").length,
  };
}

function songGekisouProjection(graph: Graph, item: RecordValue, meta?: RecordValue): RecordValue {
  const itemGekisou = asRecord(item.gekisou) || {};
  const metaGekisou = asRecord(meta?.gekisou) || {};
  const patternSource = Array.isArray(metaGekisou.missionPattern)
    ? metaGekisou.missionPattern
    : Array.isArray(itemGekisou.missionPattern)
      ? itemGekisou.missionPattern
      : Array.isArray(itemGekisou.missionTypes)
        ? itemGekisou.missionTypes
        : [];
  const missionPattern = patternSource.map(Number);
  const metaTypes = Array.isArray(metaGekisou.missionTypes) ? metaGekisou.missionTypes : [];
  const itemTypes = Array.isArray(itemGekisou.missionTypes) ? itemGekisou.missionTypes : [];
  const missionTypes = metaTypes.length ? metaTypes : itemTypes.length ? itemTypes : patternSource;
  const projection: RecordValue = { ...metaGekisou, icons:graph.missionIcons };
  delete projection.rankBonusTop;
  if (missionPattern.length && !Array.isArray(projection.missionPattern)) projection.missionPattern = missionPattern;
  if (missionTypes.length) projection.missionTypes = missionTypes;
  return projection;
}

function enrichCardReferences(graph: Graph, item: RecordValue): void {
  const members = new Map(graph.collections.get("cards") || []);
  const supports = new Map(graph.collections.get("support-cards") || []);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const reference = asRecord(value);
    if (!reference) return;
    if (reference.kind === "MemberCard" || reference.kind === "SupportCard") {
      const support = reference.kind === "SupportCard";
      const idKey = support ? "supportCardId" : "cardId";
      let id = String(reference[idKey] || "");
      if (!id && typeof reference.href === "string") {
        try {
          const url = new URL(reference.href, "https://catalog.invalid");
          id = url.searchParams.get(support ? "snap" : "card") || "";
        } catch {
          return;
        }
      }
      const card = (support ? supports : members).get(id);
      if (!card) return;
      Object.assign(reference, pick(card, support ? SUPPORT_TILE_FIELDS : CARD_TILE_FIELDS));
      const characterIds = characterIdsOf(card);
      reference.characterDetails = compactCharacters(graph, new Set(characterIds));
      return;
    }
    Object.values(reference).forEach(visit);
  };
  visit(item);
}

export function entityGraph(server: ReleaseServer): Promise<Graph> {
  let pending = graphs.get(server);
  if (!pending) {
    pending = loadGraph(server);
    graphs.set(server, pending);
    pending.catch(() => graphs.delete(server));
  }
  return pending;
}

const characterIdsOf = (item: RecordValue): number[] =>
  unique([...numbers(item.characterIds), ...numbers(item.characters), ...numbers(item.characterId)]);

function compactCharacters(graph: Graph, ids: Iterable<number>): Rows {
  return unique(ids).flatMap((id) => {
    const row = graph.characters.get(id);
    return row ? [pick(row, CHARACTER_FIELDS)] : [];
  });
}

function compactBands(graph: Graph, ids: Iterable<number>): Rows {
  return unique(ids).flatMap((id) => {
    const row = graph.bands.get(id);
    return row ? [pick(row, BAND_FIELDS)] : [];
  });
}

const allCharacterIds = (graph: Graph) => [...graph.characters.keys()];
const allBandIds = (graph: Graph) => [...graph.bands.keys()];

function referenceResolver(graph: Graph): ReferenceResolver {
  return (resource, id) => {
    const row = resource === "items" ? graph.items.get(Number(id))
      : resource === "characters" ? graph.characters.get(Number(id))
      : graph.collections.get(resource)?.find(([key]) => key === id)?.[1];
    return row ? entityReference(resource, id, row) : undefined;
  };
}

function progressionSubset(graph: Graph, key: string, keep: (row: RecordValue) => boolean): Rows {
  return rows(graph.progression[key]).filter((row) => keep(rawOf(row)));
}

/**
 * The closure of skill-reference rows a card's resolved skills can reach:
 * condition sets by group, the conditions they name, cumulative conditions,
 * and every target any of those or the effects reference.
 */
function skillReferenceSubset(graph: Graph, item: RecordValue): RecordValue {
  const reference = graph.skillReference;
  const effects: Rows = [];
  const collect = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (asRecord(value)) {
      const record = value as RecordValue;
      if (Array.isArray(record.effects)) effects.push(...rows(record.effects));
      for (const [key, child] of Object.entries(record)) if (key !== "effects" && key !== "raw") collect(child);
    }
  };
  collect(item.resolvedSkills);
  const groups = new Set<number>();
  const cumulative = new Set<number>();
  const targets = new Set<number>();
  for (const effect of effects) {
    for (const key of [
      ["conditionGroup", "_skillConditionGroup"],
      ["releaseConditionGroup", "_skillReleaseConditionGroup"],
      ["triggerConditionGroup", "_skillTriggerConditionGroup"],
    ]) {
      const group = numberField(effect, ...key);
      if (group > 0) groups.add(group);
    }
    const cumulativeId = numberField(effect, "cumulativeConditionId", "_skillCumulativeConditionID");
    if (cumulativeId > 0) cumulative.add(cumulativeId);
    numbers(field(effect, "targetIds", "_skillTargetIDs")).forEach((id) => targets.add(id));
  }
  const conditionSets = rows(reference.conditionSets).filter((row) => groups.has(numberField(row, "group", "_group")));
  const conditionIds = new Set(conditionSets.flatMap((row) => numbers(field(row, "conditionIds", "_conditionIds"))));
  const conditions = rows(reference.conditions).filter((row) => conditionIds.has(numberField(row, "id", "_id")));
  const cumulativeConditions = rows(reference.cumulativeConditions).filter((row) =>
    cumulative.has(numberField(row, "id", "_id")),
  );
  for (const row of [...conditions, ...cumulativeConditions])
    numbers(field(row, "targetIds", "conditionTargetIds", "_conditionTargetIDs")).forEach((id) => targets.add(id));
  return {
    conditionSets,
    conditions,
    cumulativeConditions,
    targets: rows(reference.targets).filter((row) => targets.has(numberField(row, "id", "_id"))),
  };
}

function cardAux(graph: Graph, item: RecordValue, support: boolean): RecordValue {
  const levelView = support ? "support-card-levels" : "member-card-levels";
  const levelGroup = Number(support ? item.supportCardLevelGroup : item.memberCardLevelGroup);
  const skillGroups = new Set(
    numbers([item.liveSkillLevelResourceGroup, item.gekisouSkillLevelResourceGroup, item.linkSkillLevelResourceGroup]),
  );
  const aux: RecordValue = {
    [levelView]: (graph.views[levelView] || []).filter((row) => Number(row.group) === levelGroup),
    "skill-level-resources": (graph.views["skill-level-resources"] || []).filter((row) =>
      skillGroups.has(Number(row.group)),
    ),
    "skill-reference": skillReferenceSubset(graph, item),
  };
  if (support) {
    const rankGroup = Number(item.supportCardRankGroup || item.supportCardLevelGroup);
    aux.progression = {
      supportCardRanks: progressionSubset(graph, "supportCardRanks", (raw) => Number(raw._group) === rankGroup),
    };
  } else {
    const awakeGroup = Number(item.memberCardAwakeGroup || 1);
    const rankGroup = Number(item.memberCardRankGroup || 1);
    const resourceGroup = Number(item.memberCardAwakeResourceGroup);
    aux["member-card-awake-resources"] = (graph.views["member-card-awake-resources"] || []).filter(
      (row) => Number(row.group) === resourceGroup,
    );
    aux.progression = {
      memberCardAwake: progressionSubset(graph, "memberCardAwake", (raw) => Number(raw._group) === awakeGroup),
      memberCardRanks: progressionSubset(graph, "memberCardRanks", (raw) => Number(raw._group) === rankGroup),
      memberCardLevelLimits: progressionSubset(
        graph,
        "memberCardLevelLimits",
        (raw) => Number(raw._rarity) === Number(item.rarity),
      ),
    };
  }
  const resolve = referenceResolver(graph);
  const progression = asRecord(aux.progression) || {};
  aux.associations = {
    skills: skillDisplay(item, asRecord(aux["skill-reference"]) || {}),
    upgrades: [
      ...upgradeSteps("live", rows(aux["skill-level-resources"]).filter(
        (row) => Number(row.group) === Number(item.liveSkillLevelResourceGroup)), "level", resolve),
      ...upgradeSteps("gekisou", rows(aux["skill-level-resources"]).filter(
        (row) => Number(row.group) === Number(item.gekisouSkillLevelResourceGroup)), "level", resolve),
      ...upgradeSteps("link", rows(aux["skill-level-resources"]).filter(
        (row) => Number(row.group) === Number(item.linkSkillLevelResourceGroup)), "level", resolve),
      ...upgradeSteps("training", rows(aux["member-card-awake-resources"]), "awakeCount", resolve),
      ...upgradeSteps(support ? "rank" : "awakening",
        rows(progression[support ? "supportCardRanks" : "memberCardRanks"]), "rank", resolve,
        support ? { resource: "support-cards", id: String(item.supportCardId) }
          : { resource: "items", id: String(item.rankUpItemId) }),
    ],
  };
  return aux;
}

/** Everything the character archive's tabs list, filtered to one character. */
function characterAux(graph: Graph, item: RecordValue): { aux: RecordValue; bandIds: number[] } {
  const id = Number(item.characterId || 0);
  const has = (row: RecordValue) => characterIdsOf(row).includes(id);
  const collection = (name: string) => graph.collections.get(name) || [];
  const byKey = (list: Array<[string, RecordValue]>, fields: readonly string[], keep: (row: RecordValue) => boolean) =>
    Object.fromEntries(list.filter(([, row]) => keep(row)).map(([key, row]) => [key, pick(row, fields)]));

  const episodes = entries(graph.stories.episodes).filter(([, row]) => has(row));
  const storyKeys = new Set(episodes.map(([key, row]) => String(row.storyId || row.storyKey || key)));
  const chapterIds = new Set(episodes.map(([, row]) => Number(row.chapterId)));
  const chapters = rows(graph.stories.chapters)
    .filter(
      (chapter) =>
        chapterIds.has(Number(chapter.chapterId)) ||
        (Array.isArray(chapter.episodes) ? chapter.episodes : []).some((story) => storyKeys.has(String(story))),
    )
    .map((chapter) => pick(chapter, CHAPTER_FIELDS));
  const homeSpots = rows(graph.stories.homeSpots)
    .filter((spot) => rows(spot.talks).some((talk) => storyKeys.has(String(talk.storyKey || ""))))
    .map((spot) => ({
      bandId: spot.bandId,
      spine: { backgroundPreview: asRecord(spot.spine)?.backgroundPreview },
      talks: rows(spot.talks)
        .filter((talk) => storyKeys.has(String(talk.storyKey || "")))
        .map((talk) => ({ storyKey: talk.storyKey })),
    }));
  const songs = byKey(collection("songs"), SONG_TILE_FIELDS, (row) => {
    return resolveSongPerformer(row,{game:"our-notes",server:graph.server,sourceId:graph.release.sourceId,bands:graph.bands,characters:graph.characters}).participantCharacterIds.includes(id);
  });
  const friendships = byKey(graph.friendships, ["friendshipId", "characterIds", "storyBanner", "rewards"], has);
  const aux: RecordValue = {
    characters: Object.fromEntries(
      [...graph.characters].map(([key, row]) => [String(key), pick(row, CHARACTER_FIELDS)]),
    ),
    cards: byKey(collection("cards"), CARD_TILE_FIELDS, (row) => Number(row.characterId) === id),
    "support-cards": byKey(collection("support-cards"), SUPPORT_TILE_FIELDS, has),
    stamps: byKey(collection("stamps"), STAMP_TILE_FIELDS, has),
    songs,
    live2d: byKey(graph.live2d, LIVE2D_TILE_FIELDS, (row) => Number(row.characterId) === id),
    stories: {
      episodes: Object.fromEntries(episodes.map(([key, row]) => [key, pick(row, STORY_TILE_FIELDS)])),
      chapters,
      homeSpots,
    },
    friendships: { friendships },
    associations: characterRankAssociations(id, graph.progression, referenceResolver(graph)),
  };
  const bandIds = [
    ...allBandIds(graph),
    ...Object.values(songs).flatMap((song) => numbers(asRecord(song)?.bandIds ?? asRecord(song)?.bandId)),
  ];
  return { aux, bandIds };
}

async function friendshipRewards(graph: Graph, aux: RecordValue): Promise<void> {
  const container = asRecord(aux.friendships);
  const friendships = asRecord(container?.friendships);
  if (!friendships) return;
  const ids = Object.keys(friendships);
  if (!ids.length) return;
  // The index projection omits rank rewards; the entity records carry them.
  const details = await fetchStaticCatalogBatch("friendships", ids, graph.server, graph.release);
  for (const id of ids) {
    const detail = details.get(id);
    const current = asRecord(friendships[id]);
    if (!detail || !current) continue;
    friendships[id] = {
      ...current,
      rewards: rows(detail.rewards).map((row) => {
        const reward = asRecord(row.reward) || row;
        const resolved = asRecord(reward.resolved) || {};
        return {
          rank: row.rank,
          reward: {
            ...associatedReward(reward, referenceResolver(graph)),
            resolved: pick(resolved, ["image", "name"]),
          },
        };
      }),
    };
  }
}

/** Where each collection keeps its entity map, and which field is the entity id (as catalog-screen reads them). */
const COLLECTION_SHAPE: Record<EntityPayloadResource, { document?: string; id: string; path?: string }> = {
  cards: { id: "cardId" },
  "support-cards": { id: "supportCardId" },
  characters: { id: "characterId" },
  songs: { id: "musicId", path: "songs?projection=4" },
  "band-items": { id: "bandItemId", document: "items" },
  items: { id: "itemId", document: "items" },
  stamps: { id: "stampId" },
  stickers: { id: "stickerId", document: "entries" },
  comics: { id: "comicId" },
  backgrounds: { id: "backgroundId", document: "entries" },
  events: { id: "id", document: "entries" },
  "real-lives": { id: "id", document: "entries" },
  gacha: { id: "id", document: "entries" },
  "login-campaigns": { id: "id", document: "entries" },
  shop: { id: "id", document: "entries" },
  exchange: { id: "id", document: "entries" },
  circle: { id: "id", document: "entries" },
  challenge: { id: "id", document: "entries" },
  passes: { id: "id", document: "entries" },
};

/**
 * The browse row for each id, keyed the way the screen keys it. The screen
 * used to open a detail as `{ _key, ...summary, ...detail }`; the summary
 * carries projections (song credits) the entity record does not.
 */
async function collectionSummaries(graph: Graph, resource: EntityPayloadResource): Promise<Map<string, RecordValue>> {
  const shape = COLLECTION_SHAPE[resource];
  const document = await fetchStaticCatalog(shape.path || resource, graph.server, graph.release);
  return new Map(
    entries(document, shape.document).map(([key, row]) => [String(row[shape.id] ?? key), { _key: key, ...row }]),
  );
}

/** Builds the payloads for one resource in a single batch against the pinned release. */
export async function buildEntityPayloads(
  server: ReleaseServer,
  resource: EntityPayloadResource,
  ids: readonly string[],
): Promise<Map<string, EntityPayload>> {
  const graph = await entityGraph(server);
  const [details, summaries] = await Promise.all([
    fetchStaticCatalogBatch(resource, ids, server, graph.release),
    collectionSummaries(graph, resource),
  ]);
  const output = new Map<string, EntityPayload>();
  for (const id of ids) {
    const detail = details.get(id);
    if (!detail) throw new Error(`Entity payload source missing: ${server}/${resource}/${id}`);
    const summary = summaries.get(id) || { _key: id };
    const item: RecordValue = {
      ...summary,
      ...detail,
      artistName: detail.artistName || summary.artistName,
      bandName: detail.bandName || summary.bandName,
    };
    if (item.artistName === undefined) delete item.artistName;
    if (item.bandName === undefined) delete item.bandName;
    if (resource === "gacha") enrichCardReferences(graph, item);
    const performer=resource==="songs" ? resolveSongPerformer(item,{game:"our-notes",server,sourceId:graph.release.sourceId,bands:graph.bands,characters:graph.characters}) : undefined;
    const characterIds = new Set(performer?.participantCharacterIds ?? characterIdsOf(item));
    if(!performer) for (const vocal of numbers(item.vocalCharacterIds)) characterIds.add(vocal);
    const bandIds = new Set(performer?.bandIds ?? [...numbers(item.bandId), ...numbers(item.bandIds)]);
    if(!performer) for (const characterId of characterIds) {
      const band = Number(graph.characters.get(characterId)?.bandId || 0);
      if (band) bandIds.add(band);
    }
    const gameItemIds = new Set(numbers(item.rankUpItemId));
    let aux: RecordValue = {};
    let document: RecordValue | undefined;
    let songMeta: RecordValue | undefined;
    let deferred: EntityPayload["deferred"];
    let characterRows: Rows | undefined;

    if (resource === "cards" || resource === "support-cards") {
      aux = cardAux(graph, item, resource === "support-cards");
    } else if (resource === "band-items") {
      const group = Number(item.resourceGroupId || 0);
      aux = {
        "skill-level-resources": (graph.views["skill-level-resources"] || []).filter(
          (row) => Number(row.group) === group,
        ),
      };
      aux.associations = {
        upgrades: upgradeSteps("level", rows(aux["skill-level-resources"]), "level", referenceResolver(graph)),
      };
    } else if (resource === "items") {
      gameItemIds.add(Number(item.itemId || id));
      document = {
        itemRelations: await itemRelations(server, Number(item.itemId || id), graph.release.releaseId),
        rewards: Object.fromEntries(
          Object.entries(graph.itemRewards).map(([source, value]) => [
            source,
            rows(value).filter(
              (reward) =>
                (reward.resourceTypeName === "Item" || Number(reward.resourceType) === 1) &&
                Number(reward.resourceId) === Number(item.itemId || id),
            ),
          ]),
        ),
      };
    } else if (resource === "songs") {
      const meta = graph.songMeta.get(id);
      const gekisou = songGekisouProjection(graph, item, meta);
      if (Object.keys(gekisou).length) item.gekisou = { ...(asRecord(item.gekisou) || {}), ...gekisou };
      const projectedMeta = meta
        ? Object.keys(gekisou).length
          ? { ...meta, gekisou }
          : meta
        : Object.keys(gekisou).length
          ? { gekisou }
          : undefined;
      songMeta = projectedMeta ? { [id]: projectedMeta } : {};
    } else if (resource === "characters") {
      const related = characterAux(graph, item);
      aux = related.aux;
      await friendshipRewards(graph, aux);
      related.bandIds.forEach((band) => bandIds.add(band));
      characterRows = compactCharacters(graph, allCharacterIds(graph));
      const voiceCount = Object.keys(
        asRecord(
          await fetchStaticCatalog(`voices/relations/character/${encodeURIComponent(id)}`, server, graph.release),
        ) || {},
      ).length;
      deferred = {
        voices: {
          url: `/api/v1/servers/${encodeURIComponent(server)}/voices/relations/character/${encodeURIComponent(id)}?release=${graph.release.releaseId}`,
          count: voiceCount,
        },
        "character-missions": {
          url: `/api/v1/servers/${encodeURIComponent(server)}/character-missions?release=${graph.release.releaseId}`,
          count: graph.missionCount,
        },
      };
    }

    // Every cost/reward item is a compact same-release record, including currencies.
    const collectItemIds = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(collectItemIds); return; }
      const row = asRecord(value);
      if (!row) return;
      if (Number(row.itemId) > 0) gameItemIds.add(Number(row.itemId));
      if ((Number(row.resourceType) === 1 || row.resourceTypeName === "Item") && Number(row.resourceId) > 0)
        gameItemIds.add(Number(row.resourceId));
      if (row.resource === "items" && Number(row.id) > 0) gameItemIds.add(Number(row.id));
      Object.entries(row).forEach(([key, child]) => { if (key !== "raw") collectItemIds(child); });
    };
    collectItemIds(aux);
    collectItemIds(document);
    const resolve = referenceResolver(graph);
    if (resource === "stickers") {
      // Older catalog releases already carry the rank-reward evidence in progression.
      const unlocks: Rows = Array.isArray(item.unlocks) ? rows(item.unlocks) : [
        ...rows(graph.progression.characterRankRewards).filter((row) => {
          const reward = asRecord(row.reward) || {};
          return Number(reward.resourceType) === 17 && Number(reward.resourceId) === Number(id);
        }).map((row) => ({ kind: "characterRank", characterId: row.characterId, rank: row.rank })),
        ...rows(graph.progression.friendshipRankRewards).filter((row) => {
          const reward = asRecord(row.reward) || {};
          return Number(reward.resourceType) === 17 && Number(reward.resourceId) === Number(id);
        }).map((row) => ({ kind: "friendshipRank", friendshipId: row.friendshipId, rank: row.rank })),
      ];
      const artworkCardId = Number(item.sourceCardId) || Number(
        typeof item.image === "string" ? item.image.match(/\/MemberCard\/(\d+)\/member_character\.png(?:$|\?)/)?.[1] : 0,
      );
      aux.associations = {
        ...(artworkCardId > 0 ? { artworkCard: resolve("cards", String(artworkCardId)) } : {}),
        unlocks: unlocks.map((unlock) => ({
          ...unlock,
          ...(Number(unlock.characterId) > 0 ? { character: resolve("characters", String(unlock.characterId)) } : {}),
        })),
      };
    }

    output.set(id, {
      schema: ENTITY_PAYLOAD_SCHEMA,
      server,
      releaseId: graph.release.releaseId,
      sourceId: graph.release.sourceId,
      resource,
      id,
      item,
      characters: characterRows ?? compactCharacters(graph, characterIds),
      bands: compactBands(graph, bandIds),
      marks: graph.marks,
      gameItems: [...gameItemIds].flatMap((itemId) => {
        const row = graph.items.get(itemId);
        return row ? [pick(row, ITEM_FIELDS)] : [];
      }),
      ...(document ? { document } : {}),
      ...(songMeta ? { songMeta } : {}),
      aux,
      ...(deferred ? { deferred } : {}),
    });
  }
  return output;
}

/**
 * A story page's payload: the episode summary plus the collection context its
 * detail reads — its chapter and the chapter's episodes (for "continue to
 * the next story"), the home spot it is told at, and the cast — instead of
 * the whole story index. The complete episode script is included for text and playback.
 */
export interface StoryPayload {
  schema: typeof STORY_PAYLOAD_SCHEMA;
  server: ReleaseServer;
  releaseId: string;
  id: string;
  mode: string;
  episodes: Record<string, RecordValue>;
  chapters: Record<string, RecordValue>;
  homeSpots: RecordValue[];
  characters: Rows;
  bands: Rows;
  storyEvents: Rows;
}

export const STORY_PAYLOAD_SCHEMA = "haneoka-story-payload-v1";

/** Story payloads for every episode in `modes`, keyed by story id. */
async function buildStoryPayloads(server: ReleaseServer, modes: ReadonlyMap<string, string>) {
  const graph = await entityGraph(server);
  const episodes = asRecord(graph.stories.episodes) || {};
  const chapters = entries(graph.stories.chapters);
  const spots = rows(graph.stories.homeSpots);
  const spotOf = new Map<string, RecordValue>();
  for (const spot of spots)
    for (const talk of rows(spot.talks)) if (talk.storyKey) spotOf.set(String(talk.storyKey), spot);
  const output = new Map<string, StoryPayload>();
  const details = await fetchStaticCatalogBatch("stories", [...modes.keys()], server, graph.release);
  for (const [id, mode] of modes) {
    const episode = asRecord(episodes[id]);
    if (!episode) continue;
    const chapter = chapters.find(([, row]) => String(row.chapterId) === String(episode.chapterId));
    // "Continue" plays the next episode of the same group in chapter order;
    // that successor is the only sibling a story page reads.
    const group = (row: RecordValue) =>
      row.isAnotherEpisode === true ? "another" : row.isExtraEpisode === true ? "extra" : "main";
    const order = chapter
      ? (Array.isArray(chapter[1].episodes) ? chapter[1].episodes : [])
          .map(String)
          .filter((key) => asRecord(episodes[key]))
      : [];
    const sequence = order.filter((key) => group(episodes[key] as RecordValue) === group(episode));
    const successor = sequence[sequence.indexOf(id) + 1];
    const kept = order.filter((key) => key === id || key === successor);
    const spot = spotOf.get(id);
    const included: Record<string, RecordValue> = { [id]: { ...episode, ...details.get(id) } };
    if (successor) included[successor] = episodes[successor] as RecordValue;
    const characterIds = new Set([
      ...Object.values(included).flatMap((row) => characterIdsOf(row)),
      ...numbers(spot?.characterIds),
      ...Object.values(included).flatMap((row) =>
        projectHaneokaTranscript(row).flatMap(({ command }) =>
          rows(command.targets).map((target) => target.characterId).filter((character): character is number =>
            typeof character === "number" && Number.isSafeInteger(character) && character > 0 &&
            graph.characters.has(character),
          ),
        ),
      ),
    ]);
    const bandIds = new Set([
      ...numbers(episode.bandId),
      ...numbers(chapter?.[1].bandId),
      ...numbers(spot?.bandId),
      ...[...characterIds].map((character) => Number(graph.characters.get(character)?.bandId || 0)).filter(Boolean),
    ]);
    output.set(id, {
      schema: STORY_PAYLOAD_SCHEMA,
      server,
      releaseId: graph.release.releaseId,
      id,
      mode,
      episodes: included,
      chapters: chapter ? { [chapter[0]]: { ...chapter[1], episodes: kept.length ? kept : [id] } } : {},
      homeSpots: spot ? [spot] : [],
      characters: compactCharacters(graph, characterIds),
      bands: compactBands(graph, bandIds),
      storyEvents: rows(graph.stories.storyEvents).filter((row) => String(row.chapterId) === String(episode.chapterId)),
    });
  }
  return output;
}

type PageData = EntityPayload | StoryPayload;
const pageData = new Map<ReleaseServer, Promise<Map<string, PageData>>>();
const payloadKey = (resource: string, id: string) => `${resource}\u0000${id}`;

async function buildPageData(server: ReleaseServer): Promise<Map<string, PageData>> {
  const pages = await searchableCatalogPages(server);
  const output = new Map<string, PageData>();
  for (const resource of ENTITY_PAYLOAD_RESOURCES) {
    const ids = unique(pages.filter((page) => page.resource === resource).map((page) => page.id));
    if (!ids.length) continue;
    for (const [id, payload] of await buildEntityPayloads(server, resource, ids)) {
      output.set(payloadKey(resource, id), payload);
    }
  }
  const stories = await searchableStoryPages(server);
  const storyPayloads = await buildStoryPayloads(server, new Map(stories.map((page) => [page.storyId, page.mode])));
  for (const [id, payload] of storyPayloads) output.set(payloadKey("stories", id), payload);
  return output;
}

export async function catalogEntityData(
  server: ReleaseServer,
  resource: string,
  id: string,
): Promise<PageData | undefined> {
  let pending = pageData.get(server);
  if (!pending) {
    pending = buildPageData(server);
    pageData.set(server, pending);
    pending.catch(() => pageData.delete(server));
  }
  return (await pending).get(payloadKey(resource, id));
}

/** Servers whose entity pages this build renders (`STATIC_RESOURCE_SERVERS`, default intl). */
export function staticResourceServers(): ReleaseServer[] {
  const requested = process.env.STATIC_RESOURCE_SERVERS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const servers = [...new Set(requested?.length ? requested : ["intl"])];
  for (const server of servers)
    if (!RELEASE_SERVERS.includes(server as ReleaseServer))
      throw new Error(`Unsupported static resource server: ${server}`);
  return servers as ReleaseServer[];
}
