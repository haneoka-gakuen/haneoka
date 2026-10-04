/** Shared private transport document. No browser, score or Master dependencies. */
export interface WorkspaceMemberEntry {
  instanceId: string;
  cardId: number;
  level: number | null;
  training: number | null;
  awakening: number | null;
  liveSkillLevel: number | null;
  gekisoSkillLevel: number | null;
  locked: boolean;
  excluded: boolean;
}
export interface WorkspaceSnapshotEntry {
  instanceId: string;
  cardId: number;
  level: number | null;
  awakening: number | null;
  locked: boolean;
  excluded: boolean;
}
export interface WorkspaceInventory {
  schema: "haneoka-team-inventory-v2";
  server: string;
  releaseId: string;
  members: WorkspaceMemberEntry[];
  snapshots: WorkspaceSnapshotEntry[];
  bandItems: Record<string, number | null>;
  characterRanks: Record<string, number | null>;
  bandRanks: Record<string, number | null>;
  playerModifiers: {
    characterTotalRank: number | null;
    vipRank: number | null;
    musicMemoryPoints: Record<string, number | null>;
    characterMemoryPoints: Record<string, number | null>;
  };
}

export interface WorkspaceIdentity {
  server: string;
  releaseId: string;
  sourceId: string;
}
export interface UpgradeProfile {
  id: string;
  name: string;
  kind: "upgrade-planning";
  identity: WorkspaceIdentity;
  baseInventoryRevision: number;
  inventory: WorkspaceInventory;
}
export interface SavedTeam {
  id: string;
  name: string;
  identity: WorkspaceIdentity;
  profileId: string | null;
  inventory: WorkspaceInventory;
  formation: { memberCardIds: number[]; snapshotCardIds: (number | null)[]; leaderCardId: number };
}
export interface TeamWorkspaceV1 {
  schema: "haneoka-team-workspace-v1";
  server: string;
  activeProfileId: string | null;
  profiles: UpgradeProfile[];
  teams: SavedTeam[];
}
export const MAX_WORKSPACE_BYTES = 1024 * 1024;
export const MAX_UPGRADE_PROFILES = 32;
export const MAX_SAVED_TEAMS = 64;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: string[]) =>
  Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
const id = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff;
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
export const validWorkspaceRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
export const validWorkspaceName = (value: unknown): value is string =>
  typeof value === "string" &&
  value === value.trim() &&
  [...value].length >= 1 &&
  [...value].length <= 80 &&
  !/[\p{Cc}\p{Cs}]/u.test(value);
const counter = (value: unknown, max = 1000000) =>
  value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max);
const levelMap = (value: unknown, max = 1000000) =>
  object(value) &&
  Object.keys(value).length <= 2048 &&
  Object.entries(value).every(
    ([key, entry]) => /^[1-9]\d{0,9}$/u.test(key) && Number(key) <= 0x7fffffff && counter(entry, max),
  );
const identityShape = (value: unknown, server: string): value is WorkspaceIdentity =>
  object(value) &&
  exact(value, ["server", "releaseId", "sourceId"]) &&
  value.server === server &&
  typeof value.releaseId === "string" &&
  /^r-[a-f0-9]{20}$/u.test(value.releaseId) &&
  typeof value.sourceId === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.sourceId);

/** Storage/transport shape only. Current Master validation happens before use. */
function inventoryShape(value: unknown, identity: WorkspaceIdentity): value is WorkspaceInventory {
  if (
    !object(value) ||
    !exact(value, [
      "schema",
      "server",
      "releaseId",
      "members",
      "snapshots",
      "bandItems",
      "characterRanks",
      "bandRanks",
      "playerModifiers",
    ]) ||
    value.schema !== "haneoka-team-inventory-v2" ||
    value.server !== identity.server ||
    value.releaseId !== identity.releaseId ||
    ![value.bandItems, value.characterRanks, value.bandRanks].every((value) => levelMap(value))
  )
    return false;
  const instances = new Set<string>();
  for (const kind of ["members", "snapshots"] as const) {
    const rows = value[kind],
      cards = new Set<number>();
    if (!Array.isArray(rows) || rows.length > 5000) return false;
    const fields =
      kind === "members"
        ? ["level", "training", "awakening", "liveSkillLevel", "gekisoSkillLevel"]
        : ["level", "awakening"];
    for (const row of rows) {
      if (
        !object(row) ||
        !exact(row, ["instanceId", "cardId", "locked", "excluded", ...fields]) ||
        !id(row.cardId) ||
        cards.has(row.cardId) ||
        typeof row.instanceId !== "string" ||
        !row.instanceId ||
        row.instanceId.length > 128 ||
        instances.has(row.instanceId) ||
        typeof row.locked !== "boolean" ||
        typeof row.excluded !== "boolean" ||
        (row.locked && row.excluded) ||
        !fields.every((field) => counter(row[field]))
      )
        return false;
      cards.add(row.cardId);
      instances.add(row.instanceId);
    }
  }
  const modifiers = value.playerModifiers;
  return (
    object(modifiers) &&
    exact(modifiers, ["characterTotalRank", "vipRank", "musicMemoryPoints", "characterMemoryPoints"]) &&
    counter(modifiers.characterTotalRank, 0x7fffffff) &&
    (modifiers.vipRank === null || id(modifiers.vipRank)) &&
    levelMap(modifiers.musicMemoryPoints, 0x7fffffff) &&
    levelMap(modifiers.characterMemoryPoints, 0x7fffffff)
  );
}

export function isTeamWorkspaceDocument(value: unknown, server: string): value is TeamWorkspaceV1 {
  if (
    !object(value) ||
    !exact(value, ["schema", "server", "activeProfileId", "profiles", "teams"]) ||
    value.schema !== "haneoka-team-workspace-v1" ||
    value.server !== server ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(server) ||
    !Array.isArray(value.profiles) ||
    value.profiles.length > MAX_UPGRADE_PROFILES ||
    !Array.isArray(value.teams) ||
    value.teams.length > MAX_SAVED_TEAMS
  )
    return false;
  const seen = new Set<string>(),
    profiles = new Set<string>();
  for (const profile of value.profiles) {
    if (
      !object(profile) ||
      !exact(profile, ["id", "name", "kind", "identity", "baseInventoryRevision", "inventory"]) ||
      !uuid(profile.id) ||
      seen.has(profile.id) ||
      !validWorkspaceName(profile.name) ||
      profile.kind !== "upgrade-planning" ||
      !validWorkspaceRevision(profile.baseInventoryRevision) ||
      !identityShape(profile.identity, server) ||
      !inventoryShape(profile.inventory, profile.identity)
    )
      return false;
    seen.add(profile.id);
    profiles.add(profile.id);
  }
  if (value.activeProfileId !== null && (!uuid(value.activeProfileId) || !profiles.has(value.activeProfileId)))
    return false;
  for (const team of value.teams) {
    if (
      !object(team) ||
      !exact(team, ["id", "name", "identity", "profileId", "inventory", "formation"]) ||
      !uuid(team.id) ||
      seen.has(team.id) ||
      !validWorkspaceName(team.name) ||
      (team.profileId !== null && !uuid(team.profileId)) ||
      !identityShape(team.identity, server) ||
      !inventoryShape(team.inventory, team.identity)
    )
      return false;
    const formation = team.formation,
      inventory = team.inventory;
    if (
      !object(formation) ||
      !exact(formation, ["memberCardIds", "snapshotCardIds", "leaderCardId"]) ||
      !Array.isArray(formation.memberCardIds) ||
      formation.memberCardIds.length !== 5 ||
      !formation.memberCardIds.every(id) ||
      new Set(formation.memberCardIds).size !== 5 ||
      !Array.isArray(formation.snapshotCardIds) ||
      formation.snapshotCardIds.length !== 5 ||
      !formation.snapshotCardIds.every((value) => value === null || id(value)) ||
      new Set(formation.snapshotCardIds.filter((value) => value !== null)).size !==
        formation.snapshotCardIds.filter((value) => value !== null).length ||
      !id(formation.leaderCardId) ||
      !formation.memberCardIds.includes(formation.leaderCardId) ||
      !formation.memberCardIds.every((cardId) => inventory.members.some((row) => row.cardId === cardId)) ||
      !formation.snapshotCardIds.every(
        (cardId) => cardId === null || inventory.snapshots.some((row) => row.cardId === cardId),
      )
    )
      return false;
    seen.add(team.id);
  }
  return true;
}
export function checkTeamWorkspace(value: unknown, server: string): TeamWorkspaceV1 {
  if (!isTeamWorkspaceDocument(value, server)) throw new TypeError("team-workspace-invalid-document");
  if (
    new TextEncoder().encode(JSON.stringify({ expectedRevision: Number.MAX_SAFE_INTEGER - 1, workspace: value }))
      .byteLength > MAX_WORKSPACE_BYTES
  )
    throw new RangeError("team-workspace-byte-limit");
  return structuredClone(value);
}
export function createEmptyTeamWorkspace(server: string): TeamWorkspaceV1 {
  return checkTeamWorkspace(
    { schema: "haneoka-team-workspace-v1", server, activeProfileId: null, profiles: [], teams: [] },
    server,
  );
}
