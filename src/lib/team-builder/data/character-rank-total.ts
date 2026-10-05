import type { DataRow, TeamBuilderData } from "../data";
import type { Inventory } from "../inventory";

export type CharacterRankIdentity = TeamBuilderData["identity"];

/** Producer attestations refer to the complete, loaded MasterCharacter box and
 * the complete account roster, including retained IDs outside that box. */
export interface CharacterRankTotalScope {
  master: {
    identity: CharacterRankIdentity;
    complete: boolean;
    rows: readonly DataRow[];
  };
  account: {
    identity: CharacterRankIdentity;
    complete: boolean;
    extraCharacterIds: readonly number[];
  };
}

export type CharacterRankTotalReason =
  | "identity-unavailable"
  | "identity-mismatch"
  | "master-incomplete"
  | "account-incomplete"
  | "invalid-master-id"
  | "invalid-account-id"
  | "account-domain-mismatch"
  | "rank-domain-unavailable"
  | "missing-rank"
  | "invalid-rank"
  | "int32-overflow";

export interface CharacterRankTotalResolution {
  effective: number | null;
  derived: number | null;
  /** Saved observation is retained even when its identity cannot be evaluated. */
  observed: number | null;
  effectiveSource: "derived" | "observed" | "unknown";
  qualified: boolean;
  reasons: CharacterRankTotalReason[];
  requiredIds: number[];
  missingIds: number[];
  invalidIds: string[];
  invalidRankIds: number[];
  extraIds: number[];
  undeclaredExtraIds: number[];
  identity: {
    data: CharacterRankIdentity;
    inventory: Pick<Inventory, "server" | "releaseId">;
    master: CharacterRankIdentity | null;
    account: CharacterRankIdentity | null;
  };
}

const INT32_MAX = 0x7fffffff;
const validId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const validRank = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= INT32_MAX;
const sortedIds = (ids: Iterable<number>) => [...new Set(ids)].sort((a, b) => a - b);
const identityCopy = (identity: CharacterRankIdentity): CharacterRankIdentity => ({
  server: identity.server,
  releaseId: identity.releaseId,
  ...(identity.sourceId ? { sourceId: identity.sourceId } : {}),
});
const pinned = (identity: CharacterRankIdentity) =>
  !!identity.server && !!identity.releaseId && !!identity.sourceId;
const samePin = (left: CharacterRankIdentity, right: CharacterRankIdentity) =>
  pinned(left) && pinned(right) && left.server === right.server &&
  left.releaseId === right.releaseId && left.sourceId === right.sourceId;

/** Returns an evaluation view; never writes a derived total into the inventory.
 * Master rows use their original numeric id/characterId/_id, including NPCs.
 * Input null ranks remain unknown. Every declared account extra must be legal
 * and covered; undeclared entries prevent qualification. */
export function resolveCharacterRankTotal(
  data: TeamBuilderData,
  inventory: Inventory,
  scope?: CharacterRankTotalScope | null,
): CharacterRankTotalResolution {
  const reasons = new Set<CharacterRankTotalReason>();
  const invalidIds = new Set<string>();
  const required = new Set<number>();
  const declaredExtras = new Set<number>();
  const ranks = new Map<number, unknown>();
  const observed = inventory.schema === "haneoka-team-inventory-v2"
    ? inventory.playerModifiers.characterTotalRank : null;
  const inventoryMatches = inventory.server === data.identity.server &&
    inventory.releaseId === data.identity.releaseId;
  if (!pinned(data.identity)) reasons.add("identity-unavailable");
  if (!inventoryMatches) reasons.add("identity-mismatch");
  if (!scope?.master.complete) reasons.add("master-incomplete");
  if (!scope?.account.complete) reasons.add("account-incomplete");
  if (scope) {
    if (!pinned(scope.master.identity) || !pinned(scope.account.identity))
      reasons.add("identity-unavailable");
    if (!samePin(data.identity, scope.master.identity) || !samePin(data.identity, scope.account.identity))
      reasons.add("identity-mismatch");
    for (const [index, row] of scope.master.rows.entries()) {
      const raw = row.raw && typeof row.raw === "object" && !Array.isArray(row.raw)
        ? row.raw as DataRow : {};
      const values = [row.characterId, row.id, row._id, raw._id]
        .filter((value) => value !== undefined);
      const id = values[0];
      if (!validId(id) || values.some((value) => value !== id)) {
        reasons.add("invalid-master-id");
        invalidIds.add(`master:${index}`);
      } else required.add(id);
    }
    for (const id of scope.account.extraCharacterIds) {
      if (!validId(id)) {
        reasons.add("invalid-account-id");
        invalidIds.add(`extra:${String(id)}`);
      } else declaredExtras.add(id);
    }
  }
  for (const [key, rank] of Object.entries(inventory.characterRanks)) {
    const id = Number(key);
    if (!validId(id) || String(id) !== key) {
      reasons.add("invalid-account-id");
      invalidIds.add(key);
    } else ranks.set(id, rank);
  }
  const extraIds = sortedIds([...declaredExtras, ...ranks.keys()].filter((id) => !required.has(id)));
  const undeclaredExtraIds = extraIds.filter((id) => !declaredExtras.has(id));
  if (undeclaredExtraIds.length || [...declaredExtras].some((id) => required.has(id)))
    reasons.add("account-domain-mismatch");
  const allowedRanks = new Set((data.progression.characterRanks ?? [])
    .map((row) => row.rank).filter(validRank));
  if (!allowedRanks.size) reasons.add("rank-domain-unavailable");
  const missingIds: number[] = [];
  const invalidRankIds: number[] = [];
  let total = 0;
  for (const id of sortedIds([...required, ...extraIds])) {
    const rank = ranks.get(id);
    if (rank === undefined || rank === null) missingIds.push(id);
    else if (!validRank(rank) || !allowedRanks.has(rank)) invalidRankIds.push(id);
    else if (total > INT32_MAX - rank) reasons.add("int32-overflow");
    else total += rank;
  }
  if (missingIds.length) reasons.add("missing-rank");
  if (invalidRankIds.length) reasons.add("invalid-rank");
  const qualified = reasons.size === 0;
  const derived = qualified ? total : null;
  const usableObserved = inventoryMatches && typeof observed === "number" &&
    Number.isInteger(observed) && observed >= 0 && observed <= INT32_MAX ? observed : null;
  return {
    effective: derived ?? usableObserved,
    derived,
    observed,
    effectiveSource: derived !== null ? "derived" : usableObserved !== null ? "observed" : "unknown",
    qualified,
    reasons: [...reasons],
    requiredIds: sortedIds(required),
    missingIds,
    invalidIds: [...invalidIds],
    invalidRankIds,
    extraIds,
    undeclaredExtraIds,
    identity: {
      data: identityCopy(data.identity),
      inventory: { server: inventory.server, releaseId: inventory.releaseId },
      master: scope ? identityCopy(scope.master.identity) : null,
      account: scope ? identityCopy(scope.account.identity) : null,
    },
  };
}
