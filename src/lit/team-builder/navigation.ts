import { DEFAULT_SETTINGS, type BuildSettings, type GoalKind, type Tab } from "./types";

export const isActivityGoal = (goal: GoalKind): goal is "event" | "plan" => goal === "event" || goal === "plan";

export function restoreBuildSettings(stored: Partial<BuildSettings>): BuildSettings {
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  return {
    ...settings,
    buildGoal: stored.buildGoal ?? (isActivityGoal(settings.goal) ? "score" : settings.goal),
    activityMode: stored.activityMode ?? (isActivityGoal(settings.goal) ? settings.goal : "recommend"),
  };
}

export function mergeBuildSettings(settings: BuildSettings, patch: Partial<BuildSettings>): BuildSettings {
  const goal = patch.goal;
  return {
    ...settings,
    ...patch,
    ...(goal ? (isActivityGoal(goal) ? { activityMode: goal } : { buildGoal: goal }) : {}),
  };
}

export function goalForTab(settings: BuildSettings, tab: Tab): GoalKind {
  if (tab === "build") return settings.buildGoal;
  if (tab === "pt" && settings.activityMode !== "recommend") return settings.activityMode;
  return settings.goal;
}
