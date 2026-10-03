import type { PowerStats, ReleaseIdentity } from "./contracts";
import { projectEventDetail } from "./data/events";
import { adaptRuntimeRules, adaptChallengePointTable, adaptBoostTables, adaptGekisoTimelineTables, GEKISO_TIMELINE_MASTER_TABLES, type RuntimeRules, type LiveChallengePointTable } from "./data/runtime-rules";
import { nativeRuleSupports } from "./solver/native-rule-profile";
import { withNativeRuleEvidence } from "./data/native-rule-evidence";

export type DataRow = Record<string, unknown>;
export interface MemberCatalog {
  id: number;
  characterId: number;
  bandId: number;
  rarity: number;
  attribute: number;
  /** Native MemberCard.get_MusicType reads the same Master field as cardType. */
  musicType: number;
  name: unknown;
  image: string;
  statMax: PowerStats;
  levelGroup: number;
  trainingGroup: number;
  awakeningGroup: number;
  liveSkillId: number;
  gekisoSkillId: number;
  leaderSkillId: number;
  bestMusicTagIds: number[] | null;
  trainingResourceGroup: number;
  liveResourceGroup: number;
  gekisoResourceGroup: number;
  rankUpItemId: number;
}
export interface SnapshotCatalog {
  id: number;
  characterIds: number[];
  rarity: number;
  attribute: number;
  name: unknown;
  /** MasterSupportCard's localized character/group description, separate from the card title. */
  characterDescription?: unknown;
  image: string;
  statMax: PowerStats;
  levelGroup: number;
  awakeningGroup: number;
  supportSkillIds: number[];
  gekisoSupportSkillIds: number[];
  supportSkillSlotsKnown?: boolean;
  gekisoSupportSkillSlotsKnown?: boolean;
}
export interface TeamBuilderData {
  schema: "haneoka-team-builder-data-v1";
  identity: ReleaseIdentity & { sourceId?: string };
  members: Record<string, MemberCatalog>;
  snapshots: Record<string, SnapshotCatalog>;
  characters: Record<string, DataRow>;
  bands: Record<string, DataRow>;
  bandItems: Record<string, DataRow>;
  songs: Record<string, DataRow>;
  events: Record<string, DataRow>;
  eventRules: DataRow;
  progression: Record<string, DataRow[]>;
  skills: Record<string, Record<string, DataRow>>;
  skillReference: DataRow;
  liveTools: DataRow;
  gekisoRules: DataRow;
  runtimeRules?: RuntimeRules;
  challengePointTable?: LiveChallengePointTable;
  gaps: string[];
}
export const objectRow = (value: unknown): DataRow =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as DataRow) : {};
export const dataRows = (value: unknown): DataRow[] =>
  (Array.isArray(value) ? value : Object.values(objectRow(value))).map(objectRow);
export const nativeRow = (value: unknown): DataRow => {
  const row = objectRow(value);
  return {
    ...Object.fromEntries(Object.entries(objectRow(row.raw)).map(([key, child]) => [key.replace(/^_/u, ""), child])),
    ...Object.fromEntries(Object.entries(row).filter(([key]) => key !== "raw")),
  };
};
const map = (value: unknown): Record<string, DataRow> =>
  Object.fromEntries(Object.entries(objectRow(value)).map(([key, row]) => [key, objectRow(row)]));
const pick = (row: DataRow, fields: readonly string[]): DataRow =>
  Object.fromEntries(fields.filter((field) => row[field] !== undefined).map((field) => [field, row[field]]));
const compactNative = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(compactNative);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(nativeRow(value)).map(([key, child]) => [key, compactNative(child)]));
};
const positiveIds = (value: unknown): number[] =>
  (Array.isArray(value) ? value : []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
/** Formal Intl 1.0.1 owned-support selection/SetDeck validates IDs, not depicted characters. */
export const nativeSnapshotEquipRuleKnown = (identity: TeamBuilderData["identity"]) =>
  nativeRuleSupports(identity, "snapshot-equip");
const stats = (row: DataRow): PowerStats => {
  const stat = objectRow(row.stat);
  return {
    performance: Number(stat.performance ?? row.performancePowerMax),
    technique: Number(stat.technique ?? row.technicPowerMax),
    visual: Number(stat.visual ?? row.visualPowerMax),
  };
};

/** The documents must already have been fetched against the same immutable identity. */
export function adaptTeamBuilderData(
  identity: TeamBuilderData["identity"],
  documents: Record<string, unknown>,
): TeamBuilderData {
  identity = withNativeRuleEvidence(identity, documents["native-rule-evidence"] ?? identity.nativeRuleEvidence);
  const characters = map(documents.characters);
  const members = Object.fromEntries(
    Object.entries(objectRow(documents.cards)).map(([key, value]) => {
      const row = nativeRow(value);
      const characterId = Number(row.characterId ?? row.characterID);
      return [
        key,
        {
          id: Number(row.cardId ?? row.id ?? key),
          characterId,
          bandId: Number(characters[String(characterId)]?.bandId ?? 0),
          rarity: Number(row.rarity),
          attribute: Number(row.cardType),
          musicType: Number(row.cardType),
          name: row.prefix ?? row.cardName,
          image: String(objectRow(row.images).thumbnail ?? ""),
          statMax: stats(row),
          levelGroup: Number(row.memberCardLevelGroup),
          trainingGroup: Number(row.memberCardAwakeGroup),
          awakeningGroup: Number(row.memberCardRankGroup),
          liveSkillId: Number(row.liveSkillId ?? row.liveSkillID ?? 0),
          gekisoSkillId: Number(row.gekisouSkillId ?? row.gekisouSkillID ?? 0),
          leaderSkillId: Number(row.leaderSkillId ?? row.leaderSkillID ?? 0),
          bestMusicTagIds: Array.isArray(row.bestMusicTagIds ?? row.bestMusicTagIDs)
            ? positiveIds(row.bestMusicTagIds ?? row.bestMusicTagIDs)
            : null,
          trainingResourceGroup: Number(row.memberCardAwakeResourceGroup),
          liveResourceGroup: Number(row.liveSkillLevelResourceGroup),
          gekisoResourceGroup: Number(row.gekisouSkillLevelResourceGroup),
          rankUpItemId: Number(row.rankUpItemId ?? row.rankUpItemID ?? 0),
        } satisfies MemberCatalog,
      ];
    }),
  );
  const snapshots = Object.fromEntries(
    Object.entries(objectRow(documents["support-cards"])).map(([key, value]) => {
      const row = nativeRow(value);
      const resolved = objectRow(row.resolvedSkills);
      const skillIds = (group: string, explicit: unknown, nativeKeys: string[]) => {
        const validId = (id: unknown): id is number =>
          typeof id === "number" && Number.isSafeInteger(id) && id >= 0 && id <= 0x7fffffff;
        if (nativeKeys.every((field) => validId(row[field])))
          return { ids: nativeKeys.map((field) => row[field] as number), known: true };
        if (Array.isArray(explicit) && explicit.length === 2 && explicit.every(validId))
          return { ids: [...explicit] as number[], known: true };
        const compact = Array.isArray(explicit)
          ? positiveIds(explicit)
          : dataRows(resolved[group])
              .map((skill) => Number(skill.id))
              .filter((id) => id > 0);
        return { ids: [compact[0] ?? 0, compact[1] ?? 0], known: compact.length === 2 };
      };
      const support = skillIds("support", row.supportSkillIds, ["supportSkillId01", "supportSkillId02"]);
      const gekisoSupport = skillIds("gekisouSupport", row.gekisouSupportSkillIds, [
        "gekisouSupportSkillId01",
        "gekisouSupportSkillId02",
      ]);
      return [
        key,
        {
          id: Number(row.supportCardId ?? row.id ?? key),
          characterIds: positiveIds(row.characterIds ?? row.characterIDs),
          rarity: Number(row.rarity),
          attribute: Number(row.cardType),
          name: row.prefix,
          characterDescription: row.cardName,
          image: String(objectRow(row.images).thumbnail ?? ""),
          statMax: stats(row),
          levelGroup: Number(row.supportCardLevelGroup),
          awakeningGroup: Number(row.supportCardRankGroup),
          supportSkillIds: support.ids,
          gekisoSupportSkillIds: gekisoSupport.ids,
          supportSkillSlotsKnown: support.known,
          gekisoSupportSkillSlotsKnown: gekisoSupport.known,
        } satisfies SnapshotCatalog,
      ];
    }),
  );
  const progression = objectRow(documents.progression);
  const growthKeys = [
    "playerRanks",
    "characterRanks",
    "characterTotalRanks",
    "bandRanks",
    "bandTypeRanks",
    "memberCardLevels",
    "supportCardLevels",
    "memberCardRanks",
    "supportCardRanks",
    "memberCardAwake",
    "memberCardLevelLimits",
  ];
  const skillResources = {
    leader: "leader-skills",
    live: "skills",
    gekiso: "gekisou-skills",
    support: "support-skills",
    gekisoSupport: "gekisou-support-skills",
  };
  const bandItems = Object.fromEntries(
    Object.entries(map(objectRow(documents["band-items"]).items)).map(([id, row]) => [
      id,
      {
        ...pick(row, ["bandItemId", "bandId", "name", "resourceGroupId"]),
        levels: dataRows(row.levels).map(nativeRow),
        effects: dataRows(row.effects).map(nativeRow),
      },
    ]),
  );
  const skillIds = {
    leader: new Set(Object.values(members).map((card) => card.leaderSkillId)),
    live: new Set(Object.values(members).map((card) => card.liveSkillId)),
    gekiso: new Set(Object.values(members).map((card) => card.gekisoSkillId)),
    support: new Set(Object.values(snapshots).flatMap((card) => card.supportSkillIds)),
    gekisoSupport: new Set(Object.values(snapshots).flatMap((card) => card.gekisoSupportSkillIds)),
  };
  const growth = Object.fromEntries(growthKeys.map((key) => [key, dataRows(progression[key]).map(nativeRow)]));
  const challengePointTable = adaptChallengePointTable(identity, objectRow(documents["runtime-rules"]).challengePointTable);
  const boosts = adaptBoostTables(identity, objectRow(documents["runtime-rules"]).boostTables);
  const liveTools = compactNative(
    pick(objectRow(documents["live-tools"]), [
      "liveSettings", "scoreRanks", "noteParameters", "judgementParameters", "judgementTiming",
      "comboScoreBonuses", "liveBoostBonuses", "challengeBoostBonuses", "tableAvailability", "expRewards",
      "gekisouRankingScoreBonuses", "gekisouLuckBasePoints", "gekisouLuckBonusLots",
    ]),
  ) as DataRow;
  const gekisoRules = compactNative(objectRow(documents.gekisou)) as DataRow;
  const gekiso = adaptGekisoTimelineTables(identity, objectRow(documents["runtime-rules"]).gekisoTables, liveTools, gekisoRules);
  for (const key of Object.keys(GEKISO_TIMELINE_MASTER_TABLES)) delete liveTools[key];
  return {
    schema: "haneoka-team-builder-data-v1",
    identity: { ...identity },
    members,
    snapshots,
    characters: Object.fromEntries(
      Object.entries(characters).map(([id, row]) => [
        id,
        pick(row, ["characterId", "characterName", "bandId", "faceImage", "thumbnailImage", "colorCode"]),
      ]),
    ),
    bands: map(documents.bands),
    bandItems,
    songs: Object.fromEntries(
      Object.entries(map(documents.songs)).map(([id, row]) => [
        id,
        pick(row, [
          "musicId",
          "musicTitle",
          "bandId",
          "bandIds",
          "musicType",
          "bestMusicTagIds",
          "liveScoreRankGroup",
          "scoreRankRewardGroup",
          "comboRewardGroup",
          "musicCategories",
          "vocalCharacterIds",
          "jacketThumbUrl",
          "jacketUrl",
          "difficulty",
          "gekisou",
        ]),
      ]),
    ),
    events: Object.fromEntries(
      Object.entries(map(objectRow(documents.events).entries)).map(([id, row]) => [
        id,
        projectEventDetail(
          compactNative(
            pick(row, [
              "id",
              "kind",
              "title",
              "name",
              "image",
              "backgroundImage",
              "logo",
              "startAt",
              "endAt",
              "displayEndAt",
              "eventType",
              "musicId",
              "eventItem",
              "effects",
              "support",
              "rewardGroups",
              "bonusNote",
              "sourceTables",
            ]),
          ) as DataRow,
        ),
      ]),
    ),
    eventRules: objectRow(objectRow(documents.events).rules),
    progression: growth,
    skills: Object.fromEntries(
      Object.entries(skillResources).map(([key, resource]) => [
        key,
        Object.fromEntries(
          Object.entries(map(documents[resource]))
            .filter(([id]) => skillIds[key as keyof typeof skillIds].has(Number(id)))
            .map(([id, row]) => [
              id,
              compactNative(
                pick(row, [
                  "id",
                  "skillName",
                  "effects",
                  "gekisouMissionType",
                  "gekisouSupportSkillExecTiming",
                  "categories",
                  "sourceTable",
                ]),
              ) as DataRow,
            ]),
        ),
      ]),
    ),
    skillReference: compactNative(
      pick(objectRow(documents["skill-reference"]), [
        "conditionSets",
        "conditions",
        "cumulativeConditions",
        "targets",
        "effectSettings",
        "effectGroups",
      ]),
    ) as DataRow,
    liveTools: {
      ...liveTools, ...boosts.rows, ...gekiso.rows,
      tableAvailability: { ...objectRow(liveTools.tableAvailability), ...boosts.availability, ...gekiso.availability },
    },
    gekisoRules,
    runtimeRules: adaptRuntimeRules(identity, documents["runtime-rules"]),
    ...(challengePointTable ? { challengePointTable } : {}),
    gaps: [
      "full-player-and-song-power-stacking-unresolved",
      ...(!nativeSnapshotEquipRuleKnown(identity) ? ["native-snapshot-equip-rule-unverified-for-source"] : []),
    ],
  };
}
