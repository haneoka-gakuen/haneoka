import { prepareResourcePlanStages, type ResourceStagePreparationControls } from "./solver/native-challenge-stage-adapter";
import { resourcePlanInputIssues } from "./resource-plan-input";
import { optimizeFixedResourcePlans, type ResourcePlannerControls } from "./resource-planner";
import type { ResourcePlannerPreparationInput, ResourcePlannerResult, ResourcePlanningProgress,
  ResourcePlannerRunContext } from "./resource-plan-contract";

export interface ResourcePlanningControls extends Omit<ResourcePlannerControls, "progress"> {
  progress?: (value: ResourcePlanningProgress) => void;
  maxStageEvaluations?: number;
  maxStageCandidates?: number;
}
type StagePreparer = typeof prepareResourcePlanStages;

/** Worker-local complete stage preparation and pair composition under one
 * overall deadline. Uses the native adapter; no chart/frame work runs in main.
 */
export async function prepareAndOptimizeResourcePlan(
  input: ResourcePlannerPreparationInput,
  controls: ResourcePlanningControls = {},
  prepare: StagePreparer = prepareResourcePlanStages,
): Promise<ResourcePlannerResult> {
  const snapshot = structuredClone(input);
  const issues = resourcePlanInputIssues(snapshot);
  if (issues.length) throw new RangeError(`resource-stage-input:${issues[0]!.path}:${issues[0]!.code}`);
  const now = controls.now ?? (() => performance.now()), started = now();
  const elapsed = () => Math.max(0, now() - started);
  const stoppedResult = (kind: "cancelled" | "budget-limited"): ResourcePlannerResult => ({
    schema: "haneoka-resource-plan-result-v1", completeness: kind, elapsedMs: elapsed(), pairsEvaluated: 0,
    scope: "fixed-normal-challenge-pair-requested-domain", difference: null,
    byObjective: Object.fromEntries(snapshot.objectives.map(objective => [objective, {
      best: null, top3: { normal: [], challenge: [] }, status: "unavailable", pairsEvaluated: 0, secondaryObjective: null,
      gaps: [{ code: `resource-plan-${kind}`, source: "overall preparation and pair budget" }],
    }])),
  });
  if (controls.cancelled?.()) return stoppedResult("cancelled");
  // Reserve composition time without changing the legal requested domains.
  controls.progress?.({ phase: "loading" });
  const stageRequest = { ...snapshot, budget: { ...snapshot.budget,
    maxMilliseconds: Math.max(1, Math.floor(snapshot.budget.maxMilliseconds * 0.75)) } };
  const preparationControls: ResourceStagePreparationControls = {
    cancelled: controls.cancelled, now, yield: controls.yield,
    maxStageEvaluations: controls.maxStageEvaluations, maxStageCandidates: controls.maxStageCandidates,
    progress: value => controls.progress?.({ phase: "stage", ...value }),
  };
  const stages = await prepare(stageRequest, preparationControls);
  if (stages.server !== snapshot.data.identity.server || stages.releaseId !== snapshot.data.identity.releaseId ||
      stages.sourceId !== snapshot.data.identity.sourceId || stages.eventId !== snapshot.normal.scene.eventId ||
      stages.skillOrderCriterion !== snapshot.skillOrderCriterion ||
      (["boostBudget", "boostPerNormalPlay", "initialChallengePoints", "challengePointCost"] as const)
        .some(key => stages.parameters[key] !== snapshot.parameters[key]))
    throw new RangeError("resource-stage-preparation-context-mismatch");
  if (controls.cancelled?.()) return stoppedResult("cancelled");
  const remaining = Math.floor(snapshot.budget.maxMilliseconds - elapsed());
  if (remaining < 1) return stoppedResult("budget-limited");
  const result = await optimizeFixedResourcePlans({ ...stages, budget: { ...snapshot.budget, maxMilliseconds: remaining } }, {
    ...controls, now, progress: value => controls.progress?.(value),
  });
  return { ...result, elapsedMs: elapsed() };
}

export function resourcePlannerContextMatches(context: ResourcePlannerRunContext, request: ResourcePlannerPreparationInput) {
  return (context.ownerId === null || (typeof context.ownerId === "string" && context.ownerId.length > 0)) &&
    Number.isSafeInteger(context.inventoryRevision) && context.inventoryRevision >= 0 &&
    context.server === request.data.identity.server && context.releaseId === request.data.identity.releaseId &&
    !!context.sourceId && context.sourceId === request.data.identity.sourceId &&
    request.inventory.server === context.server && request.inventory.releaseId === context.releaseId;
}
