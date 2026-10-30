// L3 — GEB
// Input: Engine Master and the actual event search request.
// Output: A conservative test for an unreachable minimum event bonus.
// Pos: [Map](L2-2.md); pre-submit validation for activity searches.
// Effects/Dependencies: Pure; uses the same resolved cards and event effects as the engine adapter.
import type { EngineRequest, RewardMetric } from "./engine/api";
import { resolveBox } from "./engine/box";
import type { EngineMaster } from "./engine/master";
import { memberEventPercent, snapEventPercent } from "./engine/power";

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
  const excludedMembers = new Set(constraints.excludedMembers);
  const excludedSnaps = new Set(constraints.excludedSnaps);
  const availableMembers = members.filter((member) => !excludedMembers.has(member.key));
  const availableSnaps = snaps.filter((snap) => !excludedSnaps.has(snap.key));
  const memberByKey = new Map(availableMembers.map((member) => [member.key, member]));
  const snapByKey = new Map(availableSnaps.map((snap) => [snap.key, snap]));
  if (memberByKey.size !== availableMembers.length || snapByKey.size !== availableSnaps.length) return false;

  const boundMembers = constraints.bindings.map(([member]) => member);
  if (new Set(boundMembers).size !== boundMembers.length) return false;
  const requiredMembers = new Set([
    ...constraints.requiredMembers,
    ...boundMembers,
    ...(constraints.leader === null ? [] : [constraints.leader]),
  ]);
  const fixedMembers = [...requiredMembers].map((key) => memberByKey.get(key));
  if (fixedMembers.length > 5 || fixedMembers.some((member) => !member)) return false;
  const fixedCharacters = new Set(fixedMembers.map((member) => member!.card.characterId));
  if (fixedCharacters.size !== fixedMembers.length) return false;
  const bonusType = metric === "items" ? 1 : 0;
  const memberBonus = (member: (typeof members)[number]) => Math.max(0, memberEventPercent(effects, member, bonusType));
  const bestByCharacter = new Map<number, number>();
  for (const member of availableMembers) {
    if (fixedCharacters.has(member.card.characterId)) continue;
    bestByCharacter.set(member.card.characterId, Math.max(bestByCharacter.get(member.card.characterId) ?? 0, memberBonus(member)));
  }
  const remaining = 5 - fixedMembers.length;
  if (bestByCharacter.size < remaining) return false;
  const memberUpper = fixedMembers.reduce((sum, member) => sum + memberBonus(member!), 0) +
    [...bestByCharacter.values()].sort((a, b) => b - a).slice(0, remaining).reduce((sum, bonus) => sum + bonus, 0);

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
