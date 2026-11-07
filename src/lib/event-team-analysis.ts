// L3 — GEB
// Input: Saved activity song decks, pinned growth sources and native engine updates.
// Output: Native request and stable configuration/result and correlated-equivalent contracts for activity growth inference.
// Pos: [Map](L2-2.md); type boundary shared by the dialog and existing Rust/WASM engine adapter.
// Effects/Dependencies: Type declarations only; the native engine owns search, rank caps, exact verification and correlated equivalent decompositions.
import type { SongRankingRowDto } from "./game-records";
import type { EventTeamGrowthSources } from "./event-team-growth-limits";

export interface EventTeamReading { row: SongRankingRowDto; challengeId: number }
export interface EventTeamWitness {
  challengeId: number;
  levels: number[];
  instruments: number[];
  totalRank: { min: number; max: number };
  totalValue?: number;
}
export interface EventTeamEquivalent {
  characters: Array<{ id: number; level: number; minLevel?: number; cap: number }>;
  instruments: Array<{ id: number; total: number; minTotal?: number; cap: number }>;
  totalRank: { min: number; max: number };
  witnesses: EventTeamWitness[];
}
export interface EventTeamConfiguration extends EventTeamEquivalent {
  id: string;
  equivalents: EventTeamEquivalent[];
  vipBonus: number;
  matchedChallenges: number[];
  relaxed: boolean;
  changed: boolean;
  changeCost: number;
  changedDimensions: number;
}
export interface EventTeamAnalysis {
  status: "ready" | "missingGrowth" | "missingRules" | "noMatch" | "conflictingRecords";
}
export interface EventTeamGrowthRequest {
  eventId: number;
  asOf: number;
  observations: EventTeamReading[];
  sources: EventTeamGrowthSources;
}
export interface EventTeamSearchResult {
  rows: EventTeamConfiguration[];
  count: number;
  complete: boolean;
  status: EventTeamAnalysis["status"];
}
export interface EventTeamSearchPage extends EventTeamSearchResult {
  id: number;
  page: 0;
}
