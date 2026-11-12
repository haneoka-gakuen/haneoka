// L3 — GEB
// Input: Immutable public team data and local, versioned card/event definitions.
// Output: An isolated calculation catalogue with hypothetical cards, skills and events.
// Pos: [Map](L2-2.md); local planning data projection.
// Effects/Dependencies: Clones edited records; official source data and storage remain unchanged.
import { dataRows, nativeRow, objectRow, type DataRow, type TeamBuilderData } from "./data";
import type { EngineMaster, EventEffectRow, RewardRow, BoostRow, ScoreRankRow } from "./engine/master";
import type { PowerStats } from "./model";
import type { MemberInput, SnapInput } from "./engine/box";
import type { BoxEntry } from "./sync/box-doc";
import { contentPublished } from "../content-publication";

export const PLANNER_ID_START = 1_000_000_000;
export const PLANNER_MAX_SKILL_SECONDS = 1_000_000;
export type PlannerSkillFamily = "leader" | "live" | "gekiso" | "support" | "gekisoSupport";
export interface PlannerSkill {
  family: PlannerSkillFamily;
  templateId: number;
  name: string;
  effects: Record<string, { value?: number; seconds?: number; maximum?: number }>;
  description?: unknown;
  origin?: { kind: "members" | "snaps"; cardId: number; slot: number };
}
export interface PlannerCard {
  id: number;
  kind: "members" | "snaps";
  name: string;
  templateId: number;
  materialTemplateId: number;
  characterIds: number[];
  attribute: number;
  rarity: number;
  stats: PowerStats;
  skills: PlannerSkill[];
  growth: Partial<MemberInput & SnapInput>;
  active: boolean;
}
export interface PlannerEventRules {
  normalSongs: number[];
  liveChallengePoints: { rank: number; value: number }[];
  boosts: BoostRow[];
  challengeBoosts: BoostRow[];
  normalRanks: ScoreRankRow[];
  challengeRanks: ScoreRankRow[];
}
export interface PlannerEvent {
  id: number;
  name: string;
  startAt: number | null;
  endAt: number | null;
  eventType: number;
  itemId: number;
  challenges: { songId: number; attribute: number }[];
  effects: EventEffectRow[];
  livePoints: { rank: number; value: number }[];
  challengePoints: { rank: number; value: number }[];
  liveRewards: RewardRow[];
  challengeRewards: RewardRow[];
  rules: PlannerEventRules;
  active: boolean;
}
export interface PlannerDocument {
  schema: "haneoka-planner-v1";
  cards: PlannerCard[];
  events: PlannerEvent[];
  entries: Record<string, BoxEntry>;
}
export const emptyPlanner = (): PlannerDocument => ({
  schema: "haneoka-planner-v1",
  cards: [],
  events: [],
  entries: {},
});
export function nextPlannerId(document: PlannerDocument) {
  return (
    Math.max(
      PLANNER_ID_START - 1000,
      ...document.cards.map((card) => card.id),
      ...document.events.map((event) => event.id),
    ) + 1000
  );
}
export const plannerMetadata = (card: { catalogMetadata?: DataRow }) => objectRow(card.catalogMetadata?.planner);
export const plannerEffectKey = (_row: DataRow, index: number) => String(index);
const skillOrigins = new WeakMap<TeamBuilderData, Map<string, NonNullable<PlannerSkill["origin"]>>>();
export function plannerSkillOrigin(data: TeamBuilderData, family: PlannerSkillFamily, id: number) {
  let origins = skillOrigins.get(data);
  if (!origins) {
    origins = new Map();
    for (const card of Object.values(data.members))
      for (const [family, id] of [
        ["leader", card.leaderSkillId],
        ["live", card.liveSkillId],
        ["gekiso", card.gekisoSkillId],
      ] as const)
        if (
          id &&
          (!origins.has(`${family}:${id}`) ||
            (contentPublished(card) && !contentPublished(data.members[String(origins.get(`${family}:${id}`)!.cardId)])))
        )
          origins.set(`${family}:${id}`, { kind: "members", cardId: card.id, slot: 0 });
    for (const card of Object.values(data.snapshots))
      for (const [family, ids] of [
        ["support", card.supportSkillIds],
        ["gekisoSupport", card.gekisoSupportSkillIds],
      ] as const)
        ids.forEach((id, slot) => {
          if (
            id &&
            (!origins!.has(`${family}:${id}`) ||
              (contentPublished(card) &&
                !contentPublished(data.snapshots[String(origins!.get(`${family}:${id}`)!.cardId)])))
          )
            origins!.set(`${family}:${id}`, { kind: "snaps", cardId: card.id, slot });
        });
    skillOrigins.set(data, origins);
  }
  return origins.get(`${family}:${id}`);
}
export function plannerSkillId(data: TeamBuilderData, skill: PlannerSkill): number {
  if (!skill.origin || !skill.templateId) return skill.templateId;
  const { kind, cardId, slot } = skill.origin;
  if (kind === "members") {
    const card = data.members[String(cardId)];
    return (
      (skill.family === "leader"
        ? card?.leaderSkillId
        : skill.family === "live"
          ? card?.liveSkillId
          : card?.gekisoSkillId) ?? skill.templateId
    );
  }
  const card = data.snapshots[String(cardId)];
  return (skill.family === "support" ? card?.supportSkillIds : card?.gekisoSupportSkillIds)?.[slot] ?? skill.templateId;
}
const skillDescriptions = new WeakMap<TeamBuilderData, Map<string, DataRow>>();
export function plannerSkillTemplate(
  data: TeamBuilderData,
  family: PlannerSkillFamily,
  id: number,
): DataRow | undefined {
  let indexed = skillDescriptions.get(data);
  if (!indexed) {
    indexed = new Map();
    for (const card of [...Object.values(data.members), ...Object.values(data.snapshots)])
      for (const [role, values] of Object.entries(objectRow(card.catalogMetadata?.resolvedSkills)))
        for (const row of dataRows(Array.isArray(values) ? values : [values]))
          indexed.set(`${role.replace("gekisou", "gekiso")}:${row.id}`, row);
    skillDescriptions.set(data, indexed);
  }
  const template = data.skills[family]?.[String(id)];
  return template ? { ...indexed.get(`${family}:${id}`), ...template } : undefined;
}

export function plannerSkillRecord(data: TeamBuilderData, draft: PlannerSkill, id: number): DataRow | null {
  if (!draft.templateId) return null;
  const template = plannerSkillTemplate(data, draft.family, plannerSkillId(data, draft));
  if (!template) throw new Error("planner-skill-template");
  const effects = dataRows(template.effects).map((original, index) => {
    const row = { ...original };
    const change = draft.effects[plannerEffectKey(row, index)];
    if (change?.value !== undefined) row.effectValue = change.value;
    if (change?.seconds !== undefined) row.activationTimeSecond = change.seconds;
    if (change?.maximum !== undefined) row.maxEffectValue = change.maximum;
    delete row.raw;
    return row;
  });
  return {
    ...template,
    id,
    skillName: draft.name || template.skillName,
    description: draft.description ?? template.description,
    effects,
  };
}

/** Each edited definition gets a new ID, so frozen results can retain older versions. */
export function projectPlannerData(
  base: TeamBuilderData,
  document: PlannerDocument,
  face: (id: number) => string = () => "",
): TeamBuilderData {
  if (!document.cards.length && !document.events.length) return base;
  const data: TeamBuilderData = {
    ...base,
    members: { ...base.members },
    snapshots: { ...base.snapshots },
    events: { ...base.events },
    progression: {
      ...base.progression,
      memberCardRanks: [...base.progression.memberCardRanks!],
      supportCardRanks: [...base.progression.supportCardRanks!],
    },
    skills: Object.fromEntries(Object.entries(base.skills).map(([family, entries]) => [family, { ...entries }])),
    challengeMusicTable: base.challengeMusicTable
      ? { ...base.challengeMusicTable, rows: [...base.challengeMusicTable.rows] }
      : {
          identity: { ...base.identity, sourceId: base.identity.sourceId! },
          sourceTable: "MasterChallengeMusic",
          status: "empty",
          rows: [],
          gaps: [],
        },
  };
  for (const draft of document.cards) {
    const kind = draft.kind === "members" ? "members" : "snapshots";
    const template = base[kind][String(draft.templateId)];
    const material = base[kind][String(draft.materialTemplateId)];
    if (!template || !material) throw new Error("planner-card-template");
    const metadata: DataRow = {
      prefix: draft.name,
      cardName: draft.name,
      planner: { templateId: draft.templateId, materialTemplateId: draft.materialTemplateId, active: draft.active },
      releasedAt: [0, null, null, null, null],
    };
    const character = draft.characterIds[0]!;
    const exemplar = Object.values(base.members).find((row) => row.characterId === character);
    const image =
      draft.kind === "snaps" || ("characterId" in template && template.characterId === character)
        ? template.image
        : face(character);
    let slot = 0;
    const skills = draft.skills.map((skill) => {
      const id = draft.id + slot++;
      const row = plannerSkillRecord(data, skill, id);
      if (row) data.skills[skill.family]![String(id)] = row;
      return row ? id : 0;
    });
    const maximum = (slot: number) => {
      const family = draft.skills[slot]!.family,
        id = skills[slot]!;
      return Math.max(0, ...dataRows(data.skills[family]?.[String(id)]?.effects).map((row) => Number(row.level)));
    };
    if (draft.kind === "members") {
      const original = base.members[String(draft.templateId)]!,
        costs = base.members[String(draft.materialTemplateId)]!;
      const { levelLimits: _levelLimits, ...member } = original;
      const rankGroup = draft.id + 100;
      data.progression.memberCardRanks!.push(
        ...base.progression
          .memberCardRanks!.map(nativeRow)
          .filter((row) => Number(row.group) === costs.awakeningGroup)
          .map((row) => ({
            ...row,
            group: rankGroup,
            leaderSkillLevel: Math.min(Number(row.leaderSkillLevel), maximum(0)),
          })),
      );
      data.members[String(draft.id)] = {
        ...member,
        id: draft.id,
        name: draft.name,
        image,
        characterId: character,
        bandId: exemplar?.bandId ?? original.bandId,
        bestMusicTagIds: exemplar?.bestMusicTagIds ?? original.bestMusicTagIds,
        rarity: draft.rarity,
        attribute: draft.attribute,
        musicType: draft.attribute,
        statMax: { ...draft.stats },
        catalogMetadata: metadata,
        leaderSkillId: skills[0] ?? 0,
        liveSkillId: skills[1] ?? 0,
        gekisoSkillId: skills[2] ?? 0,
        levelGroup: costs.levelGroup,
        trainingGroup: costs.trainingGroup,
        awakeningGroup: rankGroup,
        ...(costs.levelLimits ? { levelLimits: costs.levelLimits } : {}),
        trainingResourceGroup: costs.trainingResourceGroup,
        liveResourceGroup: costs.liveResourceGroup,
        gekisoResourceGroup: costs.gekisoResourceGroup,
        rankUpItemId: exemplar?.rankUpItemId ?? costs.rankUpItemId,
      };
    } else {
      const original = base.snapshots[String(draft.templateId)]!;
      const costs = base.snapshots[String(draft.materialTemplateId)]!;
      const rankGroup = draft.id + 100;
      data.progression.supportCardRanks!.push(
        ...base.progression
          .supportCardRanks!.map(nativeRow)
          .filter((row) => Number(row.group) === costs.awakeningGroup)
          .map((row) => ({
            ...row,
            group: rankGroup,
            ...Object.fromEntries(
              [
                "supportSkill01Level",
                "supportSkill02Level",
                "gekisouSupportSkill01Level",
                "gekisouSupportSkill02Level",
              ].map((key, slot) => [key, Math.min(Number(row[key]), maximum(slot))]),
            ),
          })),
      );
      data.snapshots[String(draft.id)] = {
        ...original,
        id: draft.id,
        name: draft.name,
        image,
        characterIds: [...draft.characterIds],
        rarity: draft.rarity,
        attribute: draft.attribute,
        statMax: { ...draft.stats },
        catalogMetadata: metadata,
        levelGroup: costs.levelGroup,
        awakeningGroup: rankGroup,
        supportSkillIds: skills.slice(0, 2),
        gekisoSupportSkillIds: skills.slice(2, 4),
      };
    }
  }
  for (const draft of document.events) {
    const item =
      Object.values(base.events)
        .map((event) => objectRow(event.eventItem))
        .find((item) => draft.itemId > 0 && Number(item.resourceId ?? item.id) === draft.itemId) ?? {};
    data.events[String(draft.id)] = {
      id: draft.id,
      kind: "planner-event",
      title: draft.name,
      image: "",
      startAt: draft.startAt,
      endAt: draft.endAt,
      eventType: draft.eventType,
      musicId: draft.challenges[0]?.songId ?? 0,
      eventItem: {
        ...item,
        resourceType: 1,
        resourceId: draft.itemId || draft.id,
        name: item.name ?? draft.name,
        image: item.image ?? "",
      },
      effects: draft.effects.map((row, index) => ({
        id: index + 1,
        eventId: draft.id,
        resourceTypeConstraint: row.resourceType,
        characterId: row.characterId,
        bandId: row.bandId,
        cardType: row.cardType,
        tagId: row.tagId,
        memberCardId: row.memberCardId,
        supportCardId: row.supportCardId,
        eventBonusType: row.bonusType,
        perRank: row.perRank.map((value, index) => ({ rank: index + 1, value })),
      })),
      tables: {
        MasterLiveEventPoint: draft.livePoints.map((row) => ({ scoreRank: row.rank, value: row.value })),
        MasterChallengeLiveEventPoint: draft.challengePoints.map((row) => ({ scoreRank: row.rank, value: row.value })),
        MasterLiveEventReward: draft.liveRewards.map((row) => ({ ...row, resourceCount: row.count })),
        MasterChallengeLiveEventReward: draft.challengeRewards.map((row) => ({ ...row, resourceCount: row.count })),
      },
      planner: { active: draft.active },
      plannerRules: structuredClone(draft.rules),
    };
    data.challengeMusicTable!.rows.push(
      ...draft.challenges.map((song, index) => ({
        id: draft.id + index + 1,
        eventId: draft.id,
        liveMusicId: song.songId,
        musicType: song.attribute,
        stratAt: null,
        startAt: null,
        endAt: null,
      })),
    );
    if (data.challengeMusicTable!.rows.length) data.challengeMusicTable!.status = "ready";
  }
  if (base.crossServer) {
    const owners = { ...base.crossServer.owners },
      availability = { ...base.crossServer.availability };
    for (const [kind, ids] of [
      ["members", document.cards.filter((card) => card.kind === "members").map((card) => card.id)],
      ["snapshots", document.cards.filter((card) => card.kind === "snaps").map((card) => card.id)],
      ["events", document.events.map((event) => event.id)],
    ] as const) {
      owners[kind] = { ...owners[kind] };
      availability[kind] = { ...availability[kind] };
      for (const id of ids) {
        owners[kind]![String(id)] = base.identity.server;
        availability[kind]![String(id)] = [base.identity.server];
      }
    }
    const customChallenges = data.challengeMusicTable!.rows.filter((row) => Number(row.eventId) >= PLANNER_ID_START);
    data.crossServer = {
      ...base.crossServer,
      owners,
      availability,
      challengeMusics: [...base.crossServer.challengeMusics, ...customChallenges],
    };
  }
  return data;
}

export function plannerCardFromTemplate(
  data: TeamBuilderData,
  document: PlannerDocument,
  kind: PlannerCard["kind"],
  templateId: number,
  name: string,
): PlannerCard {
  const template = kind === "members" ? data.members[String(templateId)]! : data.snapshots[String(templateId)]!;
  const ids =
    "leaderSkillId" in template
      ? [template.leaderSkillId, template.liveSkillId, template.gekisoSkillId]
      : [
          template.supportSkillIds[0] ?? 0,
          template.supportSkillIds[1] ?? 0,
          template.gekisoSupportSkillIds[0] ?? 0,
          template.gekisoSupportSkillIds[1] ?? 0,
        ];
  const families: PlannerSkillFamily[] =
    kind === "members" ? ["leader", "live", "gekiso"] : ["support", "support", "gekisoSupport", "gekisoSupport"];
  return {
    id: nextPlannerId(document),
    kind,
    name,
    templateId,
    materialTemplateId: templateId,
    characterIds: "characterId" in template ? [template.characterId] : [...template.characterIds],
    attribute: template.attribute,
    rarity: template.rarity,
    stats: { ...template.statMax },
    skills: ids.map((id, index) => ({
      family: families[index]!,
      templateId: id,
      ...(plannerSkillOrigin(data, families[index]!, id) ? { origin: plannerSkillOrigin(data, families[index]!, id)! } : {}),
      name: "",
      effects: {},
    })),
    growth: {},
    active: true,
  };
}

export function plannerEventFromTemplate(
  data: TeamBuilderData,
  master: EngineMaster,
  document: PlannerDocument,
  eventId: number | null,
  name: string,
): PlannerEvent {
  const template = eventId === null ? undefined : master.events.get(eventId);
  const original = eventId === null ? undefined : data.events[String(eventId)];
  const id = nextPlannerId(document);
  const published = [...master.events.values()]
    .filter(
      (event) =>
        data.events[String(event.id)]?.kind !== "planner-event" &&
        event.startAt !== null &&
        event.startAt <= Date.now(),
    )
    .sort((a, b) => (b.startAt ?? 0) - (a.startAt ?? 0));
  const common = <T>(select: (event: NonNullable<typeof template>) => T, fallback: T): T => {
    const groups = new Map<string, { count: number; value: T }>();
    for (const event of published) {
      const value = select(event),
        key = JSON.stringify(value);
      const group = groups.get(key);
      if (group) group.count++;
      else groups.set(key, { count: 1, value });
    }
    return structuredClone([...groups.values()].sort((a, b) => b.count - a.count)[0]?.value ?? fallback);
  };
  const points = (rows?: ReadonlyMap<number, number>) =>
    Array.from({ length: 7 }, (_, index) => ({ rank: index + 1, value: rows?.get(index + 1) ?? 0 }));
  const defaults = (values: number[]) => values.map((value, index) => ({ rank: index + 1, value }));
  const rewards = (rows: readonly RewardRow[], item: number) => {
    const groups = new Map<number, number>();
    return rows.map((row) => {
      if (!groups.has(row.group)) groups.set(row.group, groups.size);
      return {
        ...row,
        group: groups.get(row.group)!,
        resourceId: row.resourceType === 1 && row.resourceId === item ? id : row.resourceId,
      };
    });
  };
  const standardRewards = (counts: number[]) =>
    counts.flatMap((count, index) =>
      count ? [{ scoreRank: index + 1, group: 0, resourceType: 1, resourceId: id, count, probability: 10000 }] : [],
    );
  return {
    id,
    name,
    startAt: template?.startAt ?? null,
    endAt: template?.endAt ?? null,
    eventType: Number(original?.eventType ?? 1),
    itemId: template?.itemId ?? 0,
    challenges: master.challengeMusics
      .filter((row) => row.eventId === eventId)
      .map((row) => ({ songId: row.liveMusicId, attribute: row.musicType })),
    effects: template ? (structuredClone(template.effects) as EventEffectRow[]) : [],
    livePoints: template
      ? points(template.livePoints)
      : common((event) => points(event.livePoints), defaults([0, 15, 25, 35, 50, 75, 100])),
    challengePoints: template
      ? points(template.challengePoints)
      : common((event) => points(event.challengePoints), defaults([0, 1500, 2000, 2750, 3500, 4500, 5500])),
    liveRewards: template
      ? (structuredClone(template.liveRewards) as RewardRow[])
      : common((event) => rewards(event.liveRewards, event.itemId), standardRewards([0, 18, 30, 42, 60, 90, 120])),
    challengeRewards: template
      ? (structuredClone(template.challengeRewards) as RewardRow[])
      : common(
          (event) => rewards(event.challengeRewards, event.itemId),
          standardRewards([0, 2150, 2650, 3400, 4150, 4900, 5650]),
        ),
    rules: {
      normalSongs: [],
      liveChallengePoints: points(master.liveChallengePoints),
      boosts: structuredClone(master.boosts) as BoostRow[],
      challengeBoosts: structuredClone(master.challengeBoosts) as BoostRow[],
      normalRanks: [],
      challengeRanks: [],
    },
    active: true,
  };
}

export function plannerReferences(value: unknown, ids: ReadonlySet<number>, field = ""): boolean {
  if (typeof value === "number")
    return (
      ["members", "snaps", "leader", "cardId", "eventId", "bindings", "excludedMembers", "excludedSnaps"].includes(
        field,
      ) && ids.has(value)
    );
  if (typeof value === "string")
    return (
      !["name", "title", "note", "description"].includes(field) &&
      /^[ms]\d+$/u.test(value) &&
      ids.has(Number(value.slice(1)))
    );
  if (Array.isArray(value)) return value.some((child) => plannerReferences(child, ids, field));
  return (
    value !== null &&
    typeof value === "object" &&
    Object.entries(value).some(([key, child]) => plannerReferences(child, ids, key))
  );
}
export function rewritePlannerReferences<T>(value: T, ids: ReadonlyMap<number, number>, field = ""): T {
  if (typeof value === "number")
    return (([
      "members",
      "snaps",
      "leader",
      "cardId",
      "eventId",
      "bindings",
      "excludedMembers",
      "excludedSnaps",
      "memberCardId",
      "supportCardId",
      "itemId",
      "resourceId",
    ].includes(field)
      ? ids.get(value)
      : undefined) ?? value) as T;
  if (
    typeof value === "string" &&
    !["name", "title", "note", "description"].includes(field) &&
    /^[ms]\d+$/u.test(value)
  )
    return (ids.has(Number(value.slice(1))) ? value[0] + String(ids.get(Number(value.slice(1)))) : value) as T;
  if (Array.isArray(value)) return value.map((child) => rewritePlannerReferences(child, ids, field)) as T;
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, rewritePlannerReferences(child, ids, key)]),
    ) as T;
  return value;
}

/** Settlement views replace event-owned tables without changing public gameplay data. */
export function plannerMaster(master: EngineMaster, eventId: number | null, challenge = false): EngineMaster {
  const rules = eventId === null ? undefined : master.events.get(eventId)?.plannerRules;
  if (!rules) return master;
  const ranks = challenge ? rules.challengeRanks : rules.normalRanks;
  return {
    ...master,
    boosts: rules.boosts,
    challengeBoosts: rules.challengeBoosts,
    liveChallengePoints: new Map(rules.liveChallengePoints.map((row) => [row.rank, row.value])),
    ...(ranks.length
      ? {
          scoreRanks: new Map([...master.scoreRanks, [eventId!, ranks]]),
          songs: new Map([...master.songs].map(([id, song]) => [id, { ...song, rankGroup: eventId! }])),
        }
      : {}),
  };
}
