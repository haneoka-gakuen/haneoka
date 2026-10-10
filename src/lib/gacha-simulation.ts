/**
 * Recruitment simulation over the published lot table.
 *
 * Each pull picks a lot (rarity × card type) by its weight, then a prize
 * inside it. A product with a guarantee draws its last `guaranteedCount`
 * pulls from the guaranteed pool ("slot"), or redraws them there only when
 * the pulls fell short ("redraw"); the gacha's notice states which. The
 * guaranteed pool is the normal table restricted to the guaranteed rarity
 * and card type, keeping the normal relative weights.
 */

type Row = Record<string, unknown>;

export type GachaCardKind = "member" | "support" | "item";

export interface GachaPrize {
  key: string;
  kind: GachaCardKind;
  id: number;
  rarity: number;
  pickup: boolean;
  source: Row;
}

export interface GachaRun {
  option: Row;
  /** One entry per product use, in order. */
  pulls: GachaPrize[][];
  draws: number;
  cost: number;
  points: number;
}

interface Lot {
  weight: number;
  rarity: number;
  kind: GachaCardKind;
  prizes: Array<{ weight: number; prize: GachaPrize }>;
}

const rows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);

export function prizeKind(row: Row): GachaCardKind {
  const type = Number(row.resourceType);
  if (row.kind === "SupportCard" || type === 3) return "support";
  if (row.kind === "MemberCard" || type === 2) return "member";
  return "item";
}

function lots(item: Row): Lot[] {
  return rows(item.rates).flatMap((group) => {
    const prizes = rows(group.prizes)
      .filter((prize) => Number(prize.rate) > 0)
      .map((prize) => {
        const kind = prizeKind(prize);
        const id = Number(prize.resourceId) || 0;
        return {
          weight: Number(prize.rate),
          prize: {
            key: `${kind}:${id}`,
            kind,
            id,
            rarity: Number(prize.rarity ?? group.rarity) || 0,
            pickup: Boolean(prize.pickup),
            source: prize,
          },
        };
      });
    const weight = Number(group.rate);
    if (!(weight > 0) || !prizes.length) return [];
    const kind =
      group.resourceType === "SupportCard"
        ? "support"
        : group.resourceType === "MemberCard"
          ? "member"
          : prizes[0]!.prize.kind;
    return [{ weight, rarity: Number(group.rarity) || 0, kind, prizes }];
  });
}

/** GachaEnsureType: 2 member card, 3 support card, 4 either, 1/5 no type limit. */
function guaranteedLots(table: Lot[], option: Row): Lot[] {
  const rarity = Number(option.guaranteedRarity) || 0;
  const type = Number(option.guaranteedType) || 0;
  return table
    .filter((lot) => (type === 2 ? lot.kind === "member" : type === 3 ? lot.kind === "support" : true))
    .flatMap((lot) => {
      const prizes = lot.prizes.filter(({ prize }) => prize.rarity >= rarity);
      if (!prizes.length) return [];
      const share =
        prizes.reduce((sum, entry) => sum + entry.weight, 0) / lot.prizes.reduce((sum, entry) => sum + entry.weight, 0);
      return [{ ...lot, weight: lot.weight * share, prizes }];
    });
}

function pick<T extends { weight: number }>(entries: readonly T[], random: () => number): T {
  let roll = random() * entries.reduce((sum, entry) => sum + entry.weight, 0);
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll < 0) return entry;
  }
  return entries[entries.length - 1]!;
}

const drawFrom = (table: Lot[], random: () => number) => pick(pick(table, random).prizes, random).prize;

export const drawCountOf = (option: Row) => Math.max(1, Math.floor(Number(option.drawCount) || 1));

export function gachaGuarantee(option: Row) {
  const rarity = Number(option.guaranteedRarity) || 0;
  const count = Math.min(drawCountOf(option), Math.max(0, Number(option.guaranteedCount) || 0));
  return rarity && count ? { rarity, count } : null;
}

export function canSimulate(item: Row, option: Row): boolean {
  const table = lots(item);
  return table.length > 0 && (!gachaGuarantee(option) || guaranteedLots(table, option).length > 0);
}

/** Highest use count the product allows; 0 means unlimited. */
export const useLimitOf = (option: Row) => Math.max(0, Math.floor(Number(option.limitCount) || 0));

/** `previousUses` is how often this product was already used, for its first-use price. */
export function simulateGacha(
  item: Row,
  option: Row,
  uses: number,
  previousUses = 0,
  random: () => number = Math.random,
): GachaRun {
  const table = lots(item);
  const guarantee = gachaGuarantee(option);
  const ensured = guarantee ? guaranteedLots(table, option) : [];
  const size = drawCountOf(option);
  const rule = item.guaranteeRule === "redraw" ? "redraw" : "slot";
  const pulls: GachaPrize[][] = [];
  let cost = 0;
  for (let use = 0; use < uses; use += 1) {
    const pull: GachaPrize[] = [];
    for (let index = 0; index < size; index += 1) {
      const guaranteedSlot = guarantee && rule === "slot" && index >= size - guarantee.count;
      pull.push(drawFrom(guaranteedSlot ? ensured : table, random));
    }
    if (guarantee && rule === "redraw") {
      let missing = guarantee.count - pull.filter((prize) => prize.rarity >= guarantee.rarity).length;
      for (let index = size - 1; missing > 0 && index >= 0; index -= 1) {
        if (pull[index]!.rarity >= guarantee.rarity) continue;
        pull[index] = drawFrom(ensured, random);
        missing -= 1;
      }
    }
    pulls.push(pull);
    const first = Number(option.firstPrice) || 0;
    cost += previousUses + use === 0 && first > 0 ? first : Math.max(0, Number(option.price) || 0);
  }
  return { option, pulls, draws: uses * size, cost, points: uses * (Number(option.gachaPoint) || 0) };
}

export interface GachaTally {
  prize: GachaPrize;
  count: number;
}

/** Identical cards merged, rarity descending then id descending. */
export function tallyGacha(runs: readonly GachaRun[]): Record<GachaCardKind, GachaTally[]> {
  const merged = new Map<string, GachaTally>();
  for (const prize of runs.flatMap((run) => run.pulls.flat())) {
    const entry = merged.get(prize.key);
    if (entry) entry.count += 1;
    else merged.set(prize.key, { prize, count: 1 });
  }
  const sorted = [...merged.values()].sort((a, b) => b.prize.rarity - a.prize.rarity || b.prize.id - a.prize.id);
  return {
    member: sorted.filter((entry) => entry.prize.kind === "member"),
    support: sorted.filter((entry) => entry.prize.kind === "support"),
    item: sorted.filter((entry) => entry.prize.kind === "item"),
  };
}

/** Pull counts per card kind and rarity, rarities descending. */
export function kindRarityCounts(
  runs: readonly GachaRun[],
): Array<{ kind: GachaCardKind; counts: Array<[rarity: number, count: number]> }> {
  const counts = new Map<GachaCardKind, Map<number, number>>();
  for (const prize of runs.flatMap((run) => run.pulls.flat())) {
    const kind = counts.get(prize.kind) || new Map<number, number>();
    kind.set(prize.rarity, (kind.get(prize.rarity) || 0) + 1);
    counts.set(prize.kind, kind);
  }
  return (["member", "support", "item"] as const)
    .filter((kind) => counts.has(kind))
    .map((kind) => ({ kind, counts: [...counts.get(kind)!].sort(([a], [b]) => b - a) }));
}
