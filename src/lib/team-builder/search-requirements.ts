import type { Candidate, EvidenceGap, MemberOption, SearchConstraints, SnapshotOption } from "./contracts.ts";

export interface SearchRequirementDomain {
  members: readonly Pick<MemberOption, "instanceId" | "characterId">[];
  snapshots: readonly Pick<SnapshotOption, "instanceId" | "allowedCharacterIds">[];
  constraints: SearchConstraints;
}
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const bp = (value: unknown): value is number => typeof value === "number" &&
  Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff;
const nativeBP = (value: unknown): value is number => typeof value === "number" &&
  Number.isSafeInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;

/** Resolve v0.3 requirements against the actual prepared inventory. Required
 * leader/bindings enroll their cards; physical null bindings remain empty. */
export function compileSearchRequirements(domain: SearchRequirementDomain) {
  const { constraints } = domain;
  const members = new Map(domain.members.map(value => [value.instanceId, value]));
  const photos = new Map(domain.snapshots.map(value => [value.instanceId, value]));
  const requiredMembers = new Set(constraints.lockedMemberIds);
  const requiredPhotos = new Set(constraints.lockedSnapshotIds);
  const bindings = new Map<string, string | null>();
  const photoOwners = new Map<string, string>();
  const leader = constraints.requiredLeaderId ?? null;
  if (leader !== null) {
    if (!id(leader)) throw new RangeError("required-leader-id");
    requiredMembers.add(leader);
  }
  if (constraints.requiredBindings !== undefined && (!Array.isArray(constraints.requiredBindings) ||
    constraints.requiredBindings.length > constraints.teamSize)) throw new RangeError("required-bindings");
  for (const binding of constraints.requiredBindings ?? []) {
    if (!binding || !id(binding.memberInstanceId) ||
      (binding.snapshotInstanceId !== null && !id(binding.snapshotInstanceId)) ||
      bindings.has(binding.memberInstanceId)) throw new RangeError("required-binding-conflict");
    bindings.set(binding.memberInstanceId, binding.snapshotInstanceId);
    requiredMembers.add(binding.memberInstanceId);
    if (binding.snapshotInstanceId !== null) {
      if (photoOwners.has(binding.snapshotInstanceId)) throw new RangeError("required-binding-photo-conflict");
      photoOwners.set(binding.snapshotInstanceId, binding.memberInstanceId);
      requiredPhotos.add(binding.snapshotInstanceId);
    }
  }
  if (requiredMembers.size > constraints.teamSize || requiredPhotos.size > constraints.teamSize ||
    requiredPhotos.size + [...bindings.values()].filter(value => value === null).length > constraints.teamSize)
    throw new RangeError("required-assignment-count");
  const characters = new Set<number>();
  for (const memberId of requiredMembers) {
    const member = members.get(memberId);
    if (!member || constraints.excludedMemberIds.includes(memberId))
      throw new RangeError(memberId === leader ? "invalid-required-leader" : "invalid-required-member");
    if (characters.has(member.characterId)) throw new RangeError("locked-character-conflict");
    characters.add(member.characterId);
  }
  for (const photoId of requiredPhotos)
    if (!photos.has(photoId) || constraints.excludedSnapshotIds.includes(photoId))
      throw new RangeError("invalid-required-snapshot");
  for (const [memberId, photoId] of bindings) {
    if (photoId === null) continue;
    const allowed = photos.get(photoId)!.allowedCharacterIds;
    if (!allowed) throw new RangeError("required-binding-equip-unresolved");
    if (!allowed.includes(members.get(memberId)!.characterId)) throw new RangeError("required-binding-equip-invalid");
  }
  const floors = constraints.bonusFloors;
  if (floors !== undefined && (!floors || typeof floors !== "object" || Array.isArray(floors) ||
    Object.entries(floors).some(([key, value]) => !["eventPointsBP", "eventItemsBP"].includes(key) ||
      (value !== undefined && !bp(value))))) throw new RangeError("bonus-floor-input");
  if (constraints.resultDistinctCardSets !== undefined &&
    (!Number.isSafeInteger(constraints.resultDistinctCardSets) || constraints.resultDistinctCardSets < 1 ||
      constraints.resultDistinctCardSets > 15)) throw new RangeError("distinct-card-set-count");
  return { requiredMemberIds: [...requiredMembers], requiredSnapshotIds: [...requiredPhotos],
    leader, bindings, photoOwners };
}

/** Formation BP floors precede rank/boost/reward selection. An unknown active
 * axis stays a gap; zero is an active floor rather than an omitted value. */
export function candidateMeetsBonusFloors(candidate: Candidate, constraints: SearchConstraints): {
  eligible: boolean; gaps: EvidenceGap[];
} {
  const floors = constraints.bonusFloors;
  const active = ([['eventPointsBP', 'points'], ['eventItemsBP', 'items']] as const)
    .filter(([field]) => floors?.[field] !== undefined);
  if (!active.length) return { eligible: true, gaps: [] };
  const bonus = candidate.eventBonusBP;
  const gaps = [...(bonus?.gaps ?? [])];
  let eligible = true;
  for (const [field, axis] of active) {
    const value = bonus?.[axis];
    if (!nativeBP(value)) gaps.push({ code: "native-formation-bonus-floor-unresolved", source: axis });
    else if (value < floors![field]!) eligible = false;
  }
  return { eligible: eligible && !gaps.length, gaps };
}
