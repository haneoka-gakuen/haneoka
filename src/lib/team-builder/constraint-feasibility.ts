// L3 — GEB
// Input: Engine Master and the actual event or Gekiso search request.
// Output: Conservative event, COMBO, JUST and role-count limits; native integer input checks.
// Pos: [Map](L2-2.md); live card limits and pre-submit validation for search constraints.
// Effects/Dependencies: Pure; uses the same resolved cards and event effects as the engine adapter.
import type { ConstraintInput, EngineRequest, RewardMetric } from "./engine/api";
import { resolveBox } from "./engine/box";
import type { EngineMaster } from "./engine/master";
import { memberEventPercent, snapEventPercent, type MemberState } from "./engine/power";
import { dataRows, type TeamBuilderData } from "./data";
import type { SnapState } from "./engine/power";
import type { SkillEffectRow } from "./engine/master";
import { performer } from "./engine/full/deck";
import { performerMatches } from "./engine/full/conditions";

export const MAX_GEKISO_COUNT = 2_147_483_647;
export const validGekisoCount = (value: number, minimum: number) =>
  Number.isSafeInteger(value) && value >= minimum && value <= MAX_GEKISO_COUNT;

type MemberRequirement = { minimum: number; value: (member: MemberState) => number };

function memberUpperBound(members: readonly MemberState[], constraints: ConstraintInput, value: (member: MemberState) => number,
  requirements: readonly MemberRequirement[] = []): number | null {
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
  if (requirements.length) {
    if (requirements.some(requirement => { const upper = memberUpperBound(members, constraints, requirement.value); return upper !== null && upper < requirement.minimum; })) return null;
    let width = 1;
    const dimensions = requirements.map(requirement => {
      const stride = width;
      width *= requirement.minimum + 1;
      return { ...requirement, stride };
    });
    const advance = (key: number, member: MemberState) => dimensions.reduce((target, dimension) => {
      const before = Math.floor(key / dimension.stride) % (dimension.minimum + 1);
      return target + (Math.min(dimension.minimum, before + dimension.value(member)) - before) * dimension.stride;
    }, key + width);
    const initial = fixed.reduce((key, member) => advance(key, member!), 0);
    let states = new Map([[initial, fixed.reduce((sum, member) => sum + value(member!), 0)]]);
    const groups = new Map<number, MemberState[]>();
    for (const member of available) {
      if (characters.has(member.card.characterId)) continue;
      const group = groups.get(member.card.characterId) ?? [];
      group.push(member); groups.set(member.card.characterId, group);
    }
    for (const group of groups.values()) {
      const next = new Map(states);
      for (const [key, amount] of states) {
        if (Math.floor(key / width) === 5) continue;
        for (const member of group) {
          const target = advance(key, member);
          next.set(target, Math.max(next.get(target) ?? -Infinity, amount + value(member)));
        }
      }
      states = next;
    }
    return states.get(6 * width - 1) ?? null;
  }
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

function snapUpperBound(snaps: readonly SnapState[], constraints: ConstraintInput, value: (snap: SnapState) => number): number | null {
  const available = snaps.filter(snap => !constraints.excludedSnaps.includes(snap.key));
  const byKey = new Map(available.map(snap => [snap.key, snap]));
  const bound = constraints.bindings.flatMap(([, snap]) => snap === null ? [] : [snap]);
  const required = new Set([...constraints.requiredSnaps, ...bound]);
  const empty = constraints.bindings.length - bound.length;
  if (new Set(bound).size !== bound.length || byKey.size !== available.length || required.size > 5 - empty ||
    [...required].some(key => !byKey.has(key)) || constraints.noSnaps && required.size > 0) return null;
  if (constraints.noSnaps) return 0;
  return [...required].reduce((sum, key) => sum + value(byKey.get(key)!), 0) +
    available.filter(snap => !required.has(snap.key)).map(value).sort((a, b) => b - a)
      .slice(0, 5 - empty - required.size).reduce((sum, amount) => sum + amount, 0);
}

export interface TeamConstraintLimits {
  combo: number | null;
  justMs: number | null;
  members: [number | null, number | null, number | null];
  eventBonus: number | null;
  memberConditionsUnreachable: boolean;
}

/** Card limits respect fixed cards and joint member floors; dynamic skill gates remain relaxed. */
export function teamConstraintLimits(master: EngineMaster, data: TeamBuilderData, request: EngineRequest): TeamConstraintLimits {
  const { members, snaps, unknown } = resolveBox(master, request.members, request.snaps, request.unknownPolicy);
  const unavailable: TeamConstraintLimits = { combo: null, justMs: null, members: [null, null, null], eventBonus: null, memberConditionsUnreachable: false };
  if (unknown.length) return unavailable;
  const goal = request.goal;
  const arena = goal.kind === "gekiso" ? goal.arena : undefined;
  const sets = new Map<string, number[]>();
  if ("songs" in goal) for (const song of goal.songs) {
    const missions = master.songs.get(song.songId)?.gekisoMissions.map((mission, index) =>
      arena?.missions[index] || request.songRules?.missions[index] || mission) ?? [];
    if (missions.some(mission => mission === 1 || mission === 4)) sets.set([...missions].sort().join(), missions);
  }
  const comboTables = new Map<string, Map<string, number>>();
  for (const missions of sets.values()) {
    const values = new Map(members.map(member => {
      const actor = performer(master, member, null);
      const group = (id: number) => id === 0 || (master.conditionSets.get(id) ?? []).some(set => set.every(id => {
        const condition = master.conditions.get(id)!;
        const value = condition.values[0];
        if (condition.type === 0) return true;
        if (condition.type === 5000) return condition.targetIds.some(id => performerMatches(actor, master.targets.get(id)!)) === condition.positive;
        if (condition.type === 2000) return value !== undefined && (master.live.lifeBase > value) === condition.positive;
        if (condition.type === 2001) return value !== undefined && (master.live.lifeBase >= value) === condition.positive;
        if (condition.type === 7005) return condition.positive && value !== undefined && value <= 1;
        if (condition.type === 7020) {
          const targets = condition.targetIds.map(id => master.targets.get(id)!).filter(target => target.skillTargetType === 5 && target.gekisouMissionType !== 0);
          return condition.positive && (!targets.length || targets.some(target => [1, 4].includes(target.gekisouMissionType) && missions.includes(target.gekisouMissionType)));
        }
        return false;
      }));
      const skill = master.gekisoSkills.get(member.card.gekisoSkillId);
      const value = skill && [1, 4].includes(skill.missionType) ? Math.max(0, skill.effects.filter(row =>
        row.level === member.growth.gekisoSkillLevel && row.type === 12000 && row.triggerType === 2 && row.seconds === 0 &&
        !row.cumulativeId && !row.resetGroup && !row.releaseGroup && group(row.triggerGroup) && group(row.conditionGroup))
        .reduce((sum, row) => sum + row.value, 0)) : 0;
      return [member.key, value] as const;
    }));
    comboTables.set(JSON.stringify([...values.values()]), values);
  }
  const comboValues = [...comboTables.values()].map(values => (member: MemberState) => values.get(member.key)!);
  const roleValue = (role: number) => (member: MemberState) => {
    const mission = master.gekisoSkills.get(member.card.gekisoSkillId)?.missionType;
    return Number(mission === role + 1 || mission === 4);
  };
  const minimums = request.constraints.minMissionMembers ?? [0, 0, 0];
  const roles = minimums.flatMap((minimum, role) => Number.isInteger(minimum) && minimum > 0 && minimum <= 5
    ? [{ minimum, value: roleValue(role), role }] : []);
  const maxima = comboValues.map(value => memberUpperBound(members, request.constraints, value, roles) ?? memberUpperBound(members, request.constraints, value));
  const memberCombo = maxima.some(value => value === null) ? null : Math.min(...maxima as number[]);
  const minimum = goal.kind === "gekiso" ? goal.minComboBonus : goal.kind === "event" ? goal.gekiso?.minComboBonus : undefined;
  const comboRequirements = minimum !== undefined && validGekisoCount(minimum, 1) && minimum > 1
    ? comboValues.map(value => ({ minimum: minimum - 1, value })) : [];
  const requirements = [...roles, ...comboRequirements];
  const timings = dataRows(data.liveTools.judgementTiming).filter(row => Number(row.assistLevel) === 0 && Number(row.noteJudgementType) === 1);
  const window = timings.find(row => Number(row.noteSimulateJudgement) === 6);
  const miss = timings.find(row => Number(row.noteSimulateJudgement) === 1);
  let justMs: number | null = null;
  if (window && miss) {
    const base = Math.min(Number(window.beforeMs), Number(window.afterMs));
    const cap = Math.min(Number(miss.beforeMs), Number(miss.afterMs));
    const possible = (group: number, actor: ReturnType<typeof performer>) => group === 0 ||
      (master.conditionSets.get(group) ?? []).some(set => set.every(id => {
        const condition = master.conditions.get(id)!;
        return condition.type !== 5000 || condition.targetIds.some(id => performerMatches(actor, master.targets.get(id)!)) === condition.positive;
      }));
    const extra = (rows: readonly SkillEffectRow[], level: number, actor: ReturnType<typeof performer>) => rows.filter(row =>
      row.level === level && row.type === 4004 && possible(row.conditionGroup, actor) && possible(row.triggerGroup, actor))
      .reduce((sum, row) => {
        if (row.cumulativeId || row.executeLimit || row.limitCount || row.maxValue || row.resetGroup || row.releaseGroup) return cap;
        return sum + Math.max(0, Math.ceil(Math.fround(Math.fround(row.value / 10000) * base)));
      }, 0);
    const justValue = (member: MemberState) => {
      const actor = performer(master, member, null);
      return extra(master.gekisoSkills.get(member.card.gekisoSkillId)?.effects ?? [], member.growth.gekisoSkillLevel, actor) +
        extra(master.liveSkills.get(member.card.liveSkillId) ?? [], member.growth.liveSkillLevel, actor);
    };
    const memberJust = memberUpperBound(members, request.constraints, justValue, requirements) ?? memberUpperBound(members, request.constraints, justValue);
    const fixedSnaps = new Map(request.constraints.bindings.flatMap(([member, snap]) => snap === null ? [] : [[snap, member] as const]));
    const fixedMembers = new Set(request.constraints.bindings.map(([member]) => member));
    const requiredMembers = new Set([...request.constraints.requiredMembers, ...fixedMembers,
      ...(request.constraints.leader === null ? [] : [request.constraints.leader])]);
    const fixedCharacters = new Set(members.filter(member => requiredMembers.has(member.key)).map(member => member.card.characterId));
    const owners = members.filter(member => !request.constraints.excludedMembers.includes(member.key) &&
      (requiredMembers.has(member.key) || requiredMembers.size < 5 && !fixedCharacters.has(member.card.characterId)));
    const snapJust = snapUpperBound(snaps, request.constraints, snap => {
      const bound = fixedSnaps.get(snap.key);
      return owners.filter(member => bound ? member.key === bound : !fixedMembers.has(member.key)).reduce((maximum, member) => {
        const actor = performer(master, member, snap);
        const value = snap.card.gekisoSupportSkillIds.reduce((sum, id, index) => sum +
          extra(master.gekisoSupportSkills.get(id)?.effects ?? [], snap.gekisoSkillLevels[index]!, actor), 0) +
          snap.card.supportSkillIds.reduce((sum, id, index) => sum + extra(master.supportSkills.get(id) ?? [], snap.skillLevels[index]!, actor), 0);
        return Math.max(maximum, value);
      }, 0);
    });
    if (memberJust !== null && snapJust !== null) justMs = Math.min(cap, base + memberJust + snapJust);
  }
  return {
    combo: memberCombo === null || !Number.isFinite(memberCombo) ? null : 1 + memberCombo,
    justMs,
    members: [0, 1, 2].map(role => memberUpperBound(members, request.constraints, roleValue(role),
      [...roles.filter(requirement => requirement.role !== role), ...comboRequirements]) ??
      memberUpperBound(members, request.constraints, roleValue(role), roles.filter(requirement => requirement.role !== role)) ??
      memberUpperBound(members, request.constraints, roleValue(role))) as TeamConstraintLimits["members"],
    eventBonus: eventBonusUpperBound(master, request, members, snaps),
    memberConditionsUnreachable: requirements.length > 0 && memberUpperBound(members, request.constraints, () => 0, requirements) === null,
  };
}

function eventBonusUpperBound(master: EngineMaster, request: EngineRequest, members: readonly MemberState[], snaps: readonly SnapState[]): number | null {
  const { goal, constraints } = request;
  if (goal.kind !== "event" || !goal.rewardPlan && goal.measure === "challenge-points") return null;
  const metric: RewardMetric = goal.rewardPlan
    ? goal.rewardPlan.levels.flat().find((term) => term.metric !== "challenge-points")?.metric ?? "points"
    : goal.measure;
  const effects = goal.eventEffects ?? master.events.get(goal.eventId)?.effects;
  if (!effects) return null;
  const bonusType = metric === "items" ? 1 : 0;
  const memberUpper = memberUpperBound(members, constraints, member => Math.max(0, memberEventPercent(effects, member, bonusType)));
  const snapUpper = snapUpperBound(snaps, constraints, snap => Math.max(0, snapEventPercent(effects, snap, bonusType)));
  return memberUpper === null || snapUpper === null ? null : (memberUpper + snapUpper) / 100;
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
