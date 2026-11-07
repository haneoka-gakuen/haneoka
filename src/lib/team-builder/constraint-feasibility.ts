// L3 — GEB
// Input: Engine Master and the actual event or Gekiso search request.
// Output: Conservative event/COMBO bounds, role-count feasibility and native integer input checks.
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

export function missionMemberCounts(master: EngineMaster, cardIds: readonly number[]): [number, number, number] {
  const counts: [number, number, number] = [0, 0, 0];
  for (const id of cardIds) {
    const card = master.members.get(id);
    const type = card && master.gekisoSkills.get(card.gekisoSkillId)?.missionType;
    for (let role = 0; role < 3; role++) if (type === role + 1 || type === 4) counts[role]!++;
  }
  return counts;
}

export function minimumMissionMembersUnreachable(master: EngineMaster, request: EngineRequest): boolean {
  const minimum = request.constraints.minMissionMembers;
  if (!minimum?.some(Boolean) || !minimum.every((value) => Number.isInteger(value) && value >= 0 && value <= 5)
    || minimum.reduce((sum, count) => sum + count, 0) > 5)
    return false;
  const { members, unknown } = resolveBox(master, request.members, request.snaps, request.unknownPolicy);
  if (unknown.length) return false;
  const available = members.filter((member) => !request.constraints.excludedMembers.includes(member.key));
  if (new Set(available.map(member => member.card.characterId)).size < 5) return false;
  const byKey = new Map(available.map((member) => [member.key, member]));
  const fixed = [
    ...new Set([
      ...request.constraints.requiredMembers,
      ...request.constraints.bindings.map(([member]) => member),
      ...(request.constraints.leader === null ? [] : [request.constraints.leader]),
    ]),
  ].map((key) => byKey.get(key));
  if (fixed.length > 5 || fixed.some((member) => !member)) return false;
  const characters = new Set(fixed.map((member) => member!.card.characterId));
  if (characters.size !== fixed.length) return false;
  const counts = missionMemberCounts(
    master,
    fixed.map((member) => member!.card.id),
  );
  const groups = new Map<number, Set<number>>();
  for (const member of available) {
    if (characters.has(member.card.characterId)) continue;
    const type = master.gekisoSkills.get(member.card.gekisoSkillId)?.missionType ?? 0;
    const mask = type === 4 ? 7 : type >= 1 && type <= 3 ? 1 << (type - 1) : 0;
    const choices = groups.get(member.card.characterId) ?? new Set<number>();
    choices.add(mask);
    groups.set(member.card.characterId, choices);
  }
  const pack = (slots: number, values: readonly number[]) =>
    values.reduce((key, value, role) => key * 6 + Math.min(minimum[role]!, value), slots);
  let states = new Set([pack(fixed.length, counts)]);
  for (const choices of groups.values()) {
    const next = new Set(states);
    for (const key of states) {
      const values = [Math.floor(key / 36) % 6, Math.floor(key / 6) % 6, key % 6];
      const slots = Math.floor(key / 216);
      if (slots >= 5) continue;
      for (const mask of choices)
        next.add(
          pack(
            slots + 1,
            values.map((value, role) => value + Number((mask & (1 << role)) !== 0)),
          ),
        );
    }
    states = next;
  }
  return !states.has(pack(5, minimum));
}
