import type { EvidenceGap } from "../contracts.ts";
import { dataRows, nativeRow, objectRow, type TeamBuilderData } from "../data.ts";
import { nativeRuleSupports } from "./native-rule-profile.ts";

export interface NativePersonalSSContext {
  threshold: number | null;
  source: string;
  gaps: EvidenceGap[];
}
const positiveI32 = (value: unknown): value is number => typeof value === "number" &&
  Number.isInteger(value) && value > 0 && value <= 0x7fffffff;

/** Personal rank7 is selected by the parent music's native group. Neither
 * difficulty, event BP nor GK Live ranking reward defines this denominator. */
export function createNativePersonalSSResolver(data: TeamBuilderData) {
  const rows = dataRows(data.liveTools.scoreRanks).map(nativeRow);
  const metadata = objectRow(objectRow(data.liveTools.tableAvailability).scoreRanks);
  const common: EvidenceGap[] = [];
  if (!nativeRuleSupports(data.identity, "personal-solo"))
    common.push({ code: "native-personal-ss-source-unverified", source: "native personal SoloScore rank context" });
  if (Object.keys(metadata).length) {
    const identity = objectRow(metadata.identity);
    if (identity.server !== data.identity.server || identity.releaseId !== data.identity.releaseId ||
      !data.identity.sourceId || identity.sourceId !== data.identity.sourceId || metadata.sourceTable !== "MasterLiveScoreRank")
      common.push({ code: "native-personal-ss-table-source-mismatch", source: "MasterLiveScoreRank" });
    else if (metadata.status !== "ready" || !Array.isArray(data.liveTools.scoreRanks) ||
      metadata.rowCount !== rows.length || rows.length === 0)
      common.push({ code: "native-personal-ss-table-unavailable", source: "MasterLiveScoreRank" });
  }
  return (songId: number): NativePersonalSSContext => {
    const group = data.songs[String(songId)]?.liveScoreRankGroup;
    const selected = rows.filter(row => row.group === group && row.liveScoreRank === 7);
    const source = `MasterLiveMusic:${songId}.liveScoreRankGroup=${String(group)}/MasterLiveScoreRank:rank7.requiredScore`;
    const gaps = [...common];
    if (!positiveI32(group) || selected.length !== 1 || !positiveI32(selected[0]?.requiredScore) ||
      (selected[0]?.sourceTable !== undefined && selected[0].sourceTable !== "MasterLiveScoreRank"))
      gaps.push({ code: "native-personal-ss-rank7-row-unresolved", source });
    return { threshold: gaps.length ? null : selected[0]!.requiredScore as number,
      source: selected.length === 1 ? `${source}/row:${String(selected[0]!.id)}` : source, gaps };
  };
}
