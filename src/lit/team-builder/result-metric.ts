// L3 — GEB
// Input: Accepted candidate and its explicit result settings.
// Output: Numeric display metric shared by cards, exports and comparison.
// Pos: [Map](../L2-2.md); presentation only, no search or reward arithmetic changes.
// Effects/Dependencies: Localized labels supplied by the workspace.
import type { EngineHit } from "../../lib/team-builder/engine/api";
import type { TeamBuilder } from "../team-builder";
import type { BuildSettings } from "./types";
import { SCORE_GOALS, resultRequest, resultSettings, scoreGoal, scoreText } from "./score-goal";

export interface ResultMetric {
  id: string;
  label: string;
  value: number;
  digits: number;
  unit: string;
  relative: boolean;
}
export function sampledLuck(host: TeamBuilder, hit: EngineHit): boolean {
  if (hit.gekiso) return hit.gekiso.sampled;
  if (hit.aggregate) return hit.aggregate.songs.some(part => sampledLuck(host, part));
  const request = resultRequest(host, hit);
  if (!hit.song || !request) return false;
  const goal = request.goal;
  const seeds = goal.kind === "gekiso" ? goal.seeds
    : goal.kind === "event" && hit.event && resultSettings(host, hit).route === "live" ? goal.gekiso?.luckSamples ?? 0 : 0;
  if (seeds <= 0) return false;
  const arena = goal.kind === "gekiso" ? goal.arena : undefined;
  const missions = host.master?.songs.get(hit.song.songId)?.gekisoMissions ?? [];
  return [0, 1, 2].some(index => (arena?.missions[index] || request.songRules?.missions[index] || missions[index]) === 2);
}

export function resultMetric(host: TeamBuilder, hit: EngineHit, s: BuildSettings): ResultMetric {
  const metric = (id: string, label: string, value: number, digits = 0, unit = "", relative = true): ResultMetric => ({
    id,
    label: hit.aggregate && hit.event ? host.t("multiSong.average", "Average {metric}", { metric: label }) : label,
    value,
    digits,
    unit,
    relative,
  });
  if (hit.aggregate && !hit.event) return metric("arena-shared-mean", host.t("arena.mean", "Average across songs"), hit.key);
  if (s.goal === "potential" && hit.potential)
    return metric("potential", host.t("potential", "Potential"), hit.potential.value);
  if ((s.goal === "event" || s.goal === "plan") && hit.event) {
    const event = hit.event;
    const sampled = !hit.aggregate && sampledLuck(host, hit);
    const pointsLabel = sampled ? host.t("averagePointsPerPlay", "Average event points per play") : host.t("pointsPerPlay", "Event points per play");
    const itemsLabel = sampled ? host.t("averageItemsPerPlay", "Average items per play") : host.t("itemsPerPlay", "Items per play");
    const cpLabel = sampled ? host.t("averageCpPerPlay", "Average challenge points per play") : host.t("cpPerPlay", "Challenge points per play");
    if (event.rewardPlan) {
      const plan = event.rewardPlan, primary = plan.levels[0]![0]!.metric;
      const label = plan.criterion === "min" ? host.t("rewardPlan.min", "Minimum reward") : plan.criterion === "max" ? host.t("rewardPlan.max", "Highest reward") : plan.levels[0]!.length > 1 ? host.t("rewardPlan.converted", "Converted rewards")
        : primary === "points" ? pointsLabel
        : primary === "items" ? (sampled ? itemsLabel : host.t("rewardPlan.itemsPerPlay", "Badges per play")) : cpLabel;
      return metric(`reward-plan:${JSON.stringify(plan)}`, label, event.mean, 4,
        primary === "points" ? "PT" : primary === "challenge-points" ? "CP" : "");
    }
    if (s.weighted) {
      const direct = event.directMean ?? event.mean,
        other = event.otherMean ?? 0;
      const points = s.weightPoints > 0 ? direct : other,
        items = s.weightPoints > 0 ? other : direct;
      return metric(
        "weighted",
        host.t("weightedTotal", "Weighted total per play"),
        s.weightPoints * points + s.weightItems * items + (s.route === "live" ? s.weightCp * event.challengePoints : 0),
        1,
      );
    }
    const measure = s.goal === "plan" ? "points" : s.measure;
    const label = measure === "items" ? itemsLabel : measure === "challenge-points" ? cpLabel : pointsLabel;
    const converted = s.ptCycle && s.route !== "challenge";
    return metric(
      `${measure}:${converted ? "converted" : "direct"}`,
      converted ? `${label} / ${host.t("farm.converted", "Direct rewards + CP conversion")}` : label,
      measure === "challenge-points" ? event.challengePoints : event.mean,
      1,
      measure === "points" ? "pt" : measure === "challenge-points" ? "CP" : "",
    );
  }
  if (s.goal !== "power" && hit.score) {
    const goal = scoreGoal(s),
      orders = hit.score.orders,
      target = s.targetScore ?? 0;
    if (goal === "at-least" && orders.length)
      return metric(
        goal,
        scoreText(host, SCORE_GOALS[goal].metric),
        (orders.filter((v) => v >= target).length / orders.length) * 100,
        1,
        "%",
        false,
      );
    if (goal === "capped" && orders.length)
      return metric(
        goal,
        scoreText(host, SCORE_GOALS[goal].metric),
        orders.reduce((sum, v) => sum + Math.min(v, target), 0) / orders.length,
      );
    return metric(goal, scoreText(host, SCORE_GOALS[goal].metric), hit.score[s.criterion]);
  }
  return metric("power", host.t("power", "Power"), hit.power);
}
export function chartDuration(seconds: unknown): string {
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`
    : "—";
}
