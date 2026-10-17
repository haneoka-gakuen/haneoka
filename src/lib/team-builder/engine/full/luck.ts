/** Expected Gekisou luck under the native lottery with independent nominal draws: the distribution of each luck range's
 * lottery state is propagated note by note and frame by frame through a lottery-free recording of the live (range
 * states, judged notes with their gauge speed, range-start actions with their chances), and each judged note reads the
 * probability that the rush luck bonus, the rush-reading score-up skills, or both are running at its time. */
import type { GekisouTables } from "./gekisou";
import type { LuckRecord } from "./model";
import { f, floorToI32, sdiv } from "./num";

const NON_LUCK = new Set([0, 80, 82, 100, 101, 102, 103, 104, 105, 121, 122]);
const isSubNote = (nt: number) => nt === 21 || nt === 120 || (nt & 0xfffffffc) === 0x3c;
const CRITICAL = 3;
const INVALID = -1;
const LOT_TYPE_BY_RUSH = [0, 4, 3, 2];
const S_START = 3;
const S_PLAYING = 4;
const S_END = 5;
const S_COMPLETE = 7;
const S_FINISH = 8;

type Item = readonly [weight: number, value: number];
const buffed = (buff: number, weight: number) => floorToI32(f(f(buff + 1) * f(weight)));

/** Nominal probabilities of one draw: (probability, value) with values merged. */
function merge(pairs: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [p, v] of pairs) {
    const at = out.find((item) => item[1] === v);
    if (at) at[0] += p;
    else if (p > 0) out.push([p, v]);
  }
  return out;
}

export interface MissRule {
  value: number;
  chance: number;
}
/** Per judged note (by note id): probabilities that the rush luck bonus runs, that the rush score-ups run, both. */
export interface LuckCurve {
  rush: Map<number, number>;
  skill: Map<number, number>;
  both: Map<number, number>;
}

/** Settlement of one selected luck range; residues retain the history that per-note marginals discard. */
export interface LuckSettlement {
  modulus: number;
  initial: number;
  noteScore: (id: number, bonus: boolean, skill: boolean) => number;
  residues: Float64Array;
}

/** A lottery state packed into an integer: gauge (8 bits), lots (3), next + 1 (3), rush (3), minimum (2), then flags
 * missUsed, prevMiss, frameLot, frameMiss, bonus (rush luck running), skill and skillPrev (the rush checker as asked
 * this frame and the frame before). */
const G = 1,
  L = 1 << 8,
  N = 1 << 11,
  R = 1 << 14,
  MIN = 1 << 17,
  MISS_USED = 1 << 19,
  PREV_MISS = 1 << 20,
  FRAME_LOT = 1 << 21,
  FRAME_MISS = 1 << 22,
  BONUS = 1 << 23,
  SKILL = 1 << 24,
  SKILL_PREV = 1 << 25;
const lotsOf = (s: number) => (s >>> 8) & 7;
const nextOf = (s: number) => ((s >>> 11) & 7) - 1;
const rushOf = (s: number) => (s >>> 14) & 7;
const minimumOf = (s: number) => (s >>> 17) & 3;
const pack = (gauge: number, lots: number, next: number, rush: number, minimum: number, flags: number) =>
  gauge * G + Math.min(lots, 7) * L + (next + 1) * N + rush * R + minimum * MIN + flags;
const FLAGS = MISS_USED | PREV_MISS | FRAME_LOT | FRAME_MISS | BONUS | SKILL | SKILL_PREV;
const flagsOf = (s: number) => s & FLAGS;

const ROW = 1 << 18;
const HIGH = ROW - 1;

/** A distribution over lottery states as rows of gauge vectors: a row per state without its gauge (and, when settling,
 * with the score residue above it), insertion ordered. Every lottery step but the gauge itself acts on whole rows. */
class Rows {
  keys: number[] = [];
  vecs: Float64Array[] = [];
  /** Each row's nonzero gauge values lie in [lo, hi). */
  lo: number[] = [];
  hi: number[] = [];
  /** Row index + 1 by key: a table over lottery states alone, a map once residues join the key. */
  private readonly table: Int32Array | null;
  private readonly map: Map<number, number> | null;
  constructor(
    private readonly width: number,
    private readonly pool: Float64Array[],
    wide: boolean,
  ) {
    this.table = wide ? null : new Int32Array(ROW);
    this.map = wide ? new Map() : null;
  }
  private find(key: number) {
    return this.table ? this.table[key]! - 1 : (this.map!.get(key) ?? -1);
  }
  private put(key: number, vec: Float64Array, lo: number, hi: number) {
    if (this.table) this.table[key] = this.keys.length + 1;
    else this.map!.set(key, this.keys.length);
    this.keys.push(key);
    this.vecs.push(vec);
    this.lo.push(lo);
    this.hi.push(hi);
    return this.keys.length - 1;
  }
  /** The row's index, created empty if missing. */
  at(key: number) {
    const i = this.find(key);
    return i >= 0 ? i : this.put(key, this.pool.pop() ?? new Float64Array(this.width), this.width, 0);
  }
  /** Marks gauge values [lo, hi) of row i as written. */
  touch(i: number, lo: number, hi: number) {
    if (lo < this.lo[i]!) this.lo[i] = lo;
    if (hi > this.hi[i]!) this.hi[i] = hi;
  }
  /** Takes the vector over, or adds it into the row already there and returns it to the pool. */
  adopt(key: number, vec: Float64Array, lo: number, hi: number) {
    const i = this.find(key);
    if (i < 0) {
      this.put(key, vec, lo, hi);
      return;
    }
    const into = this.vecs[i]!;
    for (let g = lo; g < hi; g++) into[g]! += vec[g]!;
    this.touch(i, lo, hi);
    this.free(vec, lo, hi);
  }
  free(vec: Float64Array, lo: number, hi: number) {
    if (hi > lo) vec.fill(0, lo, hi);
    this.pool.push(vec);
  }
  /** Forgets every row; their vectors were freed or adopted elsewhere. */
  reset() {
    if (this.table) for (const key of this.keys) this.table[key] = 0;
    else this.map!.clear();
    this.keys.length = 0;
    this.vecs.length = 0;
    this.lo.length = 0;
    this.hi.length = 0;
  }
}

export function luckCurve(
  tables: GekisouTables,
  record: LuckRecord,
  frames: readonly { timeMs: number; judged: readonly { noteId: number; timeMs: number }[] }[],
  luckRanges: readonly number[],
  missRules: readonly MissRule[],
  settlement?: LuckSettlement,
): LuckCurve {
  // Lottery tables.
  const base = { good: [] as Item[], great: [] as Item[], perfect: [] as Item[], hold: [] as Item[] };
  for (const r of tables.luckBasePoints) {
    if (r.weight <= 0) continue;
    if (r.category === 0) {
      if (r.judgement === 3) base.good.push([r.weight, r.point]);
      else if (r.judgement === 4) base.great.push([r.weight, r.point]);
      else if (r.judgement === 5) base.perfect.push([r.weight, r.point]);
    } else if (r.category === 1 && r.judgement === 5) base.hold.push([r.weight, r.point]);
  }
  const lots: Item[][] = [[], [], [], [], []];
  for (const r of tables.luckBonusLots) if (r.weight > 0 && r.lotType >= 0 && r.lotType < 5) lots[r.lotType]!.push([r.weight, r.result]);
  for (const table of lots) table.sort((a, b) => b[1] - a[1]);
  const basePoints = (op: number, j: number): [number, number][] => {
    if (NON_LUCK.has(op)) return [[1, 0]];
    const u = (j + 1) >>> 0;
    if (u < 9 && ((0x107 >>> (u & 31)) & 1) !== 0) return [[1, 0]];
    const items = isSubNote(op) ? base.hold : (j - 5) >>> 0 < 2 ? base.perfect : j === 4 ? base.great : j === 3 ? base.good : null;
    if (!items?.length) return [[1, 0]];
    const total = items.reduce((sum, [w]) => sum + w, 0);
    return merge(items.map(([w, v]) => [w / total, v]));
  };
  const drawCache = new Map<number, [number, number][]>();
  /** One bonus draw of a lot type at a lot buff (percent) with a guaranteed minimum result. */
  const draw = (type: number, buffPercent: number, minimum: number): [number, number][] => {
    const key = (buffPercent * 8 + type) * 4 + minimum;
    let value = drawCache.get(key);
    if (value) return value;
    const items = lots[type] ?? [];
    const buff = f(f(buffPercent) / 100);
    let total = items.reduce((sum, [w]) => (sum + w) | 0, 0);
    let per = 0;
    if (minimum >= 1) {
      let included = 0,
        excluded = 0,
        n = 0;
      for (const [w, r] of items) {
        const weight = buffed(buff, w);
        if (r >= minimum) {
          included += weight;
          n++;
        } else excluded += weight;
      }
      per = sdiv(excluded, n);
      total = included + per * n;
    }
    const out: [number, number][] = [];
    let lo = 0;
    for (const [w, r] of items) {
      if (minimum >= 1 && r < minimum) continue;
      const weight = per + buffed(buff, w);
      const hi = lo + weight;
      const a = Math.min(Math.max(lo, 0), total),
        b = Math.min(Math.max(hi, 0), total);
      if (b > a) out.push([(b - a) / total, r]);
      lo = hi;
    }
    drawCache.set(key, (value = merge(out)));
    return value;
  };

  const curve: LuckCurve = { rush: new Map(), skill: new Map(), both: new Map() };
  const gaugeMaxOf = (rush: number) => (rush > 0 ? tables.gaugeMaxRush : tables.gaugeMax);
  const width = Math.max(tables.gaugeMax, tables.gaugeMaxRush);
  const pool: Float64Array[] = [];
  let dist = new Rows(width, pool, !!settlement);
  let spare = new Rows(width, pool, !!settlement);
  let steadyAt = -1;
  /** One-to-one changes of the non-gauge state wait here and apply to the keys the next step reads. */
  let pending: ((s: number) => number) | null = null;
  const keyAt = (i: number) => {
    const key = dist.keys[i]!;
    if (!pending) return key;
    const high = key & HIGH;
    return key - high + (pending(high << 8) >>> 8);
  };
  /** One step over every row; `step` returns true when it kept the row's vector. */
  const pass = (step: (key: number, vec: Float64Array, lo: number, hi: number, out: Rows) => boolean | void) => {
    const from = dist;
    const out = spare;
    for (let i = 0; i < from.keys.length; i++)
      if (!step(keyAt(i), from.vecs[i]!, from.lo[i]!, from.hi[i]!, out)) out.free(from.vecs[i]!, from.lo[i]!, from.hi[i]!);
    pending = null;
    from.reset();
    spare = from;
    dist = out;
    steadyAt = -1;
  };
  const axpy = (out: Rows, key: number, vec: Float64Array, scale: number, lo: number, hi: number) => {
    if (!(scale > 0)) return;
    const i = out.at(key);
    const into = out.vecs[i]!;
    for (let g = lo; g < hi; g++) into[g]! += vec[g]! * scale;
    out.touch(i, lo, hi);
  };
  /** Gauge addition with overflow into lots at the row's gauge maximum. */
  /** Adds `scale ×` gauge values [a, b) of `vec` to row `key` at gauge `g + offset`. */
  const block = (out: Rows, key: number, vec: Float64Array, a: number, b: number, offset: number, scale: number) => {
    const i = out.at(key);
    const into = out.vecs[i]!;
    for (let g = a; g < b; g++) into[g + offset]! += vec[g]! * scale;
    out.touch(i, a + offset, b + offset);
  };
  /** Gauge addition with overflow into lots at the row's gauge maximum; with `buff`, a row left holding a lot consumes
   * it at once (a luck note's draw), without an intermediate distribution. */
  const shift = (out: Rows, key: number, vec: Float64Array, scale: number, add: number, lo: number, hi: number, buff: number | null = null) => {
    if (!(scale > 0)) return;
    const high = key & HIGH;
    const max = gaugeMaxOf(rushOf(high << 8));
    const lots = high & 7;
    // Gauge values that overflow e times form one block: it lands in the row with e more lots.
    for (let e = Math.trunc((lo + add) / max); ; e++) {
      const a = Math.max(lo, e * max - add),
        b = Math.min(hi, (e + 1) * max - add);
      if (a >= hi) break;
      if (b <= a) continue;
      const target = e === 0 ? key : key - lots + Math.min(lots + e, 7);
      const offset = add - e * max;
      if (buff === null || (target & 7) === 0) block(out, target, vec, a, b, offset, scale);
      else consumeBlock(out, target, vec, a, b, offset, scale, buff);
    }
  };
  const unary = (fn: (s: number) => number) => {
    const before = pending;
    pending = before ? (s) => fn(before(s)) : fn;
    steadyAt = -1;
  };
  /** Per row (and buff): the rows one consumed lot leads to, their probabilities and the gauge maximum a rush start
   * converts the gauge at (0 when the maximum stays). */
  const lotCache = new Map<number, Map<number, number[]>>();
  const lotRows = (high: number, buff: number) => {
    let byRow = lotCache.get(buff);
    if (!byRow) lotCache.set(buff, (byRow = new Map()));
    let out = byRow.get(high);
    if (out) return out;
    out = [];
    const s = high << 8;
    const lots = lotsOf(s) - 1;
    let minimum = minimumOf(s);
    let first: [number, number][];
    if (nextOf(s) === INVALID) {
      first = draw(0, buff, minimum);
      minimum = 0;
    } else first = [[1, nextOf(s)]];
    for (const [pn, result] of first) {
      let flags = flagsOf(s);
      let rush = rushOf(s);
      if (rush === 0 || result !== CRITICAL) flags = result === CRITICAL ? flags | BONUS : flags & ~BONUS;
      const before = gaugeMaxOf(rush);
      rush = result >= 0 && result < CRITICAL ? 0 : result === CRITICAL ? Math.min(rush + 1, 4) : rush;
      const after = gaugeMaxOf(rush);
      flags |= FRAME_LOT;
      if (result === 0) flags |= FRAME_MISS;
      const type = rush < 4 ? LOT_TYPE_BY_RUSH[rush]! : 1;
      for (const [pr, value] of draw(type, buff, minimum))
        out.push(pack(0, lots, value, rush, 0, flags) >>> 8, pn * pr, before !== after && after >= 1 ? after : 0);
    }
    byRow.set(high, out);
    return out;
  };
  /** Consumes one lot: the drawn result, the rush bonus, the next draw (every guarantee lasts one draw). */
  /** Consumes one lot from row `key`, holding `scale ×` values [a, b) of `vec` at gauge `g + offset`. */
  const consumeBlock = (out: Rows, key: number, vec: Float64Array, a: number, b: number, offset: number, scale: number, buff: number) => {
    const high = key & HIGH;
    const residuePart = key - high;
    const next = lotRows(high, buff);
    for (let k = 0; k < next.length; k += 3) {
      const to = residuePart + next[k]!,
        q = next[k + 1]! * scale,
        after = next[k + 2]!;
      if (!(q > 0)) continue;
      // A rush start converts the gauge above its new maximum into lots.
      const split = after ? Math.min(b, Math.max(a, after + 1 - offset)) : b;
      if (split > a) block(out, to, vec, a, split, offset, q);
      if (split >= b) continue;
      const lots = to & 7;
      for (let g = split; g < b; g++) {
        const x = vec[g]!;
        if (x === 0) continue;
        const gauge = g + offset;
        const i = out.at(to - lots + Math.min(lots + Math.trunc(gauge / after), 7));
        out.vecs[i]![gauge % after]! += x * q;
        out.touch(i, gauge % after, (gauge % after) + 1);
      }
    }
  };
  const consume = (out: Rows, key: number, vec: Float64Array, lo: number, hi: number, buff: number) => consumeBlock(out, key, vec, lo, hi, 0, 1, buff);
  const total = (vec: Float64Array, lo: number, hi: number) => {
    let sum = 0;
    for (let g = lo; g < hi; g++) sum += vec[g]!;
    return sum;
  };
  const missHit = (high: number) => ((high << 8) & (PREV_MISS | MISS_USED)) === PREV_MISS;
  /** Skills that fill the gauge after a Miss, once per range. */
  const missPass = () => {
    if (!dist.keys.some((_, i) => missHit(keyAt(i) & HIGH))) return;
    for (const rule of missRules)
      pass((key, vec, lo, hi, out) => {
        const high = key & HIGH;
        if (!missHit(high)) {
          out.adopt(key, vec, lo, hi);
          return true;
        }
        const g = (gaugeMaxOf(rushOf(high << 8)) * rule.value) | 0;
        shift(out, key, vec, rule.chance, floorToI32(f(f(g) / 10000)), lo, hi);
        axpy(out, key, vec, 1 - rule.chance, lo, hi);
      });
    unary((s) => (((s & (PREV_MISS | MISS_USED)) === PREV_MISS ? s | MISS_USED : s)));
  };
  const pendingLots = (high: number) => {
    const s = high << 8;
    return lotsOf(s) > 0 && !(s & FRAME_LOT);
  };
  const consumePending = (buff: number) => {
    if (!dist.keys.some((_, i) => pendingLots(keyAt(i) & HIGH))) return;
    pass((key, vec, lo, hi, out) => {
      if (!pendingLots(key & HIGH)) {
        out.adopt(key, vec, lo, hi);
        return true;
      }
      consume(out, key, vec, lo, hi, buff);
    });
  };
  const basePointCache = new Map<number, [number, number][]>();
  const notesByFrame = new Map<number, LuckRecord["notes"]>();
  for (const n of record.notes) {
    const list = notesByFrame.get(n.frame);
    if (list) list.push(n);
    else notesByFrame.set(n.frame, [n]);
  }
  for (const range of luckRanges) {
    const first = record.frames.findIndex((frame) => frame.states[range] === S_START);
    if (first < 0) continue;
    let last = record.frames.findIndex((frame, k) => k > first && frame.states[range] === S_FINISH);
    if (last < 0) last = record.frames.length - 1;
    dist.vecs.forEach((vec, i) => dist.free(vec, dist.lo[i]!, dist.hi[i]!));
    dist.reset();
    pending = null;
    const start = dist.at((settlement?.initial ?? 0) * ROW + (pack(0, 0, INVALID, 0, 0, 0) >>> 8));
    dist.vecs[start]![0] = 1;
    dist.touch(start, 0, 1);
    steadyAt = -1;
    for (let k = first; k <= last; k++) {
      const frame = record.frames[k]!;
      const t = frames[k]!.timeMs;
      const state = frame.states[range]!;
      const changed = frame.updates.includes(range);
      const finishing = changed && state === S_FINISH;
      const playing = frame.playing === range;
      for (const action of record.actions) {
        if (action.frame !== k || action.range !== range) continue;
        pass((key, vec, lo, hi, out) => {
          const high = key & HIGH,
            s = high << 8;
          if (action.type === 11005) {
            const result = action.value - 2 >= 0 && action.value - 2 <= 2 ? action.value - 1 : 0;
            axpy(out, key - high + (pack(0, lotsOf(s), nextOf(s), rushOf(s), Math.max(minimumOf(s), result), flagsOf(s)) >>> 8), vec, action.chance, lo, hi);
          } else {
            const g = (gaugeMaxOf(rushOf(s)) * action.value) | 0;
            shift(out, key, vec, action.chance, floorToI32(f(f(g) / 10000)), lo, hi);
          }
          axpy(out, key, vec, 1 - action.chance, lo, hi);
        });
      }
      const gateOpen = changed || playing;
      const luckNotes = (notesByFrame.get(k) ?? []).filter((n) => n.range === range);
      const judged = frames[k]?.judged ?? [];
      const skillStep = (s: number) => {
        let skill = (s & SKILL) !== 0;
        if (playing) skill = rushOf(s) !== 0;
        if (changed && (state === S_COMPLETE || state === S_FINISH)) skill = false;
        let next = s & ~(SKILL | SKILL_PREV);
        if (s & SKILL) next |= SKILL_PREV;
        if (skill) next |= SKILL;
        return next;
      };
      // Frame end: this frame's Miss feeds the next frame's skills.
      const end = (s: number) => {
        let next = s & ~(PREV_MISS | FRAME_MISS | FRAME_LOT);
        if (s & FRAME_MISS) next |= PREV_MISS;
        if (changed && state === S_COMPLETE) next &= ~MISS_USED;
        return next;
      };
      if (!luckNotes.length && !judged.length) {
        // Once every state is settled (no pending lot or Miss, the rush checker steady), an empty frame is the identity.
        if (!changed) {
          const at = state * 2 + Number(playing);
          if (steadyAt === at) continue;
          const missGate = missRules.length > 0 && playing;
          const steady = dist.keys.every((_, i) => {
            const s = (keyAt(i) & HIGH) << 8;
            const skill = (s & SKILL) !== 0;
            return (
              !(s & (PREV_MISS | FRAME_MISS | FRAME_LOT)) &&
              skill === ((s & SKILL_PREV) !== 0) &&
              (!playing || skill === (rushOf(s) !== 0)) &&
              !(missGate && !(s & MISS_USED) && s & PREV_MISS) &&
              !(state === S_PLAYING && lotsOf(s) > 0)
            );
          });
          if (steady) {
            steadyAt = at;
            continue;
          }
        }
        if (missRules.length && gateOpen) missPass();
        unary(skillStep);
        if (state === S_PLAYING) consumePending(0);
        unary(finishing ? (s) => end(s & ~BONUS) : end);
        continue;
      }
      if (missRules.length && gateOpen) missPass();
      // The rush checker is asked in the skill phase; a score-up it starts or ends files at the frame time.
      unary(skillStep);
      // The frame's notes in chart time order: luck notes draw and consume lots, every judged note reads the state.
      // Commands filed at the frame time (the pending lot, the finish's rush disable, score-ups) reach only notes at or
      // after it.
      const observe = (id: number, atFrameTime: boolean) => {
        const skillBit = atFrameTime ? SKILL : SKILL_PREV;
        if (settlement) {
          pass((key, vec, lo, hi, out) => {
            const high = key & HIGH,
              s = high << 8;
            const residue = ((key >>> 18) + settlement.noteScore(id, !!(s & BONUS), !!(s & skillBit))) % settlement.modulus;
            out.adopt(residue * ROW + high, vec, lo, hi);
            return true;
          });
          return;
        }
        let r = 0,
          sk = 0,
          both = 0;
        for (let i = 0; i < dist.keys.length; i++) {
          const s = (keyAt(i) & HIGH) << 8;
          const bonus = (s & BONUS) !== 0,
            skill = (s & skillBit) !== 0;
          if (!bonus && !skill) continue;
          const p = total(dist.vecs[i]!, dist.lo[i]!, dist.hi[i]!);
          if (bonus) r += p;
          if (skill) sk += p;
          if (bonus && skill) both += p;
        }
        curve.rush.set(id, (curve.rush.get(id) ?? 0) + r);
        curve.skill.set(id, (curve.skill.get(id) ?? 0) + sk);
        curve.both.set(id, (curve.both.get(id) ?? 0) + both);
      };
      const luckNote = (n: (typeof luckNotes)[number]) => {
        const key = n.op * 1000 + n.judgement * 100 + Math.round(n.speed * 10);
        let points = basePointCache.get(key);
        if (!points) basePointCache.set(key, (points = basePoints(n.op, n.judgement).map(([p, v]) => [p, floorToI32(f(f(n.speed + 1) * f(v)))])));
        const buff = state <= S_END ? n.buff : null;
        pass((key, vec, lo, hi, out) => {
          for (const [pb, add] of points!) shift(out, key, vec, pb, add, lo, hi, buff);
        });
      };
      const times = [...new Set([...luckNotes.map((n) => n.timeMs), ...judged.map((n) => n.timeMs)])].sort((a, b) => a - b);
      for (const time of times) {
        if (time >= t) continue;
        for (const n of luckNotes) if (n.timeMs === time) luckNote(n);
        for (const n of judged) if (n.timeMs === time) observe(n.noteId, false);
      }
      for (const n of luckNotes) if (n.timeMs >= t) luckNote(n);
      if (state === S_PLAYING) consumePending(luckNotes.find((n) => n.timeMs >= t)?.buff ?? luckNotes.at(-1)?.buff ?? 0);
      if (finishing) unary((s) => s & ~BONUS);
      for (const n of judged) if (n.timeMs >= t) observe(n.noteId, true);
      unary(end);
    }
    if (settlement) for (let i = 0; i < dist.keys.length; i++) settlement.residues[dist.keys[i]! >>> 18]! += total(dist.vecs[i]!, dist.lo[i]!, dist.hi[i]!);
  }
  return curve;
}
