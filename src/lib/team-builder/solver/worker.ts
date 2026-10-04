import type { OptimizationInput, SongOption, SolverRequest, SolverResponse } from "../contracts.ts";
import { optimizeTeams, validateOptimizationInput } from "../optimizer.ts";
import { getTeamBuilderCapabilities } from "./capabilities.ts";
import { prepareEvaluationForSearch } from "./evaluation.ts";
import { loadSongOptions } from "./song-loader.ts";
import { createSearchCheckpoint, restoreSearchCheckpoint, searchFingerprint } from "./search-checkpoint.ts";
import { validateSearchBudget } from "./search-budget.ts";
import { createSearchResumeCheckpoint, restoreSearchResumeCheckpoint, type SearchResumeState } from "../search-resume.ts";
import { prepareAndOptimizeResourcePlan } from "../resource-plan-runner.ts";
import { evaluateManualTeam, type PinnedManualTeamSong } from "../manual-team.ts";
import { resolveNativeChallengeContext } from "./native-challenge-context.ts";
import { prepareNativePracticalSearch } from "./native-practical-search.ts";
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<SolverRequest>) => void) | null;
  postMessage(message: SolverResponse): void;
};
let active: { runId: string; cancelled: boolean; controller: AbortController } | null = null;
scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "cancel") {
    if (active?.runId === message.runId) {
      active.cancelled = true;
      active.controller.abort();
    }
    return;
  }
  if (message.type !== "start" && message.type !== "prepare" && message.type !== "resource-prepare" &&
      message.type !== "manual-prepare" && message.type !== "practical-prepare") return;
  if (active) {
    active.cancelled = true;
    active.controller.abort();
  }
  const run = { runId: message.runId, cancelled: false, controller: new AbortController() };
  active = run;
  const execute = async () => {
    if (message.type === "practical-prepare") {
      const result = await prepareNativePracticalSearch(message.request, {
        cancelled: () => run.cancelled || active !== run,
        progress: progress => { if (active === run) scope.postMessage({ type: "practical-progress", runId: run.runId, progress }); },
      });
      if (active === run) {
        scope.postMessage({ type: "practical-result", runId: run.runId, result });
        active = null;
      }
      return;
    }
    if (message.type === "manual-prepare") {
      const parsedSongs: PinnedManualTeamSong[] = [];
      const manualControls = {
        cancelled: () => run.cancelled || active !== run,
        progress: (progress: import("../contracts.ts").ManualTeamProgress) => { if (active === run) scope.postMessage({ type: "manual-progress", runId: run.runId, progress }); },
        preparedSong: (song: PinnedManualTeamSong) => { parsedSongs.push(song); },
      };
      const result = await evaluateManualTeam(message.request, manualControls);
      if (parsedSongs.length === message.request.selections.length && result.status !== "cancelled" && result.status !== "budget-limited") {
        const { assignment: _assignment, budget: _budget, ...semanticRequest } = message.request;
        const { requiredLeaderId: _leader, requiredBindings: _bindings, lockedMemberIds: _members,
          lockedSnapshotIds: _photos, resultDistinctCardSets: _count, ...constraints } = semanticRequest.constraints;
        result.contextFingerprint = await searchFingerprint({ kind: "native-fixed-team-comparison-context",
          request: { ...semanticRequest, constraints }, parsedSongs });
      }
      if (active === run) {
        scope.postMessage({ type: "manual-result", runId: run.runId, result });
        active = null;
      }
      return;
    }
    if (message.type === "resource-prepare") {
      const result = await prepareAndOptimizeResourcePlan(message.request, {
        cancelled: () => run.cancelled || active !== run,
        progress: (progress) => { if (active === run) scope.postMessage({ type: "resource-progress", runId: run.runId, progress }); },
      });
      if (active === run) {
        scope.postMessage({ type: "resource-result", runId: run.runId, result });
        active = null;
      }
      return;
    }
    validateSearchBudget(message.type === "prepare" ? message.request.budget : message.input.budget);
    let input: OptimizationInput | undefined;
    let preparedSongs: SongOption[] = [];
    let evaluate;
    let fingerprint;
    if (message.type === "prepare") {
      const request = message.request;
      let challenge: ReturnType<typeof resolveNativeChallengeContext>["value"] = null;
      if (request.challengeMusicId !== undefined) {
        const scene = request.eventScene;
        if (scene?.kind !== "challenge") throw new RangeError("native-challenge-scenario-required");
        const resolved = resolveNativeChallengeContext(request.data, request.data.challengeMusicTable, {
          challengeMusicId: request.challengeMusicId, eventId: scene.eventId,
          startTimeMs: scene.liveStartServerTime.epochMilliseconds, masterTimeSlot: scene.masterTimeSlot,
        });
        if (!resolved.value) throw new RangeError(resolved.gaps[0]?.code ?? "native-challenge-context-unresolved");
        challenge = resolved.value;
        if (request.selections.length !== 1 || request.selections[0]?.songId !== challenge.underlyingSongId)
          throw new RangeError("native-challenge-parent-chart-mismatch");
        if (request.mode === "gekiso" && request.objectives.includes("score") && request.scoreDomain !== "personal-solo")
          throw new RangeError("native-challenge-gekiso-live-context-unresolved");
      }
      scope.postMessage({
        type: "progress",
        runId: run.runId,
        progress: { phase: "loading", evaluated: 0, elapsedMs: 0 },
      });
      const songs = await loadSongOptions(message.request.data, message.request.selections, run.controller.signal, {
        nativeGekisoPerfectPlan: message.request.mode === "gekiso" && message.request.scoreDomain !== "personal-solo" &&
          message.request.objectives.includes("score") && message.request.constraints.justRate === 0 &&
          message.request.nativeGekisoPlans === undefined,
      });
      if (challenge) {
        songs[0]!.key = `challenge:${challenge.challengeMusicId}:${request.selections[0]!.difficulty}`;
        if (request.mode === "gekiso") songs[0]!.segments = songs[0]!.segments.map((range, index) =>
          ({ ...range, mission: challenge!.missionTypes[index]! }));
      }
      if (active !== run) return;
      if (run.cancelled) {
        scope.postMessage({
          type: "result",
          runId: run.runId,
          result: { candidates: [], completeness: "cancelled", evaluated: 0, elapsedMs: 0, gaps: [] },
        });
        active = null;
        return;
      }
      const { budget: _budget, ...semanticRequest } = message.request;
      fingerprint = await searchFingerprint({ kind: "prepare", request: semanticRequest, songs });
      // A verified complete cache hit needs no inventory/skill/slot factory.
      // Keep chart loading and the full semantic fingerprint before restore.
      preparedSongs = songs;
    } else {
      input = message.input;
      const { budget: _budget, ...semanticInput } = input;
      fingerprint = await searchFingerprint({ kind: "start", input: semanticInput });
    }
    if (active !== run) return;
    const restored = await restoreSearchCheckpoint(message.checkpoint, fingerprint);
    if (active !== run) return;
    if (run.cancelled) {
      scope.postMessage({
        type: "result",
        runId: run.runId,
        result: { candidates: [], completeness: "cancelled", evaluated: 0, elapsedMs: 0, gaps: [] },
      });
      active = null;
      return;
    }
    if (restored) {
      scope.postMessage({
        type: "progress",
        runId: run.runId,
        progress: {
          phase: "complete",
          evaluated: restored.evaluated,
          elapsedMs: 0,
          candidateCount: restored.candidates.length,
          proofStatus: "proven",
        },
      });
      scope.postMessage({
        type: "result",
        runId: run.runId,
        result: restored,
        checkpoint: { ...message.checkpoint!, result: restored },
        reusedCheckpoint: true,
      });
      active = null;
      return;
    }
    if (message.type === "prepare")
      ({ input, evaluate } = prepareEvaluationForSearch({ ...message.request, songs: preparedSongs }));
    if (!input) throw new Error("solver-input-unresolved");
    validateOptimizationInput(input);
    const resumedState = await restoreSearchResumeCheckpoint(message.resumeCheckpoint, fingerprint);
    if (active !== run) return;
    let resumeState: SearchResumeState | undefined;
    const result = await optimizeTeams(input, {
      fingerprint,
      resumeState: resumedState ?? undefined,
      onResumeState: state => { resumeState = state; },
      evaluate,
      cancelled: () => run.cancelled,
      progress: (progress) => {
        if (active === run) scope.postMessage({ type: "progress", runId: run.runId, progress });
      },
    });
    const completed = { ...result, capabilities: getTeamBuilderCapabilities(input) };
    const checkpoint = await createSearchCheckpoint(fingerprint, completed);
    const resumeCheckpoint = resumeState ? await createSearchResumeCheckpoint(fingerprint, resumeState) : null;
    if (active === run) {
      scope.postMessage({
        type: "result",
        runId: run.runId,
        result: checkpoint?.result ?? completed,
        ...(checkpoint ? { checkpoint } : {}),
        ...(resumeCheckpoint ? { resumeCheckpoint } : {}),
      });
      active = null;
    }
  };
  void execute().catch(async (error: unknown) => {
    if (active === run) {
      if (run.cancelled && message.type === "practical-prepare") {
        const contextFingerprint = await searchFingerprint({ kind: "native-practical-cancelled", request: message.request });
        if (active !== run) return;
        scope.postMessage({ type: "practical-result", runId: run.runId, result: {
          ...message.request.data.identity, sourceId: message.request.data.identity.sourceId ?? "",
          schema: "haneoka-native-practical-result-v1", method: "multidirection-one-neighbour-round-native-refinement",
          optimality: "heuristic-selected-candidates", contextFingerprint, status: "cancelled",
          plan: { localRounds: 1, screenOrders: null, finalOrders: 120, finalistLimit: message.request.finalistLimit ?? 6 },
          tasks: [], generated: 0, neighbourChecks: 0, screened: 0, fullyEvaluated: 0, elapsedMs: 0,
        } });
      }
      else if (run.cancelled && message.type === "manual-prepare")
        scope.postMessage({ type: "manual-result", runId: run.runId, result: {
          ...message.request.data.identity, sourceId: message.request.data.identity.sourceId ?? "",
          schema: "haneoka-manual-team-result-v1", assignment: structuredClone(message.request.assignment),
          status: "cancelled", candidates: [], elapsedMs: 0, gaps: [],
        } });
      else if (run.cancelled && message.type === "resource-prepare")
        scope.postMessage({ type: "resource-result", runId: run.runId, result: {
          schema: "haneoka-resource-plan-result-v1", byObjective: {}, completeness: "cancelled",
          elapsedMs: 0, pairsEvaluated: 0, difference: null, scope: "fixed-normal-challenge-pair-requested-domain",
        } });
      else if (run.cancelled)
        scope.postMessage({
          type: "result",
          runId: run.runId,
          result: { candidates: [], completeness: "cancelled", evaluated: 0, elapsedMs: 0, gaps: [] },
        });
      else
        scope.postMessage({
          type: "error",
          runId: run.runId,
          code: error instanceof Error ? error.message : "solver-error",
        });
      active = null;
    }
  });
};
