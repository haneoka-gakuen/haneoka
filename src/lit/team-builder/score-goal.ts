import type { EngineHit } from "../../lib/team-builder/engine/api";
import { DEFAULT_SETTINGS, type BuildSettings } from "./types";
import type { TeamBuilder } from "../team-builder";

export const SCORE_GOALS = {
  mean: {
    label: ["criterionMean", "Average score"],
    help: ["criterionMeanHelp", "Rank by the average of 120 skill orders for everyday play."],
    metric: ["expectedScore", "Average score"],
    proven: ["provenMean", "Average score proven optimal within this search"],
    unproven: ["unprovenMean", "Average score: best found so far"],
  },
  max: {
    label: ["criterionMax", "Single-run maximum (ranking)"],
    help: ["criterionMaxHelp", "Rank by the best skill order for repeated attempts at a high score."],
    metric: ["bestScore", "Best-order score"],
    proven: ["provenMax", "Single-run maximum proven optimal within this search"],
    unproven: ["unprovenMax", "Single-run maximum: best found so far"],
  },
  min: {
    label: ["criterionMin", "Minimum score (floor)"],
    help: ["criterionMinHelp", "Rank by the worst skill order to raise the score floor."],
    metric: ["worstScore", "Worst-order score"],
    proven: ["provenMin", "Minimum score proven optimal within this search"],
    unproven: ["unprovenMin", "Minimum score: best found so far"],
  },
  "at-least": {
    label: ["criterionReach", "Reach rate"],
    help: ["criterionReachHelp", "Rank by the share of the 120 skill orders that reach the target score."],
    metric: ["reachRate", "Orders reaching the target"],
    proven: ["provenReach", "Reach rate proven optimal within this search"],
    unproven: ["unprovenReach", "Reach rate: best found so far"],
  },
  capped: {
    label: ["criterionCapped", "Capped average"],
    help: ["criterionCappedHelp", "Rank by the average score with every order counted up to the target score."],
    metric: ["cappedScore", "Capped average"],
    proven: ["provenCapped", "Capped average proven optimal within this search"],
    unproven: ["unprovenCapped", "Capped average: best found so far"],
  },
} as const;

/** The score goal's ranking: a target when one is set, otherwise the criterion. */
export const scoreGoal = (s: BuildSettings) =>
  s.goal === "score" && s.scoreTarget !== "none" ? s.scoreTarget : s.criterion;

export const usesPtResults = (host: TeamBuilder) =>
  host.tab === "pt" &&
  host.settings.rewardMode !== "plan" &&
  (host.farmResultMode ?? host.settings.rewardMode) === "recommendation";
export const resultSettings = (
  host: TeamBuilder,
  hit?: EngineHit,
  source?: Pick<BuildSettings, "route" | "measure">,
): BuildSettings => {
  if (usesPtResults(host)) {
    const job = host.pt.job,
      request = job?.request,
      goal = request?.goal;
    const task = source ?? (hit ? job?.tasks.find((task) => task.result?.hits.includes(hit)) : undefined);
    return {
      ...DEFAULT_SETTINGS,
      eventId: goal?.kind === "event" && goal.eventId >= 0 ? goal.eventId : null,
      goal: "event",
      route: task?.route ?? "live",
      challengePoints: job?.cycle?.consumption ?? DEFAULT_SETTINGS.challengePoints,
      measure: task?.measure ?? (goal?.kind === "event" ? goal.measure : "points"),
      weighted: false,
      ptCycle: !!job?.cycle,
      scope: job?.presentation?.scope ?? "box",
      unknownPolicy: request?.unknownPolicy ?? "min",
      boosts: goal?.kind === "event" ? goal.consumption : 0,
      ptMode: goal?.kind === "event" && goal.gekiso ? "gekiso" : "solo",
      ptJust: goal?.kind === "event" && goal.gekiso ? goal.gekiso.just * 100 : DEFAULT_SETTINGS.ptJust,
      minComboBonus: goal?.kind === "event" ? (goal.gekiso?.minComboBonus ?? 1) : 1,
      songs: goal?.kind === "event" ? goal.songs : [],
    };
  }
  const settings = host.resultSettings ?? host.searchSettings;
  if (settings.goal === "plan" && hit)
    return {
      ...settings,
      route: hit === host.results?.plan?.challenge ? "challenge" : "live",
      boosts: settings.planBoostsPerLive,
      measure: "points",
    };
  return settings;
};

export function scoreText(host: TeamBuilder, message: readonly [string, string]): string {
  return host.t(message[0], message[1]);
}

export function scoreProof(host: TeamBuilder, proven: boolean): string {
  return proven ? host.t("proven", "Proven optimal") : host.t("recommendation", "Recommendation");
}
