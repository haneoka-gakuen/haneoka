/** Exact normal-live scores for one team over all 120 member orders. */
import type { EngineMaster } from "./master";
import type { CompiledChart } from "./chart";
import { windowMs, type SlotSkill } from "./skills";

const f = Math.fround;
export const ORDERS: readonly (readonly number[])[] = (() => {
  const out: number[][] = [];
  const visit = (chosen: number[]) => {
    if (chosen.length === 5) out.push(chosen);
    else for (let slot = 0; slot < 5; slot++) if (!chosen.includes(slot)) visit([...chosen, slot]);
  };
  visit([]);
  return out;
})();

/** Simulate judgements: 6 Just, 5 Perfect, 4 Great, 3 Good, 2 Bad, 1 Miss. */
export interface PlayModel {
  great: number;
  good: number;
  bad: number;
  miss: number;
}
export const AP: PlayModel = { great: 0, good: 0, bad: 0, miss: 0 };
export const isAllPerfect = (play: PlayModel) => !play.great && !play.good && !play.bad && !play.miss;

/** Evenly spread judgements, deterministic for a given chart and play. */
export function playJudgements(count: number, play: PlayModel): Int8Array {
  const out = new Int8Array(count).fill(5);
  const kinds: [number, number][] = [
    [1, play.miss],
    [2, play.bad],
    [3, play.good],
    [4, play.great],
  ];
  let offset = 0;
  for (const [judgement, fraction] of kinds) {
    const wanted = Math.round(Math.max(0, Math.min(1, fraction)) * count);
    let placed = 0;
    for (let i = 0; i < count && placed < wanted; i++) {
      // Low-discrepancy positions; a later kind skips notes an earlier kind took.
      const index = Math.floor(((placed + 0.5 + offset * 0.37) * count) / Math.max(wanted, 1)) % count;
      let probe = index;
      while (out[probe] !== 5) probe = (probe + 1) % count;
      out[probe] = judgement;
      placed++;
    }
    offset++;
  }
  return out;
}

export interface LiveSettings {
  /** 1 normally; assist mode multiplies by its percent. */
  assist: number;
  luckPercent: number;
}
export const NORMAL_SETTINGS: LiveSettings = { assist: 1, luckPercent: 100 };

export interface PreparedLive {
  chart: CompiledChart;
  master: EngineMaster;
  /** Combo factor of each note in an unbroken play (combo = judged notes strictly before its time). */
  apCombo: Float32Array;
  comboTable: readonly (readonly [number, number])[];
  judgeFrac: Float32Array;
}
const comboFactorAt = (table: readonly (readonly [number, number])[], combo: number) => {
  let value = 0;
  for (const [required, cumulative] of table) {
    if (required > combo) break;
    value = cumulative;
  }
  return f(Math.min(value, 1) + 1);
};
export function prepareLive(master: EngineMaster, chart: CompiledChart): PreparedLive {
  const table = master.live.combo.get(0) ?? [];
  const apCombo = new Float32Array(chart.count);
  let before = 0;
  for (let i = 0; i < chart.count; i++) {
    if (i && chart.times[i] !== chart.times[i - 1]) before = i;
    apCombo[i] = comboFactorAt(table, before);
  }
  const judgeFrac = new Float32Array(7);
  for (let type = 1; type <= 6; type++) judgeFrac[7 - type] = f((master.live.judgePercent.get(type) ?? 0) / 100);
  return { chart, master, apCombo, comboTable: table, judgeFrac };
}

export interface OrderScores {
  power: number;
  scores: Float64Array;
  mean: number;
  min: number;
  max: number;
  minOrder: number;
  maxOrder: number;
}
interface Command {
  time: number;
  /** Chart event index: same-time commands apply in event order. */
  owner: number;
  /** 0 general, 4 Great, 5 Perfect, 6 Just. */
  channel: number;
  delta: number;
}

/** Commands of one order in an all-Perfect play; life never leaves its base. */
function orderCommands(prepared: PreparedLive, slots: readonly SlotSkill[], order: readonly number[], lifeBase: number): Command[] {
  const { chart } = prepared;
  const commands: Command[] = [];
  const events = Math.min(chart.skillTimes.length, 5);
  for (let event = 0; event < events; event++) {
    const slot = slots[order[event]!];
    if (!slot) continue;
    const start = chart.skillTimes[event]!;
    for (const effect of slot.effects) {
      if (effect.gate.kind === "life-at-least" && (lifeBase >= effect.gate.value) !== effect.gate.positive) continue;
      const end = start + windowMs(effect.seconds, slot.extensionMs);
      const channels = effect.type === 2000 ? [0] : effect.judgements;
      for (const channel of channels) {
        commands.push({ time: start, owner: event, channel, delta: effect.delta });
        commands.push({ time: end, owner: event, channel, delta: -effect.delta });
      }
    }
  }
  return commands.sort((a, b) => a.time - b.time || a.owner - b.owner);
}

/** Exact all-Perfect scores: note scores at a constant factor are cached as prefix sums. */
export function scoreOrdersAP(prepared: PreparedLive, power: number, slots: readonly SlotSkill[], settings = NORMAL_SETTINGS): OrderScores {
  const { chart, master } = prepared;
  const n = chart.count;
  const t = f(f(master.live.adjustment * power) * chart.difficultyFactor);
  const perfect = prepared.judgeFrac[5]!;
  const base = new Float32Array(n);
  for (let i = 0; i < n; i++) base[i] = f(f(perfect * f(chart.noteFrac[i]! * t)) * prepared.apCombo[i]!);
  const count = chart.convertedCount;
  const luck = f(Math.min(settings.luckPercent, 200) / 100);
  const assist = f(settings.assist);
  const prefixes = new Map<number, Float64Array>();
  const prefix = (factor: number) => {
    let sums = prefixes.get(factor);
    if (sums) return sums;
    sums = new Float64Array(n + 1);
    let total = 0;
    for (let i = 0; i < n; i++) {
      let x = Math.floor(f(f(luck * f(base[i]! * factor)) / count));
      if (assist !== 1) x = Math.floor(f(assist * x));
      total += x;
      sums[i + 1] = total;
    }
    prefixes.set(factor, sums);
    return sums;
  };
  const scores = new Float64Array(ORDERS.length);
  const times = chart.times;
  const lower = (time: number) => {
    let low = 0,
      high = n;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (times[middle]! < time) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  ORDERS.forEach((order, orderIndex) => {
    const commands = orderCommands(prepared, slots, order, master.live.lifeBase);
    let general = f(1),
      perfectUp = f(0),
      index = 0,
      score = 0;
    for (const command of commands) {
      const end = lower(command.time);
      if (end > index) {
        const sums = prefix(f(general + perfectUp));
        score += sums[end]! - sums[index]!;
        index = end;
      }
      const diff = f(command.delta / 100000);
      if (command.channel === 0) general = f(general + diff);
      else if (command.channel === 5) perfectUp = f(perfectUp + diff);
    }
    if (index < n) {
      const sums = prefix(f(general + perfectUp));
      score += sums[n]! - sums[index]!;
    }
    scores[orderIndex] = score;
  });
  return summarize(power, scores);
}

function summarize(power: number, scores: Float64Array): OrderScores {
  let min = Infinity,
    max = -Infinity,
    minOrder = 0,
    maxOrder = 0;
  // Canonical summation keeps permuted equal teams exactly tied.
  const sorted = Float64Array.from(scores).sort();
  let total = 0;
  for (const value of sorted) total += value;
  scores.forEach((value, index) => {
    if (value < min) {
      min = value;
      minOrder = index;
    }
    if (value > max) {
      max = value;
      maxOrder = index;
    }
  });
  return { power, scores, mean: total / scores.length, min, max, minOrder, maxOrder };
}

/** General play: combo breaks, life, Great→Perfect conversion and life-gated skills, per order. */
export function scoreOrdersPlay(
  prepared: PreparedLive,
  power: number,
  slots: readonly SlotSkill[],
  judgements: Int8Array,
  settings = NORMAL_SETTINGS,
): OrderScores {
  const { chart, master } = prepared;
  const n = chart.count;
  const t = f(f(master.live.adjustment * power) * chart.difficultyFactor);
  const count = chart.convertedCount;
  const luck = f(Math.min(settings.luckPercent, 200) / 100);
  const assist = f(settings.assist);
  const onus = master.live.lifeOnus;
  const damage = master.live.damage;
  const firing = chart.skillOrder.filter((event) => event < 5);
  const scores = new Float64Array(ORDERS.length);
  const noteA = new Float32Array(n);
  for (let i = 0; i < n; i++) noteA[i] = f(chart.noteFrac[i]! * t);
  // Bad and Miss alone break combos, so the combo of each note is fixed by the pattern.
  const comboFactors = new Float32Array(n);
  {
    let pending = 0,
      combo = 0,
      last = -1;
    for (let i = 0; i < n; i++) {
      if (chart.times[i] !== last) {
        combo = pending;
        last = chart.times[i]!;
      }
      comboFactors[i] = comboFactorAt(prepared.comboTable, combo);
      pending = judgements[i]! <= 2 ? 0 : pending + 1;
    }
  }
  ORDERS.forEach((order, orderIndex) => {
    let life = master.live.lifeBase;
    let combo = 0,
      pendingCombo = 0,
      lastTime = -1;
    const channel = new Float32Array(7);
    // Active windows: end time, channel, delta, converting slot.
    const active: { end: number; channel: number; delta: number }[] = [];
    let factor = f(1);
    let cursor = 0;
    let convert: { end: number; judgements: readonly number[]; left: number } | null = null;
    let score = 0;
    const expire = (time: number) => {
      for (let i = active.length - 1; i >= 0; i--)
        if (active[i]!.end <= time) {
          const { channel: which, delta } = active[i]!;
          const diff = f(delta / 100000);
          if (which === 0) factor = f(factor - diff);
          else channel[which] = f(channel[which]! - diff);
          active.splice(i, 1);
        }
      if (convert && convert.end <= time) convert = null;
    };
    for (let i = 0; i <= n; i++) {
      const time = i < n ? chart.times[i]! : Infinity;
      while (cursor < firing.length && chart.skillTimes[firing[cursor]!]! <= time) {
        const event = firing[cursor]!;
        const start = chart.skillTimes[event]!;
        expire(start);
        const slot = slots[order[event]!];
        if (slot) {
          for (const effect of slot.effects) {
            if (effect.gate.kind === "life-at-least" && (life >= effect.gate.value) !== effect.gate.positive) continue;
            const end = start + windowMs(effect.seconds, slot.extensionMs);
            const diff = f(effect.delta / 100000);
            for (const which of effect.type === 2000 ? [0] : effect.judgements) {
              if (which === 0) factor = f(factor + diff);
              else channel[which] = f(channel[which]! + diff);
              active.push({ end, channel: which, delta: effect.delta });
            }
          }
          if (slot.recovery) life = Math.min(master.live.lifeBase, life + slot.recovery);
          if (slot.convert)
            convert = {
              end: start + windowMs(slot.effects[0]?.seconds ?? 5, slot.extensionMs),
              judgements: slot.convert.judgements,
              left: slot.convert.limit,
            };
        }
        cursor++;
      }
      if (i === n) break;
      expire(time);
      if (time !== lastTime) {
        combo = pendingCombo;
        lastTime = time;
      }
      let judgement = judgements[i]!;
      if (convert && convert.left > 0 && convert.judgements.includes(judgement)) {
        judgement = 5;
        convert.left--;
      }
      const judge = prepared.judgeFrac[judgement]!;
      const comboFactor = comboFactors[i]!;
      const up = f(factor + channel[judgement]!);
      let x = Math.floor(f(f(luck * f(f(f(judge * noteA[i]!) * comboFactor) * up)) / count));
      if (life <= 0) x = Math.floor(f(onus * x));
      if (assist !== 1) x = Math.floor(f(assist * x));
      score += x;
      pendingCombo = judgement <= 2 ? 0 : pendingCombo + 1;
      if (damage[judgement]) life = Math.max(0, life - damage[judgement]!);
    }
    scores[orderIndex] = score;
  });
  return summarize(power, scores);
}

/** Skip score: valid notes as Great, combo 0, full life, no skills. */
export function skipScore(master: EngineMaster, chart: CompiledChart, power: number): number {
  const t = f(f(master.live.adjustment * power) * chart.difficultyFactor);
  const great = f((master.live.judgePercent.get(3) ?? 80) / 100);
  const combo = comboFactorAt(master.live.combo.get(0) ?? [], 0);
  let total = 0;
  for (const frac of chart.skipNoteFrac) total += Math.floor(f(f(f(great * f(frac * t)) * combo) / chart.convertedCount));
  return total;
}
