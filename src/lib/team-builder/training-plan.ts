// L3 — GEB
// Input: Fixed formation, same-server save or manual budget, and pinned growth catalog.
// Output: Ordered affordable upgrades, simulated gains and remaining materials.
// Pos: [Map](L2-2.md); cost and budget logic for the training recommendation.
// Effects/Dependencies: Scores temporary requests through the caller; never writes save or Box data.
import { summarizeCatalogCosts, type CatalogCost } from "../catalog-cost-summary";
import { growthCap, type GrowthCatalogCard, type GrowthPageData } from "../growth-catalog";
import type { GrowthState } from "../growth-comparison";
import type { SaveSnapshot } from "../save-workspace/snapshot";
import { dataRows } from "./data";
import type { EngineHit, EngineRequest } from "./engine/api";
import type { EngineMaster } from "./engine/master";
import { teamGrowthActions, teamGrowthChange, type TeamGrowthChoice, type TeamGrowthStep } from "./team-growth";

type Kind = TeamGrowthChoice["kind"];
type Quantities = ReadonlyMap<string, number>;
const cardKinds = ["members", "snaps"] as const;
const catalogKind = { members: "member", snaps: "support" } as const;

function quantity(value: unknown): number | undefined {
  const n = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

function experience(value: unknown): bigint | undefined {
  if (typeof value === "string" && /^\d{1,19}$/u.test(value)) return BigInt(value);
  const n = quantity(value);
  return n === undefined ? undefined : BigInt(n);
}

function uniqueRows(value: unknown, key: string) {
  const rows = new Map<number, Record<string, unknown> | null>();
  for (const row of Array.isArray(value) ? dataRows(value) : []) {
    const id = quantity(row[key]);
    if (id) rows.set(id, rows.has(id) ? null : row);
  }
  return rows;
}

export function trainingStock(snapshot: SaveSnapshot): Quantities {
  const stock = new Map<string, number>();
  for (const [id, row] of uniqueRows(snapshot.player._items, "_masterItemId")) {
    const n = quantity(row?._amount);
    if (n !== undefined) stock.set(`items:${id}`, n);
  }
  for (const [id, row] of uniqueRows(snapshot.player._supportCards, "_masterId")) {
    const n = quantity(row?._duplicateCount);
    if (n !== undefined) stock.set(`support-cards:${id}`, n);
  }
  return stock;
}

function levelExp(card: GrowthCatalogCard, level: number | null) {
  return experience(card.tracks.level?.stages.find((stage) => stage.value === level)?.exp);
}

function savedLevel(card: GrowthCatalogCard, state: GrowthState, exp: bigint | undefined) {
  const cap = growthCap(card, state);
  if (exp === undefined || cap === null) return null;
  let level: number | null = null;
  for (const stage of card.tracks.level?.stages ?? []) {
    const threshold = experience(stage.exp);
    if (threshold !== undefined && threshold <= exp && stage.value <= cap && stage.value > (level ?? 0))
      level = stage.value;
  }
  return level;
}

export function trainingMaterials(request: EngineRequest, catalog: GrowthPageData): CatalogCost[] {
  const materials = new Map<string, CatalogCost>();
  for (const kind of cardKinds) {
    const cards = catalog.cards.filter(
      (card) => card.kind === catalogKind[kind] && request[kind].some((row) => row.cardId === card.id),
    );
    const exp = catalog.experienceItems?.[catalogKind[kind]];
    if (cards.length && exp) materials.set(exp.identity, exp);
    for (const card of cards)
      for (const track of Object.values(card.tracks))
        for (const step of track.costs)
          for (const item of step.items) if (item.identity) materials.set(item.identity, item);
  }
  return [...materials.values()];
}

export function prepareTraining(request: EngineRequest, catalog: GrowthPageData, snapshot?: SaveSnapshot) {
  if (snapshot && snapshot.server !== catalog.identity.server) throw new Error("training-save-server");
  const input = structuredClone(request);
  const cards = new Map<string, GrowthCatalogCard>();
  const expByCard = new Map<string, bigint>();
  const saved = {
    members: uniqueRows(snapshot?.player._memberCards, "_masterId"),
    snaps: uniqueRows(snapshot?.player._supportCards, "_masterId"),
  };
  for (const kind of cardKinds) {
    for (const row of input[kind]) {
      const card = catalog.cards.find((card) => card.kind === catalogKind[kind] && card.id === row.cardId);
      if (!card) {
        if (snapshot) throw new Error("training-save-team");
        continue;
      }
      cards.set(row.key, card);
      let exp = levelExp(card, row.level);
      if (snapshot) {
        const record = saved[kind].get(row.cardId);
        if (!record) throw new Error("training-save-team");
        exp = experience(record._exp);
        row.rank = quantity(record._rank) ?? null;
        if ("awake" in row) {
          row.awake = quantity(record._awakeCount) ?? null;
          row.liveSkillLevel = quantity(record._liveSkillLevel) ?? null;
          row.gekisoSkillLevel = quantity(record._performanceSkillLevel) ?? null;
          row.level = savedLevel(card, { training: row.awake }, exp);
        } else row.level = savedLevel(card, { break: row.rank }, exp);
      }
      if (exp !== undefined) expByCard.set(row.key, exp);
    }
  }
  return { input, cards, expByCard };
}

export interface TrainingStep {
  kind: Kind;
  cardId: number;
  changes: TeamGrowthStep[];
  costs: CatalogCost[];
  gain: number;
}

export interface TrainingPlan {
  baseline: EngineHit;
  final: EngineHit;
  steps: TrainingStep[];
  remaining: Quantities;
  incomplete: boolean;
}

export async function planTraining(
  master: EngineMaster,
  prepared: ReturnType<typeof prepareTraining>,
  catalog: GrowthPageData,
  stock: Quantities,
  evaluate: (requests: readonly EngineRequest[]) => Promise<(EngineHit | null)[]>,
  metric: (hit: EngineHit) => number,
  onProgress: (plan: TrainingPlan) => void,
): Promise<TrainingPlan> {
  let input = prepared.input;
  const [baseline] = await evaluate([input]);
  if (!baseline) throw new Error("growth-no-team");
  let current = baseline;
  const remaining = new Map(stock);
  const expByCard = new Map(prepared.expByCard);
  const steps: TrainingStep[] = [];
  let incomplete = false;

  while (true) {
    const candidates = [];
    for (const kind of cardKinds) {
      const actions = teamGrowthActions(kind).filter(
        (action) => input.goal.kind !== "power" || (action !== "live" && action !== "gekisou"),
      );
      const capAction = kind === "members" ? "training" : "break";
      for (const row of input[kind]) {
        const card = prepared.cards.get(row.key);
        if (!card || row.level === null) {
          incomplete = true;
          continue;
        }
        const bundles = actions.map((action) => [action]);
        if (row.level === growthCap(card, { training: "awake" in row ? row.awake : null, break: row.rank }))
          bundles.push([capAction, "level"]);
        for (const actions of bundles) {
          const change = teamGrowthChange(master, input, { kind, key: row.key, actions, target: "next" });
          if (change.status === "at-cap") continue;
          if (!change.request) {
            incomplete = true;
            continue;
          }
          if (change.steps.length !== actions.length) continue;
          const costs = new Map<string, CatalogCost>();
          let nextExp = expByCard.get(row.key);
          let complete = true;
          for (const step of change.steps) {
            let items: CatalogCost[];
            if (step.action === "level") {
              const material = catalog.experienceItems?.[card.kind];
              const target = levelExp(card, step.to);
              if (!material || nextExp === undefined || target === undefined) {
                complete = false;
                break;
              }
              const cost = target > nextExp ? target - nextExp : 0n;
              if (cost > BigInt(Number.MAX_SAFE_INTEGER)) {
                complete = false;
                break;
              }
              items = cost ? [{ ...material, count: Number(cost) }] : [];
              if (target > nextExp) nextExp = target;
            } else {
              const track = card.tracks[step.action];
              const cost = summarizeCatalogCosts(track?.costs ?? [], step.from!, step.to);
              if (!cost.complete) {
                complete = false;
                break;
              }
              items = cost.items;
            }
            for (const item of items)
              costs.set(item.identity, { ...item, count: item.count + (costs.get(item.identity)?.count ?? 0) });
          }
          const items = [...costs.values()];
          if (!complete || items.some((item) => !remaining.has(item.identity))) {
            incomplete = true;
            continue;
          }
          if (items.some((item) => item.count > remaining.get(item.identity)!)) continue;
          candidates.push({
            kind,
            cardId: row.cardId,
            key: row.key,
            request: change.request,
            changes: change.steps,
            costs: items,
            nextExp,
          });
        }
      }
    }
    if (!candidates.length) break;
    const hits = await evaluate(candidates.map((candidate) => candidate.request));
    const previous = metric(current);
    let best = -1;
    let gain = 1e-9;
    for (const [index, hit] of hits.entries()) {
      if (!hit) continue;
      const delta = metric(hit) - previous;
      if (delta > gain) {
        best = index;
        gain = delta;
      }
    }
    if (best === -1) break;
    const { request, nextExp, kind, key, cardId, changes, costs } = candidates[best]!;
    for (const item of costs) remaining.set(item.identity, remaining.get(item.identity)! - item.count);
    if (nextExp !== undefined) expByCard.set(key, nextExp);
    current = hits[best]!;
    input = request;
    steps.push({ kind, cardId, changes, costs, gain });
    onProgress({ baseline, final: current, steps: [...steps], remaining: new Map(remaining), incomplete });
  }
  return { baseline, final: current, steps, remaining, incomplete };
}
