/** Typed, search-ready Master tables. Two front-ends fill it: the public team DTO
 * and raw `_allData` tables. Every later stage reads only this shape. */
import { dataRows, nativeRow, objectRow, type DataRow, type TeamBuilderData } from "../data";

export type Stat3 = readonly [number, number, number];
export interface TargetRow {
  id: number;
  bandId: number;
  cardType: number;
  characterId: number;
  tagId: number;
  liveSkillCategories: readonly number[];
  gekisouSkillCategories: readonly number[];
  gekisouMissionType: number;
  liveMusicType: number;
  judgement: number;
  skillTargetType: number;
}
export interface ConditionRow {
  id: number;
  type: number;
  targetIds: readonly number[];
  values: readonly number[];
  positive: boolean;
}
export interface CumulativeRow {
  id: number;
  type: number;
  targetIds: readonly number[];
  values: readonly number[];
  cap: number;
}
export interface SkillEffectRow {
  id: number;
  level: number;
  /** Condition skills: 1 one-shot, 2 sustained. */
  triggerType: number;
  executeLimit: number;
  resetGroup: number;
  type: number;
  value: number;
  seconds: number;
  conditionGroup: number;
  triggerGroup: number;
  releaseGroup: number;
  cumulativeId: number;
  targetIds: readonly number[];
  limitCount: number;
  maxValue: number;
}
export interface MemberCard {
  levelLimits?: Record<string, number>;
  id: number;
  characterId: number;
  bandId: number;
  rarity: number;
  cardType: number;
  bestTags: readonly number[];
  statMax: Stat3;
  levelGroup: number;
  awakeGroup: number;
  rankGroup: number;
  liveSkillId: number;
  gekisoSkillId: number;
  leaderSkillId: number;
  releasedAt: number | null;
}
export interface SnapCard {
  id: number;
  characterIds: readonly number[];
  bandIds: readonly number[];
  rarity: number;
  cardType: number;
  statMax: Stat3;
  levelGroup: number;
  rankGroup: number;
  supportSkillIds: readonly [number, number];
  gekisoSupportSkillIds: readonly [number, number];
}
export interface MemberRankRow {
  rates: Stat3;
  leaderSkillLevel: number;
  musicTypeRate: number;
  musicTagRate: number;
}
export interface SnapRankRow {
  typeLinkRate: number;
  limitLevel: number;
  skillLevels: readonly [number, number];
  gekisoSkillLevels: readonly [number, number];
}
export interface SongDifficulty {
  difficulty: number;
  scoreId: number;
  playLevel: number;
  displayLevel: number;
  noteCount: number;
  file: string;
}
export interface Song {
  id: number;
  musicType: number;
  bestTags: readonly number[];
  bandIds: readonly number[];
  rankGroup: number;
  difficulties: readonly SongDifficulty[];
  gekisoMissions: readonly number[];
}
export interface ChallengeMusic {
  id: number;
  eventId: number;
  liveMusicId: number;
  musicType: number;
}
export interface ScoreRankRow {
  rank: number;
  required: number;
  battleRequired: number;
}
export interface EventEffectRow {
  resourceType: number;
  characterId: number;
  bandId: number;
  cardType: number;
  tagId: number;
  memberCardId: number;
  supportCardId: number;
  bonusType: number;
  perRank: readonly number[];
}
export interface RewardRow {
  scoreRank: number;
  group: number;
  resourceType: number;
  resourceId: number;
  count: number;
  probability: number;
}
export interface GameEvent {
  id: number;
  startAt: number | null;
  endAt: number | null;
  itemId: number;
  musicId: number;
  effects: readonly EventEffectRow[];
  /** score rank → points per play at rate 1. */
  livePoints: ReadonlyMap<number, number>;
  challengePoints: ReadonlyMap<number, number>;
  liveRewards: readonly RewardRow[];
  challengeRewards: readonly RewardRow[];
}
export interface BoostRow {
  consumed: number;
  eventPointRate: number;
  rewardRate: number;
}
export interface EngineMaster {
  server: string;
  releaseId: string;
  params: { musicTypeBase: number; musicTagBase: number; typeLinkBase: number; skipRank: number };
  live: {
    adjustment: number;
    lifeOnus: number;
    lifeBase: number;
    notePercent: ReadonlyMap<number, number>;
    /** Score type (1 Just … 6 Miss) → percent. */
    judgePercent: ReadonlyMap<number, number>;
    /** combo bonus type → ascending [required combo, cumulative float32 factor]. */
    combo: ReadonlyMap<number, readonly (readonly [number, number])[]>;
    assistPercent: number;
    /** Life damage indexed by simulate judgement (1 Miss … 6 Just). */
    damage: readonly number[];
    /** Raw `MasterLiveSettings` values by key. */
    settings: ReadonlyMap<string, string>;
    /** Note judgement types with a Just timing row, and every judgement type with a timing row. */
    justTypes: ReadonlySet<number>;
    timingTypes: ReadonlySet<number>;
    /** The longest judgement window after a note, ms. */
    afterMs: number;
    /** Skill effect type → update phase (1 or 2). */
    phases: ReadonlyMap<number, number>;
    gekiso: GekisouTables;
  };
  characters: ReadonlyMap<number, { id: number; bandId: number }>;
  members: ReadonlyMap<number, MemberCard>;
  snaps: ReadonlyMap<number, SnapCard>;
  memberLevels: ReadonlyMap<number, ReadonlyMap<number, Stat3>>;
  memberAwake: ReadonlyMap<number, ReadonlyMap<number, Stat3>>;
  memberRanks: ReadonlyMap<number, ReadonlyMap<number, MemberRankRow>>;
  /** `${rarity}:${awake}` → level cap. */
  memberLevelLimits: ReadonlyMap<string, number>;
  snapLevels: ReadonlyMap<number, ReadonlyMap<number, Stat3>>;
  snapRanks: ReadonlyMap<number, ReadonlyMap<number, SnapRankRow>>;
  characterRankBonus: readonly (readonly [number, number])[];
  totalRankBonus: readonly (readonly [number, number])[];
  maxCharacterRank: number;
  vipBonus: ReadonlyMap<number, number>;
  /** item → level → effects. */
  bandItems: ReadonlyMap<number, { bandId: number; levels: ReadonlyMap<number, readonly SkillEffectRow[]> }>;
  targets: ReadonlyMap<number, TargetRow>;
  conditions: ReadonlyMap<number, ConditionRow>;
  conditionSets: ReadonlyMap<number, readonly (readonly number[])[]>;
  cumulative: ReadonlyMap<number, CumulativeRow>;
  leaderSkills: ReadonlyMap<number, readonly SkillEffectRow[]>;
  liveSkills: ReadonlyMap<number, readonly SkillEffectRow[]>;
  supportSkills: ReadonlyMap<number, readonly SkillEffectRow[]>;
  gekisoSkills: ReadonlyMap<number, { missionType: number; effects: readonly SkillEffectRow[] }>;
  gekisoSupportSkills: ReadonlyMap<number, { missionType: number; effects: readonly SkillEffectRow[] }>;
  /** `_skillCategories` of live and Gekisou skills, matched by skill targets. */
  skillCategories: { live: ReadonlyMap<number, readonly number[]>; gekiso: ReadonlyMap<number, readonly number[]> };
  songs: ReadonlyMap<number, Song>;
  scoreRanks: ReadonlyMap<number, readonly ScoreRankRow[]>;
  challengeMusics: readonly ChallengeMusic[];
  events: ReadonlyMap<number, GameEvent>;
  liveChallengePoints: ReadonlyMap<number, number>;
  boosts: readonly BoostRow[];
  challengeBoosts: readonly BoostRow[];
}

import type { GekisouTables } from "./full/gekisou";

const num = (value: unknown, fallback = 0): number => {
  const result = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(result) ? result : fallback;
};
const ids = (value: unknown): number[] => (Array.isArray(value) ? value.map((item) => num(item)).filter((id) => id > 0) : []);
const list = (value: unknown): number[] => (Array.isArray(value) ? value.map((item) => num(item)) : []);
const stat = (row: DataRow, p: string, t: string, v: string): Stat3 => [num(row[p]), num(row[t]), num(row[v])];
const group = <K, V>(rows: readonly V[], key: (row: V) => K): Map<K, V[]> => {
  const out = new Map<K, V[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = out.get(k);
    if (bucket) bucket.push(row);
    else out.set(k, [row]);
  }
  return out;
};
const nested = <V>(rows: readonly DataRow[], outer: string, inner: string, value: (row: DataRow) => V) => {
  const out = new Map<number, Map<number, V>>();
  for (const row of rows) {
    const key = num(row[outer]);
    const bucket = out.get(key) ?? new Map<number, V>();
    bucket.set(num(row[inner]), value(row));
    out.set(key, bucket);
  }
  return out;
};
const time = (value: unknown): number | null => {
  if (Array.isArray(value)) return time(value.find((slot) => slot !== null && slot !== undefined));
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim() || value === "null") return null;
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/u.exec(value.trim());
  if (!match) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  // Master dates are server wall clock; the caller compares them with the same offset.
  return Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!, +match[4]!, +match[5]!, +(match[6] ?? 0));
};

export function skillEffect(row: DataRow): SkillEffectRow {
  return {
    id: num(row.id),
    level: num(row.level),
    triggerType: num(row.skillTriggerType),
    executeLimit: num(row.effectExecuteLimitCount),
    resetGroup: num(row.effectExecuteLimitResetConditionGroup),
    type: num(row.skillEffectType ?? row.effectType),
    value: num(row.effectValue),
    seconds: num(row.activationTimeSecond),
    conditionGroup: num(row.skillConditionGroup ?? row.conditionGroup),
    triggerGroup: num(row.skillTriggerConditionGroup ?? row.triggerConditionGroup),
    releaseGroup: num(row.skillReleaseConditionGroup ?? row.releaseConditionGroup),
    cumulativeId: num(row.skillCumulativeConditionID ?? row.cumulativeConditionId),
    targetIds: ids(row.skillTargetIDs ?? row.targetIds),
    limitCount: num(row.effectLimitCount),
    maxValue: num(row.maxEffectValue),
  };
}
function target(row: DataRow): TargetRow {
  return {
    id: num(row.id),
    bandId: num(row.bandID ?? row.bandId),
    cardType: num(row.cardType),
    characterId: num(row.characterID ?? row.characterId),
    tagId: num(row.tagID ?? row.tagId),
    liveSkillCategories: list(row.liveSkillCategories),
    gekisouSkillCategories: list(row.gekisouSkillCategories),
    gekisouMissionType: num(row.gekisouMissionType),
    liveMusicType: num(row.liveMusicType),
    judgement: num(row.judgement, -1),
    skillTargetType: num(row.skillTargetType),
  };
}
const RANKS: Record<string, number> = { None: 0, E: 1, D: 2, C: 3, B: 4, A: 5, S: 6, SS: 7 };
function comboTable(rows: readonly DataRow[]) {
  const out = new Map<number, [number, number][]>();
  for (const [type, items] of group(rows, (row) => num(row.comboBonusType))) {
    let sum = 0;
    out.set(
      type,
      [...items]
        .sort((a, b) => num(a.requiredComboCount) - num(b.requiredComboCount))
        .map((row) => [num(row.requiredComboCount), (sum = Math.fround(sum + Math.fround(num(row.bonusFactor))))]),
    );
  }
  return out;
}
const boostRows = (rows: readonly DataRow[], consumed: string): BoostRow[] =>
  rows
    .map((row) => ({
      consumed: num(row[consumed]),
      eventPointRate: num(row.eventPointRate),
      rewardRate: num(row.liveMusicRewardRate),
    }))
    .sort((a, b) => a.consumed - b.consumed);
function eventEffect(row: DataRow): EventEffectRow {
  const perRank = Array.isArray(row.perRank)
    ? [1, 2, 3, 4, 5].map((rank) => num((row.perRank as DataRow[]).find((item) => num(item.rank) === rank)?.value))
    : [1, 2, 3, 4, 5].map((rank) => num(row[`rank${rank}EffectValue`]));
  return {
    resourceType: num(row.resourceTypeConstraint),
    characterId: num(row.characterId),
    bandId: num(row.bandId),
    cardType: num(row.cardType),
    tagId: num(row.tagId),
    memberCardId: num(row.memberCardId),
    supportCardId: num(row.supportCardId),
    bonusType: num(row.eventBonusType),
    perRank,
  };
}
const reward = (row: DataRow): RewardRow => ({
  scoreRank: num(row.scoreRank),
  group: num(row.group),
  resourceType: num(row.resourceType),
  resourceId: num(row.resourceId),
  count: num(row.resourceCount),
  probability: num(row.probability, 10000),
});

/** Inputs shared by both front-ends, with native field names (no leading underscore). */
interface Tables {
  server: string;
  releaseId: string;
  parameters: DataRow[];
  liveSettings: DataRow[];
  noteParameters: DataRow[];
  judgementParameters: DataRow[];
  judgementTimings: DataRow[];
  effectSettings: DataRow[];
  gekisoRanking: DataRow[];
  gekisoLuckBase: DataRow[];
  gekisoLuckLots: DataRow[];
  comboScoreBonuses: DataRow[];
  characters: DataRow[];
  members: MemberCard[];
  snaps: SnapCard[];
  memberLevels: DataRow[];
  memberAwake: DataRow[];
  memberRanks: DataRow[];
  memberLevelLimits: DataRow[];
  snapLevels: DataRow[];
  snapRanks: DataRow[];
  characterRanks: DataRow[];
  totalRanks: DataRow[];
  vipBonuses: DataRow[];
  bandItems: { id: number; bandId: number; effects: DataRow[] }[];
  targets: DataRow[];
  conditions: DataRow[];
  conditionSets: DataRow[];
  cumulative: DataRow[];
  leader: [number, DataRow[]][];
  live: [number, DataRow[]][];
  support: [number, DataRow[]][];
  gekiso: [number, number, DataRow[]][];
  gekisoSupport: [number, number, DataRow[]][];
  skillCategories: { live: [number, number[]][]; gekiso: [number, number[]][] };
  songs: Song[];
  scoreRanks: DataRow[];
  challengeMusics: DataRow[];
  events: GameEvent[];
  liveChallengePoints: DataRow[];
  boosts: DataRow[];
  challengeBoosts: DataRow[];
}

function compile(tables: Tables): EngineMaster {
  const parameter = (key: string) => tables.parameters.find((row) => row.id === key)?.value;
  const setting = (key: string, fallback: number) => num(tables.liveSettings.find((row) => row.key === key)?.value, fallback);
  const judge = new Map<number, number>();
  const damage = [0, 0, 0, 0, 0, 0, 0];
  // NoteSimulateJudgement 1 Miss … 6 Just (8 Excellent is not a score type) → score type 6 Miss … 1 Just.
  for (const row of tables.judgementParameters) {
    const simulate = num(row.noteSimulateJudgement, -1);
    if (simulate >= 1 && simulate <= 6) {
      judge.set(7 - simulate, num(row.scorePercent));
      damage[simulate] = num(row.damage);
    }
  }
  const skillMap = (rows: [number, DataRow[]][]) => new Map(rows.map(([id, effects]) => [id, effects.map(skillEffect)]));
  const characters = new Map(
    tables.characters.map((row) => [num(row.characterId ?? row.id), { id: num(row.characterId ?? row.id), bandId: num(row.bandId ?? row.bandID) }]),
  );
  const conditionSets = new Map<number, number[][]>();
  for (const row of tables.conditionSets) {
    const key = num(row.group);
    conditionSets.set(key, [...(conditionSets.get(key) ?? []), ids(row.conditionIds)]);
  }
  const scoreRanks = new Map<number, ScoreRankRow[]>();
  for (const [key, rows] of group(tables.scoreRanks, (row) => num(row.group)))
    scoreRanks.set(
      key,
      rows
        .map((row) => ({ rank: num(row.liveScoreRank), required: num(row.requiredScore), battleRequired: num(row.battleLiveRequiredScore) }))
        .sort((a, b) => a.required - b.required),
    );
  const levelLimits = new Map<string, number>();
  for (const row of tables.memberLevelLimits) levelLimits.set(`${num(row.rarity)}:${num(row.awakeCount)}`, num(row.limitLevel));
  return {
    server: tables.server,
    releaseId: tables.releaseId,
    params: {
      musicTypeBase: num(parameter("music_type_base_bonus_rate"), 500),
      musicTagBase: num(parameter("music_tag_base_bonus_rate"), 500),
      typeLinkBase: num(parameter("type_link_base_bonus_rate"), 500),
      skipRank: RANKS[String(parameter("live_skip_result_score_rank") ?? "C").trim()] ?? 3,
    },
    live: {
      adjustment: Math.fround(setting("note_score_adjustment_factor", 3)),
      lifeOnus: Math.fround(setting("note_score_life_onus_factor", 0.3)),
      lifeBase: setting("life_base", 1000),
      notePercent: new Map(tables.noteParameters.map((row) => [num(row.noteOperateType), num(row.scorePercent)])),
      judgePercent: judge,
      combo: comboTable(tables.comboScoreBonuses),
      assistPercent: setting("assist_score_percent", 90),
      damage,
      settings: new Map(tables.liveSettings.map((row) => [String(row.key), String(row.value)])),
      justTypes: new Set(tables.judgementTimings.filter((row) => num(row.noteSimulateJudgement) === 6).map((row) => num(row.noteJudgementType))),
      timingTypes: new Set(tables.judgementTimings.map((row) => num(row.noteJudgementType))),
      afterMs: Math.max(0, ...tables.judgementTimings.map((row) => num(row.afterMs ?? row.after))),
      phases: new Map(tables.effectSettings.map((row) => [num(row.skillEffectType), num(row.phase, 1)])),
      gekiso: {
        luckBasePoints: tables.gekisoLuckBase.map((row) => ({
          category: num(row.noteCategory),
          judgement: num(row.noteSimulateJudgement),
          weight: num(row.weight),
          point: num(row.basePoint),
        })),
        luckBonusLots: tables.gekisoLuckLots.map((row) => ({ lotType: num(row.chanceLotType), result: num(row.lotResult), weight: num(row.weight) })),
        rankingBonuses: tables.gekisoRanking.map((row) => ({
          pattern: num(row.missionPattern),
          count: num(row.count),
          rank: num(row.rank),
          percent: num(row.scoreBonusPercent),
        })),
        gaugeMax: setting("gekisou_luck_gauge_max", 100),
        gaugeMaxRush: setting("gekisou_luck_gauge_max_rush", 50),
        rushPercent: setting("gekisou_luck_rush_score_bonus_percent", 0),
      },
    },
    characters,
    members: new Map(tables.members.map((card) => [card.id, card])),
    snaps: new Map(tables.snaps.map((card) => [card.id, card])),
    memberLevels: nested(tables.memberLevels, "group", "level", (row) => stat(row, "performanceRate", "technicRate", "visualRate")),
    memberAwake: nested(tables.memberAwake, "group", "awakeCount", (row) => stat(row, "performanceRate", "technicRate", "visualRate")),
    memberRanks: nested(tables.memberRanks, "group", "rank", (row) => ({
      rates: stat(row, "performanceRate", "technicRate", "visualRate"),
      leaderSkillLevel: num(row.leaderSkillLevel, 1),
      musicTypeRate: num(row.musicTypeBonusRate),
      musicTagRate: num(row.musicTagBonusRate),
    })),
    memberLevelLimits: levelLimits,
    snapLevels: nested(tables.snapLevels, "group", "level", (row) => stat(row, "performanceRate", "technicRate", "visualRate")),
    snapRanks: nested(tables.snapRanks, "group", "rank", (row) => ({
      typeLinkRate: num(row.cardTypeLinkBonusRate),
      limitLevel: num(row.limitLevel),
      skillLevels: [num(row.supportSkill01Level), num(row.supportSkill02Level)] as const,
      gekisoSkillLevels: [num(row.gekisouSupportSkill01Level), num(row.gekisouSupportSkill02Level)] as const,
    })),
    characterRankBonus: tables.characterRanks.map((row) => [num(row.rank), num(row.bonus)] as const).sort((a, b) => a[0] - b[0]),
    totalRankBonus: tables.totalRanks.map((row) => [num(row.totalRank), num(row.bonus)] as const).sort((a, b) => a[0] - b[0]),
    maxCharacterRank: Math.max(1, ...tables.characterRanks.map((row) => num(row.rank))),
    vipBonus: new Map(tables.vipBonuses.filter((row) => num(row.vipBonusType) === 7).map((row) => [num(row.vipRank), num(row.value)])),
    bandItems: new Map(
      tables.bandItems.map((item) => [
        item.id,
        { bandId: item.bandId, levels: new Map([...group(item.effects.map(skillEffect), (row) => row.level)]) },
      ]),
    ),
    targets: new Map(tables.targets.map((row) => [num(row.id), target(row)])),
    conditions: new Map(
      tables.conditions.map((row) => [
        num(row.id),
        { id: num(row.id), type: num(row.conditionType), targetIds: ids(row.conditionTargetIDs), values: list(row.conditionValues), positive: row.isPositive !== false },
      ]),
    ),
    conditionSets,
    cumulative: new Map(
      tables.cumulative.map((row) => [
        num(row.id),
        {
          id: num(row.id),
          type: num(row.skillCumulativeConditionType ?? row.conditionType),
          targetIds: ids(row.conditionTargetIDs),
          values: list(row.conditionValues),
          cap: num(row.maxCumulativeCount),
        },
      ]),
    ),
    leaderSkills: skillMap(tables.leader),
    liveSkills: skillMap(tables.live),
    supportSkills: skillMap(tables.support),
    gekisoSkills: new Map(tables.gekiso.map(([id, mission, rows]) => [id, { missionType: mission, effects: rows.map(skillEffect) }])),
    gekisoSupportSkills: new Map(
      tables.gekisoSupport.map(([id, mission, rows]) => [id, { missionType: mission, effects: rows.map(skillEffect) }]),
    ),
    skillCategories: { live: new Map(tables.skillCategories.live), gekiso: new Map(tables.skillCategories.gekiso) },
    songs: new Map(tables.songs.map((song) => [song.id, song])),
    scoreRanks,
    challengeMusics: tables.challengeMusics.map((row) => ({
      id: num(row.id),
      eventId: num(row.eventId),
      liveMusicId: num(row.liveMusicId),
      musicType: num(row.musicType),
    })),
    events: new Map(tables.events.map((event) => [event.id, event])),
    liveChallengePoints: new Map(tables.liveChallengePoints.map((row) => [num(row.scoreRank), num(row.value)])),
    boosts: boostRows(tables.boosts, "consumedLiveBoostCount"),
    challengeBoosts: boostRows(tables.challengeBoosts, "consumedChallengePointCount"),
  };
}

const rowsOf = (value: unknown): DataRow[] => dataRows(value).map(nativeRow);
const skillRows = (record: unknown): [number, DataRow[]][] =>
  Object.entries(objectRow(record)).map(([id, skill]) => [Number(id), rowsOf(objectRow(skill).effects)]);
const categoryRows = (record: unknown): [number, number[]][] =>
  Object.entries(objectRow(record)).map(([id, skill]) => [Number(id), list(objectRow(skill).categories)]);
const gekisoRows = (record: unknown): [number, number, DataRow[]][] =>
  Object.entries(objectRow(record)).map(([id, skill]) => [
    Number(id),
    num(objectRow(skill).gekisouMissionType),
    rowsOf(objectRow(skill).effects),
  ]);
function dtoSongs(data: TeamBuilderData): Song[] {
  return Object.values(data.songs).map((row) => ({
    id: num(row.musicId),
    musicType: num(row.musicType),
    bestTags: ids(row.bestMusicTagIds),
    bandIds: ids(row.bandIds ?? (row.bandId ? [row.bandId] : [])),
    rankGroup: num(row.liveScoreRankGroup),
    difficulties: dataRows(row.difficulty).map((level) => ({
      difficulty: num(level.difficulty),
      scoreId: num(level.scoreId),
      playLevel: num(level.playLevel),
      displayLevel: num(level.displayLevel ?? level.playLevel),
      noteCount: num(level.noteCount),
      file: String(level.file ?? ""),
    })),
    gekisoMissions: list(objectRow(row.gekisou).missionTypes),
  }));
}
function dtoEvents(data: TeamBuilderData): GameEvent[] {
  const shared = objectRow(data.eventRules);
  return Object.values(data.events).map((event) => {
    const id = num(event.id);
    const tables = objectRow(event.tables);
    const table = (name: string) => {
      const own = rowsOf(tables[name]);
      return Object.hasOwn(tables, name) ? own : rowsOf(shared[name]).filter((row) => !row.eventId || num(row.eventId) === id);
    };
    const groups = objectRow(event.groups);
    const points = (name: string, groupKey: string) => {
      const groupId = num(groups[groupKey] ?? event[groupKey]);
      return new Map(
        table(name)
          .filter((row) => !groupId || !row.group || num(row.group) === groupId)
          .map((row) => [num(row.scoreRank), num(row.value)]),
      );
    };
    const effects = Array.isArray(event.effects) ? rowsOf(event.effects) : table("MasterEventEffect");
    return {
      id,
      startAt: time(event.startAt),
      endAt: time(event.endAt),
      itemId: num(objectRow(event.eventItem).id ?? event.eventItemId),
      musicId: num(event.musicId),
      effects: effects.map(eventEffect),
      livePoints: points("MasterLiveEventPoint", "liveEventPointGroup"),
      challengePoints: points("MasterChallengeLiveEventPoint", "challengeLiveEventPointGroup"),
      liveRewards: table("MasterLiveEventReward").map(reward),
      challengeRewards: table("MasterChallengeLiveEventReward").map(reward),
    };
  });
}

/** Production DTO front-end. */
export function compileFromTeamData(data: TeamBuilderData): EngineMaster {
  const runtime = data.runtimeRules?.tables;
  const liveTools = objectRow(data.liveTools);
  const progression = data.progression;
  const reference = objectRow(data.skillReference);
  return compile({
    server: data.identity.server,
    releaseId: data.identity.releaseId,
    parameters: runtime?.parameters.rows ?? [],
    liveSettings: rowsOf(liveTools.liveSettings),
    noteParameters: rowsOf(liveTools.noteParameters),
    judgementParameters: rowsOf(liveTools.judgementParameters),
    judgementTimings: rowsOf(liveTools.judgementTiming),
    effectSettings: rowsOf(reference.effectSettings),
    gekisoRanking: rowsOf(liveTools.gekisouRankingScoreBonuses),
    gekisoLuckBase: rowsOf(liveTools.gekisouLuckBasePoints),
    gekisoLuckLots: rowsOf(liveTools.gekisouLuckBonusLots),
    comboScoreBonuses: rowsOf(liveTools.comboScoreBonuses),
    characters: Object.values(data.characters),
    members: Object.values(data.members).map((card) => ({
      levelLimits: card.levelLimits,
      id: card.id,
      characterId: card.characterId,
      bandId: card.bandId,
      rarity: card.rarity,
      cardType: card.attribute,
      bestTags: card.bestMusicTagIds ?? [],
      statMax: [card.statMax.performance, card.statMax.technique, card.statMax.visual],
      levelGroup: card.levelGroup,
      awakeGroup: card.trainingGroup,
      rankGroup: card.awakeningGroup,
      liveSkillId: card.liveSkillId,
      gekisoSkillId: card.gekisoSkillId,
      leaderSkillId: card.leaderSkillId,
      releasedAt: null,
    })),
    snaps: Object.values(data.snapshots).map((card) => ({
      id: card.id,
      characterIds: card.characterIds,
      bandIds: [...new Set(card.characterIds.map((id) => num(data.characters[String(id)]?.bandId)).filter(Boolean))],
      rarity: card.rarity,
      cardType: card.attribute,
      statMax: [card.statMax.performance, card.statMax.technique, card.statMax.visual],
      levelGroup: card.levelGroup,
      rankGroup: card.awakeningGroup,
      supportSkillIds: [card.supportSkillIds[0] ?? 0, card.supportSkillIds[1] ?? 0],
      gekisoSupportSkillIds: [card.gekisoSupportSkillIds[0] ?? 0, card.gekisoSupportSkillIds[1] ?? 0],
    })),
    memberLevels: progression.memberCardLevels ?? [],
    memberAwake: progression.memberCardAwake ?? [],
    memberRanks: progression.memberCardRanks ?? [],
    memberLevelLimits: progression.memberCardLevelLimits ?? [],
    snapLevels: progression.supportCardLevels ?? [],
    snapRanks: progression.supportCardRanks ?? [],
    characterRanks: progression.characterRanks ?? [],
    totalRanks: progression.characterTotalRanks ?? [],
    vipBonuses: runtime?.vipRankBonuses.rows ?? [],
    bandItems: Object.values(data.bandItems).map((item) => ({
      id: num(item.bandItemId),
      bandId: num(item.bandId),
      effects: rowsOf(item.effects),
    })),
    targets: rowsOf(reference.targets),
    conditions: rowsOf(reference.conditions),
    conditionSets: rowsOf(reference.conditionSets),
    cumulative: rowsOf(reference.cumulativeConditions),
    leader: skillRows(data.skills.leader),
    live: skillRows(data.skills.live),
    support: skillRows(data.skills.support),
    gekiso: gekisoRows(data.skills.gekiso),
    gekisoSupport: gekisoRows(data.skills.gekisoSupport),
    skillCategories: { live: categoryRows(data.skills.live), gekiso: categoryRows(data.skills.gekiso) },
    songs: dtoSongs(data),
    scoreRanks: rowsOf(liveTools.scoreRanks),
    challengeMusics: data.crossServer?.challengeMusics ?? data.challengeMusicTable?.rows ?? [],
    events: dtoEvents(data),
    liveChallengePoints: data.challengePointTable?.rows ?? [],
    boosts: rowsOf(liveTools.liveBoostBonuses),
    challengeBoosts: rowsOf(liveTools.challengeBoostBonuses),
  });
}

/** Raw Master front-end: `read(name)` returns the table's `_allData` rows or null. */
export function compileFromMasterTables(
  identity: { server: string; releaseId: string },
  read: (table: string) => readonly Record<string, unknown>[] | null,
  options: { songFile?: (scoreId: number, fileName: string) => string } = {},
): EngineMaster {
  const rows = (table: string) => (read(table) ?? []).map((row) => nativeRow({ raw: row }));
  const characters = rows("MasterCharacter");
  const bandOf = new Map(characters.map((row) => [num(row.id), num(row.bandID ?? row.bandId)]));
  const skills = (table: string, effects: string, key: string) => {
    const grouped = group(rows(effects), (row) => num(row[key]));
    return rows(table).map((row) => [num(row.id), grouped.get(num(row.id)) ?? []] as [number, DataRow[]]);
  };
  const gekisoSkills = (table: string, effects: string, key: string) => {
    const grouped = group(rows(effects), (row) => num(row[key]));
    return rows(table).map(
      (row) => [num(row.id), num(row.gekisouMissionType), grouped.get(num(row.id)) ?? []] as [number, number, DataRow[]],
    );
  };
  const scores = new Map(rows("MasterLiveMusicScore").map((row) => [num(row.id), row]));
  const songs: Song[] = rows("MasterLiveMusic").map((row) => ({
    id: num(row.id),
    musicType: num(row.musicType),
    bestTags: ids(row.bestMusicTagIDs ?? row.bestMusicTagIds),
    bandIds: ids(row.bandIDs ?? row.bandIds),
    rankGroup: num(row.liveScoreRankGroup),
    difficulties: ["easy", "normal", "hard", "expert", "special"].flatMap((name, difficulty) => {
      const score = scores.get(num(row[`${name}ID`]));
      return score
        ? [
            {
              difficulty,
              scoreId: num(score.id),
              playLevel: num(score.musicScoreLevel),
              displayLevel: num(score.musicScoreDisplayLevel ?? score.musicScoreLevel),
              noteCount: num(score.fullComboCount),
              file: options.songFile?.(num(score.id), String(score.musicScoreTextFileName ?? "")) ?? "",
            },
          ]
        : [];
    }),
    gekisoMissions: [1, 2, 3].map((index) => num(row[`gekisouMission${index}`])),
  }));
  const events: GameEvent[] = rows("MasterEvent").map((event) => {
    const id = num(event.id);
    const by = (table: string, groupKey: string, field: string) =>
      rows(table).filter((row) => num(row[field]) === num(event[groupKey]));
    return {
      id,
      startAt: time(event.startAt),
      endAt: time(event.endAt),
      itemId: num(event.eventItemId),
      musicId: num(event.musicId),
      effects: rows("MasterEventEffect").filter((row) => num(row.eventId) === id).map(eventEffect),
      livePoints: new Map(by("MasterLiveEventPoint", "liveEventPointGroup", "group").map((row) => [num(row.scoreRank), num(row.value)])),
      challengePoints: new Map(
        by("MasterChallengeLiveEventPoint", "challengeLiveEventPointGroup", "group").map((row) => [num(row.scoreRank), num(row.value)]),
      ),
      liveRewards: by("MasterLiveEventReward", "liveEventRewardGroup", "eventGroup").map(reward),
      challengeRewards: by("MasterChallengeLiveEventReward", "challengeLiveEventRewardGroup", "eventGroup").map(reward),
    };
  });
  return compile({
    ...identity,
    parameters: rows("MasterParameter"),
    liveSettings: rows("MasterLiveSettings"),
    noteParameters: rows("MasterLiveNoteParameter"),
    judgementParameters: rows("MasterLiveJudgementParameter"),
    judgementTimings: rows("MasterLiveJudgementTiming"),
    effectSettings: rows("MasterSkillEffectSetting"),
    gekisoRanking: rows("MasterLiveGekisouRankingScoreBonus"),
    gekisoLuckBase: rows("MasterLiveGekisouLuckBasePoint"),
    gekisoLuckLots: rows("MasterLiveGekisouLuckBonusLot"),
    comboScoreBonuses: rows("MasterLiveComboScoreBonus"),
    characters: characters.map((row) => ({ characterId: row.id, bandId: row.bandID ?? row.bandId })),
    members: rows("MasterMemberCard").map((row) => ({
      id: num(row.id),
      characterId: num(row.characterID ?? row.characterId),
      bandId: bandOf.get(num(row.characterID ?? row.characterId)) ?? 0,
      rarity: num(row.rarity),
      cardType: num(row.cardType),
      bestTags: ids(row.bestMusicTagIDs ?? row.bestMusicTagIds),
      statMax: stat(row, "performancePowerMax", "technicPowerMax", "visualPowerMax"),
      levelGroup: num(row.memberCardLevelGroup),
      awakeGroup: num(row.memberCardAwakeGroup),
      rankGroup: num(row.memberCardRankGroup),
      liveSkillId: num(row.liveSkillID ?? row.liveSkillId),
      gekisoSkillId: num(row.gekisouSkillID ?? row.gekisouSkillId),
      leaderSkillId: num(row.leaderSkillID ?? row.leaderSkillId),
      releasedAt: time(row.releasedAt),
    })),
    snaps: rows("MasterSupportCard").map((row) => {
      const characterIds = ids(row.characterIDs ?? row.characterIds);
      return {
        id: num(row.id),
        characterIds,
        bandIds: [...new Set(characterIds.map((id) => bandOf.get(id) ?? 0).filter(Boolean))],
        rarity: num(row.rarity),
        cardType: num(row.cardType),
        statMax: stat(row, "performancePowerMax", "technicPowerMax", "visualPowerMax"),
        levelGroup: num(row.supportCardLevelGroup),
        rankGroup: num(row.supportCardRankGroup),
        supportSkillIds: [num(row.supportSkillId01), num(row.supportSkillId02)] as const,
        gekisoSupportSkillIds: [num(row.gekisouSupportSkillId01), num(row.gekisouSupportSkillId02)] as const,
      };
    }),
    memberLevels: rows("MasterMemberCardLevel"),
    memberAwake: rows("MasterMemberCardAwake"),
    memberRanks: rows("MasterMemberCardRank"),
    memberLevelLimits: rows("MasterMemberCardLevelLimit"),
    snapLevels: rows("MasterSupportCardLevel"),
    snapRanks: rows("MasterSupportCardRank"),
    characterRanks: rows("MasterCharacterRank"),
    totalRanks: rows("MasterCharacterTotalRank"),
    vipBonuses: rows("MasterVipRankBonus"),
    bandItems: (() => {
      const effects = group(rows("MasterBandItemSkillEffect"), (row) => num(row.bandItemId));
      return rows("MasterBandItem").map((row) => ({ id: num(row.id), bandId: num(row.bandId), effects: effects.get(num(row.id)) ?? [] }));
    })(),
    targets: rows("MasterSkillTarget"),
    conditions: rows("MasterSkillCondition"),
    conditionSets: rows("MasterSkillConditionSet"),
    cumulative: rows("MasterSkillCumulativeCondition"),
    leader: skills("MasterLeaderSkill", "MasterLeaderSkillEffect", "leaderSkillID"),
    live: skills("MasterLiveSkill", "MasterLiveSkillEffect", "liveSkillID"),
    support: skills("MasterSupportSkill", "MasterSupportSkillEffect", "supportSkillID"),
    gekiso: gekisoSkills("MasterGekisouSkill", "MasterGekisouSkillEffect", "gekisouSkillID"),
    gekisoSupport: gekisoSkills("MasterGekisouSupportSkill", "MasterGekisouSupportSkillEffect", "gekisouSupportSkillID"),
    skillCategories: {
      live: rows("MasterLiveSkill").map((row) => [num(row.id), list(row.skillCategories)]),
      gekiso: rows("MasterGekisouSkill").map((row) => [num(row.id), list(row.skillCategories)]),
    },
    songs,
    scoreRanks: rows("MasterLiveScoreRank"),
    challengeMusics: rows("MasterChallengeMusic"),
    events,
    liveChallengePoints: rows("MasterLiveChallengePoint"),
    boosts: rows("MasterLiveMusicBoostBonus"),
    challengeBoosts: rows("MasterChallengeMusicBoostBonus"),
  });
}
