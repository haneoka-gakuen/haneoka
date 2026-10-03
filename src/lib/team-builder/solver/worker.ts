import type { OptimizationInput, SongOption, SolverRequest, SolverResponse } from "../contracts.ts";
import { optimizeTeams, validateOptimizationInput } from "../optimizer.ts";
import { getTeamBuilderCapabilities } from "./capabilities.ts";
import { prepareEvaluationForSearch } from "./evaluation.ts";
import { loadSongOptions } from "./song-loader.ts";
import { createSearchCheckpoint, restoreSearchCheckpoint, searchFingerprint } from "./search-checkpoint.ts";
import { validateSearchBudget } from "./search-budget.ts";
import { prepareResourcePlanStages } from "./native-challenge-stage-adapter.ts";
import { optimizeFixedResourcePlans } from "../resource-planner.ts";
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
  if (message.type !== "start" && message.type !== "prepare" && message.type !== "resource-prepare") return;
  if (active) {
    active.cancelled = true;
    active.controller.abort();
  }
  const run = { runId: message.runId, cancelled: false, controller: new AbortController() };
  active = run;
  const execute = async () => {
    if (message.type === "resource-prepare") {
      const started = performance.now();
      scope.postMessage({ type: "resource-progress", runId: run.runId, progress: { phase: "loading" } });
      const stages = await prepareResourcePlanStages(message.request, {
        cancelled: () => run.cancelled,
        progress: (progress) => { if (active === run) scope.postMessage({ type: "resource-progress",
          runId: run.runId, progress: { phase: "stage", ...progress } }); },
      });
      if (active !== run) return;
      const remaining = Math.max(1, Math.floor(message.request.budget.maxMilliseconds - (performance.now() - started)));
      const result = await optimizeFixedResourcePlans({ ...stages, budget: { ...stages.budget, maxMilliseconds: remaining } }, {
        cancelled: () => run.cancelled,
        progress: (progress) => { if (active === run) scope.postMessage({ type: "resource-progress", runId: run.runId, progress }); },
      });
      result.elapsedMs = performance.now() - started;
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
    const result = await optimizeTeams(input, {
      evaluate,
      cancelled: () => run.cancelled,
      progress: (progress) => {
        if (active === run) scope.postMessage({ type: "progress", runId: run.runId, progress });
      },
    });
    const completed = { ...result, capabilities: getTeamBuilderCapabilities(input) };
    const checkpoint = await createSearchCheckpoint(fingerprint, completed);
    if (active === run) {
      scope.postMessage({
        type: "result",
        runId: run.runId,
        result: checkpoint?.result ?? completed,
        ...(checkpoint ? { checkpoint } : {}),
      });
      active = null;
    }
  };
  void execute().catch((error: unknown) => {
    if (active === run) {
      if (run.cancelled && message.type === "resource-prepare")
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
