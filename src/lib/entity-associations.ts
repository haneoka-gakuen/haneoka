/** Compact, build-time associations. References inherit their payload's server and release. */
export { skillDisplay } from "../lit/shared/skill-text";
import { asRecord, type RecordValue } from "./static-catalog-source";

export const associationRows = (value: unknown): RecordValue[] =>
  (Array.isArray(value) ? value : Object.values(asRecord(value) || {})).flatMap((row) =>
    asRecord(row) ? [row as RecordValue] : [],
  );
const raw = (row: RecordValue) => asRecord(row.raw) || row;

export interface EntityReference extends RecordValue {
  resource: string;
  id: string;
}
export type ReferenceResolver = (resource: string, id: string) => EntityReference | undefined;

export function entityReference(resource: string, id: string, row: RecordValue): EntityReference {
  const images = asRecord(row.images);
  return {
    resource,
    id,
    name: row.name ?? row.prefix ?? row.cardName ?? row.characterName ?? row.musicTitle ?? row.title,
    image: row.image ?? row.thumbnailImage ?? row.faceImage ?? row.jacketThumbUrl ?? images?.thumbnail,
    ...(row.characterId ? { characterId: row.characterId } : {}),
    ...(row.characterIds ? { characterIds: row.characterIds } : {}),
  };
}

const RESOURCE_TYPES: Record<number, string> = {
  1: "items",
  2: "cards",
  3: "support-cards",
  8: "songs",
  9: "stamps",
  17: "stickers",
};

/** Preserve the authored reward identity, including types without a catalog detail page. */
export function associatedReward(value: unknown, resolve: ReferenceResolver): RecordValue {
  const reward = asRecord(value) || {};
  const source = raw(reward);
  const resourceType = Number(reward.resourceType ?? source._resourceType);
  const resourceId = Number(reward.resourceId ?? source._resourceId);
  const resourceCount = Number(reward.resourceCount ?? source._resourceCount);
  const resource = RESOURCE_TYPES[resourceType];
  const reference = resource ? resolve(resource, String(resourceId)) : undefined;
  return {
    resourceType,
    resourceId,
    resourceCount,
    ...(reward.resourceTypeName ? { resourceTypeName: reward.resourceTypeName } : {}),
    ...(reference ? { reference } : {}),
    ...(asRecord(reward.resolved) ? { resolved: reward.resolved } : {}),
  };
}

export interface UpgradeStep extends RecordValue {
  kind: string;
  from: number;
  to: number;
  costs: Array<{ count: number; reference?: EntityReference; itemId?: number }>;
}

/** Master stores requirements at the destination level, never as a cumulative sum. */
export function upgradeSteps(
  kind: string,
  rows: RecordValue[],
  levelKey: string,
  resolve: ReferenceResolver,
  rankResource?: { resource: string; id: string },
): UpgradeStep[] {
  const grouped = new Map<number, UpgradeStep>();
  for (const row of rows) {
    const source = raw(row);
    const to = Number(row[levelKey] ?? source[`_${levelKey}`]);
    const value = row.count ?? source._count ?? source._requiredRankUpItemCount;
    const parsed = typeof value === "number" || typeof value === "string" && value.trim()
      ? Number(value) : Number.NaN;
    const count = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : Number.NaN;
    // Band-item level 1 is purchased from level 0. Card and skill domains start at 1.
    const initial = kind === "level" ? 0 : 1;
    if (!Number.isSafeInteger(to) || to <= initial) continue;
    const step: UpgradeStep = grouped.get(to) || { kind, from: to - 1, to, costs: [] };
    const itemId = Number(row.itemId ?? source._itemId ?? source._itemID);
    const target = rankResource || (itemId > 0 ? { resource: "items", id: String(itemId) } : undefined);
    const reference = target ? resolve(target.resource, target.id) : undefined;
    // Only an explicit zero is free. Retain unknown quantities in the stage:
    // NaN serializes to null, which the cost consumers also treat as unknown.
    if (count !== 0)
      step.costs.push({ count, ...(itemId > 0 ? { itemId } : {}), ...(reference ? { reference } : {}) });
    grouped.set(to, step);
  }
  return [...grouped.values()].sort((a, b) => a.to - b.to);
}


export function characterRankAssociations(
  id: number,
  progression: RecordValue,
  resolve: ReferenceResolver,
): RecordValue {
  return {
    ranks: associationRows(progression.characterRanks).map((row) => ({
      rank: row.rank ?? raw(row)._rank,
      exp: row.exp ?? raw(row)._exp,
      bonus: row.bonus ?? raw(row)._bonus,
    })),
    rewards: associationRows(progression.characterRankRewards)
      .filter((row) => [0, id].includes(Number(row.characterId ?? raw(row)._characterId)))
      .map((row) => ({
        characterId: row.characterId ?? raw(row)._characterId,
        rank: row.rank ?? raw(row)._rank,
        reward: associatedReward(row.reward ?? row, resolve),
      })),
  };
}
