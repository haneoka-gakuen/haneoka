// L3 — GEB
// Input: Saved activity song decks, optional total-ranking decks, pinned growth sources and native engine updates.
// Output: Native requests, growth neighborhoods and selected-board rank constraints, resumable pages and correlated witnesses for activity growth inference.
// Pos: [Map](L2-2.md); type boundary shared by the dialog and existing Rust/WASM engine adapter.
// Effects/Dependencies: Type declarations only; the native engine owns search, rank caps, exact verification and correlated equivalent decompositions.
import type { SongRankingRowDto } from "./game-records";
import type { EventTeamGrowthSources } from "./event-team-growth-limits";

export interface EventTeamRankRange { min?: number; max?: number }
export interface EventTeamReading { row: SongRankingRowDto; challengeId: number }
export interface EventTeamWitness {
  challengeId: number;
  contextChallengeId: number;
  levels: number[];
  instruments: number[];
  totalRank: { min: number; max: number };
  totalValue?: number;
  outsideRank: { min: number; max: number };
}
export interface EventTeamEquivalent {
  characters: Array<{ id: number; level: number; minLevel?: number; cap: number }>;
  instruments: Array<{ id: number; total: number; minTotal?: number; cap: number }>;
  totalRank: { min: number; max: number };
  witnesses: EventTeamWitness[];
}
export interface EventTeamConfiguration extends Omit<EventTeamEquivalent, "witnesses"> {
  id: string;
  equivalents: EventTeamEquivalent[];
  vipBonus: number;
  matchedChallenges: number[];
  matchedTotal: boolean;
  changed: boolean;
  changeCost: number;
  changedDimensions: number;
}
export interface EventTeamAnalysis {
  status: "ready" | "missingGrowth" | "missingRules" | "noMatch" | "conflictingRecords";
}
export interface EventTeamPreferences {
  vipBonus?: number;
  characterLevels: Record<string, number>;
  instrumentLevels: Record<string, number>;
  characterRadius: number;
  instrumentRadius: number;
  allowGrowth?: boolean;
}
export interface EventTeamGrowthRequest {
  eventId: number;
  asOf: number;
  primaryChallengeId: number;
  rankRange?: EventTeamRankRange;
  preferences?: EventTeamPreferences;
  observations: EventTeamReading[];
  total?: SongRankingRowDto;
  sources: EventTeamGrowthSources;
}
export interface EventTeamSearchResult {
  rows: EventTeamConfiguration[];
  count: number;
  certified: number;
  rejectedChallenges: number[];
  costBound: number;
  minimumCost: number | null;
  costLimit: number | null;
  examinedBoxes: number;
  prunedBoxes: number;
  page: number;
  pageSize: number;
  awaitingPage: boolean;
  hasMore: boolean;
  complete: boolean;
  status: EventTeamAnalysis["status"];
}
export interface EventTeamSearchPage extends EventTeamSearchResult {
  id: number;
}
