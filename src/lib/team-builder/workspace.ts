import type { TeamAssignment } from "./contracts";
import type { TeamBuilderData } from "./data";
import { resolveCharacterRankTotal, type CharacterRankTotalScope } from "./data/character-rank-total";
import { characterRankInventoryIds } from "./data/character-rank-scope";
import {
  upgradeInventory,
  validateAssignment,
  validateInventory,
  rebaseInventory,
  type InventoryV2,
  type InventoryV1,
} from "./inventory";

import {
  checkTeamWorkspace,
  createEmptyTeamWorkspace,
  MAX_WORKSPACE_BYTES,
  validWorkspaceName as named,
  validWorkspaceRevision as revision,
  type WorkspaceIdentity,
  type UpgradeProfile,
  type SavedTeam,
  type TeamWorkspaceV1,
} from "./data/workspace-document";
export {
  checkTeamWorkspace,
  createEmptyTeamWorkspace,
  isTeamWorkspaceDocument,
  MAX_WORKSPACE_BYTES,
  MAX_UPGRADE_PROFILES,
  MAX_SAVED_TEAMS,
} from "./data/workspace-document";
export type { WorkspaceIdentity, UpgradeProfile, SavedTeam, TeamWorkspaceV1 } from "./data/workspace-document";

const pin = (data: TeamBuilderData): WorkspaceIdentity => {
  if (!data.identity.sourceId) throw new TypeError("team-workspace-source-required");
  return { server: data.identity.server, releaseId: data.identity.releaseId, sourceId: data.identity.sourceId };
};
const current = (identity: WorkspaceIdentity, data: TeamBuilderData) => {
  if (identity.server !== data.identity.server || identity.sourceId !== pin(data).sourceId)
    throw new TypeError("team-workspace-rebase-required");
};
const checkedInventory = (inventory: InventoryV1, data: TeamBuilderData, scope?: CharacterRankTotalScope, recorded = false) => {
  // Saved profile reads retain historical records without declaring a complete account.
  const ids = scope ? characterRankInventoryIds(resolveCharacterRankTotal(data, inventory, scope))
    : recorded ? Object.keys(inventory.characterRanks).filter(id => /^[1-9]\d*$/u.test(id) && Number.isSafeInteger(Number(id))).map(Number) : [];
  const rebased = rebaseInventory(inventory, data, { accountCharacterIds: ids });
  if (!rebased.canApply) throw new TypeError("team-workspace-invalid-inventory");
  return upgradeInventory(rebased.candidate);
};
const name = (value: string) => {
  value = value.trim();
  if (!named(value)) throw new TypeError("team-workspace-invalid-name");
  return value;
};

export function createUpgradeProfile(
  inventory: InventoryV1,
  data: TeamBuilderData,
  label: string,
  baseInventoryRevision: number,
  scope?: CharacterRankTotalScope,
): UpgradeProfile {
  if (!revision(baseInventoryRevision)) throw new TypeError("team-workspace-invalid-revision");
  return {
    id: crypto.randomUUID(),
    name: name(label),
    kind: "upgrade-planning",
    identity: pin(data),
    baseInventoryRevision,
    inventory: checkedInventory(inventory, data, scope),
  };
}
export function upsertUpgradeProfile(workspace: TeamWorkspaceV1, profile: UpgradeProfile): TeamWorkspaceV1 {
  return checkTeamWorkspace(
    {
      ...workspace,
      profiles: [...workspace.profiles.filter((value) => value.id !== profile.id), structuredClone(profile)],
    },
    workspace.server,
  );
}
export function updateUpgradeProfile(
  workspace: TeamWorkspaceV1,
  profileId: string,
  inventory: InventoryV1,
  data: TeamBuilderData,
  scope?: CharacterRankTotalScope,
): TeamWorkspaceV1 {
  const profile = workspace.profiles.find((value) => value.id === profileId);
  if (!profile) throw new TypeError("team-workspace-profile-missing");
  current(profile.identity, data);
  return upsertUpgradeProfile(workspace, { ...profile, identity: pin(data), inventory: checkedInventory(inventory, data, scope) });
}
export function selectWorkspaceProfile(workspace: TeamWorkspaceV1, profileId: string | null): TeamWorkspaceV1 {
  return checkTeamWorkspace({ ...workspace, activeProfileId: profileId }, workspace.server);
}
export function getWorkspaceInventory(
  workspace: TeamWorkspaceV1,
  actual: InventoryV1,
  data: TeamBuilderData,
  scope?: CharacterRankTotalScope,
): InventoryV2 {
  checkTeamWorkspace(workspace, data.identity.server);
  if (workspace.activeProfileId === null) return checkedInventory(actual, data, scope, true);
  const profile = workspace.profiles.find((value) => value.id === workspace.activeProfileId)!;
  if (profile.identity.server !== data.identity.server || profile.identity.sourceId !== data.identity.sourceId)
    throw new TypeError("team-workspace-rebase-required");
  return checkedInventory(profile.inventory, data, scope, true);
}
export function workspaceProfileCompatible(profile: UpgradeProfile, data: TeamBuilderData, scope?: CharacterRankTotalScope): boolean {
  if (profile.identity.server !== data.identity.server || profile.identity.sourceId !== data.identity.sourceId) return false;
  try { checkedInventory(profile.inventory, data, scope, true); return true; }
  catch { return false; }
}
export function removeUpgradeProfile(workspace: TeamWorkspaceV1, profileId: string): TeamWorkspaceV1 {
  return checkTeamWorkspace(
    {
      ...workspace,
      profiles: workspace.profiles.filter((profile) => profile.id !== profileId),
      activeProfileId: workspace.activeProfileId === profileId ? null : workspace.activeProfileId,
    },
    workspace.server,
  );
}
export function createSavedTeam(
  label: string,
  assignment: TeamAssignment,
  inventory: InventoryV1,
  data: TeamBuilderData,
  profileId: string | null = null,
  scope?: CharacterRankTotalScope,
): SavedTeam {
  const captured = checkedInventory(inventory, data, scope);
  if (
    validateAssignment(assignment, captured).length ||
    assignment.memberInstanceIds.length !== 5 ||
    assignment.snapshotInstanceIds.length !== 5
  )
    throw new TypeError("team-workspace-invalid-assignment");
  const members = assignment.memberInstanceIds.map(
    (instance) => captured.members.find((entry) => entry.instanceId === instance)!.cardId,
  );
  if (new Set(members.map((cardId) => data.members[String(cardId)]!.characterId)).size !== 5)
    throw new TypeError("team-workspace-repeated-character");
  return {
    id: crypto.randomUUID(),
    name: name(label),
    identity: pin(data),
    profileId,
    inventory: captured,
    formation: {
      memberCardIds: members,
      snapshotCardIds: assignment.snapshotInstanceIds.map((instance) =>
        instance === null ? null : captured.snapshots.find((entry) => entry.instanceId === instance)!.cardId,
      ),
      leaderCardId: captured.members.find((entry) => entry.instanceId === assignment.leaderInstanceId)!.cardId,
    },
  };
}
export function upsertSavedTeam(workspace: TeamWorkspaceV1, team: SavedTeam): TeamWorkspaceV1 {
  return checkTeamWorkspace(
    { ...workspace, teams: [...workspace.teams.filter((value) => value.id !== team.id), structuredClone(team)] },
    workspace.server,
  );
}
export function restoreSavedTeam(
  team: SavedTeam,
  data: TeamBuilderData,
  targetInventory?: InventoryV1,
  scope?: CharacterRankTotalScope,
): { inventory: InventoryV2; assignment: TeamAssignment } {
  current(team.identity, data);
  const inventory = checkedInventory(targetInventory ?? team.inventory, data, scope, true);
  const member = (cardId: number) => {
    const row = inventory.members.find((entry) => entry.cardId === cardId);
    if (!row) throw new TypeError("team-workspace-team-card-missing");
    return row.instanceId;
  };
  const assignment: TeamAssignment = {
    memberInstanceIds: team.formation.memberCardIds.map(member),
    snapshotInstanceIds: team.formation.snapshotCardIds.map((cardId) => {
      if (cardId === null) return null;
      const row = inventory.snapshots.find((entry) => entry.cardId === cardId);
      if (!row) throw new TypeError("team-workspace-team-card-missing");
      return row.instanceId;
    }),
    leaderInstanceId: member(team.formation.leaderCardId),
  };
  if (
    assignment.memberInstanceIds.length !== 5 ||
    assignment.snapshotInstanceIds.length !== 5 ||
    validateAssignment(assignment, inventory).length ||
    new Set(team.formation.memberCardIds.map((cardId) => data.members[String(cardId)]!.characterId)).size !== 5
  )
    throw new TypeError("team-workspace-invalid-assignment");
  return { inventory, assignment };
}
export function removeSavedTeam(workspace: TeamWorkspaceV1, teamId: string): TeamWorkspaceV1 {
  return checkTeamWorkspace(
    { ...workspace, teams: workspace.teams.filter((team) => team.id !== teamId) },
    workspace.server,
  );
}
export const exportTeamWorkspace = (workspace: TeamWorkspaceV1) =>
  JSON.stringify(checkTeamWorkspace(workspace, workspace.server), null, 2);
export function importTeamWorkspace(text: string, server: string): TeamWorkspaceV1 {
  if (new TextEncoder().encode(text).byteLength > MAX_WORKSPACE_BYTES)
    throw new RangeError("team-workspace-byte-limit");
  return checkTeamWorkspace(JSON.parse(text), server);
}
