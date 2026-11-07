import type { ArenaGoal, SongRef } from "../../lib/team-builder/engine/api";
import type { Criterion } from "../../lib/team-builder/engine/objectives";
import type { FrameRate } from "../../lib/team-builder/engine/live";
import type { RewardPlan } from "../../lib/team-builder/reward-plan";
import { emptyManualEvent, type ManualEventDraft } from "../../lib/team-builder/manual-event";

export type Tab = "build" | "arena" | "box" | "account" | "teams" | "pt" | "song-comparison";
export type GoalKind = "score" | "gekiso" | "power" | "event" | "potential" | "plan";
export type LuckSamplingMode = "auto" | "manual";
export interface BuildSettings {
  aggregation: "individual" | "mean";
  songRules?: import("../../lib/team-builder/arena").SongRules;
  arena?: ArenaGoal;
  rewardMode: "recommendation" | "event" | "plan";
  farming: FarmingSettings;
  manualScoreMode: "score" | "gekiso";
  fullRanking: boolean;
  ptCycle: boolean;
  ptMode: "solo" | "gekiso";
  ptJust: number;
  ptSamplingMode: LuckSamplingMode;
  ptLuckSamples: number;
  goal: GoalKind;
  songs: SongRef[];
  criterion: Criterion;
  scoreTiming: "nominal" | "best" | "worst";
  frameRate: FrameRate;
  /** Score goal only: rank by the share of orders reaching targetScore, or the average capped at it. */
  scoreTarget: "none" | "at-least" | "capped";
  targetScore: number | null;
  playMode: "ap" | "custom";
  /** Percent of notes, 0–100. */
  great: number;
  good: number;
  miss: number;
  /** Pattern play: every Nth note is a Miss (0 none). */
  missEvery: number;
  eventId: number | null;
  manualEventEnabled: boolean;
  manualEvent: ManualEventDraft;
  measure: "points" | "items" | "challenge-points";
  /** Rank by a weighted sum of event points, items and challenge points. */
  weighted: boolean;
  weightPoints: number;
  weightItems: number;
  weightCp: number;
  rewardPlan: RewardPlan | null;
  rewardRoomMode: "battle" | "solo";
  rewardPlayers: number;
  rewardOtherScore: number | null;
  route: "live" | "challenge" | "skip";
  boosts: number;
  challengePoints: number;
  /** Score and power under challenge rules (event parameter bonus, challenge music type). */
  challengeRules: boolean;
  /** Power: include the song's type and tag bonus. */
  powerSong: boolean;
  window: number;
  planBudget: number;
  planBoostsPerLive: number;
  planStartingCp: number;
  planChallengeSongs: SongRef[];
  k: number;
  unknownPolicy: "max" | "min";
  scope: "box" | "theoretical";
  leader: number | null;
  /** member card → snap card (null keeps it empty). */
  bindings: [number, number | null][];
  /** Cards every team of this search includes, besides those locked in the Box. */
  required: { members: number[]; snaps: number[] };
  noSnaps: boolean;
  minBonus: number | null;
  attributes: number[];
  bands: number[];
  minRarity: number;
  timeLimit: number | null;
  /** Gekisou: share of Just-eligible notes hit Just (percent) and the assumed range placement (1 for Mission). */
  just: number;
  gekisoRank: number;
  gekisoRanks: [number, number, number];
  gekisoPlacementMode: "rank" | "opponents";
  minComboBonus: number;
  /** Minimum COMBO, LUCK and JUST member counts; ALL counts in each. */
  minMissionMembers: [number, number, number];
  justWindowUnit: "percent" | "ms";
  justWindowPercent: number;
  justWindowMs: number;
  gekisoSamplingMode: LuckSamplingMode;
  /** Manual draft: zero retains nominal expectations; positive counts average seeds 0 through n-1. */
  gekisoSeeds: number;
  /** Opponents' scores per range as typed (numbers separated by spaces or commas). */
  gekisoOpponents: [string, string, string];
}
export interface FarmingSettings extends Pick<BuildSettings,
  "aggregation" | "playMode" | "great" | "good" | "miss" | "missEvery" | "measure" | "weighted" |
  "weightPoints" | "weightItems" | "weightCp" | "rewardPlan" | "rewardRoomMode" | "rewardPlayers" | "rewardOtherScore" | "unknownPolicy" | "fullRanking" | "k" | "timeLimit" | "ptCycle"> {
  play: "solo" | "gekiso" | "challenge" | "skip";
  requireGrowth: boolean;
  includeMemory: boolean;
}
export const DEFAULT_FARMING: FarmingSettings = {
  aggregation: "individual",
  play: "solo", playMode: "ap", great: 3, good: 0, miss: 0, missEvery: 0,
  measure: "points", weighted: false, weightPoints: 1, weightItems: 0, weightCp: 0,
  rewardPlan: null, rewardRoomMode: "battle", rewardPlayers: 5, rewardOtherScore: null,
  requireGrowth: true, unknownPolicy: "min", includeMemory: false,
  fullRanking: false, k: 1, timeLimit: null, ptCycle: false,
};
export const CUSTOM_ACCURACY = true;
export const DEFAULT_SETTINGS: BuildSettings = {
  aggregation: "individual",
  rewardMode: "recommendation",
  farming: DEFAULT_FARMING,
  manualScoreMode: "score",
  fullRanking: false,
  ptCycle: false,
  ptMode: "solo",
  ptJust: 25,
  ptSamplingMode: "auto",
  ptLuckSamples: 32,
  goal: "score",
  songs: [],
  criterion: "mean",
  scoreTiming: "nominal",
  frameRate: 60,
  scoreTarget: "none",
  targetScore: null,
  playMode: "ap",
  great: 3,
  good: 0,
  miss: 0,
  missEvery: 0,
  eventId: null,
  manualEventEnabled: false,
  manualEvent: emptyManualEvent(),
  measure: "points",
  weighted: false,
  weightPoints: 1,
  weightItems: 0,
  weightCp: 0,
  rewardPlan: null, rewardRoomMode: "battle", rewardPlayers: 5, rewardOtherScore: null,
  route: "live",
  boosts: 3,
  challengePoints: 200,
  challengeRules: false,
  powerSong: true,
  window: 120,
  planBudget: 100,
  planBoostsPerLive: 3,
  planStartingCp: 0,
  planChallengeSongs: [],
  k: 1,
  unknownPolicy: "max",
  scope: "box",
  leader: null,
  bindings: [],
  required: { members: [], snaps: [] },
  noSnaps: false,
  minBonus: null,
  attributes: [],
  bands: [],
  minRarity: 0,
  timeLimit: null,
  just: 100,
  gekisoRank: 1,
  gekisoRanks: [1, 1, 1],
  gekisoPlacementMode: "rank",
  minComboBonus: 1,
  minMissionMembers: [0, 0, 0],
  justWindowUnit: "percent",
  justWindowPercent: 0,
  justWindowMs: 0,
  gekisoSamplingMode: "auto",
  gekisoSeeds: 0,
  gekisoOpponents: ["", "", ""],
};
export interface BoxFilters {
  kind: "members" | "snaps";
  query: string;
  show: "owned" | "all" | "unowned";
  bands: number[];
  characters: number[];
  attributes: number[];
  rarities: number[];
  facets: Record<string, string[]>;
}
