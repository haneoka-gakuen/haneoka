import type {
  Candidate,
  EvidenceGap,
  OptimizationInput,
  SearchProgress,
  SearchResult,
  TeamAssignment,
} from "./contracts.ts";
import { prepareSong, type PreparedSong } from "./song-metrics.ts";
import { createAssignmentEvaluator } from "./solver/evaluate.ts";
import { createSearchCollectors } from "./search-collectors.ts";
import { validateSearchBudget } from "./solver/search-budget.ts";
import { compileSearchRequirements, candidateMeetsBonusFloors } from "./search-requirements.ts";
import { createAssignmentCursor } from "./assignment-cursor.ts";
import type { SearchResumeState } from "./search-resume.ts";

export interface SearchHooks {
  /** Prepared in the worker for native formation conditions; reads selected slots only. */
  evaluate?: (
    assignment: TeamAssignment,
    song: PreparedSong,
    controls: SearchEvaluationControls,
  ) => Candidate | Promise<Candidate>;
  cancelled?: () => boolean;
  progress?: (value: SearchProgress) => void;
  /** Yield to the worker event queue, so a cancel message can be delivered. */
  yield?: () => Promise<void>;
  now?: () => number;
  /** Full native Worker request fingerprint; enables serializable unfinished work. */
  fingerprint?: string;
  resumeState?: SearchResumeState;
  onResumeState?: (state: SearchResumeState | undefined) => void;
}
export interface SearchEvaluationControls {
  cancelled: () => boolean;
  yield: () => Promise<void>;
  expired: () => boolean;
  progress: () => void;
}
const defaultYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
export function dominates(left: readonly number[], right: readonly number[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value >= right[index]!) &&
    left.some((value, index) => value > right[index]!)
  );
}
export function validateOptimizationInput(input: OptimizationInput): void {
  if (input.skillOrderCriterion !== undefined && !["nominal-mean", "worst-ap"].includes(input.skillOrderCriterion))
    throw new RangeError("skill-order-criterion");
  if (input.skillOrderCriterion === "worst-ap" && input.constraints.justRate !== 0)
    throw new RangeError("worst-ap-requires-perfect-timing");
  if (input.scoreDomain !== undefined && !["personal-solo", "personal-live"].includes(input.scoreDomain))
    throw new RangeError("score-domain");
  if (input.scoreDomain === "personal-live" && input.evaluation.mode !== "gekiso")
    throw new RangeError("native-gekiso-context-domain");
  if (input.server !== input.evaluation.server || input.releaseId !== input.evaluation.releaseId)
    throw new RangeError("different-evaluation-release");
  if (
    !Number.isSafeInteger(input.constraints.teamSize) ||
    input.constraints.teamSize < 1 ||
    input.constraints.teamSize > 5
  )
    throw new RangeError("team-size");
  if (!Number.isFinite(input.constraints.justRate) || input.constraints.justRate < 0 || input.constraints.justRate > 1)
    throw new RangeError("just-rate");
  validateSearchBudget(input.budget);
  if (
    !input.objectives.length ||
    new Set(input.objectives).size !== input.objectives.length ||
    input.objectives.some(
      (value) => !["score", "ss-ratio", "ss-surplus", "event-points", "event-items", "base-score"].includes(value),
    )
  )
    throw new RangeError("objectives");
  if (
    input.members.length > 2000 ||
    input.snapshots.length > 2000 ||
    input.songs.length > 1000 ||
    input.songs.some((song) => song.events.length > 25000)
  )
    throw new RangeError("solver-input-size");
  const ids = [
    ...input.members.map((option) => option.instanceId),
    ...input.snapshots.map((option) => option.instanceId),
  ];
  if (new Set(ids).size !== ids.length || ids.some((id) => !id)) throw new RangeError("duplicate-instance");
  // Native ownership has one record per card within each kind. An alternate
  // instance ID cannot make a second owned copy or a second search option.
  if (new Set(input.members.map((member) => member.cardId)).size !== input.members.length)
    throw new RangeError("duplicate-member-card");
  if (new Set(input.snapshots.map((snapshot) => snapshot.cardId)).size !== input.snapshots.length)
    throw new RangeError("duplicate-snapshot-card");
  if (new Set(input.songs.map((song) => song.key)).size !== input.songs.length) throw new RangeError("duplicate-song");
  const constraint = input.constraints;
  if (
    constraint.lockedSongKey &&
    (constraint.excludedSongKeys.includes(constraint.lockedSongKey) ||
      !input.songs.some((song) => song.key === constraint.lockedSongKey))
  )
    throw new RangeError("invalid-locked-song");
  if (
    new Set(constraint.lockedMemberIds).size !== constraint.lockedMemberIds.length ||
    new Set(constraint.lockedSnapshotIds).size !== constraint.lockedSnapshotIds.length ||
    constraint.lockedMemberIds.length > constraint.teamSize ||
    constraint.lockedSnapshotIds.length > constraint.teamSize
  )
    throw new RangeError("invalid-lock-count");
  const lockedCharacters = constraint.lockedMemberIds.map(
    (id) => input.members.find((member) => member.instanceId === id)?.characterId,
  );
  if (new Set(lockedCharacters).size !== lockedCharacters.length) throw new RangeError("locked-character-conflict");
  for (const id of constraint.lockedMemberIds)
    if (constraint.excludedMemberIds.includes(id) || !input.members.some((member) => member.instanceId === id))
      throw new RangeError("invalid-locked-member");
  for (const id of constraint.lockedSnapshotIds)
    if (constraint.excludedSnapshotIds.includes(id) || !input.snapshots.some((snapshot) => snapshot.instanceId === id))
      throw new RangeError("invalid-locked-snapshot");
  compileSearchRequirements(input);
}

/** Exhaustive search until an explicit budget or cancellation. Only complete,
 * comparable objective vectors enter the Pareto frontier; null is never zero.
 */
export async function optimizeTeams(input: OptimizationInput, hooks: SearchHooks = {}): Promise<SearchResult> {
  validateOptimizationInput(input);
  const requirements = compileSearchRequirements(input);
  if (input.skillOrderCriterion === "worst-ap" && !hooks.evaluate)
    throw new RangeError("worst-ap-requires-native-order-factory");
  if (input.scoreDomain === "personal-live" && !hooks.evaluate)
    throw new RangeError("personal-live-requires-native-context-factory");
  const now = hooks.now ?? (() => performance.now());
  const started = now();
  const elapsed = () => Math.max(0, now() - started);
  const gaps = new Map<string, EvidenceGap>();
  const recordGap = (gap: EvidenceGap) => gaps.set(`${gap.code}:${gap.source}`, gap);
  input.evaluation.gaps.forEach(recordGap);
  input.inputGaps?.forEach(recordGap);
  const unavailable = (): SearchResult => ({
    candidates: [],
    completeness: "unavailable",
    evaluated: 0,
    elapsedMs: elapsed(),
    gaps: [...gaps.values()],
    bySong: [],
    proof: { status: "unavailable", method: "exhaustive-selected-domain", scope: "selected-input-domain" },
  });
  if (input.objectives.some((objective) => objective === "event-items")) {
    recordGap({ code: "event-reward-formula-unresolved", source: "native event result service + active event tables" });
    return unavailable();
  }
  if (input.evaluation.gaps.length) return unavailable();
  const members = input.members.filter((member) => !input.constraints.excludedMemberIds.includes(member.instanceId));
  const snapshots = input.snapshots.filter((snapshot) => {
    if (input.constraints.excludedSnapshotIds.includes(snapshot.instanceId)) return false;
    if (snapshot.allowedCharacterIds) return true;
    recordGap({ code: "snapshot-equip-legality-unresolved", source: `snapshot:${snapshot.cardId}` });
    return false;
  });
  if (requirements.requiredSnapshotIds.some((id) => !snapshots.some((snapshot) => snapshot.instanceId === id)))
    return unavailable();
  const incompleteDomain = gaps.size > 0;
  const evaluate: NonNullable<SearchHooks["evaluate"]> =
    hooks.evaluate ??
    (() => {
      const baseEvaluate = createAssignmentEvaluator(input);
      return (assignment: TeamAssignment, song: PreparedSong) => baseEvaluate(assignment, song);
    })();
  const songs: PreparedSong[] = input.songs
    .filter(
      (song) =>
        (!input.constraints.lockedSongKey || song.key === input.constraints.lockedSongKey) &&
        !input.constraints.excludedSongKeys.includes(song.key) &&
        (!input.constraints.excludeJustMissions || !song.segments.some((segment) => segment.mission === 3)),
    )
    .map((song) => prepareSong(song, input.evaluation));
  const resumable = hooks.fingerprint !== undefined;
  if (resumable && !/^[a-f0-9]{64}$/u.test(hooks.fingerprint!)) throw new RangeError("search-resume-fingerprint");
  const resume = hooks.resumeState;
  if (resume && (!resumable || resume.schema !== "haneoka-search-resume-state-v1" ||
    resume.cursor.fingerprint !== hooks.fingerprint || resume.evaluated !== resume.cursor.completedLeaves ||
    !Number.isSafeInteger(resume.evaluated) || resume.evaluated < 0 || resume.frontier.length > 1000))
    throw new RangeError("search-resume-context");
  const frontier: Candidate[] = resume ? structuredClone(resume.frontier) : [];
  const ranking = createSearchCollectors(input, resume?.collectors);
  resume?.gaps.forEach(recordGap);
  let evaluated = resume?.evaluated ?? 0;
  const initiallyEvaluated = evaluated;
  let work = 0;
  let completeness: SearchResult["completeness"] = "exhaustive";
  let stopped = false;
  let incompleteNativeInputs = resume?.incompleteNativeInputs ?? false;
  let pendingCandidate = resume?.pendingCandidate ? structuredClone(resume.pendingCandidate) : undefined;
  let lastNestedProgress = -Infinity;
  const reportProgress = () => {
    const elapsedMs = elapsed();
    if (elapsedMs - lastNestedProgress < 100) return;
    lastNestedProgress = elapsedMs;
    hooks.progress?.({
      evaluated,
      elapsedMs,
      phase: "search",
      candidateCount: frontier.length,
      proofStatus: "candidate",
    });
  };
  async function checkpoint(): Promise<boolean> {
    // Count DFS operations as well as evaluated leaves: impossible constraints
    // can otherwise consume the whole worker without producing progress.
    work++;
    if (work % 64 === 0) {
      reportProgress();
      await (hooks.yield ?? defaultYield)();
    }
    if (hooks.cancelled?.()) {
      completeness = "cancelled";
      stopped = true;
    } else if (elapsed() >= input.budget.maxMilliseconds || evaluated >= input.budget.maxEvaluations) {
      completeness = "budget-limited";
      stopped = true;
    }
    return !stopped;
  }
  function offer(candidate: Candidate): void {
    const floors = candidateMeetsBonusFloors(candidate, input.constraints);
    floors.gaps.forEach(recordGap);
    ranking.offer(candidate, floors.eligible, floors.gaps.length > 0);
    if (!floors.eligible) {
      if (floors.gaps.length) incompleteNativeInputs = true;
      return;
    }
    for (const objective of input.objectives) candidate.metrics[objective].gaps.forEach(recordGap);
    offerFrontier(candidate);
  }
  function offerFrontier(candidate: Candidate): void {
    if (
      !candidate.vector.every(Number.isFinite) ||
      input.objectives.some((objective) => {
        const metric = candidate.metrics[objective];
        return (
          metric.value === null ||
          !Number.isFinite(metric.value) ||
          metric.status === "unavailable" ||
          metric.gaps.length > 0
        );
      })
    ) {
      incompleteNativeInputs = true;
      return;
    }
    if (
      frontier.some(
        (previous) =>
          dominates(previous.vector, candidate.vector) ||
          previous.vector.every((value, index) => value === candidate.vector[index]),
      )
    )
      return;
    for (let i = frontier.length - 1; i >= 0; i--)
      if (dominates(candidate.vector, frontier[i]!.vector)) frontier.splice(i, 1);
    // Stop at a frontier memory budget instead of silently dropping Pareto points
    // that might dominate a later result. Such a search is budget-limited.
    if (frontier.length >= input.budget.maxCandidates) {
      completeness = "budget-limited";
      stopped = true;
      pendingCandidate = candidate;
      return;
    }
    frontier.push(candidate);
  }
  const team: typeof members = [];
  const equipped: (string | null)[] = [];
  const usedSnapshots = new Set<string>();
  const requiredSnapshots = new Set(requirements.requiredSnapshotIds);
  let remainingSnapshotLocks = requiredSnapshots.size;
  async function assignSnapshots(slot: number): Promise<void> {
    if (!(await checkpoint())) return;
    // A missing required photo must occupy one of the remaining physical slots.
    // Tight slots admit only still-unused required photos, preserving legal DFS order.
    const slotsRemaining = team.length - slot;
    if (remainingSnapshotLocks > slotsRemaining) return;
    const requiredSlot = slotsRemaining > 0 && remainingSnapshotLocks === slotsRemaining;
    if (slot === team.length) {
      if (!requirements.requiredSnapshotIds.every((id) => usedSnapshots.has(id))) return;
      for (const leader of team) {
        if (requirements.leader !== null && leader.instanceId !== requirements.leader) continue;
        const assignment: TeamAssignment = {
          memberInstanceIds: team.map((member) => member.instanceId),
          snapshotInstanceIds: [...equipped],
          leaderInstanceId: leader.instanceId,
        };
        for (const song of songs) {
          if (!(await checkpoint())) return;
          const candidate = await evaluate(assignment, song, {
            cancelled: hooks.cancelled ?? (() => false),
            yield: hooks.yield ?? defaultYield,
            expired: () => elapsed() >= input.budget.maxMilliseconds,
            progress: reportProgress,
          });
          evaluated++;
          offer(candidate);
          if (hooks.cancelled?.()) {
            completeness = "cancelled";
            stopped = true;
          } else if (elapsed() >= input.budget.maxMilliseconds) {
            completeness = "budget-limited";
            stopped = true;
          }
          if (stopped) return;
        }
      }
      return;
    }
    const memberId = team[slot]!.instanceId;
    const fixed = requirements.bindings.has(memberId), binding = requirements.bindings.get(memberId);
    if (!requiredSlot && (!fixed || binding === null)) {
      equipped.push(null);
      await assignSnapshots(slot + 1);
      equipped.pop();
      if (stopped) return;
    }
    for (const snapshot of snapshots) {
      if (usedSnapshots.has(snapshot.instanceId)) continue;
      const required = requiredSnapshots.has(snapshot.instanceId);
      if (requiredSlot && !required) continue;
      if ((fixed && binding !== snapshot.instanceId) ||
        (requirements.photoOwners.has(snapshot.instanceId) && requirements.photoOwners.get(snapshot.instanceId) !== memberId))
        continue;
      // Unknown equip constraints are an unresolved capability, not permission.
      if (!snapshot.allowedCharacterIds) {
        recordGap({ code: "snapshot-equip-legality-unresolved", source: `snapshot:${snapshot.cardId}` });
        continue;
      }
      if (!snapshot.allowedCharacterIds.includes(team[slot]!.characterId)) continue;
      usedSnapshots.add(snapshot.instanceId);
      if (required) remainingSnapshotLocks--;
      equipped.push(snapshot.instanceId);
      await assignSnapshots(slot + 1);
      equipped.pop();
      usedSnapshots.delete(snapshot.instanceId);
      if (required) remainingSnapshotLocks++;
      if (stopped) return;
    }
  }
  async function choose(start: number): Promise<void> {
    if (!(await checkpoint())) return;
    if (team.length === input.constraints.teamSize) {
      if (requirements.requiredMemberIds.every((id) => team.some((member) => member.instanceId === id)))
        await assignSnapshots(0);
      return;
    }
    const remaining = input.constraints.teamSize - team.length;
    const missingLocks = requirements.requiredMemberIds.filter(
      (id) => !team.some((member) => member.instanceId === id),
    );
    if (
      missingLocks.length > remaining ||
      missingLocks.some((id) => !members.slice(start).some((member) => member.instanceId === id))
    )
      return;
    for (let i = start; i <= members.length - remaining; i++) {
      const member = members[i]!;
      // Different cards of one character remain alternatives; a formation
      // selects at most one of them.
      if (team.some((selected) => selected.characterId === member.characterId)) continue;
      team.push(member);
      await choose(i + 1);
      team.pop();
      if (stopped) return;
    }
  }
  if (resumable) {
    const cursor = createAssignmentCursor({ members, snapshots, songKeys: songs.map(song => song.song.key),
      constraints: input.constraints }, resume ? { fingerprint: hooks.fingerprint!, state: resume.cursor } : undefined);
    const songMap = new Map(songs.map(song => [song.song.key, song]));
    let completedSinceYield = 0;
    if (pendingCandidate) {
      const pending = pendingCandidate;
      pendingCandidate = undefined;
      offerFrontier(pending);
    }
    while (!stopped) {
      if (hooks.cancelled?.()) { completeness = "cancelled"; stopped = true; break; }
      const step = cursor.take();
      if (step.kind === "done") break;
      if (elapsed() >= input.budget.maxMilliseconds || evaluated - initiallyEvaluated >= input.budget.maxEvaluations) {
        completeness = "budget-limited"; stopped = true; break;
      }
      if (step.kind === "yield") { reportProgress(); await (hooks.yield ?? defaultYield)(); continue; }
      const candidate = await evaluate(step.assignment, songMap.get(step.songKey)!, {
        cancelled: hooks.cancelled ?? (() => false), yield: hooks.yield ?? defaultYield,
        expired: () => elapsed() >= input.budget.maxMilliseconds, progress: reportProgress,
      });
      const cancelled = hooks.cancelled?.(), expired = elapsed() >= input.budget.maxMilliseconds;
      // An interrupted native leaf is still leased. Preserve its subspace rather
      // than publishing or counting an incomplete score as completed work.
      if ((cancelled || expired) && input.objectives.some(objective => {
        const metric = candidate.metrics[objective];
        return metric.value === null || metric.status === "unavailable" || metric.gaps.length > 0;
      })) { completeness = cancelled ? "cancelled" : "budget-limited"; stopped = true; break; }
      evaluated++;
      offer(candidate);
      cursor.commit();
      if (cancelled || expired) { completeness = cancelled ? "cancelled" : "budget-limited"; stopped = true; }
      if (!stopped && ++completedSinceYield % 64 === 0) {
        reportProgress();
        await (hooks.yield ?? defaultYield)();
      }
    }
    hooks.onResumeState?.(cursor.stats().exhausted && !pendingCandidate ? undefined : {
      schema: "haneoka-search-resume-state-v1", cursor: cursor.snapshot(hooks.fingerprint!),
      frontier: structuredClone(frontier), collectors: ranking.snapshot(), evaluated,
      gaps: [...gaps.values()], incompleteNativeInputs,
      ...(pendingCandidate ? { pendingCandidate: structuredClone(pendingCandidate) } : {}),
    });
  } else await choose(0);
  const finalCompleteness =
    completeness === "exhaustive" && (incompleteDomain || incompleteNativeInputs) ? "unavailable" : completeness;
  const proof = {
    status:
      finalCompleteness === "exhaustive"
        ? ("proven" as const)
        : finalCompleteness === "unavailable"
          ? ("unavailable" as const)
          : ("candidate" as const),
    method: "exhaustive-selected-domain" as const,
    scope: "selected-input-domain" as const,
  };
  hooks.progress?.({
    evaluated,
    elapsedMs: elapsed(),
    phase: "complete",
    candidateCount: frontier.length,
    proofStatus: proof.status,
  });
  return {
    candidates: frontier,
    completeness: finalCompleteness,
    evaluated,
    elapsedMs: elapsed(),
    gaps: [...gaps.values()],
    proof,
    bySong: ranking.finish(
      completeness === "exhaustive" && !incompleteDomain,
      new Set(songs.map((song) => song.song.key)),
    ),
    ...(input.constraints.resultDistinctCardSets !== undefined ? { cardSetsByObjective: ranking.finishGroups() } : {}),
  };
}

export function createTeamBuilderWorker(): Worker {
  return new Worker(new URL("./solver/worker.ts", import.meta.url), { type: "module", name: "haneoka-team-builder" });
}
