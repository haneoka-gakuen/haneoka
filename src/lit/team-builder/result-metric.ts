// L3 — GEB
// Input: Accepted candidate and its explicit result settings.
// Output: Numeric display metric shared by cards, exports and comparison.
// Pos: [Map](../L2-2.md); presentation only, no search or reward arithmetic changes.
// Effects/Dependencies: Localized labels supplied by the workspace.
import type { EngineHit } from "../../lib/team-builder/engine/api";
import type { TeamBuilder } from "../team-builder";
import type { BuildSettings } from "./types";
import { SCORE_GOALS, scoreGoal, scoreText } from "./score-goal";

export interface ResultMetric {
  id: string;
  label: string;
  value: number;
  digits: number;
  unit: string;
  relative: boolean;
}
export function resultMetric(host: TeamBuilder, hit: EngineHit, s: BuildSettings): ResultMetric {
  const metric = (id: string, label: string, value: number, digits = 0, unit = "", relative = true): ResultMetric => ({
    id,
    label,
    value,
    digits,
    unit,
    relative,
  });
  if (s.goal === "potential" && hit.potential)
    return metric("potential", host.t("potential", "Potential"), hit.potential.value);
  if ((s.goal === "event" || s.goal === "plan") && hit.event) {
    const event = hit.event;
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
    const label =
      measure === "items"
        ? host.t("itemsPerPlay", "Items per play")
        : measure === "challenge-points"
          ? host.t("cpPerPlay", "Challenge points per play")
          : host.t("pointsPerPlay", "Event points per play");
    const converted = s.ptCycle && s.route !== "challenge";
    return metric(
      `${measure}:${converted ? "converted" : "direct"}`,
      converted ? `${label} · ${host.t("farm.converted", "Direct rewards + CP conversion")}` : label,
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
    return metric(s.criterion, scoreText(host, SCORE_GOALS[s.criterion].metric), hit.score[s.criterion]);
  }
  return metric("power", host.t("power", "Power"), hit.power);
}
export function chartDuration(seconds: unknown): string {
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`
    : "—";
}
