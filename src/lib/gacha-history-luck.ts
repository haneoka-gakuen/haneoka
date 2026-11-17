// L3 — GEB
// Input: Published pool weights, executed product guarantees and projected history.
// Output: Joint SSR+/UP batch laws, conservative nine-tier ratings and coverage.
// Pos: [Map](L2-2.md); gacha history probability model shared by builds and its browser worker.
// Effects/Dependencies: Pure calculations; polynomial products use bounded-error floating-point FFT for large histories.
import type { GachaHistoryBatch } from "./gacha-history-view";

type Row = Record<string, unknown>;
type Categories = [number, number, number];
export type LuckTarget = "combined" | "high" | "pickup";
export interface GachaLuckLaw {
  key: string;
  kind: "card" | "item";
  count: number;
  perDraw: boolean;
  combined: number[];
  high: number[];
  pickup: number[];
}
export type GachaLuckRules = Record<string, Record<string, GachaLuckLaw | null>>;
export interface GachaLuckInput {
  laws: Record<string, GachaLuckLaw>;
  pools: Record<string, GachaLuckScope>;
}
export interface GachaLuckScope {
  groups: Record<string, number>;
  high: number;
  pickup: number;
  knownDraws: number;
  unknownDraws: number;
  itemDraws: number;
}
export interface GachaLuckValue {
  observed: number;
  expected: number;
  lower: number;
  upper: number;
  score: number;
  tier: number;
  variable: boolean;
}
export interface GachaLuckSummary {
  combined: GachaLuckValue | null;
  high: GachaLuckValue | null;
  pickup: GachaLuckValue | null;
  knownDraws: number;
  unknownDraws: number;
  itemDraws: number;
}
export interface GachaLuckResult {
  overall: GachaLuckSummary;
  pools: Record<string, GachaLuckSummary>;
}
const TARGETS = ["combined", "high", "pickup"] as const;
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : [];
const HIGH = new Set([4, 10, 20]);
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const normalized = (values: number[]) => { const total = sum(values); return values.map(value => value / total); };

function smallProduct(a: readonly number[], b: readonly number[]): number[] {
  const out = Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  return out;
}
function smallPower(values: readonly number[], count: number): number[] {
  let out = [1];
  for (let i = 0; i < count; i++) out = smallProduct(out, values);
  return out;
}
function project(values: Categories, target: LuckTarget): number[] {
  return target === "combined" ? values : target === "high" ? [values[0], values[1] + values[2]] : [values[0] + values[1], values[2]];
}

/** Keeps qualifying and nonqualifying outcomes joint with the UP bonus. */
export function compileGachaLuckLaw(pool: Row, option: Row): GachaLuckLaw | null {
  const n = Number(option.drawCount), count = Number(option.guaranteedCount), rarity = Number(option.guaranteedRarity), type = Number(option.guaranteedType);
  if (!Number.isSafeInteger(n) || n < 1 || !Number.isSafeInteger(count) || count < 0 || count > n ||
    !Number.isSafeInteger(rarity) || rarity < 0 || ![1, 2, 3, 4].includes(type) || option.guaranteedNew !== false ||
    Number(pool.pickUpSelectCount ?? 0) > 0 || !Array.isArray(pool.rates)) return null;
  const ordinary: Categories = [0, 0, 0], eligible: Categories = [0, 0, 0], ineligible: Categories = [0, 0, 0];
  let total = 0, ensured = 0, cardMass = 0;
  for (const group of rows(pool.rates)) {
    const weight = Number(group.rate), prizes = rows(group.prizes), inner = prizes.reduce((v, p) => v + Number(p.rate), 0);
    if (!Number.isFinite(weight) || weight < 0 || weight > 0 && !(inner > 0)) return null;
    if (!weight) continue;
    for (const prize of prizes) {
      const resource = Number(prize.resourceType), r = Number(prize.rarity ?? group.rarity ?? 0), rate = Number(prize.rate);
      if (!Number.isFinite(rate) || rate < 0 || !Number.isSafeInteger(resource) || resource < 1 || !Number.isFinite(r) ||
        typeof prize.pickup !== "boolean" || resource !== 1 && ![2, 3, 4, 10, 20].includes(r)) return null;
      const mass = weight * rate / inner, card = resource === 2 || resource === 3;
      const high = card && HIGH.has(r), category = high ? prize.pickup ? 2 : 1 : 0;
      const qualifies = r >= rarity && (type === 1 || type === 4 && card || type === resource);
      total += mass; ordinary[category] += mass;
      if (card) cardMass += mass;
      (qualifies ? eligible : ineligible)[category] += mass;
      if (qualifies) ensured += mass;
    }
  }
  if (!(total > 0)) return null;
  const guaranteed = count > 0 && (rarity > 0 || type !== 1);
  if (guaranteed && (!(ensured > 0) || !["slot", "redraw"].includes(String(pool.guaranteeRule)))) return null;
  const p = normalized(ordinary) as Categories;
  const a = ensured > 0 ? normalized(eligible) as Categories : p;
  const rejected = total - ensured;
  const b = rejected > 1e-14 * total ? normalized(ineligible) as Categories : p;
  const q = Math.min(1, ensured / total), perDraw = !guaranteed;
  const law = { key: "", kind: cardMass > 0 ? "card" : "item", count: perDraw ? 1 : n, perDraw } as GachaLuckLaw;
  for (const target of TARGETS) {
    const normal = project(p, target), qualified = project(a, target), other = project(b, target);
    if (!guaranteed) law[target] = normal;
    else if (pool.guaranteeRule === "slot") law[target] = smallProduct(smallPower(normal, n - count), smallPower(qualified, count));
    else {
      const qualifiers = smallPower([1 - q, q], n), out = Array<number>((target === "combined" ? 2 : 1) * n + 1).fill(0);
      for (let c = 0; c <= n; c++) {
        const kept = Math.max(c, count);
        const distribution = smallProduct(smallPower(qualified, kept), smallPower(other, n - kept));
        for (let k = 0; k < distribution.length; k++) out[k] += qualifiers[c] * distribution[k];
      }
      law[target] = out;
    }
    law[target] = normalized(law[target]);
  }
  law.key = JSON.stringify([1, law.kind, law.count, perDraw, p, guaranteed ? [pool.guaranteeRule, count, q, a, b] : null]);
  return law;
}

export function compileGachaLuckRules(metadata: Row): GachaLuckRules {
  const products = record(metadata.products);
  return Object.fromEntries(Object.entries(record(metadata.pools)).map(([id, value]) => {
    const pool = record(value), options = Array.isArray(pool.productIds) ? pool.productIds.map(String) : [];
    return [id, Object.fromEntries(options.map(productId => [productId, compileGachaLuckLaw(pool, record(products[productId]))]))];
  }));
}

const emptyScope = (): GachaLuckScope => ({ groups: {}, high: 0, pickup: 0, knownDraws: 0, unknownDraws: 0, itemDraws: 0 });
export function gachaLuckInput(batches: readonly GachaHistoryBatch[]): GachaLuckInput {
  const input: GachaLuckInput = { laws: Object.create(null), pools: Object.create(null) };
  for (const batch of batches) {
    const scope = input.pools[batch.poolId] ??= emptyScope(), n = batch.prizes.length, law = batch.luckLaw;
    if (law?.kind === "item") { scope.itemDraws += n; continue; }
    if (!law || !law.perDraw && n !== law.count || batch.prizes.some(prize => prize.kind === "unknown" ||
      (prize.kind === "member" || prize.kind === "support") && (!HIGH.has(Number(prize.rarity)) && ![2, 3].includes(Number(prize.rarity)) ||
        HIGH.has(Number(prize.rarity)) && typeof prize.pickup !== "boolean"))) { scope.unknownDraws += n; continue; }
    scope.knownDraws += n;
    for (const prize of batch.prizes) if ((prize.kind === "member" || prize.kind === "support") && HIGH.has(Number(prize.rarity))) {
      scope.high++; if (prize.pickup) scope.pickup++;
    }
    input.laws[law.key] = law;
    scope.groups[law.key] = (scope.groups[law.key] ?? 0) + (law.perDraw ? n : 1);
  }
  return input;
}

interface Distribution { offset: number; values: Float64Array }
const POINT: Distribution = { offset: 0, values: Float64Array.of(1) };
const mean = (d: Distribution) => d.offset + d.values.reduce((v, p, i) => v + p * i, 0);
function compact(values: Float64Array, offset = 0): Distribution {
  let low = 0, high = values.length - 1, removed = 0;
  while (low < high && removed + Math.max(0, values[low]) <= 1e-13) removed += Math.max(0, values[low++]);
  removed = 0;
  while (high > low && removed + Math.max(0, values[high]) <= 1e-13) removed += Math.max(0, values[high--]);
  const out = values.slice(low, high + 1);
  let total = 0;
  for (let i = 0; i < out.length; i++) { out[i] = Math.max(0, out[i]); total += out[i]; }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return { offset: offset + low, values: out };
}

function fft(real: Float64Array, imaginary: Float64Array, inverse: boolean) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]]; }
  }
  for (let size = 2; size <= n; size *= 2) {
    const angle = (inverse ? 2 : -2) * Math.PI / size, cosine = Math.cos(angle), sine = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let wr = 1, wi = 0;
      for (let j = 0; j < size / 2; j++) {
        const left = start + j, right = left + size / 2;
        const vr = real[right] * wr - imaginary[right] * wi, vi = real[right] * wi + imaginary[right] * wr;
        real[right] = real[left] - vr; imaginary[right] = imaginary[left] - vi;
        real[left] += vr; imaginary[left] += vi;
        [wr, wi] = [wr * cosine - wi * sine, wr * sine + wi * cosine];
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { real[i] /= n; imaginary[i] /= n; }
}
function product(a: Distribution, b: Distribution): Distribution {
  if (a.values.length === 1) return { offset: a.offset + b.offset, values: b.values };
  if (b.values.length === 1) return { offset: a.offset + b.offset, values: a.values };
  const length = a.values.length + b.values.length - 1;
  if (a.values.length * b.values.length < 80_000) {
    const out = new Float64Array(length);
    for (let i = 0; i < a.values.length; i++) for (let j = 0; j < b.values.length; j++) out[i + j] += a.values[i] * b.values[j];
    return compact(out, a.offset + b.offset);
  }
  let n = 1; while (n < length) n *= 2;
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(a.values); br.set(b.values); fft(ar, ai, false); fft(br, bi, false);
  for (let i = 0; i < n; i++) [ar[i], ai[i]] = [ar[i] * br[i] - ai[i] * bi[i], ar[i] * bi[i] + ai[i] * br[i]];
  fft(ar, ai, true);
  return compact(ar.slice(0, length), a.offset + b.offset);
}
function power(values: number[], exponent: number): Distribution {
  let base = compact(Float64Array.from(values)), out = POINT;
  for (let n = exponent; n > 0; n = Math.floor(n / 2)) {
    if (n % 2) out = product(out, base);
    if (n > 1) base = product(base, base);
  }
  return out;
}
function combined(distributions: Distribution[]): Distribution {
  if (!distributions.length) return POINT;
  while (distributions.length > 1) {
    distributions.sort((a, b) => b.values.length - a.values.length);
    const a = distributions.pop()!, b = distributions.pop()!;
    distributions.push(product(a, b));
  }
  return distributions[0];
}
export function gachaLuckValue(d: Distribution, observed: number): GachaLuckValue {
  let lower = 0, upper = 0;
  d.values.forEach((p, index) => { const k = d.offset + index; if (k <= observed) lower += p; if (k >= observed) upper += p; });
  lower = Math.max(0, Math.min(1, lower)); upper = Math.max(0, Math.min(1, upper));
  const boundaries = [.1, .2, .3, .4];
  const good = boundaries.findIndex(value => upper <= value + 1e-12), bad = boundaries.findIndex(value => lower <= value + 1e-12);
  return { observed, expected: mean(d), lower, upper, score: 100 * (upper < .5 ? 1 - upper : lower < .5 ? lower : .5),
    tier: good >= 0 ? 1 + good : bad >= 0 ? 9 - bad : 5, variable: d.values.length > 1 };
}

/** Worker-local cache contains only numeric distributions, at most 8 MiB. */
export class GachaLuckCalculator {
  private cache = new Map<string, Record<LuckTarget, Distribution>>();
  private bytes = 0;
  private laws(law: GachaLuckLaw, count: number) {
    const key = `${law.key}:${count}`, cached = this.cache.get(key);
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); return cached; }
    const out = Object.fromEntries(TARGETS.map(target => [target, power(law[target], count)])) as Record<LuckTarget, Distribution>;
    const size = TARGETS.reduce((v, target) => v + out[target].values.byteLength, 0);
    if (size <= 8 * 1024 * 1024) {
      this.cache.set(key, out); this.bytes += size;
      while (this.bytes > 8 * 1024 * 1024 || this.cache.size > 32) {
        const oldest = this.cache.keys().next().value!, entry = this.cache.get(oldest)!;
        this.bytes -= TARGETS.reduce((v, target) => v + entry[target].values.byteLength, 0); this.cache.delete(oldest);
      }
    }
    return out;
  }
  calculate(input: GachaLuckInput): GachaLuckResult {
    const all = emptyScope(), poolResults: Record<string, GachaLuckSummary> = Object.create(null), overall: Record<LuckTarget, Distribution[]> = { combined: [], high: [], pickup: [] };
    for (const [id, scope] of Object.entries(input.pools)) {
      all.high += scope.high; all.pickup += scope.pickup; all.knownDraws += scope.knownDraws; all.unknownDraws += scope.unknownDraws; all.itemDraws += scope.itemDraws;
      const grouped = Object.entries(scope.groups).map(([key, count]) => this.laws(input.laws[key], count));
      const summary = { knownDraws: scope.knownDraws, unknownDraws: scope.unknownDraws, itemDraws: scope.itemDraws } as GachaLuckSummary;
      for (const target of TARGETS) {
        const d = combined(grouped.map(value => value[target])); overall[target].push(d);
        summary[target] = scope.knownDraws ? gachaLuckValue(d, target === "combined" ? scope.high + scope.pickup : scope[target]) : null;
      }
      poolResults[id] = summary;
    }
    const summary = { knownDraws: all.knownDraws, unknownDraws: all.unknownDraws, itemDraws: all.itemDraws } as GachaLuckSummary;
    for (const target of TARGETS) summary[target] = all.knownDraws ? gachaLuckValue(combined(overall[target]), target === "combined" ? all.high + all.pickup : all[target]) : null;
    return { overall: summary, pools: poolResults };
  }
}
