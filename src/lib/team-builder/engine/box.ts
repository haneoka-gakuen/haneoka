/** Card box → resolved member and snap states. */
import type { EngineMaster, MemberCard, SnapCard } from "./master";
import {
  maxAwake,
  maxMemberRank,
  maxSkillLevel,
  maxSnapRank,
  memberLevelCap,
  resolveMember,
  resolveSnap,
  snapLevelCap,
  type MemberGrowth,
  type MemberState,
  type PlayerState,
  type SnapGrowth,
  type SnapState,
} from "./power";

export interface MemberInput {
  key: string;
  cardId: number;
  level: number | null;
  awake: number | null;
  rank: number | null;
  liveSkillLevel: number | null;
  gekisoSkillLevel: number | null;
}
export interface SnapInput {
  key: string;
  cardId: number;
  level: number | null;
  rank: number | null;
}
/** How unknown growth fields are filled. */
export type UnknownPolicy = "max" | "min";

export function maxMemberGrowth(master: EngineMaster, card: MemberCard): MemberGrowth {
  const awake = maxAwake(master, card);
  return {
    level: memberLevelCap(master, card, awake),
    awake,
    rank: maxMemberRank(master, card),
    liveSkillLevel: maxSkillLevel(master.liveSkills.get(card.liveSkillId)),
    gekisoSkillLevel: maxSkillLevel(master.gekisoSkills.get(card.gekisoSkillId)?.effects),
  };
}
export function maxSnapGrowth(master: EngineMaster, card: SnapCard): SnapGrowth {
  const rank = maxSnapRank(master, card);
  return { level: snapLevelCap(master, card, rank), rank };
}
export function memberGrowth(master: EngineMaster, card: MemberCard, input: MemberInput, policy: UnknownPolicy): MemberGrowth {
  const max = maxMemberGrowth(master, card);
  const pick = (value: number | null, high: number) => value ?? (policy === "max" ? high : 1);
  const awake = Math.min(pick(input.awake, max.awake), max.awake);
  const cap = memberLevelCap(master, card, awake);
  return {
    level: Math.max(1, Math.min(pick(input.level, cap), cap)),
    awake,
    rank: Math.min(pick(input.rank, max.rank), max.rank),
    liveSkillLevel: Math.min(pick(input.liveSkillLevel, max.liveSkillLevel), max.liveSkillLevel),
    gekisoSkillLevel: Math.min(pick(input.gekisoSkillLevel, max.gekisoSkillLevel), max.gekisoSkillLevel),
  };
}
export function snapGrowth(master: EngineMaster, card: SnapCard, input: SnapInput, policy: UnknownPolicy): SnapGrowth {
  const max = maxSnapGrowth(master, card);
  const rank = Math.min(input.rank ?? (policy === "max" ? max.rank : 1), max.rank);
  const cap = snapLevelCap(master, card, rank);
  return { level: Math.max(1, Math.min(input.level ?? (policy === "max" ? cap : 1), cap)), rank };
}

export interface ResolvedBox {
  members: MemberState[];
  snaps: SnapState[];
  /** Entries whose card is unknown to this release. */
  unknown: string[];
}
export function resolveBox(
  master: EngineMaster,
  members: readonly MemberInput[],
  snaps: readonly SnapInput[],
  policy: UnknownPolicy = "max",
): ResolvedBox {
  const unknown: string[] = [];
  const resolvedMembers: MemberState[] = [];
  for (const input of members) {
    const card = master.members.get(input.cardId);
    const state = card && resolveMember(master, input.key, card, memberGrowth(master, card, input, policy));
    if (state) resolvedMembers.push(state);
    else unknown.push(input.key);
  }
  const resolvedSnaps: SnapState[] = [];
  for (const input of snaps) {
    const card = master.snaps.get(input.cardId);
    const state = card && resolveSnap(master, input.key, card, snapGrowth(master, card, input, policy));
    if (state) resolvedSnaps.push(state);
    else unknown.push(input.key);
  }
  return { members: resolvedMembers, snaps: resolvedSnaps, unknown };
}
/** Every card at full growth: the reference box. */
export function theoreticalBox(master: EngineMaster): ResolvedBox {
  return resolveBox(
    master,
    [...master.members.values()].map((card) => ({ key: `m${card.id}`, cardId: card.id, level: null, awake: null, rank: null, liveSkillLevel: null, gekisoSkillLevel: null })),
    [...master.snaps.values()].map((card) => ({ key: `s${card.id}`, cardId: card.id, level: null, rank: null })),
    "max",
  );
}
export const emptyPlayer = (): PlayerState => ({
  characterRanks: new Map(),
  totalRank: 0,
  bandItems: new Map(),
  vipRank: 1,
  characterMemory: new Map(),
  musicMemory: new Map(),
});
