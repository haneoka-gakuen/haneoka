// L3 — GEB
// Input: Engine Master, actual search request and up to four shared cached native charts.
// Output: Linked event, opening COMBO, coverage-aware JUST and role-count upper bounds; native integer input checks.
// Pos: [Map](L2-2.md); live card limits and pre-submit validation for search constraints.
// Effects/Dependencies: Pure; uses the same resolved cards and event effects as the engine adapter.
import type { ConstraintInput, EngineRequest, RewardMetric } from "./engine/api";
import { resolveBox } from "./engine/box";
import type { EngineMaster } from "./engine/master";
import { memberEventPercent, snapEventPercent, type MemberState } from "./engine/power";
import { dataRows, type TeamBuilderData } from "./data";
import type { SnapState } from "./engine/power";
import type { EngineChart } from "./engine/protocol";
import { coverageLimit, peakPhase, windowExtra, windowRanges, type WindowPhase } from "./constraint-window";
import { performer } from "./engine/full/deck";
import { performerMatches } from "./engine/full/conditions";
import { maxAssignment } from "./engine/search";

export const MAX_GEKISO_COUNT = 2_147_483_647;
export const validGekisoCount = (value: number, minimum: number) =>
  Number.isSafeInteger(value) && value >= minimum && value <= MAX_GEKISO_COUNT;

type MemberRequirement = { minimum: number; value: (member: MemberState) => number };

/** Rewarded bypass columns leave five active slots; mandatory bonuses precede the skill objective. */
function formationUpperBound(members: readonly MemberState[], snaps: readonly SnapState[], constraints: ConstraintInput,
  value: (member: MemberState, snap: SnapState | null) => number | undefined): number | null {
  const bindings = new Map(constraints.bindings);
  const required = new Set([...constraints.requiredMembers, ...bindings.keys(), ...(constraints.leader ? [constraints.leader] : [])]);
  const requiredSnaps = new Set([...constraints.requiredSnaps, ...constraints.bindings.flatMap(([, snap]) => snap ? [snap] : [])]);
  const fixed = new Map(members.filter(member => required.has(member.key)).map(member => [member.card.characterId, member.key]));
  if (fixed.size !== required.size) return null;
  const groups = new Map<number, MemberState[]>();
  for (const member of members) {
    if (constraints.excludedMembers.includes(member.key) || fixed.has(member.card.characterId) && fixed.get(member.card.characterId) !== member.key) continue;
    const group = groups.get(member.card.characterId) ?? [];
    group.push(member); groups.set(member.card.characterId, group);
  }
  if (groups.size < 5) return null;
  const pool = constraints.noSnaps ? [] : snaps.filter(snap => !constraints.excludedSnaps.includes(snap.key));
  const boundSnaps = new Set([...bindings.values()].filter((key): key is string => key !== null));
  const rows = [...groups.values()], columns = pool.length + rows.length;
  const realColumns = pool.length + 5, forbidden = -Number.MAX_SAFE_INTEGER / 4;
  const original = rows.map(group => Float64Array.from({ length: columns }, (_, column) => {
    if (column >= realColumns) return 0;
    const snap = pool[column] ?? null;
    return Math.max(forbidden, ...group.flatMap(member => {
      if (bindings.has(member.key) ? bindings.get(member.key) !== snap?.key && !(bindings.get(member.key) === null && snap === null) : snap && boundSnaps.has(snap.key)) return [];
      const amount = value(member, snap);
      return amount === undefined ? [] : [amount];
    }));
  }));
  const maximum = Math.max(1, ...original.flatMap(row => [...row].filter(value => value !== forbidden)));
  const requiredBonus = maximum * rows.length + 1;
  const skipBonus = requiredBonus * (required.size + requiredSnaps.size + 1);
  const weights = original.map((row, index) => Float64Array.from(row, (value, column) => value === forbidden ? forbidden
    : column >= realColumns ? fixed.has(rows[index]![0]!.card.characterId) ? forbidden : skipBonus
    : value + (fixed.has(rows[index]![0]!.card.characterId) ? requiredBonus : 0) + (requiredSnaps.has(pool[column]?.key ?? "") ? requiredBonus : 0)));
  const picked = new Int32Array(rows.length);
  maxAssignment(weights, columns, picked);
  const used = [...picked].flatMap((column, row) => column < realColumns ? [{ row, column }] : []);
  if (used.length !== 5 || used.some(({ row, column }) => original[row]![column] === forbidden) ||
    [...fixed.keys()].some(character => !used.some(({ row }) => rows[row]![0]!.card.characterId === character)) ||
    [...requiredSnaps].some(key => !used.some(({ column }) => pool[column]?.key === key))) return null;
  return used.reduce((sum, { row, column }) => sum + original[row]![column]!, 0);
}

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
    const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
    requirements = requirements.map(requirement => {
      const divisor = available.reduce((divisor, member) => gcd(divisor, requirement.value(member)), 0) || 1;
      return { minimum: Math.ceil(requirement.minimum / divisor), value: (member: MemberState) => requirement.value(member) / divisor };
    });
    let width = 1;
    const dimensions = requirements.map(requirement => {
      const stride = width;
      width *= requirement.minimum + 1;
      return { ...requirement, stride };
    });
    const contribution = (member: MemberState) => dimensions.map(dimension => dimension.value(member));
    const advance = (key: number, values: readonly number[]) => dimensions.reduce((target, dimension, index) => {
      const before = Math.floor(key / dimension.stride) % (dimension.minimum + 1);
      return target + (Math.min(dimension.minimum, before + values[index]!) - before) * dimension.stride;
    }, key + width);
    const initial = fixed.reduce((key, member) => advance(key, contribution(member!)), 0);
    let states = new Map([[initial, fixed.reduce((sum, member) => sum + value(member!), 0)]]);
    const groups = new Map<number, MemberState[]>();
    for (const member of available) {
      if (characters.has(member.card.characterId)) continue;
      const group = groups.get(member.card.characterId) ?? [];
      group.push(member); groups.set(member.card.characterId, group);
    }
    for (const group of groups.values()) {
      const profiles = new Map<string, { values: number[]; amount: number }>();
      for (const member of group) {
        const values = contribution(member), key = values.join(), amount = value(member);
        if (!profiles.has(key) || profiles.get(key)!.amount < amount) profiles.set(key, { values, amount });
      }
      const next = new Map(states);
      for (const [key, amount] of states) {
        if (Math.floor(key / width) === 5) continue;
        for (const profile of profiles.values()) {
          const target = advance(key, profile.values);
          next.set(target, Math.max(next.get(target) ?? -Infinity, amount + profile.amount));
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

/** Fixed cards and linked floors constrain each bound; dynamic skill gates remain relaxed. */
export function teamConstraintLimits(master: EngineMaster, data: TeamBuilderData, request: EngineRequest, charts: readonly EngineChart[] = []): TeamConstraintLimits {
  const { members: resolvedMembers, snaps, unknown } = resolveBox(master, request.members, request.snaps, request.unknownPolicy);
  const unavailable: TeamConstraintLimits = { combo: null, justMs: null, members: [null, null, null], eventBonus: null, memberConditionsUnreachable: false };
  if (unknown.length) return unavailable;
  const goal = request.goal;
  const arena = goal.kind === "gekiso" ? goal.arena : undefined;
  const members = arena ? resolvedMembers.filter(member => member.card.bandId === arena.bandId) : resolvedMembers;
  const bounds = new Map<string, number | null>();
  const memberBound = (value: (member: MemberState) => number, requirements: readonly MemberRequirement[] = []) => {
    const key = JSON.stringify([members.map(value), requirements.map(requirement => [requirement.minimum, members.map(requirement.value)])]);
    if (!bounds.has(key)) bounds.set(key, memberUpperBound(members, request.constraints, value, requirements));
    return bounds.get(key)!;
  };
  const sets = new Map<string, number[]>();
  let hasJust = false;
  if ("songs" in goal) for (const song of goal.songs) {
    const missions = master.songs.get(song.songId)?.gekisoMissions.map((mission, index) =>
      arena?.missions[index] || request.songRules?.missions[index] || mission) ?? [];
    hasJust ||= missions.includes(3);
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
  const maxima = comboValues.map(value => memberBound(value, roles) ?? memberBound(value));
  const memberCombo = maxima.some(value => value === null) ? null : Math.min(...maxima as number[]);
  const minimum = goal.kind === "gekiso" ? goal.minComboBonus : goal.kind === "event" ? goal.gekiso?.minComboBonus : undefined;
  const comboRequirements = minimum !== undefined && validGekisoCount(minimum, 1) && minimum > 1
    ? comboValues.map(value => ({ minimum: minimum - 1, value })) : [];
  const requirements = [...roles, ...comboRequirements];
  const gekiso = goal.kind === "gekiso" ? goal : goal.kind === "event" ? goal.gekiso : undefined;
  const windowTarget = gekiso?.justWindow?.minimumMs ?? gekiso?.minJustWindowMs ?? 0;
  const justRequirements: MemberRequirement[] = [];
  let justAssignment: { minimum: number; maximum: number; bound: (value: (member: MemberState) => number, multiplier: number) => number | null } | null = null;
  const timings = dataRows(data.liveTools.judgementTiming).filter(row => Number(row.assistLevel) === 0 && Number(row.noteJudgementType) === 1);
  const window = timings.find(row => Number(row.noteSimulateJudgement) === 6);
  const miss = timings.find(row => Number(row.noteSimulateJudgement) === 1);
  let justMs: number | null = null;
  if (window && miss && hasJust && windowTarget > 0) {
    const base = Math.min(Number(window.beforeMs), Number(window.afterMs));
    const cap = Math.min(Number(miss.beforeMs), Number(miss.afterMs));
    const timingRows = dataRows(data.liveTools.judgementTiming).filter(row => Number(row.assistLevel) === 0);
    const windows = new Map(timingRows.filter(row => Number(row.noteSimulateJudgement) === 6).map(row => {
      const limit = timingRows.find(limit => Number(limit.noteJudgementType) === Number(row.noteJudgementType) && Number(limit.noteSimulateJudgement) === 1)!;
      return [Number(row.noteJudgementType), { base: Math.min(Number(row.beforeMs), Number(row.afterMs)),
        cap: Math.min(Math.max(Number(row.beforeMs), Number(limit.beforeMs)), Math.max(Number(row.afterMs), Number(limit.afterMs))) }] as const;
    }));
    const fixedSnaps = new Map(request.constraints.bindings.flatMap(([member, snap]) => snap === null ? [] : [[snap, member] as const]));
    const fixedMembers = new Set(request.constraints.bindings.map(([member]) => member));
    const requiredMembers = new Set([...request.constraints.requiredMembers, ...fixedMembers,
      ...(request.constraints.leader === null ? [] : [request.constraints.leader])]);
    const fixedCharacters = new Set(members.filter(member => requiredMembers.has(member.key)).map(member => member.card.characterId));
    const owners = members.filter(member => !request.constraints.excludedMembers.includes(member.key) &&
      (requiredMembers.has(member.key) || requiredMembers.size < 5 && !fixedCharacters.has(member.card.characterId)));
    const allowedSnaps = request.constraints.noSnaps ? [] : snaps.filter(snap => !request.constraints.excludedSnaps.includes(snap.key));
    const phases = new Map<string, { upper: number; base: number; member: (member: MemberState) => number; maximum: number; assignment: (value: (member: MemberState) => number, multiplier: number) => number | null }>();
    const phaseLimit = (phase: WindowPhase) => {
      const key = `${phase.active}:${phase.until}:${phase.base ?? base}:${phase.cap ?? cap}`;
      const cached = phases.get(key);
      if (cached) return cached;
      const phaseBase = phase.base ?? base;
      const values = new Map(members.map(member => {
        const actor = performer(master, member, null);
        return [member.key, windowExtra(master, master.gekisoSkills.get(member.card.gekisoSkillId)?.effects ?? [], member.growth.gekisoSkillLevel, actor, phase, phaseBase, cap) +
          windowExtra(master, master.liveSkills.get(member.card.liveSkillId) ?? [], member.growth.liveSkillLevel, actor, phase, phaseBase, cap)] as const;
      }));
      const memberValue = (member: MemberState) => values.get(member.key)!;
      const pairValues = new Map<string, Map<string, number>>();
      for (const member of owners) {
        const bound = request.constraints.bindings.find(([key]) => key === member.key);
        const pairs = new Map<string, number>();
        for (const snap of allowedSnaps) {
          if (bound ? bound[1] !== snap.key : fixedSnaps.has(snap.key)) continue;
          const actor = performer(master, member, snap);
          const value = (actor.gekisouSkill ? snap.card.gekisoSupportSkillIds.reduce((sum, id, index) => sum +
            windowExtra(master, master.gekisoSupportSkills.get(id)?.effects ?? [], snap.gekisoSkillLevels[index]!, actor, phase, phaseBase, cap), 0) : 0) +
            snap.card.supportSkillIds.reduce((sum, id, index) => sum + windowExtra(master, master.supportSkills.get(id) ?? [], snap.skillLevels[index]!, actor, phase, phaseBase, cap), 0);
          pairs.set(snap.key, value);
        }
        pairValues.set(member.key, pairs);
      }
      const snapValue = snapUpperBound(snaps, request.constraints, snap => Math.max(0, ...owners.map(member => pairValues.get(member.key)?.get(snap.key) ?? 0)));
      const memberValueUpper = memberBound(memberValue, requirements) ?? memberBound(memberValue);
      const pairedValue = (member: MemberState) => memberValue(member) + Math.max(0, ...pairValues.get(member.key)?.values() ?? []);
      const pairedUpper = memberBound(pairedValue, requirements) ?? memberBound(pairedValue);
      const assignments = new Map<string, number | null>();
      const assignment = (value: (member: MemberState) => number, multiplier: number) => {
        const key = JSON.stringify([members.map(value), multiplier]);
        if (!assignments.has(key)) assignments.set(key, formationUpperBound(members, snaps, request.constraints, (member, snap) => {
          const extra = snap ? pairValues.get(member.key)?.get(snap.key) : 0;
          return extra === undefined ? undefined : value(member) + multiplier * (memberValue(member) + extra);
        }));
        return assignments.get(key)!;
      };
      const matching = assignment(() => 0, 1);
      const upper = snapValue === null || memberValueUpper === null || pairedUpper === null ? cap
        : Math.min(phase.cap ?? cap, phaseBase + Math.min(memberValueUpper + snapValue, pairedUpper, matching ?? Infinity));
      const result = { upper, base: phaseBase, member: pairedValue, maximum: matching ?? pairedUpper ?? cap, assignment };
      phases.set(key, result);
      return result;
    };
    const ranges = charts.flatMap(chart => {
      if (!("songs" in goal) || !goal.songs.some(song => song.songId === chart.song.songId && song.difficulty === chart.song.difficulty)) return [];
      const song = master.songs.get(chart.song.songId);
      if (!song) return [];
      const missions = song.gekisoMissions.map((mission, index) => arena?.missions[index] || request.songRules?.missions[index] || mission);
      return windowRanges(master, chart, missions, windows);
    });
    justMs = charts.length && !ranges.length ? null : coverageLimit(ranges, gekiso?.justWindow, phase => phaseLimit(phase).upper);
    if (justMs !== null && !Number.isFinite(justMs)) justMs = null;
    if (windowTarget > base && charts.length && justMs !== null) {
      const phase = !gekiso?.justWindow && ranges.length
        ? [...phases.values()].sort((a, b) => a.upper - b.upper)[0]!
        : phaseLimit(peakPhase);
      if (windowTarget - phase.base > 0) {
        justRequirements.push({ minimum: Math.ceil(windowTarget - phase.base), value: phase.member });
        justAssignment = { minimum: windowTarget - phase.base, maximum: phase.maximum, bound: phase.assignment };
      }
    }
  }
  const linkedRequirements = [...roles, ...justRequirements];
  const linkedUpper = (value: (member: MemberState) => number, requirements: readonly MemberRequirement[]) => {
    let upper = memberBound(value, requirements);
    if (upper === null || !justAssignment || justAssignment.minimum > justAssignment.maximum) return upper;
    const small = 2 ** -Math.ceil(Math.log2(justAssignment.maximum + 1));
    const lexicographic = justAssignment.bound(value, small);
    if (lexicographic !== null) {
      const count = Math.floor(lexicographic + 1e-8);
      upper = Math.min(upper, count);
      if (count === upper && (lexicographic - count) / small + 1e-8 >= justAssignment.minimum) return upper;
    }
    for (const multiplier of [0.25, 0.5, 1, 2]) {
      const bound = justAssignment.bound(value, multiplier);
      if (bound !== null) upper = Math.min(upper, Math.floor(bound - multiplier * justAssignment.minimum + 1e-8));
    }
    return Math.max(0, upper);
  };
  const linkedCombo = justRequirements.length ? comboValues.map(value => linkedUpper(value, linkedRequirements)) : maxima;
  const comboLimit = linkedCombo.some(value => value === null) ? memberCombo : Math.min(...linkedCombo as number[]);
  return {
    combo: comboLimit === null || !Number.isFinite(comboLimit) ? null : 1 + comboLimit,
    justMs,
    members: [0, 1, 2].map(role => linkedUpper(roleValue(role),
      [...roles.filter(requirement => requirement.role !== role), ...comboRequirements, ...justRequirements]) ??
      memberBound(roleValue(role), roles.filter(requirement => requirement.role !== role)) ??
      memberBound(roleValue(role))) as TeamConstraintLimits["members"],
    eventBonus: eventBonusUpperBound(master, request, members, snaps),
    memberConditionsUnreachable: requirements.length + justRequirements.length > 0 && memberBound(() => 0, [...requirements, ...justRequirements]) === null,
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
