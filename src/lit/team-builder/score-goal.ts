import type { TemplateResult } from "lit";
import type { EngineHit, EngineRequest } from "../../lib/team-builder/engine/api";
import { manualEventFromEffects } from "../../lib/team-builder/manual-event";
import { DEFAULT_SETTINGS, type BuildSettings } from "./types";
import { choiceField } from "./catalog";
import type { TeamBuilder } from "../team-builder";

export interface ManualResultSource {
  input: EngineRequest;
  settings: BuildSettings;
  session: string;
  selectedOrder: number;
  onOrderChange?: (index: number) => void;
}
const manualSources = new WeakMap<EngineHit, ManualResultSource>();
const selectedOrders = new WeakMap<object, Map<string, number>>();
export const manualResultSource = (hit: EngineHit) => manualSources.get(hit);
export const registerManualResult = (hit: EngineHit, source: ManualResultSource) => manualSources.set(hit, source);
function orderContext(host: TeamBuilder, hit: EngineHit) {
  const source = manualResultSource(hit)?.input ?? resultRequest(host) ?? host;
  const key = JSON.stringify([hit.song, hit.members, hit.snaps, resultSettings(host, hit).route]);
  let choices = selectedOrders.get(source);
  if (!choices) selectedOrders.set(source, choices = new Map());
  return { choices, key };
}
export function resultOrderIndex(host: TeamBuilder, hit: EngineHit) {
  const { choices, key } = orderContext(host, hit);
  return manualResultSource(hit)?.selectedOrder ?? choices.get(key)
    ?? hit.score?.orders.reduce((best, value, index, values) => value > values[best]! ? index : best, 0) ?? 0;
}
export function setResultOrder(host: TeamBuilder, hit: EngineHit, index: number) {
  const { choices, key } = orderContext(host, hit);
  choices.set(key, index);
  const source = manualResultSource(hit);
  if (source) {
    source.selectedOrder = index;
    source.onOrderChange?.(index);
  }
}

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
  "max-best-timing": {
    label: ["criterionMaxBestTiming", "Maximum score · best timing"],
    help: ["criterionMaxBestTiming", "Maximum score · best timing"],
    metric: ["bestTimingScore", "Best-timing score"],
    proven: ["provenMax", "Single-run maximum proven optimal within this search"],
    unproven: ["unprovenMax", "Single-run maximum: best found so far"],
  },
  "max-worst-timing": {
    label: ["criterionMaxWorstTiming", "Maximum score · worst timing"],
    help: ["criterionMaxWorstTiming", "Maximum score · worst timing"],
    metric: ["worstTimingScore", "Worst-timing score"],
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

export function renderScoreGoal(host: TeamBuilder, s: BuildSettings, set: (patch: Partial<BuildSettings>) => void): TemplateResult {
  const goals = s.goal === "score"
    ? (["mean", "max", "max-best-timing", "max-worst-timing", "min", "at-least", "capped"] as const)
    : (["mean", "max", "min"] as const);
  return choiceField({
    type: "select",
    label: host.t("criterion", "Score goal"), value: scoreGoal(s),
    options: goals.map(value => ({value, label: scoreText(host, SCORE_GOALS[value].label), disabled: s.aggregation === "mean"})),
    onSelect: value => set(
      value === "max-best-timing" || value === "max-worst-timing"
        ? {scoreTiming: value === "max-best-timing" ? "best" : "worst", criterion: "max", scoreTarget: "none"}
        : s.goal === "gekiso" && (value === "mean" || value === "max" || value === "min") ? {criterion: value}
        : value === "at-least" || value === "capped" ? {scoreTarget: value, criterion: "mean", scoreTiming: "nominal"}
        : {scoreTarget: "none", criterion: value, scoreTiming: "nominal"},
    ),
  });
}

/** The score goal's ranking: a target when one is set, otherwise the criterion. */
export const scoreGoal = (s: BuildSettings) =>
  s.goal === "score" && s.scoreTarget !== "none" ? s.scoreTarget
    : s.goal === "score" && s.criterion === "max" && s.scoreTiming === "best" ? "max-best-timing"
    : s.goal === "score" && s.criterion === "max" && s.scoreTiming === "worst" ? "max-worst-timing" : s.criterion;

export const usesPtResults = (host: TeamBuilder) =>
  host.tab === "pt" &&
  host.settings.rewardMode !== "plan" &&
  (host.farmResultMode ?? host.settings.rewardMode) === "recommendation";
export const resultRequest = (host: TeamBuilder, hit?: EngineHit): EngineRequest | null => {
  const manual = hit && manualResultSource(hit);
  if (manual) return manual.input;
  const input = usesPtResults(host) ? (host.pt.job?.request ?? null) : host.resultInputs;
  if (!input || !hit || hit !== host.results?.cpChallenge || input.goal.kind !== "event") return input;
  const auto = input.goal.rewardPlan?.autoCp;
  if (!auto) return input;
  const { aggregation: _aggregation, shard: _shard, floors: _floors, cutoff: _cutoff, rewardCutoff: _rewardCutoff,
    rewardPhase: _rewardPhase, completed: _completed, seeds: _seeds, seedOnly: _seedOnly, seeded: _seeded,
    resolveRewardPlan: _resolveRewardPlan, ...request } = input;
  const { autoCp: _autoCp, ...plan } = input.goal.rewardPlan!;
  return { ...request, k: 1, goal: { ...input.goal, route: "challenge", songs: auto.songs,
    consumption: auto.consumption, ranking: "primary", gekiso: undefined, cpExchange: undefined,
    rewardPlan: { ...plan, levels: plan.levels.slice(0, 1) } } };
};
export const resultSettings = (
  host: TeamBuilder,
  hit?: EngineHit,
  source?: Pick<BuildSettings, "route" | "measure">,
): BuildSettings => {
  const manual = hit && manualResultSource(hit);
  if (manual) return manual.settings;
  if (usesPtResults(host)) {
    const job = host.pt.job,
      request = job?.request,
      goal = request?.goal;
    const task = source ?? (hit ? job?.tasks.find((task) => task.result?.hits.includes(hit)) : undefined);
    return {
      ...DEFAULT_SETTINGS,
      ...(goal?.kind === "event" && goal.eventEffects !== undefined ? {
        manualEventEnabled: true,
        manualEvent: manualEventFromEffects(goal.eventId, goal.eventEffects),
      } : {}),
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
  if (hit && hit === host.results?.cpChallenge) {
    const input = resultRequest(host, hit);
    if (input?.goal.kind === "event") return { ...settings, route: "challenge", aggregation: "individual", ptCycle: false,
      ptMode: "solo", songs: input.goal.songs, challengePoints: input.goal.consumption,
      farming: { ...settings.farming, play: "challenge", ptCycle: false } };
  }
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

export function scoreProof(host: TeamBuilder, proven: boolean, sampled = false): string {
  if (proven && sampled) return host.t("sampledProven", "Optimal within samples");
  return proven ? host.t("proven", "Proven optimal") : host.t("recommendation", "Recommendation");
}
