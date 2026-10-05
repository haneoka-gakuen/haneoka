import { nativeRow, type DataRow } from "../data";

export interface BandRankDisplayData {
  identity: { sourceId?: string };
  progression: { bandRanks?: readonly DataRow[] };
}

/** App.Master.BandRank original constant values (current metadata type19731).
 * Source: T18/player-rank-memory-semantics/current-roster-types.json, enumValues.
 * These are enum labels, not a generated alphabet or a power formula.
 */
const OFFICIAL_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: "D1", 2: "D2", 3: "D3", 4: "D4",
  5: "C1", 6: "C2", 7: "C3", 8: "C4",
  9: "B1", 10: "B2", 11: "B3", 12: "B4",
  13: "A1", 14: "A2", 15: "A3", 16: "A4",
  17: "S1", 18: "S2", 19: "S3", 20: "S4",
  21: "SS1", 22: "SS2", 23: "SS3", 24: "SS4",
});

export interface BandRankDisplayChoice {
  value: number;
  label: string;
  threshold: number;
  sourceTable: "MasterBandRank";
  sourceId: string;
}

/** Only actual source rows enter the slider's legal, numerically ordered domain. */
export function bandRankDisplayChoices(data: BandRankDisplayData): BandRankDisplayChoice[] {
  if (!data.identity.sourceId) return [];
  const choices = new Map<number, BandRankDisplayChoice>();
  for (const original of data.progression.bandRanks ?? []) {
    const row = nativeRow(original), value = row.rank, threshold = row.value;
    if (row.sourceTable !== "MasterBandRank" || typeof value !== "number" || !Number.isSafeInteger(value) ||
        !Object.hasOwn(OFFICIAL_NAMES, value) || typeof threshold !== "number" || !Number.isSafeInteger(threshold) || threshold < 0 || choices.has(value))
      return [];
    choices.set(value, { value, label: OFFICIAL_NAMES[value]!, threshold,
      sourceTable: "MasterBandRank", sourceId: data.identity.sourceId });
  }
  return [...choices.values()].sort((a, b) => a.value - b.value);
}

/** Official enum tags are locale invariant; unknown/unavailable values stay unknown. */
export function bandRankLabel(data: BandRankDisplayData, rank: number | null, _locale?: string): string | null {
  return typeof rank === "number" && Number.isSafeInteger(rank)
    ? bandRankDisplayChoices(data).find(choice => choice.value === rank)?.label ?? null
    : null;
}
