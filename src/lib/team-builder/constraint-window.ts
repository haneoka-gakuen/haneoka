// L3 — GEB
// Input: Resolved skill effects, JUST policy and cached native charts.
// Output: Mode-specific note and duration envelopes for JUST constraint limits.
// Pos: [Map](L2-2.md); shared geometry and native rounding for the card-limit preflight.
// Effects/Dependencies: Pure; converts each cached chart once, without starting a search.
import type { EngineChart } from "./engine/protocol";
import type { JustWindowPolicy } from "./engine/api";
import type { EngineMaster, SkillEffectRow } from "./engine/master";
import type { Performer } from "./engine/full/conditions";
import { performerMatches } from "./engine/full/conditions";
import { f, roundTiesEven } from "./engine/full/num";
import { runtimeChart } from "./engine/runtime-chart";
import type { ChartSource } from "./engine/chart";

export interface WindowPhase { active: boolean; until: number; base?: number; cap?: number }
export interface WindowRange {
  notes: { phase: WindowPhase; tap: boolean }[];
  spans: { phase: WindowPhase; start: number; end: number }[];
}
const sources = new WeakMap<object, ChartSource>();
const frame = (time: number) => Math.ceil(time * 60 / 1000);
const timeAt = (frame: number) => Math.floor(frame * 1000 / 60);
export const peakPhase: WindowPhase = { active: true, until: 0 };

export function windowRanges(master: EngineMaster, chart: EngineChart, missions: readonly number[], windows: ReadonlyMap<number, { base: number; cap: number }>): WindowRange[] {
  let source = sources.get(chart.chart);
  if (!source) { source = runtimeChart(chart.chart); sources.set(chart.chart, source); }
  const durations = [...new Set([master.gekisoSkills, master.gekisoSupportSkills].flatMap(skills => [...skills.values()].flatMap(skill =>
    skill.effects.filter(row => row.type === 4004 && row.seconds > 0).map(row => row.seconds * 1000))))].sort((a, b) => a - b);
  const bucket = (until: number) => durations.reduce((at, duration) => duration < until ? duration + 1 : at, 0);
  return source.feverMs.flatMap(([start, end], index) => {
    if (missions[index] !== 3) return [];
    const first = frame(start);
    const notes = source!.notes.filter(note => note.judged && master.live.justTypes.has(note.judgementType))
      .map(note => ({ note, at: frame(note.timeMs) }))
      .filter(({ at }) => timeAt(at) >= start && timeAt(at) < end)
      .map(({ note, at }) => ({ tap: note.operateType === 1, phase: { active: at > first, until: bucket(Math.max(0, timeAt(at - 1) - start)), ...windows.get(note.judgementType) } }));
    if (!notes.length) return [];
    const boundaries = [...new Set([start, end, ...durations.map(duration => Math.min(end, start + duration + 34))])].sort((a, b) => a - b);
    const spans = boundaries.slice(1).map((end, index) => ({ start: boundaries[index]!, end,
      phase: { active: true, until: bucket(Math.max(0, boundaries[index]! - start - 1)) } }));
    return [{ notes, spans }];
  });
}

function possible(master: EngineMaster, group: number, actor: Performer): boolean {
  return group === 0 || (master.conditionSets.get(group) ?? []).some(set => set.every(id => {
    const condition = master.conditions.get(id)!;
    return condition.type !== 5000 || condition.targetIds.some(id => performerMatches(actor, master.targets.get(id)!)) === condition.positive;
  }));
}

export function windowExtra(master: EngineMaster, rows: readonly SkillEffectRow[], level: number, actor: Performer,
  phase: WindowPhase, base: number, cap: number): number {
  return rows.filter(row => row.level === level && row.type === 4004 && possible(master, row.conditionGroup, actor) && possible(master, row.triggerGroup, actor))
    .reduce((sum, row) => {
      if (row.targetIds.length && row.targetIds.every(id => master.targets.get(id)!.judgement > 6)) return sum;
      if (row.cumulativeId || row.executeLimit || row.limitCount || row.maxValue || row.resetGroup || row.releaseGroup) return cap;
      const sets = master.conditionSets.get(row.triggerGroup);
      const trigger = sets?.length === 1 && sets[0]!.length === 1 ? master.conditions.get(sets[0]![0]!) : undefined;
      const justTrigger = trigger?.positive && !trigger.values.length && trigger.targetIds.length > 0 &&
        trigger.targetIds.every(id => master.targets.get(id)!.gekisouMissionType === 3);
      if (justTrigger && (trigger.type === 7010 || trigger.type === 7020)) {
        if (!phase.active) return sum;
        if (trigger.type === 7010 && row.triggerType === 1 && row.seconds > 0 && row.seconds * 1000 < phase.until) return sum;
      }
      return sum + Math.max(0, roundTiesEven(f(f(row.value / 10000) * base)));
    }, 0);
}

function weightedLimit(rows: readonly { value: number; weight: number }[], need: number): number {
  let count = 0;
  for (const row of [...rows].sort((a, b) => b.value - a.value)) {
    count += row.weight;
    if (count + 1e-8 >= need) return row.value;
  }
  return 0;
}

export function coverageLimit(ranges: readonly WindowRange[], policy: JustWindowPolicy | undefined, upper: (phase: WindowPhase) => number): number {
  if (!ranges.length) return upper(peakPhase);
  return Math.min(...ranges.map(range => {
    if (!policy) {
      const taps = range.notes.filter(note => note.tap);
      const active = taps.filter(note => note.phase.active);
      const probes = active.length ? active : taps;
      return probes.length ? Math.min(...probes.map(note => upper(note.phase))) : Infinity;
    }
    let limit = weightedLimit(range.notes.map(note => ({ value: upper(note.phase), weight: 1 })),
      Math.max(1, Math.ceil(range.notes.length * policy.minCoverage - 1e-12)));
    const spans = range.spans.map(span => ({ ...span, value: upper(span.phase) }));
    if (policy.minDurationMs > 0) limit = Math.min(limit, weightedLimit(spans.map(span => ({ value: span.value, weight: span.end - span.start })), policy.minDurationMs));
    if (policy.minContinuousMs > 0) {
      let continuous = 0;
      for (const threshold of [...new Set(spans.map(span => span.value))].sort((a, b) => b - a)) {
        let run = 0, longest = 0;
        for (const span of spans) { run = span.value >= threshold ? run + span.end - span.start : 0; longest = Math.max(longest, run); }
        if (longest + 1e-8 >= policy.minContinuousMs) { continuous = threshold; break; }
      }
      limit = Math.min(limit, continuous);
    }
    return limit;
  }));
}
