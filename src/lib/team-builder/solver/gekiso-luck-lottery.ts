import type { GekisoResolved, GekisoRules, LuckLotResult } from "./gekiso-mission-luck.ts";

const f = Math.fround;
const i32 = (value: number) => value | 0;
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
const nonnegative = (value: unknown): value is number => integer(value) && value >= 0;
const unknown = <T>(code: string, source: string): GekisoResolved<T> => ({ value: null, gaps: [{ code, source }] });

export interface GekisoMinimumEntry {
  id: number;
  minimum: number;
  remaining: number;
}
export interface GekisoLotteryItem {
  result: LuckLotResult;
  rawWeight: number;
}
export type GekisoRandomLaw =
  | { kind: "uniform-residue" }
  | { kind: "explicit-signed-i32-pmf"; atoms: readonly { value: number; probability: number }[] };
export interface GekisoLotteryInput {
  drawTimeMs: number;
  chanceType: number;
  items: readonly GekisoLotteryItem[];
  /** Ordinary Lottery retains the ctor's original sum after SetWeightBuff. */
  cachedTotalWeight: number;
  itemOrder: "native-verified" | "explicit-scenario" | "unresolved";
  probabilityUpFactorAtDraw: number;
  minimumEntries: readonly GekisoMinimumEntry[] | null;
  randomLaw: GekisoRandomLaw;
}
export interface GekisoLotteryDistribution {
  minimum: number;
  probabilityBuffPercent: number;
  denominator: number;
  /** Exact residue counts for the uniform law; null for a supplied raw PMF. */
  counts: readonly [number, number, number, number] | null;
  probabilities: readonly [number, number, number, number];
  failureProbability: number;
  effectiveItems: readonly (GekisoLotteryItem & { weight: number })[];
  /** Apply only after a successful prefetch. Native null throws before consuming quota. */
  entriesAfterSuccess: readonly GekisoMinimumEntry[];
  exhaustedAtDraw: readonly { id: number; timeMs: number }[];
  assumptions: string[];
}

/** Original generic Lottery/WithMinimum distribution and prefetch quota update.
 * Registry enable/disable and native item sorting belong to the phase driver.
 * The nominal uniform residue law stays distinct from a concrete seed replay.
 */
export function resolveGekisoLotteryDistribution(input: GekisoLotteryInput): GekisoResolved<GekisoLotteryDistribution> {
  const source = `native Luck prefetch/chance:${input.chanceType}`;
  if (
    !input.randomLaw ||
    !["uniform-residue", "explicit-signed-i32-pmf"].includes(input.randomLaw.kind) ||
    !["native-verified", "explicit-scenario", "unresolved"].includes(input.itemOrder) ||
    !nonnegative(input.drawTimeMs) ||
    !nonnegative(input.chanceType) ||
    input.chanceType > 4 ||
    !nonnegative(input.cachedTotalWeight) ||
    input.cachedTotalWeight < 1 ||
    !Number.isFinite(f(input.probabilityUpFactorAtDraw)) ||
    !input.items.length ||
    input.items.length > 4096 ||
    input.items.some((item) => !nonnegative(item.rawWeight) || !nonnegative(item.result) || item.result > 3)
  )
    return unknown("gekiso-lottery-input-unresolved", source);
  if (input.minimumEntries === null) return unknown("gekiso-minimum-registry-unresolved", source);
  if (
    input.minimumEntries.length > 4096 ||
    new Set(input.minimumEntries.map((entry) => entry.id)).size !== input.minimumEntries.length ||
    input.minimumEntries.some((entry) => !nonnegative(entry.id) || !integer(entry.minimum) || !integer(entry.remaining))
  )
    return unknown("gekiso-minimum-registry-invalid", source);
  const rawTotal = input.items.reduce((sum, item) => i32(sum + item.rawWeight), 0);
  if (rawTotal !== input.cachedTotalWeight) return unknown("gekiso-lottery-cached-total-mismatch", source);
  const minimum = input.minimumEntries.reduce((max, entry) => Math.max(max, entry.minimum), 0);
  const percent = Math.floor(f(f(input.probabilityUpFactorAtDraw) * f(100)));
  if (!integer(percent)) return unknown("gekiso-lottery-buff-out-of-int32", source);
  const factor = f(f(1) + f(f(percent) / f(100)));
  const weighted = input.items.map((item) => ({ ...item, weight: Math.floor(f(factor * f(item.rawWeight))) }));
  if (weighted.some((item) => !nonnegative(item.weight)))
    return unknown("gekiso-lottery-weight-domain-unresolved", source);
  const assumptions = input.randomLaw.kind === "uniform-residue" ? ["native-luck-nominal-uniform-residue"] : [];
  if (input.itemOrder === "explicit-scenario") assumptions.push("explicit-luck-item-order");
  if (
    input.itemOrder === "unresolved" &&
    (input.randomLaw.kind !== "uniform-residue" || (minimum < 1 && percent !== 0))
  )
    return unknown("gekiso-lottery-item-order-unresolved", source);
  let effectiveItems = weighted,
    denominator = input.cachedTotalWeight;
  if (minimum >= 1) {
    const eligible = weighted.filter((item) => item.result >= minimum);
    if (!eligible.length) return unknown("gekiso-lottery-no-minimum-item", source);
    const sum = (items: typeof weighted) => items.reduce((total, item) => i32(total + item.weight), 0);
    const included = sum(eligible),
      excluded = sum(weighted.filter((item) => item.result < minimum));
    if (included < 0 || excluded < 0) return unknown("gekiso-lottery-signed-overflow", source);
    const redistributed = Math.trunc(excluded / eligible.length);
    denominator = i32(included + Math.imul(redistributed, eligible.length));
    effectiveItems = eligible.map((item) => ({ ...item, weight: i32(item.weight + redistributed) }));
  }
  if (denominator < 1 || effectiveItems.some((item) => item.weight < 0))
    return unknown("gekiso-lottery-denominator-unresolved", source);
  const prefixes: number[] = [];
  let cumulative = 0;
  for (const item of effectiveItems) {
    const next = i32(cumulative + item.weight);
    if (next < cumulative) return unknown("gekiso-lottery-signed-overflow", source);
    prefixes.push(next);
    cumulative = next;
  }
  const counts: [number, number, number, number] = [0, 0, 0, 0];
  const probabilities: [number, number, number, number] = [0, 0, 0, 0];
  let failureProbability = 0;
  if (input.randomLaw.kind === "uniform-residue") {
    let previous = 0;
    for (const [index, item] of effectiveItems.entries()) {
      const upper = Math.min(denominator, prefixes[index]!);
      counts[item.result] += Math.max(0, upper - previous);
      previous = upper;
    }
    counts.forEach((count, result) => {
      probabilities[result] = count / denominator;
    });
    failureProbability = Math.max(0, denominator - cumulative) / denominator;
  } else {
    const atoms = input.randomLaw.atoms;
    if (
      !atoms.length ||
      atoms.length > 100000 ||
      atoms.some((atom) => !integer(atom.value) || !Number.isFinite(atom.probability) || atom.probability < 0) ||
      Math.abs(atoms.reduce((sum, atom) => sum + atom.probability, 0) - 1) > 1e-12
    )
      return unknown("gekiso-lottery-random-law-invalid", source);
    for (const atom of atoms) {
      // INT_MIN intentionally remains negative after native cneg32.
      const residue = i32(Math.abs(atom.value)) % denominator;
      const index = prefixes.findIndex((prefix) => residue < prefix);
      if (index < 0) failureProbability += atom.probability;
      else probabilities[effectiveItems[index]!.result] += atom.probability;
    }
  }
  const entriesAfterSuccess: GekisoMinimumEntry[] = [];
  const exhaustedAtDraw: { id: number; timeMs: number }[] = [];
  for (const original of input.minimumEntries) {
    const entry = { ...original };
    if (minimum >= 1 && entry.minimum <= minimum) {
      if (entry.remaining >= 0) entry.remaining = i32(entry.remaining - 1);
      if (entry.remaining === 0) {
        exhaustedAtDraw.push({ id: entry.id, timeMs: input.drawTimeMs });
        continue;
      }
    }
    entriesAfterSuccess.push(entry);
  }
  return {
    value: {
      minimum,
      probabilityBuffPercent: percent,
      denominator,
      counts: input.randomLaw.kind === "uniform-residue" ? counts : null,
      probabilities,
      failureProbability,
      effectiveItems,
      entriesAfterSuccess,
      exhaustedAtDraw,
      assumptions,
    },
    gaps: [],
  };
}

/** Prepare raw chance tables once; neutral uniform draws are order-independent.
 * A nonzero ordinary buff needs the actual ctor order supplied by its resolver.
 */
export function createGekisoLuckDrawResolver(rules: GekisoRules) {
  const tables = new Map(
    Object.entries(rules.bonusLotTables).map(([chance, rows]) => [
      Number(chance),
      {
        // ConfigCreator filters original Master weight>0 before conversion.
        // A positive raw item whose buffed weight becomes zero remains present.
        items: rows.filter((row) => row.weight > 0).map((row) => ({ result: row.result, rawWeight: row.weight })),
        cachedTotalWeight: rows.reduce((sum, row) => i32(sum + row.weight), 0),
      },
    ]),
  );
  return (
    input: Omit<GekisoLotteryInput, "items" | "cachedTotalWeight" | "itemOrder"> & {
      orderedItems?: readonly GekisoLotteryItem[];
      itemOrder?: GekisoLotteryInput["itemOrder"];
    },
  ): GekisoResolved<GekisoLotteryDistribution> => {
    const table = tables.get(input.chanceType);
    if (!table) return unknown("gekiso-lottery-chance-table-missing", String(input.chanceType));
    if (input.itemOrder && input.itemOrder !== "unresolved" && !input.orderedItems)
      return unknown("gekiso-lottery-ordered-table-required", String(input.chanceType));
    if (input.orderedItems) {
      const identity = (items: readonly GekisoLotteryItem[]) =>
        items
          .map((item) => `${item.result}:${item.rawWeight}`)
          .sort()
          .join("|");
      if (identity(input.orderedItems) !== identity(table.items))
        return unknown("gekiso-lottery-ordered-table-mismatch", String(input.chanceType));
    }
    return resolveGekisoLotteryDistribution({
      ...input,
      items: input.orderedItems ?? table.items,
      cachedTotalWeight: table.cachedTotalWeight,
      itemOrder: input.itemOrder ?? "unresolved",
    });
  };
}
