// L3 — GEB
// Input: release-bound card progression and nullable owned growth.
// Output: one explicit transition, independent stat deltas and complete costs.
// Pos: [Map](L2-2.md); single-card growth comparison.
// Effects/Dependencies: pure; never updates ownership or fills unknown growth.
import { summarizeCatalogCosts, type CatalogCostStep, type CatalogCostSummary } from "./catalog-cost-summary";
import { levelContribution, trainingContribution, rankContribution, snapshotPercent } from "./card-growth";
export type GrowthAction = "level" | "training" | "awakening" | "live" | "gekisou" | "break";
export type GrowthStat = readonly [number, number, number];
export interface GrowthStage {
  value: number;
  exp?: string;
  rates?: GrowthStat;
  cap?: number;
  effects: Readonly<Record<string, number>>;
}
export interface GrowthTrack {
  stages: readonly GrowthStage[];
  costs: readonly CatalogCostStep[];
}
export interface GrowthCard {
  kind: "member" | "support";
  maximum: GrowthStat | null;
  tracks: Partial<Record<GrowthAction, GrowthTrack>>;
}
export type GrowthState = Readonly<Partial<Record<GrowthAction, number | null>>>;
export interface GrowthComparison {
  status: "ready" | "missing-state" | "missing-data" | "at-cap" | "invalid-state";
  from: number | null;
  to: number | null;
  delta: GrowthStat | null;
  effects: Array<{ key: string; before: number; after: number }>;
  costs: CatalogCostSummary;
}
const unknownCosts = (): CatalogCostSummary => ({ items: [], complete: false, missing: [] });
/** Levels stop at the current stage cap; other actions advance exactly one authored stage. */
export function compareGrowth(
  card: GrowthCard,
  state: GrowthState,
  action: GrowthAction,
  target: "next" | "cap" = "next",
): GrowthComparison {
  const from = state[action] ?? null;
  const result: GrowthComparison = {
    status: "missing-state",
    from,
    to: null,
    delta: null,
    effects: [],
    costs: unknownCosts(),
  };
  const track = card.tracks[action];
  if (!track) return { ...result, status: "missing-data" };
  if (from === null) return result;
  const current = track.stages.find((row) => row.value === from);
  if (!current) return { ...result, status: "invalid-state" };
  let cap = Math.max(...track.stages.map((row) => row.value));
  if (action === "level") {
    const capAction = card.kind === "member" ? "training" : "break";
    const capStage = state[capAction];
    if (capStage == null) return result;
    const row = card.tracks[capAction]?.stages.find((row) => row.value === capStage);
    if (row?.cap === undefined) return { ...result, status: "missing-data" };
    cap = row.cap;
  }
  if (from > cap) return { ...result, status: "invalid-state" };
  if (from === cap) return { ...result, status: "at-cap" };
  const to = action === "level" && target === "cap" ? cap : from + 1;
  const next = track.stages.find((row) => row.value === to);
  if (!next) return { ...result, status: "missing-data", to };
  result.status = "ready";
  result.to = to;
  // Member EXP records are absent from the box: level thresholds are not remaining cost.
  if (action !== "level") result.costs = summarizeCatalogCosts(track.costs, from, to);
  if (action === "live" || action === "gekisou" || action === "break") result.delta = [0, 0, 0];
  else if (card.maximum && current.rates && next.rates) {
    const calc =
      card.kind === "support"
        ? snapshotPercent
        : action === "level"
          ? levelContribution
          : action === "training"
            ? trainingContribution
            : rankContribution;
    result.delta = card.maximum.map(
      (maximum, i) => calc(maximum, next.rates![i]!) - calc(maximum, current.rates![i]!),
    ) as unknown as GrowthStat;
  }
  const before: Record<string, number> = {
    ...current.effects,
    ...(current.cap === undefined ? {} : { levelCap: current.cap }),
  };
  const after: Record<string, number> = { ...next.effects, ...(next.cap === undefined ? {} : { levelCap: next.cap }) };
  for (const key of Object.keys(before))
    if (after[key] !== undefined && before[key] !== after[key])
      result.effects.push({ key, before: before[key]!, after: after[key]! });
  return result;
}
