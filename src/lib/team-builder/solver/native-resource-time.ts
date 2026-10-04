import type { ResourcePlannerPreparationInput } from "../resource-plan-contract.ts";
import { resourcePlanInputIssues } from "../resource-plan-input.ts";
import { prepareResourcePlanStages } from "./native-challenge-stage-adapter.ts";
import { optimizeFixedResourceTime, type ResourceCycleTiming, type ResourceTimeControls, type ResourceTimeResult } from "./resource-time-efficiency.ts";

export interface NativeResourceTimeInput {
  schema: "haneoka-native-resource-time-request-v1";
  resource: ResourcePlannerPreparationInput;
  timing?: ResourceCycleTiming;
}
export interface NativeResourceTimeControls extends Omit<ResourceTimeControls, "progress"> {
  maxStageEvaluations?: number;
  maxStageCandidates?: number;
  progress?: (value: { phase: "loading" | "stage" | "pairs"; kind?: "normal" | "challenge";
    evaluated?: number; pairsEvaluated?: number; totalPairs?: number }) => void;
}

/** Independent native consumer. Existing total-reward planning keeps its
 * established protocol; this entry compares every prepared pair by cycle rate. */
export async function prepareNativeResourceTime(input: NativeResourceTimeInput,
  controls: NativeResourceTimeControls = {}): Promise<ResourceTimeResult> {
  const snapshot = structuredClone(input), request = snapshot.resource;
  if (snapshot.schema !== "haneoka-native-resource-time-request-v1") throw new RangeError("native-resource-time-schema");
  const issues = resourcePlanInputIssues(request);
  if (issues.length) throw new RangeError(`resource-stage-input:${issues[0]!.path}:${issues[0]!.code}`);
  const now = controls.now ?? (() => performance.now()), started = now();
  const stopped = (kind: "cancelled" | "budget-limited" | "unavailable", code: string): ResourceTimeResult => ({
    schema: "haneoka-resource-time-result-v1", completeness: kind, elapsedMs: Math.max(0, now() - started), pairsEvaluated: 0,
    definition: "expected-cycle-reward-divided-by-expected-cycle-seconds", scope: "fixed-normal-challenge-pair-requested-domain",
    assumptions: [], byObjective: Object.fromEntries(request.objectives.map(objective => [objective, {
      best: null, rewardOnlyBest: null, top3: { normal: [], challenge: [] }, status: "unavailable", pairsEvaluated: 0,
      gaps: [{ code, source: "native resource time preparation" }],
    }])),
  });
  if (controls.cancelled?.()) return stopped("cancelled", "resource-time-cancelled");
  // Until the stage producer checks active floors before retaining its law,
  // these requests cannot establish the legal domain for a new rate proof.
  if ([request.normal, request.challenge].some(stage => stage.constraints.bonusFloors &&
    (stage.constraints.bonusFloors.eventPointsBP !== undefined || stage.constraints.bonusFloors.eventItemsBP !== undefined)))
    return stopped("unavailable", "resource-time-stage-bonus-floor-retention-unresolved");
  controls.progress?.({ phase: "loading" });
  const stages = await prepareResourcePlanStages({ ...request, budget: { ...request.budget,
    maxMilliseconds: Math.max(1, Math.floor(request.budget.maxMilliseconds * 0.75)) } }, {
    cancelled: controls.cancelled, now, yield: controls.yield,
    maxStageEvaluations: controls.maxStageEvaluations, maxStageCandidates: controls.maxStageCandidates,
    progress: value => controls.progress?.({ phase: "stage", kind: value.kind, evaluated: value.evaluated }),
  });
  if (stages.server !== request.data.identity.server || stages.releaseId !== request.data.identity.releaseId ||
    stages.sourceId !== request.data.identity.sourceId || stages.eventId !== request.normal.scene.eventId ||
    stages.skillOrderCriterion !== request.skillOrderCriterion ||
    (["boostBudget", "boostPerNormalPlay", "initialChallengePoints", "challengePointCost"] as const)
      .some(key => stages.parameters[key] !== request.parameters[key]))
    throw new RangeError("resource-stage-preparation-context-mismatch");
  if (controls.cancelled?.()) return stopped("cancelled", "resource-time-cancelled");
  const remaining = Math.floor(request.budget.maxMilliseconds - (now() - started));
  if (remaining < 1) return stopped("budget-limited", "resource-time-budget-limited");
  const result = await optimizeFixedResourceTime({ ...stages, budget: { ...request.budget, maxMilliseconds: remaining } }, snapshot.timing,
    { ...controls, now, progress: value => controls.progress?.({ phase: "pairs", ...value }) });
  return { ...result, elapsedMs: Math.max(0, now() - started) };
}

export type NativeResourceTimeRequest = { type: "prepare"; runId: string; request: NativeResourceTimeInput }
  | { type: "cancel"; runId: string };
export type NativeResourceTimeResponse = { type: "result"; runId: string; result: ResourceTimeResult }
  | { type: "progress"; runId: string; progress: Parameters<NonNullable<NativeResourceTimeControls["progress"]>>[0] }
  | { type: "error"; runId: string; code: string };
