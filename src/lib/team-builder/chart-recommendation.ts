// L3 — GEB
// Input: Ordinary Live request and release-pinned rates for the filtered charts.
// Output: Candidate charts ordered by estimated average score.
// Pos: [Map](L2-2.md); approximate ranking before native team search.
// Effects/Dependencies: Lazily decodes shared timelines and yields between charts.

import { SKILL_WINDOWS, slotOrderRates, type ChartRateTable, type ChartRates } from "../chart-rates";
import { prepareChartRecommendationPlay } from "./chart-recommendation-play";
import { loadChartScoreTimelines } from "./chart-score-timeline";
import { musicView, playerState, type EngineRequest, type Goal, type SongRef } from "./engine/api";
import { resolveBox } from "./engine/box";
import { chartKey } from "./engine/charts";
import { isAllPerfect, type PlayModel } from "./engine/live";
import type { EngineMaster } from "./engine/master";
import { leaderPercentBound, leaderPoints, leaderProfile, slotBase, snapPoints, teamPower, type MemberState, type SnapState } from "./engine/power";
import { maxAssignment } from "./engine/search";
import { effectPercent, resolveSlotSkill, windowMs, type SlotSkill } from "./engine/skills";

type ScoreRequest = EngineRequest & { goal: Extract<Goal, { kind: "score" }> };
const average = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const minRateWindow = SKILL_WINDOWS[0]!;
const maxRateWindow = SKILL_WINDOWS.at(-1)!;

function needsTimeline({ effects, extensionMs }: SlotSkill) {
  const first = effects[0] && windowMs(effects[0].seconds, extensionMs);
  return effects.some(({ seconds }) => {
    const duration = windowMs(seconds, extensionMs);
    return duration !== first || duration < minRateWindow || duration > maxRateWindow;
  });
}

function estimateLineups(master: EngineMaster, request: ScoreRequest, replay: boolean) {
  const { constraints, goal } = request;
  const { members, snaps } = resolveBox(master, request.members, request.snaps, request.unknownPolicy);
  const memberPool = members.filter((member) => !constraints.excludedMembers.includes(member.key));
  const snapPool = constraints.noSnaps ? [] : snaps.filter((snap) => !constraints.excludedSnaps.includes(snap.key));
  const bindings = new Map(constraints.bindings);
  const requiredMembers = new Set([...constraints.requiredMembers, ...bindings.keys()]);
  if (constraints.leader) requiredMembers.add(constraints.leader);
  const fixed = memberPool.filter((member) => requiredMembers.has(member.key));
  const fixedCharacters = new Set(fixed.map((member) => member.card.characterId));
  const bindingKeys = [...bindings.values()].filter((key): key is string => key !== null);
  const bound = new Set(bindingKeys);
  const availableSnaps = snapPool.filter((snap) => !bound.has(snap.key));
  const forceSnaps = constraints.requiredSnaps.filter((key) => !bound.has(key))
    .map((key) => availableSnaps.find((snap) => snap.key === key));
  if (
    fixed.length !== requiredMembers.size ||
    fixed.length !== fixedCharacters.size ||
    fixed.length > 5 ||
    forceSnaps.some((snap) => !snap) ||
    forceSnaps.length > 5 - bindings.size ||
    [...bound].some((key) => !snapPool.some((snap) => snap.key === key)) ||
    bound.size !== bindingKeys.length
  )
    return null;

  const player = playerState(master, request.player);
  const fixedLeader = fixed.find((member) => member.key === constraints.leader);
  const leader = fixedLeader && leaderProfile(master, fixedLeader);
  const slots = new Map(memberPool.map((member) => [member.key, resolveSlotSkill(master, member, null, undefined, replay)]));
  const skill = (member: MemberState) => {
    const slot = slots.get(member.key)!;
    return effectPercent(slot, 2000) + effectPercent(slot, 2004);
  };
  const pairSkills = new Map<string, Map<string, SlotSkill>>();
  const pairedSkill = (member: MemberState, snap: SnapState | null) => {
    if (!snap) return slots.get(member.key)!;
    let pairs = pairSkills.get(member.key);
    if (!pairs) pairSkills.set(member.key, (pairs = new Map()));
    let result = pairs.get(snap.key);
    if (!result) pairs.set(snap.key, (result = resolveSlotSkill(master, member, snap, undefined, replay)));
    return result;
  };
  const damagingGrades: number[] = [];
  if (goal.play.bad > 0) damagingGrades.push(2);
  if (goal.play.miss > 0 || (goal.play.missEvery ?? 0) > 0) damagingGrades.push(1);
  const seenSustain = new WeakMap<SlotSkill, number>();
  const sustainValue = (slot: SlotSkill) => {
    let value = seenSustain.get(slot);
    if (value !== undefined) return value;
    const life = Math.max(1, master.live.lifeBase);
    const to = slot.convert?.to ?? 5;
    const avoidedDamage = Math.max(0, ...(slot.convert?.judgements ?? [])
      .filter((grade) => damagingGrades.includes(grade))
      .map((grade) => master.live.damage[grade]! - master.live.damage[to]!));
    const conversion = avoidedDamage * Math.min(slot.convert?.limit ?? 0, life / Math.max(1, avoidedDamage));
    value = (slot.recovery + conversion) / life;
    seenSustain.set(slot, value);
    return value;
  };
  const cache = new Map<string, ReturnType<typeof lineups>>();

  function lineups(music: ReturnType<typeof musicView>) {
    const bases = new Map(memberPool.map((member) => [member.key, slotBase(master, player, member, music, 0)]));
    const maxPower = Math.max(1, ...[...bases.values()].map((base) => base.fixedPoints));
    const priorities = ["power", "skill"];
    if (availableSnaps.length) {
      priorities.push("snap");
      if (replay) priorities.push("sustain");
    }
    const seen = new Set<string>();
    return priorities.flatMap((priority) => {
      const withSustain = priority === "sustain";
      const withSkill = priority !== "power";
      const withSupport = priority === "snap" || withSustain;
      const pairValue = (member: MemberState, snap: SnapState) => {
        const points = snapPoints(master, bases.get(member.key)!, member, snap, 0);
        if (!withSkill) return points;
        const slot = pairedSkill(member, snap);
        return points + slot.extensionMs * maxPower / 20000 +
          (withSustain ? maxPower * sustainValue(slot) / 2 : 0);
      };
      const value = (member: MemberState) => {
        const base = bases.get(member.key)!;
        const captain = replay && withSupport && leader
          ? leaderPoints(base, leaderPercentBound(master, leader, member)) : 0;
        const support = withSupport
          ? availableSnaps.reduce((best, snap) => Math.max(best, pairValue(member, snap)), 0) : 0;
        return base.fixedPoints + captain + support + (withSkill ? maxPower * skill(member) / 500 : 0);
      };
      const ranked = memberPool.map((member) => ({ member, value: value(member) })).sort((a, b) => b.value - a.value);
      const characters = new Set(fixedCharacters);
      const team = [...fixed];
      for (const { member } of ranked) {
        if (team.length === 5) break;
        if (characters.has(member.card.characterId)) continue;
        team.push(member);
        characters.add(member.card.characterId);
      }
      if (team.length !== 5) return [];

      const open = [...availableSnaps];
      const assigned = new Map<string, SnapState | null>();
      for (const [key, snap] of bindings) assigned.set(key, snapPool.find((card) => card.key === snap) ?? null);
      for (const required of forceSnaps) {
        const snap = required!;
        const best = team.filter((member) => !assigned.has(member.key))
          .sort((a, b) => pairValue(b, snap) - pairValue(a, snap))[0]!;
        assigned.set(best.key, snap);
        open.splice(open.indexOf(snap), 1);
      }
      const freeSlots = team.filter((member) => !assigned.has(member.key));
      if (replay && freeSlots.length && open.length) {
        const columns = open.length + freeSlots.length;
        const picked = new Int32Array(freeSlots.length);
        const weights = freeSlots.map((member) =>
          Float64Array.from({ length: columns }, (_, i) => i < open.length ? pairValue(member, open[i]!) : 0),
        );
        maxAssignment(weights, columns, picked);
        for (const [i, member] of freeSlots.entries()) assigned.set(member.key, open[picked[i]!] ?? null);
      } else {
        for (const member of freeSlots) {
          let best = -1;
          let bestValue = -Infinity;
          for (const [i, snap] of open.entries()) {
            const value = pairValue(member, snap);
            if (value > bestValue) {
              best = i;
              bestValue = value;
            }
          }
          assigned.set(member.key, best < 0 ? null : open.splice(best, 1)[0]!);
        }
      }
      const support = team.map((member) => assigned.get(member.key) ?? null);
      if (replay) {
        const identity = JSON.stringify(team.map((member, i) => [member.key, support[i]?.key]).sort());
        if (seen.has(identity)) return [];
        seen.add(identity);
      }
      const leaders = constraints.leader ? [team.findIndex((member) => member.key === constraints.leader)] : [0, 1, 2, 3, 4];
      const power = Math.max(...leaders.map((leader) => teamPower(master, player, team, support, leader, music).total));
      const programs = team.map((member, i) => pairedSkill(member, support[i] ?? null));
      const useTimeline = replay || programs.some(needsTimeline);
      return [{
        power,
        useTimeline,
        programs: useTimeline && !replay
          ? team.map((member, i) => resolveSlotSkill(master, member, support[i] ?? null, undefined, true))
          : programs,
      }];
    });
  }

  return (songId: number) => {
    const music = musicView(master, songId, null);
    if (request.songRules?.musicType) music.musicType = request.songRules.musicType;
    const identity = JSON.stringify([music.musicType, music.bestTags, player.musicMemory.get(music.memoryKey) ?? 0]);
    let result = cache.get(identity);
    if (!result) cache.set(identity, (result = lineups(music)));
    return result;
  };
}

const hasJudgements = (play: PlayModel) => !isAllPerfect(play);

function apScore(rates: ChartRates, power: number, programs: SlotSkill[]) {
  const skills = programs.map((slot) => ({
    score: effectPercent(slot, 2000),
    perfect: effectPercent(slot, 2004),
    extensionMs: Math.max(0, ...slot.effects.map((effect) => effect.seconds * 1000 + slot.extensionMs - minRateWindow)),
  }));
  return average(slotOrderRates({ base: rates.base, general: rates.windows, perfect: rates.windows }, skills)
    .map((rate) => rate * power));
}

export async function rankPickerCharts(
  master: EngineMaster,
  request: EngineRequest,
  tableFor: (song: SongRef) => ChartRateTable | undefined,
  signal: AbortSignal,
): Promise<SongRef[] | null> {
  signal.throwIfAborted();
  const { goal } = request;
  if (goal.kind !== "score" || goal.criterion !== "mean" || goal.target || goal.challengeEventId !== null ||
      goal.play.cumulativeTiming || request.aggregation || request.members.length < 5) return [];
  const replay = hasJudgements(goal.play);
  const tables = new Map<ChartRateTable, Awaited<ReturnType<typeof loadChartScoreTimelines>>>();
  const candidates = goal.songs.map((song) => {
    const table = tableFor(song);
    const key = chartKey(song);
    return { song, key, table, rates: table?.charts[key] };
  });
  if (candidates.some(({ rates }) => !rates)) return null;
  if (replay) {
    await Promise.all([...new Set(candidates.map(({ table }) => table!))].map(async (table) => {
      tables.set(table, await loadChartScoreTimelines(table));
    }));
    signal.throwIfAborted();
    if (candidates.some(({ table, key }) => !tables.get(table!)!.has(key))) return null;
  }
  const lineups = estimateLineups(master, { ...request, goal }, replay);
  if (!lineups) return [];
  const output: { song: SongRef; score: number }[] = [];
  let until = performance.now() + 8;
  for (const { song, table, key, rates } of candidates) {
    const teams = lineups(song.songId);
    if (!teams.length) return [];
    let prepared: ReturnType<typeof prepareChartRecommendationPlay> | undefined;
    if (teams.some(({ useTimeline }) => useTimeline)) {
      let timelines = tables.get(table!);
      if (!timelines) {
        timelines = await loadChartScoreTimelines(table!);
        signal.throwIfAborted();
        tables.set(table!, timelines);
      }
      const timeline = timelines.get(key);
      if (!timeline) return null;
      const level = master.songs.get(song.songId)!.difficulties.find((row) => row.difficulty === song.difficulty)!;
      prepared = prepareChartRecommendationPlay(master, level.playLevel, rates!.notes, timeline, goal.play);
    }
    const score = Math.max(...teams.map(({ power, programs, useTimeline }) =>
      useTimeline ? average(prepared!.scores(power, programs)) : apScore(rates!, power, programs),
    ));
    output.push({ song, score });
    if (performance.now() >= until) {
      await (globalThis.scheduler?.yield?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 0)));
      signal.throwIfAborted();
      until = performance.now() + 8;
    }
  }
  return output.sort((a, b) => b.score - a.score || a.song.songId - b.song.songId || a.song.difficulty - b.song.difficulty)
    .map(({ song }) => song);
}
