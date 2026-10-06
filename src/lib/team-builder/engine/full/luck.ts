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
const gaugeOf = (s: number) => s & 0xff;
const lotsOf = (s: number) => (s >>> 8) & 7;
const nextOf = (s: number) => ((s >>> 11) & 7) - 1;
const rushOf = (s: number) => (s >>> 14) & 7;
const minimumOf = (s: number) => (s >>> 17) & 3;
const pack = (gauge: number, lots: number, next: number, rush: number, minimum: number, flags: number) =>
  gauge * G + Math.min(lots, 7) * L + (next + 1) * N + rush * R + minimum * MIN + flags;
const FLAGS = MISS_USED | PREV_MISS | FRAME_LOT | FRAME_MISS | BONUS | SKILL | SKILL_PREV;
const flagsOf = (s: number) => s & FLAGS;

export function luckCurve(
  tables: GekisouTables,
  record: LuckRecord,
  frames: readonly { timeMs: number; judged: readonly { noteId: number; timeMs: number }[] }[],
  luckRanges: readonly number[],
  missRules: readonly MissRule[],
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
  const drawCache = new Map<string, [number, number][]>();
  /** One bonus draw of a lot type at a lot buff (percent) with a guaranteed minimum result. */
  const draw = (type: number, buffPercent: number, minimum: number): [number, number][] => {
    const key = `${type},${buffPercent},${minimum}`;
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
  /** Gauge addition with overflow into lots at the state's gauge maximum. */
  const addGauge = (s: number, v: number) => {
    const max = gaugeMaxOf(rushOf(s));
    const g = (gaugeOf(s) + v) | 0;
    if (max > g) return pack(g, lotsOf(s), nextOf(s), rushOf(s), minimumOf(s), flagsOf(s));
    return pack(g % max, lotsOf(s) + Math.trunc(g / max), nextOf(s), rushOf(s), minimumOf(s), flagsOf(s));
  };
  let dist = new Map<number, number>();
  const push = (out: Map<number, number>, s: number, p: number) => {
    if (p > 0) out.set(s, (out.get(s) ?? 0) + p);
  };
  let spare = new Map<number, number>();
  const map = (fn: (s: number, p: number, out: Map<number, number>) => void) => {
    const out = spare;
    out.clear();
    for (const [s, p] of dist) fn(s, p, out);
    spare = dist;
    dist = out;
    if (dist.size > peak) peak = dist.size;
    steps++;
  };
  let peak = 0,
    steps = 0;
  /** Consumes one lot: the drawn result, the rush bonus, the next draw (every guarantee lasts one draw). */
  const consume = (s: number, p: number, buff: number, out: Map<number, number>) => {
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
      let gauge = gaugeOf(s),
        lotCount = lots;
      if (before !== after && after >= 1 && gauge > after) {
        lotCount += Math.trunc(gauge / after);
        gauge %= after;
      }
      flags |= FRAME_LOT;
      if (result === 0) flags |= FRAME_MISS;
      const type = rush < 4 ? LOT_TYPE_BY_RUSH[rush]! : 1;
      for (const [pr, value] of draw(type, buff, minimum)) push(out, pack(gauge, lotCount, value, rush, 0, flags), p * pn * pr);
    }
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
    dist = new Map([[pack(0, 0, INVALID, 0, 0, 0), 1]]);
    spare = new Map();
    for (let k = first; k <= last; k++) {
      const frame = record.frames[k]!;
      const t = frames[k]!.timeMs;
      const state = frame.states[range]!;
      const changed = frame.updates.includes(range);
      const finishing = changed && state === S_FINISH;
      for (const action of record.actions) {
        if (action.frame !== k || action.range !== range) continue;
        map((s, p, out) => {
          if (action.type === 11005) {
            const result = action.value - 2 >= 0 && action.value - 2 <= 2 ? action.value - 1 : 0;
            push(out, pack(gaugeOf(s), lotsOf(s), nextOf(s), rushOf(s), Math.max(minimumOf(s), result), flagsOf(s)), p * action.chance);
          } else {
            const g = (gaugeMaxOf(rushOf(s)) * action.value) | 0;
            push(out, addGauge(s, floorToI32(f(f(g) / 10000))), p * action.chance);
          }
          push(out, s, p * (1 - action.chance));
        });
      }
      const gateOpen = changed || frame.playing === range;
      const luckNotes = (notesByFrame.get(k) ?? []).filter((n) => n.range === range);
      const judged = frames[k]?.judged ?? [];
      if (!luckNotes.length && !judged.length) {
        // A frame without notes: Miss gauge, rush checker, pending lot, finish and frame end in one pass.
        const pendingBuff = 0;
        map((s0, p0, out) => {
          let branches: [number, number][] = [[s0, p0]];
          if (missRules.length && gateOpen && s0 & PREV_MISS && !(s0 & MISS_USED)) {
            for (const rule of missRules)
              branches = branches.flatMap(([b, q]): [number, number][] => {
                const g = (gaugeMaxOf(rushOf(b)) * rule.value) | 0;
                return [
                  [addGauge(b, floorToI32(f(f(g) / 10000))), q * rule.chance],
                  [b, q * (1 - rule.chance)],
                ];
              });
            branches = branches.map(([b, q]) => [b | MISS_USED, q]);
          }
          const tail = (s: number, p: number) => {
            if (finishing) s &= ~BONUS;
            let next = s & ~(PREV_MISS | FRAME_MISS | FRAME_LOT);
            if (s & FRAME_MISS) next |= PREV_MISS;
            if (changed && state === S_COMPLETE) next &= ~MISS_USED;
            push(out, next, p);
          };
          for (const [b, q] of branches) {
            let skill = (b & SKILL) !== 0;
            if (frame.playing === range) skill = rushOf(b) !== 0;
            if (changed && (state === S_COMPLETE || state === S_FINISH)) skill = false;
            let s = b & ~(SKILL | SKILL_PREV);
            if (b & SKILL) s |= SKILL_PREV;
            if (skill) s |= SKILL;
            if (state === S_PLAYING && lotsOf(s) > 0 && !(s & FRAME_LOT)) {
              const tmp = new Map<number, number>();
              consume(s, q, pendingBuff, tmp);
              for (const [c, cq] of tmp) tail(c, cq);
            } else tail(s, q);
          }
        });
        continue;
      }
      if (missRules.length && gateOpen)
        map((s, p, out) => {
          if (!(s & PREV_MISS) || s & MISS_USED) return push(out, s, p);
          let branches: [number, number][] = [[s, p]];
          for (const rule of missRules)
            branches = branches.flatMap(([b, q]): [number, number][] => {
              const g = (gaugeMaxOf(rushOf(b)) * rule.value) | 0;
              return [
                [addGauge(b, floorToI32(f(f(g) / 10000))), q * rule.chance],
                [b, q * (1 - rule.chance)],
              ];
            });
          for (const [b, q] of branches) push(out, b | MISS_USED, q);
        });
      // The rush checker is asked in the skill phase; a score-up it starts or ends files at the frame time.
      map((s, p, out) => {
        let skill = (s & SKILL) !== 0;
        if (frame.playing === range) skill = rushOf(s) !== 0;
        if (changed && (state === S_COMPLETE || state === S_FINISH)) skill = false;
        let next = s & ~(SKILL | SKILL_PREV);
        if (s & SKILL) next |= SKILL_PREV;
        if (skill) next |= SKILL;
        push(out, next, p);
      });
      // The frame's notes in chart time order: luck notes draw and consume lots, every judged note reads the state.
      // Commands filed at the frame time (the pending lot, the finish's rush disable, score-ups) reach only notes at or
      // after it.
      const observe = (id: number, atFrameTime: boolean) => {
        let r = 0,
          sk = 0,
          both = 0;
        const skillBit = atFrameTime ? SKILL : SKILL_PREV;
        for (const [s, p] of dist) {
          const bonus = (s & BONUS) !== 0,
            skill = (s & skillBit) !== 0;
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
        const consumes = state <= S_END;
        map((s, p, out) => {
          for (const [pb, add] of points!) {
            const next = addGauge(s, add);
            if (consumes && lotsOf(next) > 0) consume(next, p * pb, n.buff, out);
            else push(out, next, p * pb);
          }
        });
      };
      const times = [...new Set([...luckNotes.map((n) => n.timeMs), ...judged.map((n) => n.timeMs)])].sort((a, b) => a - b);
      for (const time of times) {
        if (time >= t) continue;
        for (const n of luckNotes) if (n.timeMs === time) luckNote(n);
        for (const n of judged) if (n.timeMs === time) observe(n.noteId, false);
      }
      for (const n of luckNotes) if (n.timeMs >= t) luckNote(n);
      if (state === S_PLAYING) {
        const buff = luckNotes.find((n) => n.timeMs >= t)?.buff ?? luckNotes.at(-1)?.buff ?? 0;
        map((s, p, out) => (lotsOf(s) > 0 && !(s & FRAME_LOT) ? consume(s, p, buff, out) : push(out, s, p)));
      }
      if (finishing) map((s, p, out) => push(out, s & ~BONUS, p));
      for (const n of judged) if (n.timeMs >= t) observe(n.noteId, true);
      // Frame end: this frame's Miss feeds the next frame's skills.
      map((s, p, out) => {
        let next = s & ~(PREV_MISS | FRAME_MISS | FRAME_LOT);
        if (s & FRAME_MISS) next |= PREV_MISS;
        if (changed && state === S_COMPLETE) next &= ~MISS_USED;
        push(out, next, p);
      });
    }
  }
  return curve;
}
