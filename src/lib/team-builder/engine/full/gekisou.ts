/** The Gekisou controller: range states, the Gekisou combo and Just counts with their bonuses and protections, the luck
 * gauge with its lottery, and the solo rank bonus. Every chart fever is one range with a mission (1 combo, 2 luck,
 * 3 Just). A range moves Wait → Standby → Start → Playing → End → Delay → Complete → Finish. */
import { LUCK, type LiveRandom } from "./random";
import { f, floorToI32, sdiv, srem } from "./num";
import type { GekisouComboInfo } from "./score";

const J_WAIT = 0;
const J_GOOD = 3;
const J_GREAT = 4;
const J_PERFECT = 5;
const J_JUST = 6;
const J_PASS = 7;

export const M_COMBO = 1;
export const M_LUCK = 2;
export const M_ALL = 4;

export const S_WAIT = 1;
export const S_STANDBY = 2;
export const S_START = 3;
export const S_PLAYING = 4;
export const S_END = 5;
export const S_DELAY = 6;
export const S_COMPLETE = 7;
export const S_FINISH = 8;

export const FEVER_WAIT = 1;
export const FEVER_FEVER = 2;
export const FEVER_END = 3;

const INVALID = -1;
const CRITICAL = 3;
const NONE_LOT = 0;
const CHANCE_LOW = 1;
const LOT_TYPE_BY_RUSH = [NONE_LOT, 4, 3, 2];
const BONUS_POINT_BY_RESULT = [5, 10, 10];
const COMPLETE_DELAY_MS = 500;
const STANDBY_MS = 4001;
export const MAX_RANGES = 3;
const NON_LUCK_NOTE_TYPES = new Set([0, 80, 82, 100, 101, 102, 103, 104, 105, 121, 122]);

type Item = readonly [weight: number, value: number];
const buffed = (buff: number, weight: number) => floorToI32(f(f(buff + 1) * f(weight)));
const isSubNote = (nt: number) => nt === 21 || nt === 120 || (nt & 0xfffffffc) === 0x3c;

function lotteryTable(items: readonly Item[], r: number): number | null {
  if (!items.length) return null;
  let total = 0;
  for (const it of items) total = (total + it[0]) | 0;
  if (total < 1) throw new Error("lottery table with a total weight below 1");
  const m = srem(Math.abs(r) | 0, total);
  let cum = 0;
  for (const it of items) {
    cum = (cum + it[0]) | 0;
    if (m < cum) return it[1];
  }
  return null;
}

class LuckSkillTable {
  readonly items: Item[];
  buff = 0;
  readonly total: number;
  constructor(items: Item[]) {
    this.items = [...items].sort((a, b) => b[1] - a[1]);
    let total = 0;
    for (const it of this.items) total = (total + it[0]) | 0;
    if (this.items.length && total < 1) throw new Error("luck bonus table with a total weight below 1");
    this.total = total;
  }
  lottery(r: number): number | null {
    if (!this.items.length) return null;
    const m = srem(Math.abs(r) | 0, this.total);
    let cum = 0;
    for (const it of this.items) {
      cum = (cum + buffed(this.buff, it[0])) | 0;
      if (m < cum) return it[1];
    }
    return null;
  }
  lotteryWithMinimum(r: number, minimum: number): number | null {
    if (!this.items.length) return null;
    let n = 0;
    let inc = 0;
    let exc = 0;
    for (const it of this.items) {
      const w = buffed(this.buff, it[0]);
      if (minimum <= it[1]) {
        n++;
        inc = (inc + w) | 0;
      } else exc = (exc + w) | 0;
    }
    if (!n) return null;
    const per = sdiv(exc, n);
    const total = (inc + Math.imul(per, n)) | 0;
    const m = srem(Math.abs(r) | 0, total);
    let cum = 0;
    for (const it of this.items)
      if (minimum <= it[1]) {
        cum = (cum + per + buffed(this.buff, it[0])) | 0;
        if (m < cum) return it[1];
      }
    return null;
  }
}

export interface GekisouTables {
  luckBasePoints: readonly { category: number; judgement: number; weight: number; point: number }[];
  luckBonusLots: readonly { lotType: number; result: number; weight: number }[];
  rankingBonuses: readonly { pattern: number; count: number; rank: number; percent: number }[];
  gaugeMax: number;
  gaugeMaxRush: number;
  rushPercent: number;
}

export class LotteryMachine {
  private good: Item[] | null = null;
  private great: Item[] | null = null;
  private perfect: Item[] | null = null;
  private hold: Item[] = [];
  private tables: LuckSkillTable[];
  private minimum: [id: number, result: number, remaining: number][] = [];
  private minimumCounter = 0;
  private lastConsumed = new Map<number, number>();
  constructor(t: GekisouTables) {
    for (const r of t.luckBasePoints) {
      if (r.weight <= 0) continue;
      const it: Item = [r.weight, r.point];
      if (r.category === 0) {
        if (r.judgement === 3) (this.good ??= []).push(it);
        else if (r.judgement === 4) (this.great ??= []).push(it);
        else if (r.judgement === 5) (this.perfect ??= []).push(it);
      } else if (r.category === 1 && r.judgement === J_PERFECT) this.hold.push(it);
    }
    const bonus: Item[][] = [[], [], [], [], []];
    for (const r of t.luckBonusLots) if (r.weight > 0 && r.lotType >= 0 && r.lotType < 5) bonus[r.lotType]!.push([r.weight, r.result]);
    this.tables = bonus.map((items) => new LuckSkillTable(items));
  }
  setBuff(percent: number) {
    const mul = f(f(percent) / 100);
    for (const t of this.tables) t.buff = mul;
  }
  private maxMinimum(): number {
    let m = 0;
    for (const [, res] of this.minimum) if (m <= res) m = res;
    return m;
  }
  private consumeMinimum(applied: number, t: number) {
    this.minimum = this.minimum.filter((e) => {
      if (e[1] > applied || e[2] < 0) return true;
      e[2] = (e[2] - 1) | 0;
      if (e[2] !== 0) return true;
      this.lastConsumed.set(e[0], t);
      return false;
    });
  }
  enableMinimum(result: number, limit: number): number {
    this.minimumCounter = (this.minimumCounter + 1) | 0;
    this.minimum.push([this.minimumCounter, result, limit >= 1 ? limit : -1]);
    return this.minimumCounter;
  }
  disableMinimum(id: number) {
    this.minimum = this.minimum.filter((e) => e[0] !== id);
  }
  isMinimumActive(id: number) {
    return this.minimum.some((e) => e[0] === id);
  }
  takeLastConsumed(id: number): number {
    const v = this.lastConsumed.get(id);
    this.lastConsumed.delete(id);
    return v ?? -1;
  }
  luckBonus(lotType: number, t: number, random: LiveRandom): number {
    const r = random.nextInt(LUCK);
    const applied = this.maxMinimum();
    const table = this.tables[lotType];
    if (!table) throw new Error("lot type out of range");
    if (applied < 1) {
      const v = table.lottery(r);
      if (v === null) throw new Error("no luck lottery item");
      return v;
    }
    const v = table.lotteryWithMinimum(r, applied);
    if (v === null) throw new Error("no luck lottery item");
    this.consumeMinimum(applied, t);
    return v;
  }
  basePoint(nt: number, j: number, random: LiveRandom): number {
    if (NON_LUCK_NOTE_TYPES.has(nt)) return 0;
    const u = (j + 1) >>> 0;
    if (u < 9 && ((0x107 >>> (u & 31)) & 1) !== 0) return 0;
    const r = random.nextInt(LUCK);
    let items: Item[] | null;
    if (isSubNote(nt)) items = this.hold;
    else if ((j - 5) >>> 0 < 2) items = this.perfect;
    else if (j === J_GREAT) items = this.great;
    else if (j === J_GOOD) items = this.good;
    else return 0;
    if (!items) throw new Error("no base point table");
    const v = lotteryTable(items, r);
    if (v === null) throw new Error("empty base point table");
    return v;
  }
}

export class LuckScore {
  totalBonusPoint = 0;
  gauge = 0;
  lotCount = 0;
  rushCombo = 0;
  results = [0, 0, 0, 0];
  next = INVALID;
  gaugeMax = 100;
  private gaugeMaxDefault = 100;
  private gaugeMaxRush = 50;
  addGauge(v: number) {
    const g = (this.gauge + v) | 0;
    const m = this.gaugeMax;
    if (m <= g) {
      if (m <= 0) throw new Error("luck gauge maximum below 1");
      this.lotCount = (this.lotCount + Math.trunc(g / m)) | 0;
      this.gauge = g % m;
    } else this.gauge = g;
  }
  private changeMax(m: number) {
    if (m < 1 || this.gaugeMax === m) return;
    this.gaugeMax = m;
    const g = this.gauge;
    if (g <= m) return;
    this.lotCount = (this.lotCount + Math.trunc(g / m)) | 0;
    this.gauge = g % m;
  }
  initialize(max: number, rushMax: number) {
    if (max > 0 && rushMax > 0) {
      this.gaugeMaxDefault = max;
      this.gaugeMaxRush = rushMax;
      this.changeMax(max);
    }
  }
  currentLotType(): number {
    const rc = this.rushCombo >>> 0;
    return rc < 4 ? LOT_TYPE_BY_RUSH[rc]! : CHANCE_LOW;
  }
  addScore(r: number) {
    const i = r - 1;
    if (i >>> 0 < 3) this.totalBonusPoint = (this.totalBonusPoint + BONUS_POINT_BY_RESULT[i]!) | 0;
    if (r >= 0 && r <= CRITICAL) this.results[r]!++;
    if (r >>> 0 < 3) {
      this.rushCombo = 0;
      this.changeMax(this.gaugeMaxDefault);
    } else if (r === CRITICAL) {
      this.rushCombo = (this.rushCombo + 1) | 0;
      this.changeMax(this.gaugeMaxRush);
    }
  }
}

class FactorStorage {
  lot: [number, number][] = [];
  gauge: [number, number][] = [];
  private lotIds = new Map<number, number>();
  private gaugeIds = new Map<number, number>();
  private current = 0;
  static at(cmds: readonly [number, number][], t: number): number {
    let s = 0;
    for (const [ct, d] of cmds) if (ct <= t) s = f(s + d);
    return s;
  }
  add(gauge: boolean, t: number, value: number): number {
    this.current = (this.current + 1) | 0;
    (gauge ? this.gaugeIds : this.lotIds).set(this.current, value);
    (gauge ? this.gauge : this.lot).push([t, value]);
    return this.current;
  }
  subtract(gauge: boolean, t: number, id: number) {
    const ids = gauge ? this.gaugeIds : this.lotIds;
    const v = ids.get(id);
    if (v === undefined) throw new Error("luck factor id not found");
    ids.delete(id);
    (gauge ? this.gauge : this.lot).push([t, -v]);
  }
}

export interface Range {
  startMs: number;
  endMs: number;
  mission: number;
  targets: ReadonlySet<number>;
}
export class RangeState {
  state = S_WAIT;
  timeTo = 0;
  combo = 0;
  maxCombo = 0;
  just = 0;
  rawJust = 0;
  cumBase = 0;
  startScore = 0;
  endScore = 0;
  lastComboMs = -1;
  lastJustMs = -1;
  luck = new LuckScore();
  swElapsed = 0;
  swStopped = true;
  get score() {
    return (this.endScore - this.startScore) | 0;
  }
}
interface Resume {
  processed: number;
  combo: number;
  maxCombo: number;
  just: number;
  rawJust: number;
  cumBase: number;
  comboBonus: number;
  justBonus: number;
  iCb: number;
  iJb: number;
  iAddJust: number;
  iAddCombo: number;
}
const emptyResume = (): Resume => ({
  processed: 0,
  combo: 0,
  maxCombo: 0,
  just: 0,
  rawJust: 0,
  cumBase: 0,
  comboBonus: 0,
  justBonus: 0,
  iCb: 0,
  iJb: 0,
  iAddJust: 0,
  iAddCombo: 0,
});
interface Rule {
  rangeIndex: number;
  unit: number;
  effect: number;
  maxCum: number;
  maxEff: number;
}
function cumulativeJustBonus(rules: Iterable<Rule>, rangeIndex: number, x: number): number {
  let total = 0;
  for (const r of rules) {
    if (r.rangeIndex !== rangeIndex || r.unit <= 0) continue;
    let steps = Math.trunc(x / r.unit) | 0;
    if (!(steps <= r.maxCum || r.maxCum === 0 || r.maxCum < 0)) steps = r.maxCum;
    let v = Number(BigInt.asIntN(32, BigInt(steps) * BigInt(r.effect)));
    if (r.maxEff > 0 && r.maxEff <= v) v = r.maxEff;
    total = (total + v) | 0;
  }
  return total;
}
const scoreFrame = (ms: number) => (ms > 0 ? Math.ceil(f(f(ms) / 40)) : 0);
const previousFrameEnd = (t: number) => (Math.imul(scoreFrame(t), 40) - 40) | 0;
function lastJudgementIndex(h: readonly [number, number, number][], count: number, maxMs: number): number {
  let hi = count - 1;
  if (hi < 1) return 0;
  let lo = 0;
  for (;;) {
    const mid = lo + sdiv(hi - lo + 1, 2);
    if (h[mid]![0] <= maxMs) lo = mid;
    else hi = mid - 1;
    if (lo >= hi) return lo;
  }
}

export interface LuckHandle {
  add(t: number, percent: number): number;
  disable(t: number, id: number): void;
}
export interface Env {
  random: LiveRandom;
  handle: LuckHandle;
}
/** A judged note as the controller reads it: note id, note type, chart time, converted judgement. */
export type GkNote = readonly [id: number, type: number, timeMs: number, judgement: number];

export class Controller implements GekisouComboInfo {
  readonly ranges: Range[];
  readonly states: RangeState[];
  readonly machine: LotteryMachine;
  private storage = new FactorStorage();
  private rushId = 0;
  private playing: number[] = [];
  private comboBonusIds = new Map<number, number>();
  private justBonusIds = new Map<number, number>();
  private rules = new Map<number, Rule>();
  private handleId = 0;
  private needsRecalc = false;
  private fullRecalc = false;
  private seq = 0;
  private history: [number, number, number][][];
  private snapshot: number[][];
  private resume: Resume[];
  private cbStack: [number, number, number][] = [];
  private jbStack: [number, number, number][] = [];
  private addJustStack: [number, number, number][] = [];
  private addComboStack: [number, number, number][] = [];
  private prStack: [number, number, number, number][] = [];
  private unlimited: [number, number][] = [];
  private limited: [number, number, number][] = [];
  private limitedIds = new Set<number>();
  private pending: [number, number, number, number][][];
  private lotResult = INVALID;
  lotResults: number[] = [];
  stateUpdates: number[] = [];
  currentPlayingIndex = -1;

  constructor(
    ranges: readonly (readonly [number, number, number])[],
    notes: readonly (readonly [id: number, timeMs: number])[],
    t: GekisouTables,
    private readonly rushPercent: number,
    private readonly lastNoteDelayMs: number,
  ) {
    this.ranges = ranges.map(([s, e, mission]) => ({
      startMs: s,
      endMs: e,
      mission,
      targets: new Set(notes.filter(([, time]) => s <= time && time <= e).map(([id]) => id)),
    }));
    this.states = this.ranges.map((r) => {
      const st = new RangeState();
      if (r.mission === M_LUCK) st.luck.initialize(t.gaugeMax, t.gaugeMaxRush);
      return st;
    });
    this.machine = new LotteryMachine(t);
    const n = this.ranges.length;
    this.history = Array.from({ length: n }, () => []);
    this.snapshot = Array.from({ length: n }, () => []);
    this.resume = Array.from({ length: n }, emptyResume);
    this.pending = Array.from({ length: n }, () => []);
    this.luckGaugeMax = t.gaugeMax;
  }
  private readonly luckGaugeMax: number;

  private nextId() {
    this.handleId = (this.handleId + 1) | 0;
    return this.handleId;
  }
  private flag() {
    this.needsRecalc = true;
    this.fullRecalc = true;
  }
  /** The last range that started and has not finished, or -1. */
  playingRangeIndex(): number {
    return this.playing.length ? this.playing[this.playing.length - 1]! : -1;
  }
  addJustCount(timeMs: number, count: number) {
    this.addJustStack.push([timeMs, f(count), this.playingRangeIndex()]);
    this.flag();
  }
  addGekisouCombo(timeMs: number, count: number) {
    this.addComboStack.push([timeMs, f(count), this.playingRangeIndex()]);
    this.flag();
  }
  private applyFixedCount(idx: number, delta: number, range: number, just: boolean) {
    if (range !== -1 && range !== idx) return;
    const n = Math.trunc(delta) | 0;
    const rs = this.states[idx]!;
    if (just) {
      rs.just = (rs.just + n) | 0;
      rs.cumBase = (rs.cumBase + n) | 0;
    } else {
      rs.combo = (rs.combo + n) | 0;
      rs.maxCombo = Math.max(rs.maxCombo, rs.combo);
    }
  }
  addLuckPoint(p: number) {
    const i = this.playingRangeIndex();
    if (i < 0) return;
    const ls = this.states[i]!.luck;
    ls.totalBonusPoint = (ls.totalBonusPoint + p) | 0;
  }
  addLuckGaugePercent(g: number) {
    const i = this.playingRangeIndex();
    if (i >= 0) this.states[i]!.luck.addGauge(g);
  }
  currentGaugeMax(): number {
    const i = this.playingRangeIndex();
    return i >= 0 ? this.states[i]!.luck.gaugeMax : this.luckGaugeMax;
  }
  addComboBonus(t: number, bonus: number): number {
    const i = this.nextId();
    this.comboBonusIds.set(i, bonus);
    this.cbStack.push([t, bonus, (this.seq - 1) | 0]);
    this.flag();
    return i;
  }
  subtractComboBonus(t: number, id: number) {
    const v = this.comboBonusIds.get(id);
    if (v === undefined) throw new Error("combo bonus id not found");
    this.comboBonusIds.delete(id);
    this.cbStack.push([t, -v, (this.seq - 1) | 0]);
    this.flag();
  }
  addJustBonus(t: number, bonus: number): number {
    const i = this.nextId();
    this.justBonusIds.set(i, bonus);
    this.jbStack.push([t, bonus, (this.seq - 1) | 0]);
    this.flag();
    return i;
  }
  subtractJustBonus(t: number, id: number) {
    const v = this.justBonusIds.get(id);
    if (v === undefined) throw new Error("Just bonus id not found");
    this.justBonusIds.delete(id);
    this.jbStack.push([t, -v, (this.seq - 1) | 0]);
    this.flag();
  }
  addCumulativeRule(unit: number, effect: number, maxCum: number, maxEff: number): number {
    const i = this.nextId();
    this.rules.set(i, { rangeIndex: this.playingRangeIndex(), unit, effect, maxCum, maxEff });
    this.flag();
    return i;
  }
  removeCumulativeRule(id: number) {
    if (this.rules.delete(id)) this.flag();
  }
  enableComboProtect(t: number, limit: number, mask: number): number {
    const i = this.nextId();
    if (limit < 1) this.prStack.push([t, 1, i, mask & 0xff]);
    else {
      this.limitedIds.add(i);
      this.prStack.push([t, (limit + 1) | 0, i, mask & 0xff]);
    }
    this.flag();
    return i;
  }
  disableComboProtect(t: number, id: number) {
    const d = this.limitedIds.delete(id) ? -2 : -1;
    this.prStack.push([t, d, id, 0]);
    this.flag();
  }
  addLotProbabilityUp(t: number, value: number) {
    return this.storage.add(false, t, value);
  }
  addGaugeUp(t: number, value: number) {
    return this.storage.add(true, t, value);
  }
  subtractLotProbabilityUp(t: number, id: number) {
    this.storage.subtract(false, t, id);
  }
  subtractGaugeUp(t: number, id: number) {
    this.storage.subtract(true, t, id);
  }

  private recalculate() {
    for (let idx = 0; idx < this.states.length; idx++) {
      if (this.states[idx]!.state >= S_DELAY || !this.history[idx]!.length) continue;
      const rr = this.resume[idx]!;
      const rs = this.states[idx]!;
      const h = this.history[idx]!;
      let cb: number, jb: number, iCb: number, iJb: number, iPr: number, k: number, iAddJust: number, iAddCombo: number;
      if (!this.fullRecalc && !this.prStack.length && 1 <= rr.processed && rr.processed <= h.length) {
        rs.combo = rr.combo;
        rs.maxCombo = rr.maxCombo;
        rs.just = rr.just;
        rs.rawJust = rr.rawJust;
        rs.cumBase = rr.cumBase;
        [cb, jb, iCb, iJb, iPr, k, iAddJust, iAddCombo] = [rr.comboBonus, rr.justBonus, rr.iCb, rr.iJb, 0, rr.processed, rr.iAddJust, rr.iAddCombo];
      } else {
        rs.combo = rs.maxCombo = rs.just = rs.rawJust = rs.cumBase = 0;
        this.snapshot[idx] = [];
        this.unlimited = [];
        this.limited = [];
        [cb, jb, iCb, iJb, iPr, k, iAddJust, iAddCombo] = [1, 1, 0, 0, 0, 0, 0, 0];
      }
      while (k < h.length) {
        const [et, j, es] = h[k]!;
        while (iCb < this.cbStack.length) {
          const [ct, d, cs] = this.cbStack[iCb]!;
          if (et <= ct && (et < ct || es < cs)) break;
          cb = f(cb + d);
          iCb++;
        }
        while (iJb < this.jbStack.length) {
          const [ct, d, cs] = this.jbStack[iJb]!;
          if (et <= ct && (et < ct || es < cs)) break;
          jb = f(jb + d);
          iJb++;
        }
        while (iPr < this.prStack.length && et >= this.prStack[iPr]![0]) {
          const [, d, pid, mask] = this.prStack[iPr]!;
          if (d < 2) {
            if (d === 1) this.unlimited.push([pid, mask]);
            else if (d < -1) {
              const p = this.limited.findIndex((x) => x[0] === pid);
              if (p >= 0) this.limited.splice(p, 1);
            } else {
              const p = this.unlimited.findIndex((x) => x[0] === pid);
              if (p >= 0) this.unlimited.splice(p, 1);
            }
          } else this.limited.push([pid, (d - 1) | 0, mask]);
          iPr++;
        }
        while (iAddJust < this.addJustStack.length && this.addJustStack[iAddJust]![0] <= et) {
          const [, d, range] = this.addJustStack[iAddJust]!;
          this.applyFixedCount(idx, d, range, true);
          iAddJust++;
        }
        while (iAddCombo < this.addComboStack.length && this.addComboStack[iAddCombo]![0] <= et) {
          const [, d, range] = this.addComboStack[iAddCombo]!;
          this.applyFixedCount(idx, d, range, false);
          iAddCombo++;
        }
        this.entry(idx, j, floorToI32(cb), floorToI32(jb));
        this.snapshot[idx]!.push(rs.combo);
        k++;
      }
      this.resume[idx] = {
        processed: h.length,
        combo: rs.combo,
        maxCombo: rs.maxCombo,
        just: rs.just,
        rawJust: rs.rawJust,
        cumBase: rs.cumBase,
        comboBonus: cb,
        justBonus: jb,
        iCb,
        iJb,
        iAddJust,
        iAddCombo,
      };
      for (let i = iAddJust; i < this.addJustStack.length; i++) {
        const [, d, range] = this.addJustStack[i]!;
        this.applyFixedCount(idx, d, range, true);
      }
      for (let i = iAddCombo; i < this.addComboStack.length; i++) {
        const [, d, range] = this.addComboStack[i]!;
        this.applyFixedCount(idx, d, range, false);
      }
    }
    this.fullRecalc = false;
  }
  private entry(idx: number, j: number, iCombo: number, iJust: number) {
    const rs = this.states[idx]!;
    if ((j - 3) >>> 0 < 0xfffffffe) {
      if ((j - 7) >>> 0 > 0xfffffffb) {
        rs.combo = (rs.combo + iCombo) | 0;
        rs.maxCombo = Math.max(rs.maxCombo, rs.combo);
      } else return;
    } else {
      const bit = 1 << (j & 31);
      const eff = (m: number) => (m !== 0 ? m : 6);
      let prot = this.unlimited.some(([, m]) => (eff(m) & bit) !== 0);
      for (let i = this.limited.length - 1; i >= 0; i--) {
        const [pid, rem, m] = this.limited[i]!;
        if ((eff(m) & bit) !== 0) {
          const left = (rem - 1) | 0;
          if (left < 1) this.limited.splice(i, 1);
          else this.limited[i] = [pid, left, m];
          prot = true;
        }
      }
      if (!prot) {
        rs.maxCombo = Math.max(rs.maxCombo, rs.combo);
        rs.combo = 0;
      }
    }
    if (j === J_JUST) {
      rs.rawJust = (rs.rawJust + 1) | 0;
      rs.cumBase = (rs.cumBase + iJust) | 0;
      const c = cumulativeJustBonus(this.rules.values(), idx, rs.cumBase);
      rs.just = (c + iJust + rs.just) | 0;
    }
  }
  private timingComboInRange(idx: number, t: number): number {
    const h = this.history[idx]!;
    const sn = this.snapshot[idx]!;
    const n = Math.min(h.length, sn.length);
    if (!n) return 0;
    const prevEnd = previousFrameEnd(t);
    if (prevEnd < h[0]![0]) return 0;
    return sn[lastJudgementIndex(h, n, prevEnd)]!;
  }

  /** Luck recording: no lottery is drawn (the luck DP propagates it). */
  weighted = false;
  /** Gauge speed and lot buff filed at a chart time. */
  gaugeSpeedAt(t: number) {
    return FactorStorage.at(this.storage.gauge, t);
  }
  lotBuffAt(t: number) {
    return floorToI32(f(FactorStorage.at(this.storage.lot, t) * 100));
  }
  private updateLuck(idx: number, nt: number, tn: number, j: number, env: Env) {
    if (this.weighted) return;
    const buff = floorToI32(f(FactorStorage.at(this.storage.lot, tn) * 100));
    this.machine.setBuff(buff);
    const gup = FactorStorage.at(this.storage.gauge, tn);
    const base = this.machine.basePoint(nt, j, env.random);
    const add = floorToI32(f(f(gup + 1) * f(base)));
    this.states[idx]!.luck.addGauge(add);
    this.consumeLot(idx, tn, env);
  }
  private disableRush(t: number, env: Env) {
    if (this.rushId !== 0) {
      env.handle.disable(t, this.rushId);
      this.rushId = 0;
    }
  }
  private consumeLot(idx: number, t: number, env: Env) {
    const st = this.states[idx]!;
    if (st.state > S_END || st.luck.lotCount < 1) return;
    st.luck.lotCount--;
    if (st.luck.next === INVALID) st.luck.next = this.machine.luckBonus(NONE_LOT, t, env.random);
    const next = st.luck.next;
    const rush = st.luck.rushCombo;
    if (rush === 0) {
      if (next === CRITICAL) this.rushId = env.handle.add(t, this.rushPercent);
      else this.disableRush(t, env);
    } else if (next !== CRITICAL) this.disableRush(t, env);
    st.luck.addScore(next);
    if (next !== INVALID) {
      this.lotResult = next;
      this.lotResults.push(next);
    }
    st.luck.next = this.machine.luckBonus(st.luck.currentLotType(), t, env.random);
  }
  private pendingLots(t: number, env: Env) {
    if (this.weighted) return;
    for (const idx of [...this.playing]) {
      const rs = this.states[idx]!;
      if (this.ranges[idx]!.mission === M_LUCK && rs.state === S_PLAYING && rs.luck.lotCount !== 0 && this.lotResult === INVALID) {
        this.machine.setBuff(floorToI32(f(FactorStorage.at(this.storage.lot, t) * 100)));
        this.consumeLot(idx, t, env);
      }
    }
  }
  private judge(idx: number, nt: number, tn: number, j: number, env: Env) {
    if (j === J_PASS || j === J_WAIT) return;
    this.history[idx]!.push([tn, j, this.seq]);
    this.seq = (this.seq + 1) | 0;
    this.needsRecalc = true;
    if ((j - 3) >>> 0 < 4) this.states[idx]!.lastComboMs = tn;
    if (j === J_JUST) this.states[idx]!.lastJustMs = tn;
    if (this.ranges[idx]!.mission === M_LUCK) {
      if (this.states[idx]!.state < S_START) this.pending[idx]!.push([nt, tn, 0, j]);
      else this.updateLuck(idx, nt, tn, j, env);
    }
  }
  /** After the frame's skills and score: judged notes of the ranges, the recount, fever-end scores and pending lots. */
  update(t: number, judged: readonly GkNote[], feverUpdates: readonly (readonly [number, number])[], currentScore: number, env: Env) {
    for (let idx = 0; idx < this.states.length; idx++)
      if (this.states[idx]!.state > S_STANDBY && this.pending[idx]!.length) {
        const pending = this.pending[idx]!;
        this.pending[idx] = [];
        for (const [nt, tn, , j] of pending) this.updateLuck(idx, nt, tn, j, env);
      }
    for (let idx = 0; idx < this.states.length; idx++)
      for (const [nid, nt, tn, j] of judged) if (this.ranges[idx]!.targets.has(nid)) this.judge(idx, nt, tn, j, env);
    if (this.needsRecalc) {
      this.recalculate();
      this.needsRecalc = false;
    }
    for (const [idx, fs] of feverUpdates) {
      const rs = this.states[idx];
      if (!rs) throw new Error("IndexOutOfRangeException: fever without a Gekisou range");
      if (fs === FEVER_END) rs.endScore = currentScore;
    }
    this.pendingLots(t, env);
  }
  private stateUpdate(idx: number) {
    if (!this.stateUpdates.includes(idx)) this.stateUpdates.push(idx);
  }
  private static elapsedMs(rs: RangeState): number {
    const v = f(rs.swElapsed * 1000);
    return v === Infinity ? -Number.MAX_SAFE_INTEGER : Math.trunc(v);
  }
  /** Before the frame: range state machine and stopwatches. */
  beforeUpdate(dt: number, t: number, feverUpdates: readonly (readonly [number, number])[], currentScore: number, env: Env) {
    this.stateUpdates.length = 0;
    this.lotResult = INVALID;
    this.lotResults.length = 0;
    this.currentPlayingIndex = -1;
    for (let i = 0; i < this.states.length; i++) this.states[i]!.timeTo = (this.ranges[i]!.startMs - t) | 0;
    let remove: number[] | null = null;
    for (const idx of this.playing) {
      const rs = this.states[idx]!;
      const st = rs.state;
      if (st < S_END) {
        if (st === S_START) {
          rs.state = S_PLAYING;
          this.stateUpdate(idx);
          this.currentPlayingIndex = idx;
        } else if (st === S_PLAYING) this.currentPlayingIndex = idx;
      } else if (st === S_END) {
        this.currentPlayingIndex = idx;
        if (!rs.swStopped) rs.swElapsed = f(rs.swElapsed + dt);
        if (this.lastNoteDelayMs <= Controller.elapsedMs(rs)) {
          rs.swElapsed = 0;
          rs.swStopped = false;
          rs.state = S_DELAY;
          this.stateUpdate(idx);
        }
      } else if (st === S_DELAY) {
        if (!rs.swStopped) rs.swElapsed = f(rs.swElapsed + dt);
        if (COMPLETE_DELAY_MS <= Controller.elapsedMs(rs)) {
          rs.state = S_COMPLETE;
          rs.swStopped = true;
          this.stateUpdate(idx);
        }
      } else if (st === S_COMPLETE) {
        rs.state = S_FINISH;
        this.stateUpdate(idx);
        (remove ??= []).push(idx);
        this.disableRush(t, env);
      }
    }
    if (remove)
      for (const idx of remove) {
        const p = this.playing.indexOf(idx);
        if (p >= 0) this.playing.splice(p, 1);
      }
    for (const [idx, fs] of feverUpdates) {
      const rs = this.states[idx];
      if (!rs) throw new Error("IndexOutOfRangeException: fever without a Gekisou range");
      if (fs === FEVER_END) {
        rs.state = S_END;
        rs.swElapsed = 0;
        rs.swStopped = false;
        this.stateUpdate(idx);
      } else if (fs === FEVER_FEVER) {
        rs.state = S_START;
        rs.startScore = currentScore;
        this.playing.push(idx);
        this.stateUpdate(idx);
        this.currentPlayingIndex = idx;
      }
    }
    for (let idx = 0; idx < this.states.length; idx++)
      if (this.states[idx]!.state === S_WAIT && this.states[idx]!.timeTo < STANDBY_MS) {
        this.states[idx]!.state = S_STANDBY;
        this.stateUpdate(idx);
      }
  }
  gekisouCombo(timeMs: number): number | null {
    const i = this.ranges.findIndex((r) => r.mission === M_COMBO && r.startMs <= timeMs && timeMs <= r.endMs);
    return i < 0 ? null : this.timingComboInRange(i, timeMs);
  }
}

/** The chart's fevers: Wait → Fever at the start and Fever → End at the end, at most one step per frame. */
export class FeverUpdater {
  private state: number[];
  constructor(private readonly fevers: readonly (readonly [number, number])[]) {
    this.state = fevers.map(() => FEVER_WAIT);
  }
  private readonly out: [number, number][] = [];
  update(t: number): [number, number][] {
    const out = this.out;
    out.length = 0;
    for (let i = 0; i < this.fevers.length; i++) {
      const [s, e] = this.fevers[i]!;
      const st = this.state[i]!;
      const next = st === FEVER_WAIT && t >= s ? FEVER_FEVER : st === FEVER_FEVER && t >= e ? FEVER_END : 0;
      if (!next) continue;
      this.state[i] = next;
      out.push([i, next]);
    }
    return out;
  }
}

/** The song's mission pattern: 0 when a mission is missing, 1 all the same, 2 all different, 3 otherwise. */
export function missionPattern(t0: number, t1: number, t2: number): number {
  if (!t0 || !t1 || !t2) return 0;
  if (t0 === t1) return t0 === t2 ? 1 : 3;
  if (t1 !== t2 && t0 !== t2) return 2;
  return 3;
}
/** Rank bonus percentages `[range][rank - 1]` of a mission pattern. */
export function rankingFactors(t: GekisouTables, pattern: number): number[][] {
  const out = [0, 1, 2].map(() => [0, 0, 0, 0, 0]);
  for (const r of t.rankingBonuses) {
    const c = r.count - 1;
    const k = r.rank - 1;
    if (r.pattern === pattern && c >>> 0 < 3 && k >>> 0 <= 4) out[c]![k] = r.percent;
  }
  return out;
}
