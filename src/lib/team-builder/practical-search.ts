/*!
 * Staged seed/neighbour/screen/refinement structure adapted from
 * stonesver/otonote@8eb58fe4, site/src/lib/practical-optimizer.mjs.
 *
 * MIT License
 * Copyright (c) 2026 OtoNote contributors
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { Candidate, EvidenceGap, MemberOption, Objective, PlayMode, SearchConstraints,
  SnapshotOption, TeamAssignment } from "./contracts.ts";
import { createAssignmentCursor } from "./assignment-cursor.ts";
import { compileSearchRequirements, candidateMeetsBonusFloors } from "./search-requirements.ts";

export interface PracticalDirection {
  id: string;
  /** Diversity/priority features supplied by the native owner; never final scores. */
  members: Readonly<Record<string, number>>;
  snapshots: Readonly<Record<string, number>>;
  pairs?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  leaders?: Readonly<Record<string, number>>;
}
export interface PracticalTask { key: string; songKey: string; mode: PlayMode; objective: Objective }
export interface PracticalSearchInput {
  contextFingerprint: string;
  members: readonly MemberOption[];
  snapshots: readonly SnapshotOption[];
  constraints: SearchConstraints;
  tasks: readonly PracticalTask[];
  directions: readonly PracticalDirection[];
  baseline?: TeamAssignment;
  finalistLimit?: number;
}
export interface PracticalControls {
  cancelled?: () => boolean;
  expired?: () => boolean;
  yield?: () => Promise<void>;
  progress?: (value: { phase: "seeds" | "neighbours" | "screen" | "final";
    taskKey?: string; completed: number; total: number }) => void;
}
export interface PracticalEvaluators {
  /** Native-owner task-dependent whole-team feature, not a score or upper bound. */
  priority?: (assignment: TeamAssignment, task: PracticalTask, controls: PracticalControls) => Promise<number | null>;
  /** Optional native-owner balanced ten-order screen. Its value never escapes as a Candidate. */
  screen?: (assignment: TeamAssignment, task: PracticalTask, controls: PracticalControls) =>
    Promise<{ orders: 10; value: number | null }>;
  full: (assignment: TeamAssignment, task: PracticalTask, controls: PracticalControls) =>
    Promise<{ contextFingerprint: string; orders: 120; complete: boolean; candidate: Candidate }>;
}
export interface PracticalTaskResult {
  task: PracticalTask;
  status: "pending" | "complete" | "unavailable";
  baseline: Candidate | null;
  candidates: Candidate[];
  gaps: EvidenceGap[];
}
export interface PracticalSearchResult {
  method: "multidirection-one-neighbour-round-native-refinement";
  optimality: "heuristic-selected-candidates";
  contextFingerprint: string;
  status: "complete" | "unavailable" | "cancelled" | "budget-limited";
  plan: { localRounds: 1; screenOrders: 10 | null; finalOrders: 120; finalistLimit: number };
  tasks: PracticalTaskResult[];
  generated: number;
  neighbourChecks: number;
  screened: number;
  fullyEvaluated: number;
}
const key = (assignment: TeamAssignment) => JSON.stringify([assignment.memberInstanceIds,
  assignment.snapshotInstanceIds, assignment.leaderInstanceId]);
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Stone's staged structure, with Haneoka legality and native callbacks. No
 * additive native-power assumption, proxy result or full-search proof is used. */
export async function refinePracticalCandidates(input: PracticalSearchInput, evaluators: PracticalEvaluators,
  controls: PracticalControls = {}): Promise<PracticalSearchResult> {
  const request = structuredClone(input), limit = request.finalistLimit ?? 6;
  if (!/^[a-f0-9]{64}$/u.test(request.contextFingerprint) || request.constraints.teamSize !== 5 ||
    !request.tasks.length || request.tasks.length > 1000 || !request.directions.length || request.directions.length > 16 ||
    !Number.isInteger(limit) || limit < 2 || limit > 24 || new Set(request.tasks.map(task => task.key)).size !== request.tasks.length ||
    request.tasks.some(task => !task.key || !task.songKey || !["normal", "gekiso", "multi", "battle"].includes(task.mode) ||
      !["score", "ss-ratio", "ss-surplus", "event-points", "event-items", "base-score"].includes(task.objective)))
    throw new RangeError("practical-search-input");
  if (new Set(request.directions.map(direction => direction.id)).size !== request.directions.length ||
    request.tasks.some(task => request.constraints.excludedSongKeys.includes(task.songKey) ||
      (request.constraints.lockedSongKey && request.constraints.lockedSongKey !== task.songKey)))
    throw new RangeError("practical-search-domain");
  const requirements = compileSearchRequirements(request);
  const members = request.members.filter(member => !request.constraints.excludedMemberIds.includes(member.instanceId));
  const snapshots = request.snapshots.filter(photo => photo.allowedCharacterIds !== undefined &&
    !request.constraints.excludedSnapshotIds.includes(photo.instanceId));
  const memberMap = new Map(members.map(member => [member.instanceId, member]));
  const photoMap = new Map(snapshots.map(photo => [photo.instanceId, photo]));
  const legal = (assignment: TeamAssignment) => {
    const ids = assignment.memberInstanceIds, photos = assignment.snapshotInstanceIds;
    return ids.length === 5 && photos.length === 5 && new Set(ids).size === 5 && ids.every(id => memberMap.has(id)) &&
      new Set(ids.map(id => memberMap.get(id)!.characterId)).size === 5 && ids.includes(assignment.leaderInstanceId) &&
      (!requirements.leader || requirements.leader === assignment.leaderInstanceId) &&
      requirements.requiredMemberIds.every(id => ids.includes(id)) &&
      requirements.requiredSnapshotIds.every(id => photos.includes(id)) &&
      new Set(photos.filter(id => id !== null)).size === photos.filter(id => id !== null).length &&
      photos.every((photoId, slot) => (photoId === null || photoMap.get(photoId)?.allowedCharacterIds?.includes(memberMap.get(ids[slot]!)!.characterId)) &&
        (!requirements.bindings.has(ids[slot]!) || requirements.bindings.get(ids[slot]!) === photoId));
  };
  const output: PracticalSearchResult = { method: "multidirection-one-neighbour-round-native-refinement",
    optimality: "heuristic-selected-candidates", contextFingerprint: request.contextFingerprint, status: "complete",
    plan: { localRounds: 1, screenOrders: evaluators.screen ? 10 : null, finalOrders: 120, finalistLimit: limit },
    tasks: request.tasks.map(task => ({ task, status: "pending", baseline: null, candidates: [], gaps: [] })),
    generated: 0, neighbourChecks: 0, screened: 0, fullyEvaluated: 0 };
  const stopped = () => {
    if (controls.cancelled?.()) output.status = "cancelled";
    else if (controls.expired?.()) output.status = "budget-limited";
    return output.status !== "complete";
  };
  const yieldWork = controls.yield ?? pause;
  const prepared = new Map<string, { assignment: TeamAssignment; origins: Set<string>; byDirection: Map<string, number> }>();
  const add = (assignment: TeamAssignment, origin: string, feature: number) => {
    if (!legal(assignment)) return;
    const identity = key(assignment), old = prepared.get(identity);
    if (old) { old.origins.add(origin); old.byDirection.set(origin, Math.max(old.byDirection.get(origin) ?? -Infinity, feature)); }
    else prepared.set(identity, { assignment: structuredClone(assignment), origins: new Set([origin]), byDirection: new Map([[origin, feature]]) });
  };
  const featureOf = (direction: PracticalDirection, assignment: TeamAssignment) => assignment.memberInstanceIds.reduce((sum, id) => sum + (direction.members[id] ?? 0), 0) +
    assignment.snapshotInstanceIds.reduce((sum, id, slot) => sum + (id === null ? 0 : (direction.snapshots[id] ?? 0) +
      (direction.pairs?.[assignment.memberInstanceIds[slot]!]?.[id] ?? 0)), 0) + (direction.leaders?.[assignment.leaderInstanceId] ?? 0);
  const seeds: { assignment: TeamAssignment; direction: PracticalDirection }[] = [];
  if (request.baseline && legal(request.baseline)) add(request.baseline, "current", Infinity);
  for (const [directionIndex, direction] of request.directions.entries()) {
    if (stopped()) return output;
    if (!direction.id || Object.values(direction.members).some(value => !Number.isFinite(value)) ||
      Object.values(direction.snapshots).some(value => !Number.isFinite(value)) ||
      Object.values(direction.leaders ?? {}).some(value => !Number.isFinite(value)) ||
      Object.values(direction.pairs ?? {}).some(row => Object.values(row).some(value => !Number.isFinite(value)))) throw new RangeError("practical-direction");
    const ordered = [...members].sort((a, b) => (direction.members[b.instanceId] ?? 0) - (direction.members[a.instanceId] ?? 0) ||
      a.instanceId.localeCompare(b.instanceId, "en"));
    const selected = requirements.requiredMemberIds.map(id => memberMap.get(id)!);
    for (const member of ordered) {
      if (selected.length === 5) break;
      if (!selected.some(value => value.characterId === member.characterId)) selected.push(member);
    }
    if (selected.length === 5) {
      const orderedPhotos = [...snapshots].sort((a, b) => (direction.snapshots[b.instanceId] ?? 0) - (direction.snapshots[a.instanceId] ?? 0) ||
        a.instanceId.localeCompare(b.instanceId, "en"));
      const desired = [...requirements.requiredSnapshotIds];
      const emptySlots = [...requirements.bindings.values()].filter(id => id === null).length;
      for (const photo of orderedPhotos) if (desired.length < 5 - emptySlots && !desired.includes(photo.instanceId)) desired.push(photo.instanceId);
      let assignment: TeamAssignment | undefined;
      // Relax only heuristic-added photo requirements when the feature seed's
      // preferred set cannot be equipped. User requirements always remain.
      while (!assignment && desired.length >= requirements.requiredSnapshotIds.length) {
        const cursor = createAssignmentCursor({ members: selected, snapshots: orderedPhotos, songKeys: ["seed"],
          constraints: { ...request.constraints, lockedMemberIds: selected.map(member => member.instanceId), lockedSnapshotIds: desired } });
        while (!stopped()) { const step = cursor.take(); if (step.kind === "done") break;
          if (step.kind === "leaf") { assignment = step.assignment; break; } await yieldWork(); }
        if (assignment || desired.length === requirements.requiredSnapshotIds.length) break;
        desired.pop();
      }
      if (assignment) {
        const feature = (value: TeamAssignment) => featureOf(direction, value);
        add(assignment, direction.id, feature(assignment)); seeds.push({ assignment, direction });
        for (const leaderInstanceId of assignment.memberInstanceIds) {
          const variant = { ...assignment, leaderInstanceId };
          add(variant, direction.id, feature(variant));
        }
      }
    }
    controls.progress?.({ phase: "seeds", completed: directionIndex + 1, total: request.directions.length }); await yieldWork();
  }
  const totalNeighbours = seeds.length * (5 * (members.length - 1 + snapshots.length) + 15);
  for (const seed of seeds) {
    const winners = new Map<string, { assignment: TeamAssignment; feature: number }>();
    const consider = async (kind: string, assignment: TeamAssignment) => {
      output.neighbourChecks++;
      if (legal(assignment) && key(assignment) !== key(seed.assignment)) {
        const feature = featureOf(seed.direction, assignment);
        if (!winners.has(kind) || winners.get(kind)!.feature < feature) winners.set(kind, { assignment, feature });
      }
      if (output.neighbourChecks % 50 === 0) { controls.progress?.({ phase: "neighbours", completed: output.neighbourChecks, total: totalNeighbours }); await yieldWork(); }
    };
    for (let slot = 0; slot < 5; slot++) {
      for (const member of members) { if (stopped()) return output;
        if (member.instanceId === seed.assignment.memberInstanceIds[slot]) continue;
        const assignment = structuredClone(seed.assignment), oldId = assignment.memberInstanceIds[slot]!;
        assignment.memberInstanceIds[slot] = member.instanceId;
        if (assignment.leaderInstanceId === oldId) assignment.leaderInstanceId = member.instanceId;
        await consider("member", assignment); }
      for (const photoId of [null, ...snapshots.map(photo => photo.instanceId)]) { if (stopped()) return output;
        if (photoId === seed.assignment.snapshotInstanceIds[slot]) continue;
        const assignment = structuredClone(seed.assignment); assignment.snapshotInstanceIds[slot] = photoId;
        await consider("photo", assignment); }
    }
    for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) { const assignment = structuredClone(seed.assignment);
      [assignment.snapshotInstanceIds[a], assignment.snapshotInstanceIds[b]] = [assignment.snapshotInstanceIds[b]!, assignment.snapshotInstanceIds[a]!]; await consider("pairing", assignment); }
    for (const leader of seed.assignment.memberInstanceIds) { const assignment = structuredClone(seed.assignment); assignment.leaderInstanceId = leader; await consider("leader", assignment); }
    winners.forEach(value => add(value.assignment, seed.direction.id, value.feature));
  }
  output.generated = prepared.size;
  if (stopped()) return output;
  if (!prepared.size) {
    const characters = new Set(members.map(member => member.characterId)).size;
    output.status = "unavailable";
    for (const row of output.tasks) {
      row.status = "unavailable";
      row.gaps.push({ code: characters < 5 ? "practical-five-distinct-characters-required" : "practical-no-legal-seed",
        source: characters < 5 ? "available:" + characters : row.task.key });
    }
    return output;
  }
  type PreparedCandidate = { assignment: TeamAssignment; origins: Set<string>; byDirection: Map<string, number> };
  const plans: { row: PracticalTaskResult; finalists: { candidate: PreparedCandidate; value: number }[]; completed: number }[] = [];
  const evaluateNext = async (plan: typeof plans[number]) => {
    const { row, finalists } = plan, finalist = finalists[plan.completed]!;
    const evaluated = await evaluators.full(finalist.candidate.assignment, row.task, controls);
    if (evaluated.contextFingerprint !== request.contextFingerprint || evaluated.orders !== 120 ||
      evaluated.candidate.songKey !== row.task.songKey || key(evaluated.candidate.assignment) !== key(finalist.candidate.assignment))
      throw new RangeError("practical-native-context");
    if (!evaluated.complete && stopped()) return;
    plan.completed++;
    if (!evaluated.complete) row.gaps.push({ code: "practical-native-incomplete", source: row.task.key });
    else {
      const candidate = evaluated.candidate, metric = candidate.metrics[row.task.objective], floors = candidateMeetsBonusFloors(candidate, request.constraints);
      row.gaps.push(...metric.gaps, ...floors.gaps); output.fullyEvaluated++;
      if (metric.value !== null && Number.isFinite(metric.value) && metric.status !== "unavailable" && !metric.gaps.length && floors.eligible) {
        const completed = structuredClone(candidate); row.candidates.push(completed);
        if (finalist.candidate.origins.has("current")) row.baseline = completed;
      }
    }
    row.candidates.sort((a, b) => b.metrics[row.task.objective].value! - a.metrics[row.task.objective].value! || key(a.assignment).localeCompare(key(b.assignment), "en"));
    if (plan.completed === finalists.length) {
      row.status = row.candidates.length ? "complete" : "unavailable";
      if (!row.candidates.length && !row.gaps.length)
        row.gaps.push({ code: "practical-no-eligible-native-candidate", source: row.task.key });
    }
    controls.progress?.({ phase: "final", taskKey: row.task.key, completed: plan.completed, total: finalists.length });
    await yieldWork();
  };
  for (const row of output.tasks) {
    if (stopped()) return output;
    const screened: { candidate: typeof prepared extends Map<string, infer T> ? T : never; value: number }[] = [];
    for (const candidate of prepared.values()) {
      if (stopped()) return output;
      // Direction units are compared only within that direction below.
      // With no usable whole-team priority, global ordering is a stable tie.
      let value = 0;
      if (evaluators.priority) {
        const priority = await evaluators.priority(candidate.assignment, row.task, controls);
        if (priority !== null && Number.isFinite(priority)) value = priority;
      }
      if (evaluators.screen) { const score = await evaluators.screen(candidate.assignment, row.task, controls);
        if (score.orders !== 10) throw new RangeError("practical-screen-orders");
        value = score.value !== null && Number.isFinite(score.value) ? score.value : -Infinity; }
      screened.push({ candidate, value }); output.screened++;
      controls.progress?.({ phase: "screen", taskKey: row.task.key, completed: screened.length, total: prepared.size }); await yieldWork();
    }
    screened.sort((a, b) => b.value - a.value || key(a.candidate.assignment).localeCompare(key(b.candidate.assignment), "en"));
    const finalists: typeof screened[number][] = [], seen = new Set<string>();
    const choose = (value: typeof screened[number] | undefined) => { if (!value || finalists.length >= limit) return;
      const identity = key(value.candidate.assignment); if (!seen.has(identity)) { seen.add(identity); finalists.push(value); } };
    choose(screened.find(value => value.candidate.origins.has("current"))); choose(screened[0]);
    for (const direction of request.directions) {
      const representatives = screened.filter(value => value.candidate.origins.has(direction.id));
      if (!evaluators.screen) representatives.sort((a, b) => (b.candidate.byDirection.get(direction.id) ?? -Infinity) -
        (a.candidate.byDirection.get(direction.id) ?? -Infinity) || key(a.candidate.assignment).localeCompare(key(b.candidate.assignment), "en"));
      choose(representatives[0]);
    }
    screened.forEach(choose);
    const plan = { row, finalists, completed: 0 };
    plans.push(plan);
    // Establish one complete native comparison per task before refining the
    // next formation. A limited run retains real candidates and pending tasks.
    if (finalists.length) await evaluateNext(plan);
    else {
      row.status = "unavailable";
      row.gaps.push({ code: "practical-no-eligible-native-candidate", source: row.task.key });
    }
  }
  for (let round = 1; round < limit; round++) for (const plan of plans) {
    if (plan.completed >= plan.finalists.length) continue;
    if (stopped()) return output;
    await evaluateNext(plan);
  }
  stopped();
  if (output.status === "complete" && !output.tasks.some(row => row.candidates.length)) output.status = "unavailable";
  return output;
}
