import { createMemberCompletionCheck } from "./member-completion.ts";
import type { MemberOption, SearchConstraints, SnapshotOption, TeamAssignment } from "./contracts.ts";
import { compileSearchRequirements } from "./search-requirements.ts";
import { canMatchMandatorySlots } from "./mandatory-slot-matching.ts";

type Members = readonly Pick<MemberOption, "instanceId" | "characterId">[];
type Photos = readonly Pick<SnapshotOption, "instanceId" | "allowedCharacterIds">[];
type Task = { kind: "members"; members: number[]; start: number } |
  { kind: "photos"; members: number[]; photos: (number | null)[] } |
  { kind: "leaf"; members: number[]; photos: (number | null)[]; leader: number; song: number };
export interface AssignmentCursorState {
  schema: "haneoka-assignment-cursor-v1";
  /** Worker fingerprint includes every native closure/source and user constraint. */
  fingerprint: string;
  completedLeaves: number;
  work: number;
  tasks: Task[];
}
export interface AssignmentCursorDomain {
  members: Members;
  snapshots: Photos;
  songKeys: readonly string[];
  constraints: SearchConstraints;
}
export type AssignmentCursorStep = { kind: "yield" } | { kind: "done" } |
  { kind: "leaf"; assignment: TeamAssignment; songKey: string };
const whole = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const fingerprintValid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

/** Ordered exhaustive legal assignment cursor. A leased leaf remains at the
 * frontier until commit, so a cancelled native evaluation is retried on resume.
 * No native score/upper bound or incomplete evaluation is stored here. */
export function createAssignmentCursor(domain: AssignmentCursorDomain, restore?: {
  fingerprint: string; state: AssignmentCursorState;
}) {
  const constraints = structuredClone(domain.constraints);
  const members = domain.members.filter(value => !constraints.excludedMemberIds.includes(value.instanceId))
    .map(value => ({ instanceId: value.instanceId, characterId: value.characterId }));
  const photos = domain.snapshots.filter(value => value.allowedCharacterIds !== undefined &&
    !constraints.excludedSnapshotIds.includes(value.instanceId)).map(value => ({
      instanceId: value.instanceId, allowedCharacterIds: [...value.allowedCharacterIds!],
    }));
  const songs = [...domain.songKeys];
  if (!whole(domain.constraints.teamSize, 5) || domain.constraints.teamSize < 1 ||
    members.length > 2000 || photos.length > 2000 || songs.length > 1000 ||
    new Set(members.map(value => value.instanceId)).size !== members.length ||
    new Set(photos.map(value => value.instanceId)).size !== photos.length ||
    new Set(songs).size !== songs.length || songs.some(value => !value)) throw new RangeError("assignment-cursor-domain");
  const requirements = compileSearchRequirements({ members, snapshots: photos, constraints });
  const memberIndex = new Map(members.map((value, index) => [value.instanceId, index]));
  const requiredMembers = requirements.requiredMemberIds.map(value => memberIndex.get(value)!);
  const requiredPhotos = new Set(requirements.requiredSnapshotIds);
  const requiredPhotoOptions = new Map(photos.filter(photo => requiredPhotos.has(photo.instanceId))
    .map(photo => [photo.instanceId, new Set(photo.allowedCharacterIds)]));
  const teamSize = domain.constraints.teamSize;
  const completion = createMemberCompletionCheck(members);
  let tasks: Task[] = songs.length ? [{ kind: "members", members: [], start: 0 }] : [];
  let completedLeaves = 0, work = 0;
  let boundFingerprint = restore?.fingerprint;
  const selectedMembersValid = (values: unknown): values is number[] => Array.isArray(values) &&
    values.length <= teamSize && values.every((value, index) => whole(value, members.length - 1) &&
      (index === 0 || value > values[index - 1]!)) &&
    new Set(values.map(value => members[value]!.characterId)).size === values.length;
  const selectedPhotosValid = (task: { members: number[]; photos: unknown }): task is { members: number[]; photos: (number | null)[] } => {
    if (!Array.isArray(task.photos) || task.photos.length > teamSize || task.photos.some((value: unknown) =>
      value !== null && !whole(value, photos.length - 1))) return false;
    const photoIndices = task.photos as (number | null)[];
    const ids = photoIndices.map(value => value === null ? null : photos[value]!.instanceId);
    if (new Set(ids.filter(value => value !== null)).size !== ids.filter(value => value !== null).length) return false;
    return ids.every((photoId, slot) => {
      const member = members[task.members[slot]!]!;
      if (requirements.bindings.has(member.instanceId) && requirements.bindings.get(member.instanceId) !== photoId) return false;
      if (photoId === null) return true;
      return (!requirements.photoOwners.has(photoId) || requirements.photoOwners.get(photoId) === member.instanceId) &&
        photos[photoIndices[slot]!]!.allowedCharacterIds!.includes(member.characterId);
    });
  };
  if (restore) {
    const state = restore.state;
    if (!fingerprintValid(restore.fingerprint) || !state || state.schema !== "haneoka-assignment-cursor-v1" ||
      state.fingerprint !== restore.fingerprint || !whole(state.completedLeaves) || !whole(state.work) ||
      !Array.isArray(state.tasks) || state.tasks.length > 20001) throw new RangeError("assignment-cursor-state");
    for (const task of state.tasks) {
      if (!task || !selectedMembersValid(task.members)) throw new RangeError("assignment-cursor-task");
      if (task.kind === "members") {
        if (!whole(task.start, members.length) || task.start !== ((task.members.at(-1) ?? -1) + 1))
          throw new RangeError("assignment-cursor-member-task");
      } else if (task.kind === "photos" || task.kind === "leaf") {
        if (task.members.length !== teamSize || !requiredMembers.every(value => task.members.includes(value)) ||
          !selectedPhotosValid(task)) throw new RangeError("assignment-cursor-photo-task");
        if (task.kind === "leaf" && (task.photos.length !== teamSize ||
          !whole(task.leader, teamSize - 1) || !whole(task.song, songs.length - 1) ||
          (requirements.leader !== null && members[task.members[task.leader]!]!.instanceId !== requirements.leader) ||
          !requirements.requiredSnapshotIds.every(id => task.photos.some(index => index !== null && photos[index]!.instanceId === id))))
          throw new RangeError("assignment-cursor-leaf-task");
      } else throw new RangeError("assignment-cursor-task-kind");
    }
    tasks = structuredClone(state.tasks);
    completedLeaves = state.completedLeaves; work = state.work;
  }
  return {
    take(maxWork = 64): AssignmentCursorStep {
      if (!whole(maxWork, 4096) || maxWork < 1) throw new RangeError("assignment-cursor-slice");
      let sliceWork = 0;
      while (tasks.length) {
        const task = tasks.at(-1)!;
        if (task.kind === "leaf") return { kind: "leaf", songKey: songs[task.song]!, assignment: {
          memberInstanceIds: task.members.map(index => members[index]!.instanceId),
          snapshotInstanceIds: task.photos.map(index => index === null ? null : photos[index]!.instanceId),
          leaderInstanceId: members[task.members[task.leader]!]!.instanceId,
        } };
        if (sliceWork++ >= maxWork) return { kind: "yield" };
        tasks.pop(); work++;
        if (task.kind === "members") {
          const remaining = teamSize - task.members.length;
          const missing = requiredMembers.filter(index => !task.members.includes(index));
          if (missing.length > remaining || missing.some(index => index < task.start)) continue;
          if (!completion.canComplete(task.start, task.members, remaining)) continue;
          if (!remaining) { tasks.push({ kind: "photos", members: task.members, photos: [] }); continue; }
          for (let index = members.length - remaining; index >= task.start; index--) {
            if (task.members.some(value => members[value]!.characterId === members[index]!.characterId)) continue;
            if (missing.length === remaining && !missing.includes(index)) continue;
            tasks.push({ kind: "members", members: [...task.members, index], start: index + 1 });
          }
        } else {
          const slot = task.photos.length;
          const used = new Set(task.photos.flatMap(index => index === null ? [] : [photos[index]!.instanceId]));
          const missing = requirements.requiredSnapshotIds.filter(id => !used.has(id));
          const remaining = teamSize - slot;
          if (missing.length > remaining) continue;
          if (!remaining) {
            const leader = requirements.leader === null ? 0 : task.members.findIndex(index =>
              members[index]!.instanceId === requirements.leader);
            tasks.push({ kind: "leaf", members: task.members, photos: task.photos, leader, song: 0 }); continue;
          }
          if (missing.length && !canMatchMandatorySlots(missing.map(id => {
            const allowed = requiredPhotoOptions.get(id)!;
            let mask = 0;
            for (let offset = 0; offset < remaining; offset++) {
              const candidate = members[task.members[slot + offset]!]!;
              if (allowed.has(candidate.characterId) &&
                (!requirements.bindings.has(candidate.instanceId) || requirements.bindings.get(candidate.instanceId) === id) &&
                (!requirements.photoOwners.has(id) || requirements.photoOwners.get(id) === candidate.instanceId))
                mask |= 1 << offset;
            }
            return mask;
          }), remaining)) continue;
          const member = members[task.members[slot]!]!;
          const fixed = requirements.bindings.has(member.instanceId), binding = requirements.bindings.get(member.instanceId);
          for (let index = photos.length - 1; index >= 0; index--) {
            const photo = photos[index]!;
            if (used.has(photo.instanceId) || (missing.length === remaining && !requiredPhotos.has(photo.instanceId)) ||
              (fixed && binding !== photo.instanceId) ||
              (requirements.photoOwners.has(photo.instanceId) && requirements.photoOwners.get(photo.instanceId) !== member.instanceId) ||
              !photo.allowedCharacterIds!.includes(member.characterId)) continue;
            tasks.push({ kind: "photos", members: task.members, photos: [...task.photos, index] });
          }
          if (missing.length < remaining && (!fixed || binding === null))
            tasks.push({ kind: "photos", members: task.members, photos: [...task.photos, null] });
        }
      }
      return { kind: "done" };
    },
    /** Commit only after a whole native leaf was offered to its result collectors. */
    commit() {
      const task = tasks.at(-1);
      if (!task || task.kind !== "leaf") throw new RangeError("assignment-cursor-no-leaf");
      tasks.pop(); completedLeaves++;
      if (task.song + 1 < songs.length) tasks.push({ ...task, song: task.song + 1 });
      else if (requirements.leader === null && task.leader + 1 < teamSize)
        tasks.push({ ...task, leader: task.leader + 1, song: 0 });
    },
    snapshot(fingerprint: string): AssignmentCursorState {
      if (!fingerprintValid(fingerprint) || (boundFingerprint !== undefined && boundFingerprint !== fingerprint))
        throw new RangeError("assignment-cursor-fingerprint");
      boundFingerprint = fingerprint;
      return { schema: "haneoka-assignment-cursor-v1", fingerprint, completedLeaves, work, tasks: structuredClone(tasks) };
    },
    stats() { return { completedLeaves, work, pendingTasks: tasks.length, exhausted: tasks.length === 0 }; },
  };
}
