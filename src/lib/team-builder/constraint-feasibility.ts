// L3 — GEB
// Input: Engine Master and the actual event or Gekiso search request.
// Output: Conservative event/COMBO feasibility bounds and native integer input checks.
// Pos: [Map](L2-2.md); pre-submit validation for search constraints.
// Effects/Dependencies: Pure; uses the same resolved cards and event effects as the engine adapter.
import type { ConstraintInput, EngineRequest, RewardMetric } from "./engine/api";
import { resolveBox } from "./engine/box";
import type { EngineMaster } from "./engine/master";
import { memberEventPercent, snapEventPercent, type MemberState } from "./engine/power";

export const MAX_GEKISO_COUNT = 2_147_483_647;
export const validGekisoCount = (value: number, minimum: number) =>
  Number.isSafeInteger(value) && value >= minimum && value <= MAX_GEKISO_COUNT;

function memberUpperBound(members: readonly MemberState[], constraints: ConstraintInput, value: (member: MemberState) => number): number | null {
  const available = members.filter((member) => !constraints.excludedMembers.includes(member.key));
  const byKey = new Map(available.map((member) => [member.key, member]));
  const bound = constraints.bindings.map(([member]) => member);
  if (byKey.size !== available.length || new Set(bound).size !== bound.length) return null;
  const required = new Set([...constraints.requiredMembers, ...bound,
    ...(constraints.leader === null ? [] : [constraints.leader])]);
  const fixed = [...required].map((key) => byKey.get(key));
  if (fixed.length > 5 || fixed.some((member) => !member)) return null;
  const characters = new Set(fixed.map((member) => member!.card.characterId));
  if (characters.size !== fixed.length) return null;
  const best = new Map<number, number>();
  for (const member of available) {
    if (characters.has(member.card.characterId)) continue;
    best.set(member.card.characterId, Math.max(best.get(member.card.characterId) ?? 0, value(member)));
  }
  const remaining = 5 - fixed.length;
  if (best.size < remaining) return null;
  return fixed.reduce((sum, member) => sum + value(member!), 0) +
    [...best.values()].sort((a, b) => b - a).slice(0, remaining).reduce((sum, upper) => sum + upper, 0);
}

export function minimumComboBonusUnreachable(master: EngineMaster, request: EngineRequest): boolean {
  const { goal, constraints } = request;
  const minimum = goal.kind === "gekiso" ? goal.minComboBonus : goal.kind === "event" ? goal.gekiso?.minComboBonus : undefined;
  if (minimum === undefined || !Number.isFinite(minimum) || minimum <= 1) return false;
  if (goal.kind !== "gekiso" && goal.kind !== "event") return false;
  const arena = goal.kind === "gekiso" ? goal.arena : undefined;
  if (!goal.songs.some((ref) => master.songs.get(ref.songId)?.gekisoMissions.some((mission, index) =>
    [1, 4].includes(arena?.missions[index] || request.songRules?.missions[index] || mission)))) return false;
  const { members, unknown } = resolveBox(master, request.members, request.snaps, request.unknownPolicy);
  if (unknown.length) return false;
  const upper = memberUpperBound(members, constraints, (member) => {
    const skill = master.gekisoSkills.get(member.card.gekisoSkillId);
    if (!skill || ![1, 4].includes(skill.missionType)) return 0;
    // Opening bonuses use these sustained rows; ignoring their gates only raises the bound.
    const rows = skill.effects.filter((row) => row.level === member.growth.gekisoSkillLevel && row.type === 12000
      && row.triggerType === 2 && row.seconds === 0 && !row.cumulativeId && !row.resetGroup && !row.releaseGroup);
    if (rows.some((row) => row.value < 0)) return MAX_GEKISO_COUNT;
    return rows.reduce((sum, row) => sum + row.value, 0);
  });
  return upper !== null && 1 + upper < minimum;
}

/** False means either the floor may be reachable or this request cannot be checked here. */
export function minimumEventBonusUnreachable(master: EngineMaster, request: EngineRequest): boolean {
  const { goal, constraints } = request;
  const minimum = constraints.minBonusPercent;
  if (goal.kind !== "event" || minimum === null || !Number.isFinite(minimum) || minimum <= 0) return false;
  if (!goal.rewardPlan && goal.measure === "challenge-points") return false;
  const metric: RewardMetric = goal.rewardPlan
    ? goal.rewardPlan.levels.flat().find((term) => term.metric !== "challenge-points")?.metric ?? "points"
    : goal.measure;
  const effects = goal.eventEffects ?? master.events.get(goal.eventId)?.effects;
  if (!effects) return false;
  const { members, snaps, unknown } = resolveBox(master, request.members, request.snaps, request.unknownPolicy);
  if (unknown.length) return false;
  const excludedSnaps = new Set(constraints.excludedSnaps);
  const availableSnaps = snaps.filter((snap) => !excludedSnaps.has(snap.key));
  const snapByKey = new Map(availableSnaps.map((snap) => [snap.key, snap]));
  if (snapByKey.size !== availableSnaps.length) return false;
  const bonusType = metric === "items" ? 1 : 0;
  const memberUpper = memberUpperBound(members, constraints, (member) => Math.max(0, memberEventPercent(effects, member, bonusType)));
  if (memberUpper === null) return false;

  const boundSnaps = constraints.bindings.flatMap(([, snap]) => snap === null ? [] : [snap]);
  if (new Set(boundSnaps).size !== boundSnaps.length) return false;
  const requiredSnaps = new Set([...constraints.requiredSnaps, ...boundSnaps]);
  const emptySlots = constraints.bindings.length - boundSnaps.length;
  if ((constraints.noSnaps && requiredSnaps.size) || requiredSnaps.size > 5 - emptySlots ||
      [...requiredSnaps].some((key) => !snapByKey.has(key))) return false;
  let snapUpper = 0;
  if (!constraints.noSnaps) {
    const snapBonus = (snap: (typeof snaps)[number]) => Math.max(0, snapEventPercent(effects, snap, bonusType));
    snapUpper = [...requiredSnaps].reduce((sum, key) => sum + snapBonus(snapByKey.get(key)!), 0) +
      availableSnaps.filter((snap) => !requiredSnaps.has(snap.key)).map(snapBonus)
        .sort((a, b) => b - a).slice(0, 5 - emptySlots - requiredSnaps.size).reduce((sum, bonus) => sum + bonus, 0);
  }
  return memberUpper + snapUpper < Math.floor(minimum * 100 + 0.5);
}
