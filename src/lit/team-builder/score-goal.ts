import type { BuildSettings } from "./types";
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
} as const;

export const resultSettings = (host: TeamBuilder): BuildSettings => host.resultSettings ?? host.settings;

export function scoreText(host: TeamBuilder, message: readonly [string, string]): string {
  return host.t(message[0], message[1]);
}

export function scoreProof(host: TeamBuilder, proven: boolean): string {
  const settings = resultSettings(host);
  if (settings.goal === "score" || settings.goal === "gekiso")
    return scoreText(host, SCORE_GOALS[settings.criterion][proven ? "proven" : "unproven"]);
  return proven ? host.t("proven", "Proven optimal") : host.t("unproven", "Time limit reached: best found so far");
}
