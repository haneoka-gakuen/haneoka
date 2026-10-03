import { validateInventory } from "./inventory.ts";
import type { ResourcePlannerPreparationInput } from "./resource-plan-contract.ts";

const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= 0x7fffffff;
export interface ResourcePlanInputIssue { path: string; code: string }

/** Structural input readiness for the UI and native preparation adapter. Actual
 * challenge eligibility, Master costs, event windows, laws and native evidence
 * remain the native factory's responsibility. No reference event/cost is defaulted.
 */
export function resourcePlanInputIssues(input: ResourcePlannerPreparationInput): ResourcePlanInputIssue[] {
  const issues: ResourcePlanInputIssue[] = [];
  const issue = (path: string, code: string) => issues.push({ path, code });
  if (input.schema !== "haneoka-resource-plan-request-v1") issue("schema", "unsupported-schema");
  const data = input.data;
  if (!data.identity.sourceId) issue("data.identity.sourceId", "source-required");
  issues.push(...validateInventory(input.inventory, data).issues);
  const parameters = input.parameters;
  for (const [key, minimum] of [
    ["boostBudget", 0], ["boostPerNormalPlay", 1], ["initialChallengePoints", 0], ["challengePointCost", 1],
  ] as const) if (!integer(parameters[key], minimum)) issue(`parameters.${key}`, "invalid-resource-amount");
  if (parameters.boostBudget > 2000) issue("parameters.boostBudget", "resource-budget-limit");
  if (!input.objectives.length || new Set(input.objectives).size !== input.objectives.length ||
      input.objectives.some(value => value !== "event-points" && value !== "event-items"))
    issue("objectives", "invalid-objectives");
  if (!["nominal-mean", "worst-ap"].includes(input.skillOrderCriterion)) issue("skillOrderCriterion", "invalid-criterion");
  if (input.objectives.includes("event-items") && (!input.itemResource ||
      !integer(input.itemResource.type) || !integer(input.itemResource.id))) issue("itemResource", "resource-identity-required");
  for (const kind of ["normal", "challenge"] as const) {
    const stage = input[kind];
    if (!["normal", "gekiso"].includes(stage.mode)) issue(`${kind}.mode`, "invalid-mode");
    if (stage.scene.kind !== kind || !integer(stage.scene.eventId, 1)) issue(`${kind}.scene`, "invalid-stage-scene");
    if (stage.scene.consumedCount !== (kind === "normal" ? parameters.boostPerNormalPlay : parameters.challengePointCost))
      issue(`${kind}.scene.consumedCount`, "consumption-mismatch");
    if (stage.constraints.teamSize !== 5) issue(`${kind}.constraints.teamSize`, "five-members-required");
    if (!stage.charts.length || stage.charts.length > 1000) issue(`${kind}.charts`, "invalid-chart-count");
    const seen = new Set<string>();
    for (const [index, chart] of stage.charts.entries()) {
      const id = "songId" in chart ? chart.songId : chart.challengeMusicId;
      if (!integer(id, 1) || !integer(chart.difficulty)) issue(`${kind}.charts.${index}`, "invalid-chart-identity");
      const key = `${id}:${chart.difficulty}`;
      if (seen.has(key)) issue(`${kind}.charts.${index}`, "duplicate-chart");
      seen.add(key);
    }
  }
  if (input.normal.scene.eventId !== input.challenge.scene.eventId) issue("challenge.scene.eventId", "different-event");
  for (const [key, limit] of [
    ["maxPairs", 1000000], ["maxMilliseconds", 60000], ["maxCycleStates", 100000], ["maxCycleTransitions", 2000000],
  ] as const) if (!integer(input.budget[key], 1) || input.budget[key] > limit) issue(`budget.${key}`, "invalid-search-budget");
  return issues;
}
