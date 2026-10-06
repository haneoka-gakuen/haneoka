/** Per-chart linear skill model: the uniform-order mean of a play is
 * P·(W + Σ g_i)/divisor up to binary32 rounding and one floor per note. */
import type { CompiledChart } from "./chart";
import type { PreparedLive } from "./live";
import type { SlotSkill } from "./skills";
import { windowMs } from "./skills";

const f = Math.fround;
export interface LinearChart {
  live: PreparedLive;
  /** Note weight per unit power, prefix-summed in chart order. */
  prefix: Float64Array;
  /** The same over notes whose judgement can take a Perfect raise. */
  perfectPrefix: Float64Array;
  total: number;
  /** Life when each skill event fires. */
  lifeAtEvent: readonly number[];
  /** Relative + absolute slack covering binary32 rounding and per-note floors. */
  relativeError: number;
  absoluteError: number;
}
export function linearChart(live: PreparedLive): LinearChart {
  const { chart, master } = live;
  const perfect = live.judgeFrac[5]!;
  const unit = master.live.adjustment * chart.difficultyFactor * perfect;
  const prefix = new Float64Array(chart.count + 1);
  let sum = 0;
  for (let i = 0; i < chart.count; i++) {
    sum += unit * chart.noteFrac[i]! * live.apCombo[i]!;
    prefix[i + 1] = sum;
  }
  return {
    live,
    prefix,
    perfectPrefix: prefix,
    total: sum,
    lifeAtEvent: chart.skillTimes.map(() => master.live.lifeBase),
    relativeError: 2e-6,
    absoluteError: chart.count + 1,
  };
}

/** Linear model of a fixed judgement pattern. The pessimistic side ignores Great→Perfect
 * conversions and life recovery; the optimistic side never loses life and converts up to
 * `conversions` Great/Good notes (the most any team's snaps can convert). */
export function linearPlayChart(
  live: PreparedLive,
  judgements: Int8Array,
  side: "low" | "high",
  conversions = 0,
  factorCap = 1,
  /** High side: the most any member recovers per activation; life with it bounds every team's life. */
  maxRecovery = 0,
): LinearChart {
  const { chart, master } = live;
  const unit = master.live.adjustment * chart.difficultyFactor;
  const prefix = new Float64Array(chart.count + 1);
  const perfectPrefix = new Float64Array(chart.count + 1);
  const gains: number[] = [];
  let sum = 0,
    perfectSum = 0,
    life = master.live.lifeBase,
    combo = 0,
    pending = 0,
    last = -1;
  const lifeAt: number[] = [];
  let cursor = 0;
  for (let i = 0; i < chart.count; i++) {
    const time = chart.times[i]!;
    while (cursor < chart.skillOrder.length && chart.skillTimes[chart.skillOrder[cursor]!]! <= time) {
      lifeAt[chart.skillOrder[cursor]!] = side === "high" ? master.live.lifeBase : life;
      if (side === "high") life = Math.min(master.live.lifeBase, life + maxRecovery);
      cursor++;
    }
    if (time !== last) {
      combo = pending;
      last = time;
    }
    const judgement = judgements[i]!;
    let comboValue = 0;
    for (const [required, cumulative] of live.comboTable) {
      if (required > combo) break;
      comboValue = cumulative;
    }
    const lifeFactor = life > 0 ? 1 : master.live.lifeOnus;
    const base = unit * chart.noteFrac[i]! * f(Math.min(comboValue, 1) + 1) * lifeFactor;
    const weight = base * live.judgeFrac[judgement]!;
    sum += weight;
    const convertible = judgement === 3 || judgement === 4;
    if (judgement === 5) perfectSum += base * live.judgeFrac[5]!;
    if (side === "high" && convertible) gains.push(base * (live.judgeFrac[5]! - live.judgeFrac[judgement]!));
    prefix[i + 1] = sum;
    perfectPrefix[i + 1] = perfectSum;
    pending = judgement <= 2 ? 0 : pending + 1;
    life = Math.max(0, life - (master.live.damage[judgement] ?? 0));
  }
  while (cursor < chart.skillOrder.length) lifeAt[chart.skillOrder[cursor++]!] = side === "high" ? master.live.lifeBase : life;
  // Converted notes also take the general factor; their largest gains bound the total.
  if (side === "high" && conversions > 0) sum += factorCap * gains.sort((a, b) => b - a).slice(0, conversions).reduce((total, gain) => total + gain, 0);
  return { live, prefix, perfectPrefix, total: sum, lifeAtEvent: lifeAt, relativeError: 2e-6, absoluteError: chart.count + 1 };
}

const lowerIndex = (times: Int32Array, time: number) => {
  let low = 0,
    high = times.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (times[middle]! < time) low = middle + 1;
    else high = middle;
  }
  return low;
};
/** Weight of notes inside [start, start + length). */
export function windowWeight(prefix: Float64Array, chart: CompiledChart, start: number, length: number) {
  return prefix[lowerIndex(chart.times, start + length)]! - prefix[lowerIndex(chart.times, start)]!;
}

/** Most a slot's Great→Perfect conversions can add at each event (per unit power), given a
 * cap on any note's total factor. */
export function conversionWeights(model: LinearChart, judgements: Int8Array, skill: SlotSkill, factorCap: number): Float64Array {
  const out = new Float64Array(5);
  const convert = skill.convert;
  if (!convert) return out;
  const { chart } = model.live;
  const perfect = model.live.judgeFrac[5]!;
  const unit = model.live.master.live.adjustment * chart.difficultyFactor;
  for (let event = 0; event < Math.min(chart.skillTimes.length, 5); event++) {
    const start = lowerIndex(chart.times, chart.skillTimes[event]!);
    const end = lowerIndex(chart.times, chart.skillTimes[event]! + windowMs(skill.effects[0]?.seconds ?? 5, skill.extensionMs));
    const values: number[] = [];
    // Combo factors are at most 2; the note percent and Perfect percent bound the rest.
    for (let i = start; i < end; i++) if (convert.judgements.includes(judgements[i]!)) values.push(unit * chart.noteFrac[i]! * 2 * perfect);
    values.sort((a, b) => b - a);
    let total = 0;
    for (let i = 0; i < Math.min(values.length, convert.limit); i++) total += values[i]!;
    out[event] = total * factorCap;
  }
  return out;
}

export interface SkillWeights {
  /** Mean over the five event positions. */
  mean: number;
  /** Best and worst single event position. */
  best: number;
  worst: number;
  perEvent: Float64Array;
}
export function skillWeights(model: LinearChart, skill: SlotSkill): SkillWeights {
  const { chart } = model.live;
  const events = Math.min(chart.skillTimes.length, 5);
  const perEvent = new Float64Array(5);
  for (const effect of skill.effects) {
    if (effect.type === 2004 && !effect.judgements.includes(5)) continue;
    const factor = f(effect.delta / 100000);
    const length = windowMs(effect.seconds, skill.extensionMs);
    const prefix = effect.type === 2004 ? model.perfectPrefix : model.prefix;
    for (let event = 0; event < events; event++) {
      if (effect.gate.kind === "life-at-least" && (model.lifeAtEvent[event]! >= effect.gate.value) !== effect.gate.positive) continue;
      perEvent[event]! += factor * windowWeight(prefix, chart, chart.skillTimes[event]!, length);
    }
  }
  let total = 0,
    best = 0,
    worst = Infinity;
  for (let event = 0; event < 5; event++) {
    const value = perEvent[event]!;
    total += value;
    best = Math.max(best, value);
    worst = Math.min(worst, value);
  }
  return { mean: total / 5, best, worst, perEvent };
}

/** Per-order bounds of a fixed judgement pattern with the team's real life trajectory.
 * Life only changes at damaging notes and at skill activations, so each order's life,
 * life-gated skills and 0-life penalty spans are exact; only Great→Perfect conversions
 * stay as slack (granted in full on the high side). */
export interface PlayBoundsChart {
  live: PreparedLive;
  /** Pattern weights, no penalty, no conversion. */
  raw: Float64Array;
  /** Notes judged Perfect. */
  perfectLow: Float64Array;
  /** Per note: its Perfect value per unit power (for conversions), and its judgement. */
  perfectBase: Float64Array;
  judgements: Int8Array;
  total: number;
  /** Note index and damage of every damaging note. */
  damage: { index: number; amount: number }[];
  /** First note index at or after each skill event. */
  eventIndex: number[];
  relativeError: number;
  absoluteError: number;
}
export function playBoundsChart(live: PreparedLive, judgements: Int8Array): PlayBoundsChart {
  const { chart, master } = live;
  const unit = master.live.adjustment * chart.difficultyFactor;
  const n = chart.count;
  const raw = new Float64Array(n + 1),
    perfectLow = new Float64Array(n + 1),
    perfectBase = new Float64Array(n);
  const damage: { index: number; amount: number }[] = [];
  let combo = 0,
    pending = 0,
    last = -1;
  for (let i = 0; i < n; i++) {
    const time = chart.times[i]!;
    if (time !== last) {
      combo = pending;
      last = time;
    }
    let comboValue = 0;
    for (const [required, cumulative] of live.comboTable) {
      if (required > combo) break;
      comboValue = cumulative;
    }
    const judgement = judgements[i]!;
    const base = unit * chart.noteFrac[i]! * f(Math.min(comboValue, 1) + 1);
    raw[i + 1] = raw[i]! + base * live.judgeFrac[judgement]!;
    perfectLow[i + 1] = perfectLow[i]! + (judgement === 5 ? base * live.judgeFrac[5]! : 0);
    perfectBase[i] = base * live.judgeFrac[5]!;
    const amount = master.live.damage[judgement] ?? 0;
    if (amount) damage.push({ index: i, amount });
    pending = judgement <= 2 ? 0 : pending + 1;
  }
  const eventIndex = chart.skillTimes.map((time) => lowerIndex(chart.times, time));
  return { live, raw, perfectLow, perfectBase, judgements, total: raw[n]!, damage, eventIndex, relativeError: 2e-6, absoluteError: n + 1 };
}
/** [low, high] score of one order. `slots` are indexed by formation slot; `order[event]` is the slot. */
export function playOrderBounds(model: PlayBoundsChart, slots: readonly SlotSkill[], order: readonly number[], power: number): [number, number] {
  const { live } = model;
  const { chart, master } = live;
  const n = chart.count;
  const onus = master.live.lifeOnus;
  const events = Math.min(chart.skillTimes.length, 5);
  // Life walk: penalty spans [start, end) of note indices scored at 0 life.
  const spans: number[] = [];
  const gates: boolean[][] = [];
  let life = master.live.lifeBase,
    damageAt = 0,
    spanStart = -1;
  const advanceTo = (index: number) => {
    while (damageAt < model.damage.length && model.damage[damageAt]!.index < index) {
      const row = model.damage[damageAt++]!;
      if (life <= 0 && spanStart < 0) spanStart = row.index;
      life = Math.max(0, life - row.amount);
      if (life <= 0 && spanStart < 0) spanStart = row.index + 1;
    }
  };
  const firing = chart.skillOrder.filter((event) => event < events);
  for (const event of firing) {
    const index = model.eventIndex[event]!;
    advanceTo(index);
    const slot = slots[order[event]!];
    gates[event] = (slot?.effects ?? []).map((effect) => effect.gate.kind !== "life-at-least" || (life >= effect.gate.value) === effect.gate.positive);
    if (slot?.recovery) {
      life = Math.min(master.live.lifeBase, life + slot.recovery);
      if (life > 0 && spanStart >= 0) {
        spans.push(spanStart, index);
        spanStart = -1;
      }
    }
  }
  advanceTo(n);
  if (spanStart >= 0 && spanStart < n) spans.push(spanStart, n);
  const weight = (prefix: Float64Array, start: number, end: number) => {
    if (end <= start) return 0;
    let value = prefix[end]! - prefix[start]!;
    for (let i = 0; i < spans.length; i += 2) {
      const a = Math.max(start, spans[i]!),
        b = Math.min(end, spans[i + 1]!);
      if (b > a) value -= (1 - onus) * (prefix[b]! - prefix[a]!);
    }
    return value;
  };
  let value = weight(model.raw, 0, n);
  // Active windows of this order, for the factor a converted note is scored with.
  const windows: { start: number; end: number; general: number; perfect: number }[] = [];
  for (let event = 0; event < events; event++) {
    const slot = slots[order[event]!];
    if (!slot) continue;
    const start = model.eventIndex[event]!;
    slot.effects.forEach((effect, index) => {
      if (!gates[event]![index]) return;
      if (effect.type === 2004 && !effect.judgements.includes(5)) return;
      const end = lowerIndex(chart.times, chart.skillTimes[event]! + windowMs(effect.seconds, slot.extensionMs));
      const factor = f(effect.delta / 100000);
      if (effect.type === 2000) {
        value += factor * weight(model.raw, start, end);
        windows.push({ start, end, general: factor, perfect: 0 });
      } else {
        value += factor * weight(model.perfectLow, start, end);
        windows.push({ start, end, general: 0, perfect: factor });
      }
    });
  }
  // Conversions are deterministic: the first `limit` eligible notes of the converting member's
  // window, a later activation replacing an earlier one, as the live simulation does.
  const converters: { start: number; end: number; slot: SlotSkill }[] = [];
  for (const event of firing) {
    const slot = slots[order[event]!];
    if (!slot?.convert) continue;
    const start = model.eventIndex[event]!;
    const previous = converters.at(-1);
    if (previous && previous.end > start) previous.end = start;
    converters.push({ start, end: lowerIndex(chart.times, chart.skillTimes[event]! + windowMs(slot.effects[0]?.seconds ?? 5, slot.extensionMs)), slot });
  }
  const perfect = live.judgeFrac[5]!;
  for (const { start, end, slot } of converters) {
    let left = slot.convert!.limit;
    for (let i = start; i < end && left > 0; i++) {
      const judgement = model.judgements[i]!;
      if (!slot.convert!.judgements.includes(judgement)) continue;
      left--;
      let general = 1,
        perfectUp = 0;
      for (const window of windows)
        if (window.start <= i && i < window.end) {
          general += window.general;
          perfectUp += window.perfect;
        }
      let penalty = 1;
      for (let span = 0; span < spans.length; span += 2) if (spans[span]! <= i && i < spans[span + 1]!) penalty = onus;
      const base = model.perfectBase[i]! / perfect;
      value += penalty * base * ((perfect - live.judgeFrac[judgement]!) * general + perfect * perfectUp);
    }
  }
  const low = value,
    high = value;
  const divisor = chart.convertedCount;
  return [Math.max(0, ((power * low) / divisor) * (1 - model.relativeError) - model.absoluteError), ((power * high) / divisor) * (1 + model.relativeError)];
}

/** All 120 order bounds of one team at once. An order's life (and so its penalty spans and
 * life-gated skills) depends only on where the recovering members stand, so orders sharing
 * that signature share every (slot, event) contribution; only conversions are per order. */
export function playTeamBounds(model: PlayBoundsChart, slots: readonly SlotSkill[], orders: readonly (readonly number[])[], power: number) {
  const { live } = model;
  const { chart, master } = live;
  const n = chart.count;
  const onus = master.live.lifeOnus;
  const events = Math.min(chart.skillTimes.length, 5);
  const divisor = chart.convertedCount;
  const lows = new Float64Array(orders.length),
    highs = new Float64Array(orders.length);
  const groups = new Map<string, number[]>();
  orders.forEach((order, index) => {
    const key = order.map((slot) => slots[slot]?.recovery ?? 0).join(",");
    const list = groups.get(key);
    if (list) list.push(index);
    else groups.set(key, [index]);
  });
  const converting = slots.some((slot) => slot?.convert);
  for (const indices of groups.values()) {
    const order = orders[indices[0]!]!;
    // Life walk shared by the group.
    const spans: number[] = [];
    const lifeAtEvent: number[] = [];
    let life = master.live.lifeBase,
      damageAt = 0,
      spanStart = -1;
    const advanceTo = (index: number) => {
      while (damageAt < model.damage.length && model.damage[damageAt]!.index < index) {
        const row = model.damage[damageAt++]!;
        life = Math.max(0, life - row.amount);
        if (life <= 0 && spanStart < 0) spanStart = row.index + 1;
      }
    };
    for (const event of chart.skillOrder) {
      if (event >= events) continue;
      const index = model.eventIndex[event]!;
      advanceTo(index);
      lifeAtEvent[event] = life;
      const recovery = slots[order[event]!]?.recovery ?? 0;
      if (recovery) {
        life = Math.min(master.live.lifeBase, life + recovery);
        if (life > 0 && spanStart >= 0) {
          spans.push(spanStart, index);
          spanStart = -1;
        }
      }
    }
    advanceTo(n);
    if (spanStart >= 0 && spanStart < n) spans.push(spanStart, n);
    const weight = (prefix: Float64Array, start: number, end: number) => {
      if (end <= start) return 0;
      let value = prefix[end]! - prefix[start]!;
      for (let i = 0; i < spans.length; i += 2) {
        const a = Math.max(start, spans[i]!),
          b = Math.min(end, spans[i + 1]!);
        if (b > a) value -= (1 - onus) * (prefix[b]! - prefix[a]!);
      }
      return value;
    };
    const base = weight(model.raw, 0, n);
    // contribution[slot * 5 + event], and the windows it opens.
    const contribution = new Float64Array(25).fill(NaN);
    const windowsOf: { start: number; end: number; general: number; perfect: number }[][] = [];
    const contribute = (slotIndex: number, event: number) => {
      const key = slotIndex * 5 + event;
      if (!Number.isNaN(contribution[key]!)) return contribution[key]!;
      const slot = slots[slotIndex];
      let value = 0;
      const windows: { start: number; end: number; general: number; perfect: number }[] = [];
      if (slot) {
        const start = model.eventIndex[event]!;
        for (const effect of slot.effects) {
          if (effect.gate.kind === "life-at-least" && (lifeAtEvent[event]! >= effect.gate.value) !== effect.gate.positive) continue;
          if (effect.type === 2004 && !effect.judgements.includes(5)) continue;
          const end = lowerIndex(chart.times, chart.skillTimes[event]! + windowMs(effect.seconds, slot.extensionMs));
          const factor = f(effect.delta / 100000);
          if (effect.type === 2000) {
            value += factor * weight(model.raw, start, end);
            windows.push({ start, end, general: factor, perfect: 0 });
          } else {
            value += factor * weight(model.perfectLow, start, end);
            windows.push({ start, end, general: 0, perfect: factor });
          }
        }
      }
      contribution[key] = value;
      windowsOf[key] = windows;
      return value;
    };
    const perfect = live.judgeFrac[5]!;
    for (const orderIndex of indices) {
      const current = orders[orderIndex]!;
      let value = base;
      for (let event = 0; event < events; event++) value += contribute(current[event]!, event);
      if (converting) {
        const windows = Array.from({ length: events }, (_, event) => windowsOf[current[event]! * 5 + event] ?? []).flat();
        const converters: { start: number; end: number; slot: SlotSkill }[] = [];
        for (const event of chart.skillOrder) {
          if (event >= events) continue;
          const slot = slots[current[event]!];
          if (!slot?.convert) continue;
          const start = model.eventIndex[event]!;
          const previous = converters.at(-1);
          if (previous && previous.end > start) previous.end = start;
          converters.push({ start, end: lowerIndex(chart.times, chart.skillTimes[event]! + windowMs(slot.effects[0]?.seconds ?? 5, slot.extensionMs)), slot });
        }
        for (const { start, end, slot } of converters) {
          let left = slot.convert!.limit;
          for (let i = start; i < end && left > 0; i++) {
            const judgement = model.judgements[i]!;
            if (!slot.convert!.judgements.includes(judgement)) continue;
            left--;
            let general = 1,
              perfectUp = 0;
            for (const window of windows)
              if (window.start <= i && i < window.end) {
                general += window.general;
                perfectUp += window.perfect;
              }
            let penalty = 1;
            for (let span = 0; span < spans.length; span += 2) if (spans[span]! <= i && i < spans[span + 1]!) penalty = onus;
            value += penalty * (model.perfectBase[i]! / perfect) * ((perfect - live.judgeFrac[judgement]!) * general + perfect * perfectUp);
          }
        }
      }
      lows[orderIndex] = Math.max(0, ((power * value) / divisor) * (1 - model.relativeError) - model.absoluteError);
      highs[orderIndex] = ((power * value) / divisor) * (1 + model.relativeError);
    }
  }
  return { lows, highs };
}
