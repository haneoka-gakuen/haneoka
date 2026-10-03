import type { EvidenceGap } from "../contracts.ts";
import { nativeRow, objectRow, type DataRow, type TeamBuilderData } from "../data.ts";
import { resolveNativeChallengeMusicTypes } from "./native-music-types.ts";
import { nativeRuleGaps } from "./native-rule-profile.ts";

export interface NativeChallengeMusicTable {
  identity: TeamBuilderData["identity"];
  status: "ready" | "empty" | "missing";
  rows: readonly DataRow[];
}
export interface NativeChallengeContext {
  challengeMusicId: number;
  underlyingSongId: number;
  parameterMusicType: number;
  skillTargetMusicType: number;
  musicTypeBaseBonusBP: number;
  musicTagBaseBonusBP: number;
  bestMusicTagIds: number[];
  liveScoreRankGroup: number;
  missionTypes: [number, number, number];
  missionPattern: 0 | 1 | 2 | 3;
}
const int = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff;
const fail = (code: string, source: string) => ({ value: null, gaps: [{ code, source }] as EvidenceGap[] });

/** Challenge IDs belong to MasterChallengeMusic, while canonical charts and
 * score-rank groups belong to its actual parent MasterLiveMusic. This resolver
 * uses already parsed UTC milliseconds from the same-pin producer; it does not
 * choose a locale column, infer a current server clock or calculate Live score.
 */
export function resolveNativeChallengeContext(
  data: TeamBuilderData,
  table: NativeChallengeMusicTable | undefined,
  selection: { challengeMusicId: number; eventId: number; startTimeMs: number; masterTimeSlot: number },
): { value: NativeChallengeContext | null; gaps: EvidenceGap[] } {
  const ruleGaps = nativeRuleGaps(data.identity, "challenge-context");
  if (ruleGaps.length) return { value: null, gaps: ruleGaps };
  if (!table || table.status === "missing") return fail("native-challenge-music-table-missing", "MasterChallengeMusic");
  if ((table.status === "empty" && table.rows.length) || (table.status === "ready" && !table.rows.length))
    return fail("native-challenge-table-availability-unverified", "MasterChallengeMusic");
  if (
    table.identity.server !== data.identity.server ||
    table.identity.releaseId !== data.identity.releaseId ||
    table.identity.sourceId !== data.identity.sourceId
  )
    return fail("native-challenge-music-table-release-mismatch", table.identity.releaseId);
  if (
    !int(selection.challengeMusicId) ||
    selection.challengeMusicId < 1 ||
    !int(selection.eventId) ||
    selection.eventId < 1 ||
    !Number.isSafeInteger(selection.startTimeMs) ||
    selection.startTimeMs < 0 ||
    !int(selection.masterTimeSlot) ||
    selection.masterTimeSlot > 4
  )
    return fail("native-challenge-selection-unresolved", "challenge/event/start/Master column");
  const rows = table.rows.map(nativeRow).filter((row) => row.id === selection.challengeMusicId);
  if (rows.length !== 1 || rows[0]!.eventId !== selection.eventId)
    return fail("native-challenge-music-event-binding-unresolved", String(selection.challengeMusicId));
  const row = rows[0]!;
  if (!int(row.liveMusicId) || row.liveMusicId < 1)
    return fail("native-challenge-parent-music-unresolved", String(selection.challengeMusicId));
  const parent = data.songs[String(row.liveMusicId)];
  if (
    !parent ||
    !int(parent.liveScoreRankGroup) ||
    parent.liveScoreRankGroup < 1 ||
    !Array.isArray(parent.bestMusicTagIds) ||
    !parent.bestMusicTagIds.every(int)
  )
    return fail("native-challenge-parent-fields-unresolved", String(row.liveMusicId));
  const types = resolveNativeChallengeMusicTypes(
    int(row.musicType) ? row.musicType : null,
    int(parent.musicType) ? parent.musicType : null,
  );
  if (!types.value) return { value: null, gaps: types.gaps };
  const time = (value: unknown) => (Array.isArray(value) ? value[selection.masterTimeSlot] : value);
  const unset = (value: unknown) => value === "" ? null : value;
  const start = unset(time(row.stratAt)),
    end = unset(time(row.endAt));
  if (
    (start !== null && (!Number.isSafeInteger(start) || Number(start) < 0)) ||
    (end !== null && (!Number.isSafeInteger(end) || Number(end) < 0)) ||
    (start !== null && end !== null && Number(end) < Number(start))
  )
    return fail("native-challenge-music-window-unresolved", String(selection.challengeMusicId));
  if (
    (start !== null && selection.startTimeMs < Number(start)) ||
    (end !== null && selection.startTimeMs >= Number(end))
  )
    return fail("native-challenge-music-not-held-at-start", String(selection.challengeMusicId));
  const rawMissions = [row.gekisouMission1, row.gekisouMission2, row.gekisouMission3];
  if (!rawMissions.every(int) || rawMissions.some((value) => Number(value) > 3))
    return fail("native-challenge-mission-context-unresolved", String(selection.challengeMusicId));
  const missions = rawMissions as [number, number, number];
  return {
    value: {
      challengeMusicId: selection.challengeMusicId,
      underlyingSongId: row.liveMusicId,
      parameterMusicType: types.value.parameterMusicType,
      skillTargetMusicType: types.value.skillTargetMusicType,
      musicTypeBaseBonusBP: 0,
      musicTagBaseBonusBP: 0,
      bestMusicTagIds: [...parent.bestMusicTagIds],
      liveScoreRankGroup: parent.liveScoreRankGroup,
    missionTypes: missions as [number, number, number],
    missionPattern: nativeMissionPattern(missions),
    },
    gaps: [],
  };
}

/** Default GetGekisouMissionPattern: a zero means no pattern; three equal
 * nonzero entries are1, all different2, any repeated pair3.
 */
export function nativeMissionPattern(missions: readonly [number, number, number]): 0 | 1 | 2 | 3 {
  if (!missions.every(value => Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff))
    throw new RangeError("native-mission-input");
  if (missions.some(value => value === 0)) return 0;
  const [a,b,c] = missions;
  return a === b && b === c ? 1 : a !== b && a !== c && b !== c ? 2 : 3;
}

/** LiveMusicUtility.GetGekisouSourceMusic default body 0x65d9e4c. Mode3
 * prefers the selected challenge wrapper; an absent wrapper uses the parent.
 */
export function nativeGekisoSourceMusic<T>(nativeLiveMode: number, challenge: T | null, parent: T): T {
  if (!Number.isInteger(nativeLiveMode) || nativeLiveMode < -0x80000000 || nativeLiveMode > 0x7fffffff)
    throw new RangeError("native-live-mode");
  return nativeLiveMode === 3 && challenge !== null ? challenge : parent;
}
