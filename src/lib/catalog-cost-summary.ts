/** Costs retain the identity of their same-release referenced resource. */
export interface CatalogCost {
  identity: string;
  name: string;
  count: number;
  image?: string;
  href?: string;
}

export interface CatalogCostStep {
  from: number;
  to: number;
  items: ReadonlyArray<CatalogCost>;
}

export interface CatalogCostSummary {
  items: CatalogCost[];
  complete: boolean;
  missing: number[];
}

/** Destination rows are incremental costs. An absent destination is unknown. */
export function summarizeCatalogCosts(
  steps: ReadonlyArray<CatalogCostStep>,
  from: number,
  to: number,
): CatalogCostSummary {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from)
    return { items: [], complete: false, missing: [] };
  const selected = new Map<number, CatalogCostStep>();
  const duplicates = new Set<number>();
  for (const step of steps) {
    if (step.to <= from || step.to > to) continue;
    if (selected.has(step.to)) duplicates.add(step.to);
    selected.set(step.to, step);
  }
  const missing: number[] = [];
  const totals = new Map<string, CatalogCost>();
  for (let stage = from + 1; stage <= to; stage++) {
    const step = selected.get(stage);
    if (!step || step.from !== stage - 1 || duplicates.has(stage)) {
      missing.push(stage);
      continue;
    }
    for (const item of step.items) {
      if (!item.identity || !Number.isSafeInteger(item.count) || item.count < 0) {
        if (!missing.includes(stage)) missing.push(stage);
        continue;
      }
      const count = (totals.get(item.identity)?.count ?? 0) + item.count;
      if (!Number.isSafeInteger(count)) {
        if (!missing.includes(stage)) missing.push(stage);
        continue;
      }
      totals.set(item.identity, { ...item, count });
    }
  }
  return { items: missing.length ? [] : [...totals.values()], complete: !missing.length, missing };
}
