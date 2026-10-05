import { nativeRow, objectRow, type DataRow, type TeamBuilderData } from "../data";
import type { CharacterRankTotalResolution, CharacterRankTotalScope } from "./character-rank-total";

export interface MasterCharacterRosterSource {
  identity: TeamBuilderData["identity"];
  sourceTable: "MasterCharacter";
  status: "complete" | "empty" | "missing" | "invalid";
  rows: DataRow[];
}
export interface AccountCharacterRankDeclaration {
  identity: TeamBuilderData["identity"];
  complete: boolean;
  extraCharacterIds: readonly number[];
}

/** Rank coverage affects the total, while a qualified roster still permits
 * unknown ranks and lets the ordinary validator report illegal rank values. */
export function characterRankInventoryIds(total: CharacterRankTotalResolution): number[] {
  return total.reasons.every(reason => reason === "missing-rank" || reason === "invalid-rank" || reason === "int32-overflow")
    ? [...total.requiredIds, ...total.extraIds] : [];
}

/** Full-box metadata comes from a pinned raw Master reader, never the public character union. */
export function adaptMasterCharacterRoster(identity: TeamBuilderData["identity"], value: unknown): MasterCharacterRosterSource {
  const source = objectRow(value), raw = source.rows ?? source._allData;
  const pinned = identity.sourceId && source.server === identity.server && source.sourceId === identity.sourceId &&
    (source.releaseId === undefined || source.releaseId === identity.releaseId);
  if (!pinned || source.sourceTable !== "MasterCharacter" || !Array.isArray(raw))
    return { identity: { ...identity }, sourceTable: "MasterCharacter", status: "missing", rows: [] };
  if (raw.some(row => !row || typeof row !== "object" || Array.isArray(row)))
    return { identity: { ...identity }, sourceTable: "MasterCharacter", status: "invalid", rows: [] };
  const rows = raw.map(row => nativeRow({ raw: row, ...objectRow(row) }));
  const ids = rows.map(row => row.id ?? row.characterId ?? row._id);
  const valid = ids.every((id, index) => typeof id === "number" && Number.isSafeInteger(id) && id > 0 &&
    [rows[index]!.id, rows[index]!.characterId, rows[index]!._id].every(value => value === undefined || value === id)) &&
    new Set(ids).size === ids.length;
  return { identity: { ...identity }, sourceTable: "MasterCharacter",
    status: !valid ? "invalid" : source.status !== "complete" ? "missing" : rows.length ? "complete" : "empty", rows };
}

/** Explicit complete-account declarations include every retained extra ID.
 * No declaration is created merely because all catalog sliders have values.
 */
export function characterRankTotalScope(data: TeamBuilderData, account?: AccountCharacterRankDeclaration | null): CharacterRankTotalScope {
  const master = data.masterCharacterRoster;
  return {
    master: { identity: master?.identity ?? { ...data.identity }, complete: master?.status === "complete", rows: master?.rows ?? [] },
    account: { identity: account?.identity ?? { ...data.identity }, complete: account?.complete === true,
      extraCharacterIds: account?.extraCharacterIds ?? [] },
  };
}
