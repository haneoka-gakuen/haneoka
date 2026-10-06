import type { SongRef } from "../../lib/team-builder/engine/api";

export type Tab = "build" | "box" | "account" | "teams";
export type GoalKind = "score" | "gekiso" | "power" | "event" | "potential" | "plan";
export interface BuildSettings {
  goal: GoalKind;
  songs: SongRef[];
  criterion: "mean" | "min";
  playMode: "ap" | "custom";
  /** Percent of notes, 0–100. */
  great: number;
  good: number;
  miss: number;
  eventId: number | null;
  measure: "points" | "items" | "challenge-points";
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
  noSnaps: boolean;
  minBonus: number | null;
  attributes: number[];
  bands: number[];
  minRarity: number;
  timeLimit: number | null;
  /** Gekisou: share of Just-eligible notes hit Just (percent) and the assumed range placement (1 for Mission). */
  just: number;
  gekisoRank: number;
}
export const DEFAULT_SETTINGS: BuildSettings = {
  goal: "score",
  songs: [],
  criterion: "mean",
  playMode: "ap",
  great: 3,
  good: 0,
  miss: 0,
  eventId: null,
  measure: "points",
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
  k: 5,
  unknownPolicy: "max",
  scope: "box",
  leader: null,
  bindings: [],
  noSnaps: false,
  minBonus: null,
  attributes: [],
  bands: [],
  minRarity: 0,
  timeLimit: null,
  just: 100,
  gekisoRank: 1,
};
export interface BoxFilters {
  kind: "members" | "snaps";
  query: string;
  show: "owned" | "all" | "unowned";
  bands: number[];
  characters: number[];
  attributes: number[];
  rarities: number[];
}
