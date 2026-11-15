// L3 — GEB
// Input: One published ordinary Live timeline, play settings and resolved candidate skills.
// Output: Per-order scores for ranking charts before native search.
// Pos: [Map](L2-2.md); timeline branch of ordinary chart recommendation.
// Effects/Dependencies: Decodes static data and reuses native judgment allocation and skill order symmetry. No I/O.

import { decodeChartScoreNotes, type ChartScoreTimeline } from "./chart-score-timeline";
import { difficultyFactor } from "./engine/chart";
import { playJudgements, type PlayModel } from "./engine/live";
import type { EngineMaster } from "./engine/master";
import { ORDERS, restoreOrderScores, skillOrderPlan } from "./engine/order-equivalence";
import { windowMs, type SlotSkill } from "./engine/skills";

const f = Math.fround;
const gradeBit = (grade: number) => 1 << grade;
const gradeMask = (grades: readonly number[]) => grades.reduce((mask, grade) => mask | gradeBit(grade), 0);

function bound(times: Int32Array, time: number) {
  let first = 0;
  let end = times.length;
  while (first < end) {
    const middle = (first + end) >>> 1;
    if (times[middle]! < time) first = middle + 1;
    else end = middle;
  }
  return first;
}

interface ConversionWindow {
  from: number;
  until: number;
  targets: number;
  to: number;
  limit: number;
}

interface ReplayLife {
  dead: number;
  gates: number[];
}

export function prepareChartRecommendationPlay(
  master: EngineMaster,
  level: number,
  noteCount: number,
  timeline: ChartScoreTimeline,
  play: PlayModel,
) {
  const { times, kinds, fractions, totalPercent } = decodeChartScoreNotes(timeline, noteCount, master.live.notePercent);
  const rate = play.frameRate ?? 60;
  const frame = (time: number) => Math.floor((Math.ceil((Math.max(0, time) * rate) / 1000) * 1000) / rate);
  const events = timeline.skillTimes.slice(0, 5).map((start, index) => ({
    start, index, boundary: bound(times, start + 1), delivered: bound(times, frame(start) + 1),
  })).sort((left, right) => left.start - right.start || left.index - right.index);
  const grades = playJudgements(noteCount, play, kinds);
  const { damage, lifeBase, lifeOnus } = master.live;
  const fractionsByGrade = Array.from({ length: 7 }, (_, grade) => f((master.live.judgePercent.get(7 - grade) ?? 0) / 100));
  const ladder = master.live.combo.get(0) ?? [];
  const combos = new Float32Array(noteCount + 1);
  let bonus = 0;
  let step = 0;
  for (let count = 0; count < combos.length; count++) {
    while (step < ladder.length && ladder[step]![0] <= count) bonus = ladder[step++]![1];
    combos[count] = f(1 + Math.min(bonus, 1));
  }
  const adjustment = (master.live.adjustment * difficultyFactor(level)) / Math.max(1, Math.ceil(f(totalPercent / 100)));
  const zeroRecovery = [0, 0, 0, 0, 0];
  const gradeSet = gradeMask(Array.from(new Set(grades)));
  const lifeSegments = [...events, { index: -1, boundary: noteCount, delivered: noteCount }];

  function trajectory(converts: readonly ConversionWindow[]) {
    const replay = converts.length ? grades.slice() : grades;
    // Later windows claim each note first. Each window consumes its limit in chart order.
    for (let c = converts.length - 1; c >= 0; c--) {
      const convert = converts[c]!;
      let left = convert.limit;
      const end = bound(times, convert.until + 1);
      for (let index = bound(times, convert.from + 1); left && index < end; index++) {
        const grade = grades[index]!;
        if (replay[index] !== grade || convert.to === grade || !(convert.targets & gradeBit(grade))) continue;
        replay[index] = convert.to;
        left--;
      }
    }
    const total = new Float64Array(noteCount + 1);
    const weights = new Float64Array(noteCount);
    const prefixes: (Float64Array | undefined)[] = [total];
    const losses = new Float64Array(noteCount + 1);
    const gradeIndices: (number[] | undefined)[] = [];
    let pending = 0;
    let combo = 0;
    let last = -1;
    for (let index = 0; index < noteCount; index++) {
      if (times[index] !== last) {
        combo = pending;
        last = times[index]!;
      }
      const grade = replay[index]!;
      const weight = fractions[index]! * combos[combo]! * fractionsByGrade[grade]!;
      weights[index] = weight;
      total[index + 1] = total[index]! + weight;
      losses[index + 1] = losses[index]! + (damage[grade] ?? 0);
      pending = grade <= 2 ? 0 : pending + 1;
    }
    const lifeCache = new Map<string, ReplayLife>();
    const life = (recoveries: readonly number[], key: string) => {
      let result = lifeCache.get(key);
      if (result) return result;
      result = { dead: lifeBase > 0 ? noteCount : 0, gates: [...zeroRecovery] };
      if (lifeBase <= 0) return result;
      let hp = lifeBase;
      let cursor = 0;
      for (const event of lifeSegments) {
        const loss = losses[event.boundary]! - losses[cursor]!;
        if (hp <= loss) {
          const needed = losses[cursor]! + hp;
          let end = event.boundary;
          while (cursor < end) {
            const mid = (cursor + end) >>> 1;
            if (losses[mid + 1]! < needed) cursor = mid + 1;
            else end = mid;
          }
          result.dead = cursor;
          break;
        }
        hp -= loss;
        cursor = event.boundary;
        if (event.index < 0) break;
        hp = Math.min(2 * lifeBase, hp + recoveries[event.index]!);
        result.gates[event.index] = Math.max(0, hp - (losses[event.delivered]! - losses[cursor]!));
      }
      lifeCache.set(key, result);
      return result;
    };
    return {
      life,
      prefix(grade: number) {
        let sums = prefixes[grade];
        if (!sums) {
          sums = new Float64Array(noteCount + 1);
          let sum = 0;
          for (let index = 0; index < noteCount; index++) {
            if (replay[index] === grade) sum += weights[index]!;
            sums[index + 1] = sum;
          }
          prefixes[grade] = sums;
        }
        return sums;
      },
      notesFor(grade: number) {
        let notes = gradeIndices[grade];
        if (!notes) {
          notes = [];
          for (let index = 0; index < noteCount; index++) if (replay[index] === grade) notes.push(index);
          gradeIndices[grade] = notes;
        }
        return notes;
      },
    };
  }
  const trajectories = new Map<string, ReturnType<typeof trajectory>>();
  const unassisted = trajectory([]);
  trajectories.set("", unassisted);

  function interval(prefix: Float64Array, start: number, end: number, dead: number) {
    const aliveEnd = Math.max(start, Math.min(dead, end));
    return prefix[aliveEnd]! - prefix[start]! + lifeOnus * (prefix[end]! - prefix[aliveEnd]!);
  }

  function scores(power: number, slots: readonly SlotSkill[]) {
    const plan = skillOrderPlan(slots);
    const output = new Float64Array(ORDERS.length);
    const window = (slot: SlotSkill, start: number): ConversionWindow | null => {
      const convert = slot.convert;
      if (!convert) return null;
      const targets = gradeMask(convert.judgements) & gradeSet;
      if (!targets) return null;
      const from = frame(start);
      const duration = convert.seconds === undefined
        ? windowMs(slot.effects[0]?.seconds ?? 5, slot.extensionMs)
        : windowMs(convert.seconds, 0);
      return {
        from, until: frame(from + duration), targets, to: convert.to ?? 5, limit: convert.limit,
      };
    };
    const opening = slots.flatMap((slot) => {
      const convert = slot.convert?.atStart ? window(slot, 0) : null;
      return convert ? [convert] : [];
    });
    const atEvent = events.map((event) => slots.map((slot) => {
      const convert = slot.convert && !slot.convert.atStart ? window(slot, event.start) : null;
      return {
        convert,
        conversionKey: convert && [convert.from, convert.until, convert.targets, convert.to, convert.limit].join(","),
        byLife: new WeakMap<ReplayLife, number[]>(),
        effects: slot.effects.map((effect) => {
          const end = event.start + windowMs(effect.seconds, slot.extensionMs);
          return {
            effect, first: bound(times, event.start), last: bound(times, end),
            releaseAfter: frame(frame(event.start) + 1), releaseUntil: frame(end + 1),
          };
        }),
      };
    }));
    const openingKey = opening.map(({ from, until, targets, to, limit }) => [from, until, targets, to, limit].join(",")).join(";");
    const hasRecovery = slots.some((slot) => slot.recovery !== 0);
    const recoveries = [...zeroRecovery];
    for (const index of plan.representatives) {
      const order = ORDERS[index]!;
      let key = openingKey;
      for (let i = 0; i < events.length; i++) {
        const event = events[i]!;
        const slot = order[event.index]!;
        const { conversionKey } = atEvent[i]![slot]!;
        if (conversionKey) key += ";" + conversionKey;
        if (hasRecovery) recoveries[event.index] = slots[slot]!.recovery;
      }
      let replay = trajectories.get(key);
      if (!replay) {
        const converts = [...opening];
        for (let i = 0; i < events.length; i++) {
          const convert = atEvent[i]![order[events[i]!.index]!]!.convert;
          if (convert) converts.push(convert);
        }
        replay = trajectory(converts);
        trajectories.set(key, replay);
      }
      const life = replay.life(recoveries, hasRecovery ? recoveries.join(",") : "");
      let value = interval(replay.prefix(0), 0, noteCount, life.dead);
      for (let i = 0; i < events.length; i++) {
        const event = events[i]!;
        const { byLife, effects } = atEvent[i]![order[event.index]!]!;
        let contributions = byLife.get(life);
        if (!contributions) {
          contributions = [];
          for (const { effect, first, last, releaseAfter, releaseUntil } of effects) {
            const { gate, releaseJudgements } = effect;
            if (gate.kind === "never" || (gate.kind === "life-at-least" && (life.gates[event.index]! >= gate.value) !== gate.positive)) continue;
            let end = last;
            if (releaseJudgements?.length) {
              let releaseFrame = Infinity;
              let release = noteCount;
              for (const grade of releaseJudgements) {
                for (const note of replay.notesFor(grade)) {
                  const due = frame(times[note]!);
                  if (due <= releaseAfter) continue;
                  if (due > releaseUntil || due > releaseFrame) break;
                  if (due < releaseFrame) release = note;
                  else release = Math.max(release, note);
                  releaseFrame = due;
                }
              }
              if (release < last) end = Math.min(last, bound(times, releaseFrame));
            }
            if (end <= first) continue;
            let weight = 0;
            if (effect.type === 2000) weight = interval(replay.prefix(0), first, end, life.dead);
            else for (const grade of effect.judgements) weight += interval(replay.prefix(grade), first, end, life.dead);
            contributions.push(f(effect.delta / 100000) * weight);
          }
          byLife.set(life, contributions);
        }
        // Keep the original floating-point addition order across effects and events.
        for (let j = 0; j < contributions.length; j++) value += contributions[j]!;
      }
      output[index] = power * adjustment * value;
    }
    restoreOrderScores(output, plan);
    return Array.from(output);
  }

  return { scores };
}
