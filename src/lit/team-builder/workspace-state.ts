// L3 — GEB
// Input: Saved build preferences, opponent drafts and chart selections.
// Output: Migrated drafts, resolved LUCK counts and JUST windows, effective reward conditions and selection transactions.
// Pos: [Map](../L2-2.md); team workspace input projection.
// Effects/Dependencies: Pure transformations; no persistence or engine calls.
import { dataRows, type TeamBuilderData } from "../../lib/team-builder/data";
import { MAX_GEKISO_COUNT } from "../../lib/team-builder/constraint-feasibility";
import { readSongRules } from "../../lib/team-builder/arena";
import { legacyRewardPlan } from "../../lib/team-builder/reward-plan";
import type { SongRef } from "../../lib/team-builder/engine/api";
import { CUSTOM_ACCURACY, DEFAULT_FARMING, DEFAULT_SETTINGS, type BuildSettings, type FarmingSettings } from "./types";

export const chartKey = (song: SongRef) => `${song.songId}:${song.difficulty}`;
export const uniqueCharts = (songs: readonly SongRef[]): SongRef[] =>
  [...new Map(songs.map(song => [chartKey(song), { ...song }])).values()];

export function missionSummary(missions: readonly string[]): string {
  const labels = missions.map(value => value === "Combo" ? "COMBO" : value === "Luck" ? "LUCK" : value === "JustCount" ? "JUST" : "—");
  if (!labels.length || labels.every(value => value === "—")) return "";
  return labels.every(value => value === labels[0]) ? `${labels[0]} ×${labels.length}` : labels.join(" / ");
}

export function parseOpponents(drafts: readonly string[]) {
  const tokens = drafts.map(text => text.trim() ? text.trim().split(/[\s,，、]+/u) : []);
  const ranges = tokens.map(range => range.map(Number).filter(value => Number.isFinite(value) && value > 0));
  const invalid = tokens.map((range, index) => range.length > 4 || range.length !== ranges[index]!.length);
  return { ranges, invalid, empty: ranges.every(range => !range.length) };
}

export function resolveLuckSamples(settings: Pick<BuildSettings,
  "gekisoSamplingMode" | "gekisoSeeds" | "ptSamplingMode" | "ptLuckSamples">,
  context: "score" | "rewards" = "score"): number {
  if (context === "rewards") return settings.ptSamplingMode === "manual" ? settings.ptLuckSamples : 32;
  return settings.gekisoSamplingMode === "manual" ? settings.gekisoSeeds : 0;
}

const baseJustWindows = new WeakMap<TeamBuilderData, number>();
export function justBaseWindow(data: TeamBuilderData | null): number | null {
  if (!data) return null;
  const cached = baseJustWindows.get(data);
  if (cached !== undefined) return cached;
  const row = dataRows(data?.liveTools.judgementTiming).find(
    (row) =>
      Number(row.noteJudgementType) === 1 && Number(row.noteSimulateJudgement) === 6 && Number(row.assistLevel) === 0,
  );
  if (!row) return null;
  const base = Math.min(Number(row.beforeMs), Number(row.afterMs));
  baseJustWindows.set(data, base);
  return base;
}
export function resolveJustWindow(
  settings: Pick<BuildSettings, "justWindowUnit" | "justWindowPercent" | "justWindowMs">,
  data: TeamBuilderData | null,
): number {
  if (settings.justWindowUnit === "ms") return settings.justWindowMs;
  if (settings.justWindowPercent === 0) return 0;
  const base = justBaseWindow(data);
  return base === null ? NaN : base * (1 + settings.justWindowPercent / 100);
}
export const validJustWindowInput = (
  settings: Pick<BuildSettings, "justWindowUnit" | "justWindowPercent" | "justWindowMs">,
) => {
  const value = settings.justWindowUnit === "percent" ? settings.justWindowPercent : settings.justWindowMs;
  return Number.isFinite(value) && value >= 0 && value <= MAX_GEKISO_COUNT;
};

export function restoreBuildSettings(stored: Partial<BuildSettings> = {}): BuildSettings {
  const settings = { ...structuredClone(DEFAULT_SETTINGS), ...stored, songRules: readSongRules(stored.songRules) };
  settings.minMissionMembers = stored.minMissionMembers?.length === 3 ? [...stored.minMissionMembers] : [0, 0, 0];
  settings.justWindowUnit = stored.justWindowUnit ?? ((stored.justWindowMs ?? 0) > 0 ? "ms" : "percent");
  settings.gekisoRanks = stored.gekisoRanks ? [...stored.gekisoRanks] : [settings.gekisoRank, settings.gekisoRank, settings.gekisoRank];
  settings.frameRate = [30, 60, 90, 120].includes(settings.frameRate) ? settings.frameRate : 60;
  // Required cards hold for this visit only.
  settings.required = { members: [], snaps: [] };
  if (!CUSTOM_ACCURACY) settings.playMode = "ap";
  settings.gekisoSamplingMode = stored.gekisoSamplingMode === "manual" && (stored.gekisoSeeds ?? 0) !== 0 ? "manual" : "auto";
  settings.ptSamplingMode = stored.ptSamplingMode === "manual" ? "manual" : "auto";
  const { attribute, ...manualEvent } = settings.manualEvent as typeof settings.manualEvent & { attribute?: number | null };
  settings.manualEvent = { ...manualEvent, attributes: manualEvent.attributes ?? (attribute ? [attribute] : attribute === 0 ? [] : null) };
  if (stored.gekisoPlacementMode === undefined)
    settings.gekisoPlacementMode = parseOpponents(settings.gekisoOpponents).empty ? "rank" : "opponents";
  const mode = stored.goal === "event" || stored.goal === "plan" ? stored.goal : settings.rewardMode;
  if (!stored.farming) {
    const custom = mode === "event";
    settings.farming = { ...DEFAULT_FARMING,
      play: custom ? settings.route === "live" ? "solo" : settings.route : settings.ptMode,
      measure: settings.measure === "items" || custom ? settings.measure : "points",
      ptCycle: settings.ptCycle,
      ...(custom ? Object.fromEntries(Object.keys(DEFAULT_FARMING).filter(key => key in settings).map(key => [key, settings[key as keyof BuildSettings]])) : {}),
      requireGrowth: !custom, includeMemory: custom,
    };
  }
  settings.farming = { ...structuredClone(DEFAULT_FARMING), ...settings.farming, ...(CUSTOM_ACCURACY ? {} : { playMode: "ap" as const }) };
  if (settings.farming.weighted && !settings.farming.rewardPlan) settings.farming.rewardPlan = legacyRewardPlan(settings.farming);
  settings.rewardMode = mode === "plan" && !settings.manualEventEnabled ? "plan" : farmingSettings(settings).rewardMode;
  return settings;
}

/** Gekisou rewards retain the engine's AP / recorded-input contract; other play drafts survive the switch. */
export function farmingConditions(draft: FarmingSettings): FarmingSettings {
  if (draft.play !== "gekiso") return { ...draft, playMode: draft.play === "skip" ? "ap" : draft.playMode, measure: draft.play === "challenge" && draft.measure === "challenge-points" ? "points" : draft.measure };
  return { ...draft, playMode: "ap", requireGrowth: true, unknownPolicy: "min", includeMemory: false,
    measure: draft.measure === "items" ? "items" : "points", weighted: false, fullRanking: false, k: 1, timeLimit: null };
}
export function farmingMode(draft: FarmingSettings): "recommendation" | "event" {
  const s = farmingConditions(draft);
  return (s.play !== "gekiso" || s.rewardRoomMode === "battle" && s.rewardPlayers === 5 && s.rewardOtherScore === null) && s.aggregation !== "mean" && !s.rewardPlan && (s.play === "solo" || s.play === "gekiso") && s.playMode === "ap" && s.requireGrowth && !s.includeMemory &&
    s.measure !== "challenge-points" && !s.weighted && !s.fullRanking && s.k === 1 && s.timeLimit === null ? "recommendation" : "event";
}
export function farmingSettings(settings: BuildSettings): BuildSettings {
  const draft = settings.manualEventEnabled
    ? { ...settings.farming, play: settings.farming.play === "challenge" ? "solo" as const : settings.farming.play, ptCycle: false }
    : settings.farming;
  const s = farmingConditions(draft);
  const mode = farmingMode(s);
  const selectedPlan = s.rewardPlan ?? (s.aggregation === "mean" && s.ptCycle ? legacyRewardPlan(s) : null);
  const rewardPlan = settings.manualEventEnabled && selectedPlan
    ? { ...selectedPlan, options: { ...selectedPlan.options,
        "challenge-points": { ...selectedPlan.options["challenge-points"], auto: false } } }
    : selectedPlan;
  return { ...settings, ...s, rewardPlan, rewardMode: mode, goal: "event",
    farming: draft,
    eventId: settings.manualEventEnabled ? settings.manualEvent.templateId : settings.eventId,
    route: s.play === "solo" || s.play === "gekiso" ? "live" : s.play,
    ptMode: s.play === "gekiso" ? "gekiso" : "solo",
    unknownPolicy: s.requireGrowth ? "min" : s.unknownPolicy,
    ptCycle: s.ptCycle };
}
