/** Exact deck power (CardParameterCalculator) split into additive per-slot terms.
 * One stat point is 10 000 BP; percentages use 10 000 BP = 100 %. Float steps are binary32. */
import type { EngineMaster, MemberCard, SkillEffectRow, SnapCard, Stat3, TargetRow } from "./master";

const f = Math.fround;
const floorF32Div = (numerator: number) => Math.floor(f(f(numerator) / 10000));
export type BP3 = [number, number, number];

export interface PlayerState {
  /** character → rank; absent characters count as rank 1. */
  characterRanks: ReadonlyMap<number, number>;
  totalRank: number;
  bandItems: ReadonlyMap<number, number>;
  vipRank: number;
  /** Direct points per component, from character and song memories. */
  characterMemory: ReadonlyMap<number, number>;
  musicMemory: ReadonlyMap<number, number>;
}
export interface MemberGrowth {
  level: number;
  awake: number;
  rank: number;
  liveSkillLevel: number;
  gekisoSkillLevel: number;
}
export interface SnapGrowth {
  level: number;
  rank: number;
}
export interface MemberState {
  key: string;
  card: MemberCard;
  growth: MemberGrowth;
  leaderSkillLevel: number;
  musicTypeRate: number;
  musicTagRate: number;
  /** Level + awake + rank stats, BP. */
  own: BP3;
  liveSkillCategories: readonly number[];
  gekisoSkillCategories: readonly number[];
  gekisoMissionType: number;
}
export interface SnapState {
  key: string;
  card: SnapCard;
  growth: SnapGrowth;
  /** Snap power bonus percentage, BP. */
  percent: BP3;
  typeLinkRate: number;
  skillLevels: readonly [number, number];
  gekisoSkillLevels: readonly [number, number];
}
export interface MusicView {
  musicType: number;
  bestTags: readonly number[];
  memoryKey: number;
}

const add3 = (a: BP3, b: Stat3 | BP3): BP3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** CardPower.mul then to_floor: trunc(a·b/10000), then binary32 floor to whole points. */
export const pctFloor = (base: BP3, pct: Stat3 | BP3): BP3 => [
  floorF32Div(Math.trunc((base[0] * pct[0]) / 10000)) * 10000,
  floorF32Div(Math.trunc((base[1] * pct[1]) / 10000)) * 10000,
  floorF32Div(Math.trunc((base[2] * pct[2]) / 10000)) * 10000,
];
const pctUniform = (base: BP3, pct: number) => pctFloor(base, [pct, pct, pct]);
/** Displayed total: floor of each component's points, summed. */
export const points = (bp: BP3 | Stat3) => Math.floor(bp[0] / 10000) + Math.floor(bp[1] / 10000) + Math.floor(bp[2] / 10000);

export function memberLevelCap(master: EngineMaster, card: MemberCard, awake: number): number {
  return master.memberLevelLimits.get(`${card.rarity}:${awake}`) ?? Math.max(...(master.memberLevels.get(card.levelGroup)?.keys() ?? [1]));
}
export function snapLevelCap(master: EngineMaster, card: SnapCard, rank: number): number {
  return master.snapRanks.get(card.rankGroup)?.get(rank)?.limitLevel ?? Math.max(...(master.snapLevels.get(card.levelGroup)?.keys() ?? [1]));
}
export const maxAwake = (master: EngineMaster, card: MemberCard) => Math.max(1, ...(master.memberAwake.get(card.awakeGroup)?.keys() ?? [1]));
export const maxMemberRank = (master: EngineMaster, card: MemberCard) => Math.max(1, ...(master.memberRanks.get(card.rankGroup)?.keys() ?? [1]));
export const maxSnapRank = (master: EngineMaster, card: SnapCard) => Math.max(1, ...(master.snapRanks.get(card.rankGroup)?.keys() ?? [1]));
export const maxSkillLevel = (rows: readonly SkillEffectRow[] | undefined) => Math.max(1, ...(rows ?? []).map((row) => row.level));

export function resolveMember(master: EngineMaster, key: string, card: MemberCard, growth: MemberGrowth): MemberState | null {
  const level = master.memberLevels.get(card.levelGroup)?.get(growth.level);
  const awake = master.memberAwake.get(card.awakeGroup)?.get(growth.awake) ?? (growth.awake <= 1 ? ([0, 0, 0] as const) : undefined);
  const rank = master.memberRanks.get(card.rankGroup)?.get(growth.rank);
  if (!level || !awake || !rank) return null;
  const max = card.statMax;
  const own: BP3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const levelPoints = floorF32Div(level[i]! * max[i]!);
    const awakePoints = Math.floor(f(f(awake[i]! / 10000) * f(max[i]!)));
    const rankPoints = floorF32Div(Math.imul(rank.rates[i]!, max[i]!));
    own[i] = (levelPoints + awakePoints + rankPoints) * 10000;
  }
  const gekiso = master.gekisoSkills.get(card.gekisoSkillId);
  return {
    key,
    card,
    growth,
    leaderSkillLevel: rank.leaderSkillLevel,
    musicTypeRate: rank.musicTypeRate,
    musicTagRate: rank.musicTagRate,
    own,
    liveSkillCategories: master.skillCategories.live.get(card.liveSkillId) ?? [],
    gekisoSkillCategories: master.skillCategories.gekiso.get(card.gekisoSkillId) ?? [],
    gekisoMissionType: gekiso?.missionType ?? 0,
  };
}

export function resolveSnap(master: EngineMaster, key: string, card: SnapCard, growth: SnapGrowth): SnapState | null {
  const level = master.snapLevels.get(card.levelGroup)?.get(growth.level);
  const rank = master.snapRanks.get(card.rankGroup)?.get(growth.rank);
  if (!level || !rank) return null;
  const percent: BP3 = [0, 1, 2].map((i) => floorF32Div(Math.imul(level[i]!, card.statMax[i]!))) as BP3;
  return {
    key,
    card,
    growth,
    percent,
    typeLinkRate: rank.typeLinkRate,
    skillLevels: rank.skillLevels,
    gekisoSkillLevels: rank.gekisoSkillLevels,
  };
}

/** Whether a skill target selects a member: first matching key among band, type, character, tag, categories, mission. */
export function isTargetMember(member: MemberState, target: TargetRow): boolean {
  const card = member.card;
  if (target.bandId > 0 && target.bandId === card.bandId) return true;
  if (target.cardType !== 0 && target.cardType === card.cardType) return true;
  if (target.characterId > 0 && target.characterId === card.characterId) return true;
  if (target.tagId > 0 && card.bestTags.includes(target.tagId)) return true;
  if (target.liveSkillCategories.length && target.liveSkillCategories.some((id) => member.liveSkillCategories.includes(id))) return true;
  if (target.gekisouSkillCategories.length && target.gekisouSkillCategories.some((id) => member.gekisoSkillCategories.includes(id)))
    return true;
  return target.gekisouMissionType !== 0 && target.gekisouMissionType === member.gekisoMissionType;
}
export function matchesTargets(master: EngineMaster, member: MemberState, targetIds: readonly number[]): boolean {
  for (const id of targetIds) {
    const target = master.targets.get(id);
    if (target && isTargetMember(member, target)) return true;
  }
  return false;
}

function accumulate(type: number, value: number, acc: BP3) {
  switch (type) {
    case 1000:
    case 1500:
      acc[0] = (acc[0] + value) | 0;
      acc[1] = (acc[1] + value) | 0;
      acc[2] = (acc[2] + value) | 0;
      break;
    case 1001:
    case 1501:
      acc[1] = (acc[1] + value) | 0;
      break;
    case 1002:
    case 1502:
      acc[2] = (acc[2] + value) | 0;
      break;
    case 1003:
    case 1503:
      acc[0] = (acc[0] + value) | 0;
      break;
  }
}
const isCumulative = (type: number) => (type & ~3) === 1500;

/** Band item percentage of a member (character, band and card-type targets). */
export function bandItemPercent(master: EngineMaster, player: PlayerState, member: MemberState): BP3 {
  const acc: BP3 = [0, 0, 0];
  const card = member.card;
  for (const [itemId, level] of player.bandItems) {
    const effects = master.bandItems.get(itemId)?.levels.get(level);
    if (!effects) continue;
    for (const effect of effects)
      for (const id of effect.targetIds) {
        const target = master.targets.get(id);
        if (!target) continue;
        const hits =
          Number(target.bandId > 0 && target.bandId === card.bandId) +
          Number(target.characterId > 0 && target.characterId === card.characterId) +
          Number(target.cardType !== 0 && target.cardType === card.cardType);
        for (let i = 0; i < hits; i++) accumulate(effect.type === 1000 || effect.type === 1001 || effect.type === 1002 || effect.type === 1003 ? effect.type : -1, effect.value, acc);
      }
  }
  return acc;
}

function conditionHolds(master: EngineMaster, groupId: number, members: readonly MemberState[], music: MusicView | null) {
  if (groupId <= 0) return true;
  for (const set of master.conditionSets.get(groupId) ?? [])
    for (const id of set) {
      const condition = master.conditions.get(id);
      if (!condition || condition.type === 0 || !condition.targetIds.length) continue;
      const any = (member: MemberState) => matchesTargets(master, member, condition.targetIds);
      let holds = true;
      if (condition.type === 3000) holds = members.some(any);
      else if (condition.type === 3001) holds = members.every(any);
      else if (condition.type === 4012)
        holds = !!music && condition.targetIds.some((target) => {
          const row = master.targets.get(target);
          return !!row && row.liveMusicType !== 0 && row.liveMusicType === music.musicType;
        });
      if (!holds) return false;
    }
  return true;
}
function cumulativeCount(master: EngineMaster, id: number, members: readonly MemberState[], leader: number) {
  const row = id > 0 ? master.cumulative.get(id) : undefined;
  if (!row) return 1;
  const hit = (member: MemberState) => matchesTargets(master, member, row.targetIds);
  let count: number;
  switch (row.type) {
    case 3000:
      count = members.filter(hit).length;
      break;
    case 3001:
      count = members.filter((member, index) => index !== leader && hit(member)).length;
      break;
    case 3002:
      count = members.filter((member) => member.card.bandId === members[leader]!.card.bandId).length;
      break;
    case 3003:
      count = members.filter((member) => member.card.bandId !== members[leader]!.card.bandId).length;
      break;
    case 3004:
      count = new Set(members.map((member) => member.card.bandId)).size;
      break;
    case 3005:
      count = new Set(members.map((member) => member.card.cardType)).size;
      break;
    default:
      return 1;
  }
  return row.cap < 1 ? count : Math.min(count, row.cap);
}

export interface LeaderProfile {
  effects: readonly SkillEffectRow[];
  /** Unconditional, non-cumulative: a member's percentage depends on that member alone. */
  simple: boolean;
}
export function leaderProfile(master: EngineMaster, leader: MemberState): LeaderProfile {
  const effects = (master.leaderSkills.get(leader.card.leaderSkillId) ?? []).filter((row) => row.level === leader.leaderSkillLevel);
  return { effects, simple: effects.every((row) => row.conditionGroup <= 0 && !isCumulative(row.type)) };
}
/** Exact leader percentages of `members` (leader at `leader`). */
export function leaderPercents(
  master: EngineMaster,
  profile: LeaderProfile,
  members: readonly MemberState[],
  leader: number,
  music: MusicView | null,
): BP3[] {
  const out = members.map((): BP3 => [0, 0, 0]);
  for (const effect of profile.effects) {
    if (!conditionHolds(master, effect.conditionGroup, members, music)) continue;
    const value = isCumulative(effect.type)
      ? Math.imul(effect.value, cumulativeCount(master, effect.cumulativeId, members, leader))
      : effect.value;
    members.forEach((member, index) => {
      if (!effect.targetIds.length || matchesTargets(master, member, effect.targetIds)) accumulate(effect.type, value, out[index]!);
    });
  }
  return out;
}
/** Percentage of one member when the profile is simple, or a component-wise upper bound otherwise. */
export function leaderPercentBound(master: EngineMaster, profile: LeaderProfile, member: MemberState): BP3 {
  const acc: BP3 = [0, 0, 0];
  for (const effect of profile.effects) {
    if (effect.targetIds.length && !matchesTargets(master, member, effect.targetIds)) continue;
    let value = effect.value;
    if (isCumulative(effect.type)) {
      const cap = master.cumulative.get(effect.cumulativeId)?.cap ?? 5;
      value = Math.max(value, value * (cap >= 1 ? Math.min(cap, 5) : 5));
    }
    accumulate(effect.type, profile.simple ? value : Math.max(0, value), acc);
  }
  return acc;
}

/** Everything of a slot that does not depend on the snap or the leader. */
export interface SlotBase {
  /** Common base the percentages multiply. */
  common: BP3;
  /** Points of base, ranks, memory, band item, music type/tag and VIP. */
  fixedPoints: number;
}
export function slotBase(
  master: EngineMaster,
  player: PlayerState,
  member: MemberState,
  music: MusicView | null,
  memberEventPct: number,
): SlotBase {
  const own = member.own;
  const base: BP3 = memberEventPct ? add3(own, pctUniform(own, memberEventPct)) : [...own];
  const rank = player.characterRanks.get(member.card.characterId) ?? 1;
  let cr = 0;
  for (const [threshold, bonus] of master.characterRankBonus) if (threshold <= rank) cr = bonus;
  let ctr = 0;
  for (const [threshold, bonus] of master.totalRankBonus) if (threshold <= player.totalRank) ctr = bonus;
  const memory = (player.characterMemory.get(member.card.characterId) ?? 0) + (music ? (player.musicMemory.get(music.memoryKey) ?? 0) : 0);
  const flat = (cr + ctr + memory) * 10000;
  const common: BP3 = [base[0] + flat, base[1] + flat, base[2] + flat];
  let total = points(common);
  total += points(pctFloor(common, bandItemPercent(master, player, member)));
  if (music) {
    const card = member.card;
    if (card.cardType === 99 || music.musicType === 99 || card.cardType === music.musicType)
      total += points(pctUniform(common, master.params.musicTypeBase + member.musicTypeRate));
    if (card.bestTags.some((tag) => music.bestTags.includes(tag)))
      total += points(pctUniform(common, master.params.musicTagBase + member.musicTagRate));
  }
  const vip = master.vipBonus.get(player.vipRank) ?? 0;
  if (vip) total += points(pctUniform(common, vip));
  return { common, fixedPoints: total };
}
/** Snap power and type link of one slot. */
export function snapPoints(master: EngineMaster, base: SlotBase, member: MemberState, snap: SnapState | null, snapEventPct: number) {
  const percent: BP3 = snap ? [snap.percent[0] + snapEventPct, snap.percent[1] + snapEventPct, snap.percent[2] + snapEventPct] : [0, 0, 0];
  let total = snap || snapEventPct ? points(pctFloor(base.common, percent)) : 0;
  if (snap && snap.card.cardType === member.card.cardType) {
    const link = master.params.typeLinkBase + snap.typeLinkRate;
    total += points(pctUniform(base.common, link));
  }
  return total;
}
export const leaderPoints = (base: SlotBase, percent: BP3) =>
  percent[0] || percent[1] || percent[2] ? points(pctFloor(base.common, percent)) : 0;

/** Event parameter percentages (bonus type 2) of a member and a snap, summed over held events. */
export function memberEventPercent(effects: readonly import("./master").EventEffectRow[], member: MemberState, bonusType = 2): number {
  let total = 0;
  const card = member.card;
  for (const effect of effects) {
    if (effect.bonusType !== bonusType || effect.resourceType !== 2) continue;
    if (effect.characterId > 0 && effect.characterId !== card.characterId) continue;
    if (effect.bandId > 0 && effect.bandId !== card.bandId) continue;
    if (effect.cardType !== 0 && effect.cardType !== card.cardType) continue;
    if (effect.tagId > 0 && !card.bestTags.includes(effect.tagId)) continue;
    if (effect.memberCardId >= 1 && effect.memberCardId !== card.id) continue;
    total = (total + (effect.perRank[member.growth.rank - 1] ?? 0)) | 0;
  }
  return total;
}
export function snapEventPercent(effects: readonly import("./master").EventEffectRow[], snap: SnapState, bonusType = 2): number {
  let total = 0;
  const card = snap.card;
  for (const effect of effects) {
    if (effect.bonusType !== bonusType || effect.resourceType !== 3) continue;
    if (effect.characterId > 0 && !card.characterIds.includes(effect.characterId)) continue;
    if (effect.bandId > 0 && !card.bandIds.includes(effect.bandId)) continue;
    if (effect.cardType !== 0 && effect.cardType !== card.cardType) continue;
    if (effect.tagId >= 1) continue;
    if (effect.supportCardId >= 1 && effect.supportCardId !== card.id) continue;
    total = (total + (effect.perRank[snap.growth.rank - 1] ?? 0)) | 0;
  }
  return total;
}

export interface TeamPower {
  total: number;
  slots: number[];
  leaderPercents: BP3[];
}
/** Exact power of five slots; `eventEffects` is non-empty only where parameter bonuses apply (challenge). */
export function teamPower(
  master: EngineMaster,
  player: PlayerState,
  members: readonly MemberState[],
  snaps: readonly (SnapState | null)[],
  leader: number,
  music: MusicView | null,
  eventEffects: readonly import("./master").EventEffectRow[] = [],
): TeamPower {
  const percents = leaderPercents(master, leaderProfile(master, members[leader]!), members, leader, music);
  const slots = members.map((member, index) => {
    const base = slotBase(master, player, member, music, eventEffects.length ? memberEventPercent(eventEffects, member) : 0);
    const snap = snaps[index] ?? null;
    const snapEvent = snap && eventEffects.length ? snapEventPercent(eventEffects, snap) : 0;
    return base.fixedPoints + snapPoints(master, base, member, snap, snapEvent) + leaderPoints(base, percents[index]!);
  });
  return { total: slots.reduce((sum, value) => sum + value, 0), slots, leaderPercents: percents };
}
