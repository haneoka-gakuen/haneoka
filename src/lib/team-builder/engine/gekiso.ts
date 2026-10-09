/** Gekisou (fever mission) lives: the order-independent part of a team's live (Gekisou combo, Gekisou skills, Gekisou
 * support skills, the luck lottery, Just judgements) comes from one whole-live simulation without live skills; the 120
 * member orders then add live skills and snap skills note by note, with the solo rank bonus of each completed range.
 * Luck ranges average the native seeded lottery over common seeds, so teams are compared on the same draws. */
import type { EngineMaster } from "./master";
import type { ChartSource } from "./chart";
import { ORDERS, type OrderScores } from "./live";
import { FULL_SKILL_ORDER_PLAN, restoreOrderScores, skillOrderPlan } from "./order-equivalence";
import { windowMs, type SlotSkill } from "./skills";
import { LiveModel, type GekisouSetup, type LiveNote, type LuckRecord, type Performer } from "./full/model";
import { chanceOf, Factory, type CheckCtx } from "./full/conditions";
import { luckCurve, type MissRule } from "./full/luck";
import { LifeController } from "./full/life";
import { LiveRandom } from "./full/random";
import { noteFactorMill } from "./full/score";
import { fullChart, isJudgementNote, judgementStream, type Accuracy, type FullChart, type LivePlay } from "./full/play";
import { M_LUCK, missionPattern, rankingFactors } from "./full/gekisou";
import { getFrame } from "./full/num";

const f = Math.fround;

export interface GekisoChart {
  full: FullChart;
  setup: GekisouSetup;
  play: LivePlay;
  accuracy: Accuracy;
  /** Judged notes in (time, id) order. */
  notes: LiveNote[];
  times: Int32Array;
  noteFrac: Float32Array;
  /** Play judgement of each note before conversions (6 Just … 1 Miss). */
  judgements: Int8Array;
  /** Range of each note's rank bonus (-1 none) and each range's bonus percent. */
  rangeOf: Int8Array;
  rangePercent: number[];
  luck: boolean;
  difficultyFactor: number;
  musicLengthMs: number;
  /** Combo factor `min(table, 1) + 1` per note of the play (combo strictly before its time). */
  comboFactor: Float32Array;
  judgeFrac: Float32Array;
  /** Frame indices [first, end) spanning every range from standby to finish. */
  span: [number, number];
}

/** `rank` is the assumed placement in every range (1 for solo Mission lives). */
export function gekisoChart(master: EngineMaster, source: ChartSource, level: number, missions: readonly number[], accuracy: Accuracy, rank = 1): GekisoChart {
  const full = fullChart(master, source, level);
  const setup: GekisouSetup = { fevers: full.fevers, missions };
  const play = judgementStream(master, full, setup, accuracy);
  const byId = new Map(full.notes.map((n) => [n.id, n]));
  const judgementOf = new Map<number, number>();
  for (const frame of play.frames) for (const j of frame.judged) judgementOf.set(j.noteId, j.judgement);
  const notes = full.notes.filter((n) => isJudgementNote(n.op) && master.live.notePercent.has(n.op)).sort((a, b) => a.timeMs - b.timeMs || a.id - b.id);
  const n = notes.length;
  const times = Int32Array.from(notes, (note) => note.timeMs);
  const noteFrac = Float32Array.from(notes, (note) => f((master.live.notePercent.get(note.op) ?? 0) / 100));
  const judgements = Int8Array.from(notes, (note) => judgementOf.get(note.id) ?? 5);
  const factors = rankingFactors(master.live.gekiso, missionPattern(missions[0] ?? 0, missions[1] ?? 0, missions[2] ?? 0));
  const ranges = full.fevers.slice(0, 3);
  const rangePercent = ranges.map((_, r) => factors[r]?.[rank - 1] ?? 0);
  const rangeOf = new Int8Array(n).fill(-1);
  notes.forEach((note, i) => {
    const frame = getFrame(note.timeMs);
    ranges.forEach(([s, e], r) => {
      if (getFrame(s) < frame && frame <= getFrame(e) && rangeOf[i] === -1) rangeOf[i] = r;
    });
  });
  const table = master.live.combo.get(0) ?? [];
  const comboFactor = new Float32Array(n);
  {
    // The combo counter orders judgements by time; Bad and Miss reset it.
    let before = 0,
      pending = 0,
      last = -1;
    for (let i = 0; i < n; i++) {
      if (times[i] !== last) {
        before = pending;
        last = times[i]!;
      }
      let value = 0;
      for (const [required, cumulative] of table) {
        if (required > before) break;
        value = cumulative;
      }
      comboFactor[i] = f(Math.min(value, 1) + 1);
      pending = judgements[i]! <= 2 ? 0 : pending + 1;
    }
  }
  const judgeFrac = new Float32Array(7);
  for (let type = 1; type <= 6; type++) judgeFrac[7 - type] = f((master.live.judgePercent.get(type) ?? 0) / 100);
  const frameTimes = play.frames.map((frame) => frame.timeMs);
  const firstStart = Math.min(...ranges.map(([start]) => start));
  const lastEnd = Math.max(...ranges.map(([, end]) => end));
  const span: [number, number] = ranges.length
    ? [
        Math.max(0, frameTimes.findIndex((time) => time >= firstStart - 4500) - 1),
        (() => {
          const at = frameTimes.findIndex((time) => time >= lastEnd + master.live.afterMs + 1200);
          return at < 0 ? frameTimes.length : at;
        })(),
      ]
    : [0, 0];
  return {
    full,
    setup,
    play,
    accuracy,
    notes,
    times,
    noteFrac,
    judgements,
    rangeOf,
    rangePercent,
    luck: missions.slice(0, ranges.length).includes(M_LUCK),
    difficultyFactor: f(f(f((level - 5) | 0) * f(0.005)) + 1),
    musicLengthMs: full.lastTimingMs + 1000,
    comboFactor,
    judgeFrac,
    span,
  };
}

export interface GekisoContext {
  /** Simulate judgement of each note after Gekisou conversions (6 Just … 1 Miss). */
  judgement: Int8Array;
  /** Gekisou combo factor. */
  gk: Float32Array;
  /** Expected luck factor × order-independent note score-up (1 + Gekisou support score-ups). */
  up: Float64Array;
  /** Expected luck factor. */
  luck: Float64Array;
  /** Lottery runs averaged: 1 deterministic, 0 the exact nominal expectation (luck DP). */
  seeds: number;
}

/** Performers reduced to their Gekisou parts: what every member order shares. */
export const gekisoPerformer = (p: Performer): Performer => ({ ...p, liveSkill: null, supportSkills: [] });

/** Rush-reading score-ups (sum of their factors) and Miss-triggered gauge additions of a deck's support skills. */
function luckReaders(master: EngineMaster, deck: readonly Performer[]) {
  const factory = new Factory(master, deck, master.live.lifeBase, 0);
  const ctx: CheckCtx = {
    prevConfirmedRank: null,
    life: new LifeController(master.live.lifeBase, master.live.damage, 1000),
    random: new LiveRandom(0),
    frameTime: 0,
    currentCombo: 0,
    judged: [],
    events: [],
    gk: null,
    record: true,
  };
  const reads = (group: number, type: number, value?: number) =>
    (master.conditionSets.get(group) ?? []).some((set) =>
      set.some((id) => {
        const c = master.conditions.get(id);
        return c?.type === type && (value === undefined || c.values[0] === value);
      }),
    );
  let rush = 0;
  const misses: MissRule[] = [];
  deck.forEach((p, k) => {
    if (!p.gekisouSkill && !p.missionOnly) return;
    for (const [id, level] of p.gekisouSupportSkills) {
      const skill = master.gekisoSupportSkills.get(id);
      if (!skill || (skill.missionType !== M_LUCK && skill.missionType !== 4)) continue;
      for (const row of skill.effects) {
        if (row.level !== level) continue;
        if (row.type === 2000 && reads(row.triggerGroup, 7021)) {
          if (chanceOf(factory.group(row.conditionGroup, k), ctx) > 0.5) rush = f(rush + f(noteFactorMill(f(f(row.value) / 10000)) / 100000));
        } else if (row.type === 11003 && reads(row.triggerGroup, 7000, 0)) {
          const chance = chanceOf(factory.group(row.conditionGroup, k), ctx);
          if (chance > 0) misses.push({ value: row.value, chance });
        }
      }
    }
  });
  return { rush, misses };
}

export function gekisoContext(master: EngineMaster, chart: GekisoChart, deck: readonly Performer[], seeds: readonly number[]): GekisoContext {
  if (chart.luck && seeds.length === 0) return expectedContext(master, chart, deck);
  const n = chart.notes.length;
  const index = new Map(chart.notes.map((note, i) => [note.id, i]));
  const judgement = Int8Array.from(chart.judgements);
  const gk = new Float32Array(n).fill(1);
  const up = new Float64Array(n);
  const luck = new Float64Array(n);
  const runs = chart.luck ? seeds : [seeds[0] ?? 0];
  const reduced = deck.map(gekisoPerformer);
  for (const seed of runs) {
    const model = new LiveModel(
      master,
      reduced,
      chart.full.notes,
      chart.full.events,
      { skillTargetMusicType: 0, power: 1, level: chart.full.level, convertedCount: chart.full.convertedCount, musicLengthMs: chart.musicLengthMs, assist: 1 },
      chart.setup,
      seed,
    );
    const noteUp = new Float32Array(n).fill(1);
    const noteLuck = new Float32Array(n).fill(1);
    model.score.calc.onNote = (id, scoreType, note, factor, luckFactor) => {
      const i = index.get(id);
      if (i === undefined) return;
      judgement[i] = 7 - scoreType;
      gk[i] = factor;
      noteUp[i] = note;
      noteLuck[i] = luckFactor;
    };
    const { frames, dt } = chart.play;
    // Outside the ranges (from standby to finish) no Gekisou state or factor exists: only that span is simulated.
    for (let k = chart.span[0]; k < chart.span[1]; k++) model.frame(frames[k]!.timeMs, frames[k]!.judged, dt[k]!);
    for (let i = 0; i < n; i++) {
      up[i]! += noteLuck[i]! * noteUp[i]!;
      luck[i]! += noteLuck[i]!;
    }
  }
  for (let i = 0; i < n; i++) {
    up[i]! /= runs.length;
    luck[i]! /= runs.length;
  }
  return { judgement, gk, up, luck, seeds: runs.length };
}

const luckCurves = new WeakMap<GekisoChart, Map<string, ReturnType<typeof luckCurve>>>();
/** The exact nominal luck expectation: one lottery-free run records the live, the luck DP propagates the lottery. */
function expectedContext(master: EngineMaster, chart: GekisoChart, deck: readonly Performer[]): GekisoContext {
  const n = chart.notes.length;
  const index = new Map(chart.notes.map((note, i) => [note.id, i]));
  const judgement = Int8Array.from(chart.judgements);
  const gk = new Float32Array(n).fill(1);
  const noteUp = new Float32Array(n).fill(1);
  const reduced = deck.map(gekisoPerformer);
  const record: LuckRecord = { actions: [], frames: [], notes: [] };
  const model = new LiveModel(
    master,
    reduced,
    chart.full.notes,
    chart.full.events,
    { skillTargetMusicType: 0, power: 1, level: chart.full.level, convertedCount: chart.full.convertedCount, musicLengthMs: chart.musicLengthMs, assist: 1 },
    chart.setup,
    0,
    record,
  );
  model.score.calc.onNote = (id, scoreType, note, factor) => {
    const i = index.get(id);
    if (i === undefined) return;
    judgement[i] = 7 - scoreType;
    gk[i] = factor;
    noteUp[i] = note;
  };
  const { frames, dt } = chart.play;
  // The record is indexed from the first simulated frame.
  const simulated = frames.slice(chart.span[0], chart.span[1]);
  for (let k = 0; k < simulated.length; k++) model.frame(simulated[k]!.timeMs, simulated[k]!.judged, dt[chart.span[0] + k]!);
  const { rush, misses } = luckReaders(master, reduced);
  const luckRanges = chart.setup.missions.slice(0, Math.min(3, chart.full.fevers.length)).flatMap((m, r) => (m === M_LUCK ? [r] : []));
  // The lottery only reads the luck chain: teams with the same actions, gauge speeds and Miss rules share one curve.
  const signature = JSON.stringify([
    record.actions,
    misses,
    record.notes.map((n) => [n.frame, n.judgement, n.speed, n.buff]),
    record.frames.map((frame) => frame.states.join("") + frame.playing),
  ]);
  let curves = luckCurves.get(chart);
  if (!curves) luckCurves.set(chart, (curves = new Map()));
  let curve = curves.get(signature);
  if (!curve) curves.set(signature, (curve = luckCurve(master.live.gekiso, record, simulated, luckRanges, misses)));
  const bonus = Math.min(100 + master.live.gekiso.rushPercent, 200) / 100 - 1;
  const up = new Float64Array(n);
  const luck = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const id = chart.notes[i]!.id;
    const pr = curve.rush.get(id) ?? 0,
      ps = curve.skill.get(id) ?? 0,
      both = curve.both.get(id) ?? 0;
    luck[i] = 1 + bonus * pr;
    up[i] = noteUp[i]! * luck[i]! + rush * (ps + bonus * both);
  }
  return { judgement, gk, up, luck, seeds: 0 };
}

/** Per-order scores: live skills and snap skills on top of the shared Gekisou context, plus rank bonuses. */
export function scoreOrdersGekiso(
  master: EngineMaster,
  chart: GekisoChart,
  ctx: GekisoContext,
  power: number,
  slots: readonly SlotSkill[],
  debug?: (order: number, note: number, score: number, live: number) => void,
): OrderScores {
  const n = chart.notes.length;
  const t = f(f(master.live.adjustment * power) * chart.difficultyFactor);
  const count = chart.full.convertedCount;
  const onus = master.live.lifeOnus;
  const damage = master.live.damage;
  const eventTimes = chart.full.events.map(([, time]) => time);
  // Events fire in time order; the chart lists them by performer position.
  const firing = eventTimes.map((_, i) => i).filter((i) => i < 5).sort((a, b) => eventTimes[a]! - eventTimes[b]! || a - b);
  const noteA = new Float32Array(n);
  const comboFactor = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    noteA[i] = f(chart.noteFrac[i]! * t);
    comboFactor[i] = f(ctx.gk[i]! * chart.comboFactor[i]!);
  }
  const deterministic = ctx.seeds === 1;
  const ranges = chart.rangePercent.length;
  const scores = new Float64Array(ORDERS.length);
  const rangeScore = new Float64Array(ranges);
  // Debug callbacks observe every original order/note, so retain their complete execution trace.
  const orderPlan = debug ? FULL_SKILL_ORDER_PLAN : skillOrderPlan(slots);
  for (const orderIndex of orderPlan.representatives) {
    const order = ORDERS[orderIndex]!;
    let life = master.live.lifeBase;
    const channel = new Float32Array(7);
    const active: { end: number; channel: number; delta: number }[] = [];
    let factor = f(0);
    let cursor = 0;
    let convert: { end: number; judgements: readonly number[]; left: number } | null = null;
    let score = 0;
    rangeScore.fill(0);
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
      while (cursor < firing.length && eventTimes[firing[cursor]!]! <= time) {
        const event = firing[cursor]!;
        const start = eventTimes[event]!;
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
            convert = { end: start + windowMs(slot.effects[0]?.seconds ?? 5, slot.extensionMs), judgements: slot.convert.judgements, left: slot.convert.limit };
        }
        cursor++;
      }
      if (i === n) break;
      expire(time);
      let judgement = ctx.judgement[i]!;
      if (convert && convert.left > 0 && convert.judgements.includes(judgement)) {
        judgement = 5;
        convert.left--;
      }
      const c = f(f(chart.judgeFrac[judgement]! * noteA[i]!) * comboFactor[i]!);
      const live = f(factor + channel[judgement]!);
      let x: number;
      if (deterministic) {
        const up = f(f(ctx.up[i]! / ctx.luck[i]!) + live);
        x = Math.floor(f(f(f(ctx.luck[i]!) * f(c * up)) / count));
      } else x = Math.floor((c * (ctx.up[i]! + ctx.luck[i]! * live)) / count);
      if (life <= 0) x = Math.floor(f(onus * x));
      debug?.(orderIndex, i, x, live);
      score += x;
      const r = chart.rangeOf[i]!;
      if (r >= 0) rangeScore[r]! += x;
      if (damage[judgement]) life = Math.max(0, life - damage[judgement]!);
    }
    for (let r = 0; r < ranges; r++) score += Math.floor((rangeScore[r]! * chart.rangePercent[r]!) / 100);
    scores[orderIndex] = score;
  }
  restoreOrderScores(scores, orderPlan);
  let min = Infinity,
    max = -Infinity,
    minOrder = 0,
    maxOrder = 0,
    total = 0;
  for (const value of Float64Array.from(scores).sort()) total += value;
  scores.forEach((value, index) => {
    if (value < min) [min, minOrder] = [value, index];
    if (value > max) [max, maxOrder] = [value, index];
  });
  return { power, scores, mean: total / scores.length, min, max, minOrder, maxOrder };
}
