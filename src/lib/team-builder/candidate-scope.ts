import type { MemberCatalog, SnapshotCatalog, TeamBuilderData } from "./data";
import type { InventoryV1 } from "./inventory";

export interface CandidateScope {
  members: { attributes: number[]; rarities: number[]; bands: number[]; characters: number[] };
  snapshots: { attributes: number[]; rarities: number[] };
}
export function emptyCandidateScope(): CandidateScope {
  return { members: { attributes: [], rarities: [], bands: [], characters: [] }, snapshots: { attributes: [], rarities: [] } };
}
export function validCandidateScope(value: unknown): value is CandidateScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as CandidateScope;
  if (Object.keys(scope).length !== 2) return false;
  return (["members", "snapshots"] as const).every(kind => {
    const filters = scope[kind], keys = kind === "members" ? ["attributes", "rarities", "bands", "characters"] : ["attributes", "rarities"];
    return !!filters && typeof filters === "object" && !Array.isArray(filters) && Object.keys(filters).length === keys.length && keys.every(key => {
      const ids = (filters as unknown as Record<string, unknown>)[key];
      return Object.hasOwn(filters, key) && Array.isArray(ids) && ids.length <= 256 && new Set(ids).size === ids.length &&
        ids.every(id => Number.isSafeInteger(id) && id > 0 && id <= 0x7fffffff);
    });
  });
}
export function candidateAllowed(card: MemberCatalog | SnapshotCatalog | undefined, kind: "members" | "snapshots", scope: CandidateScope): boolean {
  const filters = scope[kind];
  if (!card) return Object.values(filters).every(ids => ids.length === 0);
  if (filters.attributes.length && !filters.attributes.includes(card.attribute) ||
    filters.rarities.length && !filters.rarities.includes(card.rarity)) return false;
  if (kind === "members") {
    if (!("characterId" in card)) return false;
    return (!scope.members.bands.length || scope.members.bands.includes(card.bandId)) &&
      (!scope.members.characters.length || scope.members.characters.includes(card.characterId));
  }
  return true;
}
/** Project display choices into the existing solver exclusions without editing
 * owned cards, their training, or their explicit lock/exclusion flags. */
export function resolveCandidateScope(data: TeamBuilderData, inventory: InventoryV1, scope: CandidateScope) {
  if (!validCandidateScope(scope)) throw new RangeError("candidate-scope");
  const members = inventory.members.filter(row => !row.excluded && candidateAllowed(data.members[String(row.cardId)], "members", scope));
  const snapshots = inventory.snapshots.filter(row => !row.excluded && candidateAllowed(data.snapshots[String(row.cardId)], "snapshots", scope));
  const memberIds = new Set(members.map(row => row.instanceId)), snapshotIds = new Set(snapshots.map(row => row.instanceId));
  return {
    members, snapshots,
    excludedMemberIds: inventory.members.filter(row => !memberIds.has(row.instanceId)).map(row => row.instanceId),
    excludedSnapshotIds: inventory.snapshots.filter(row => !snapshotIds.has(row.instanceId)).map(row => row.instanceId),
  };
}
