import type { EvidenceGap } from "../contracts";
import { dataRows, nativeRow, objectRow, type DataRow, type TeamBuilderData } from "../data";
import { nativeRewardSources } from "./reward-input";
import { nativeRuleSupports } from "../solver/native-rule-profile";
import { resolveChallengeConsumptionChoices } from "./challenge-consumption";

export interface ChallengeMusicTable {
  identity: TeamBuilderData["identity"] & { sourceId: string };
  sourceTable: "MasterChallengeMusic";
  status: "ready" | "empty" | "missing";
  rows: DataRow[];
  gaps: EvidenceGap[];
}
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff;
const gap = (code: string, source: string): EvidenceGap => ({ code, source });

/** Master date strings use the producer's JST clock. Unknown/unset raw strings
 * stay explicit until the native date-loader contract has established them.
 */
function dateMilliseconds(value: unknown, unsetQualified: boolean): unknown {
  if (Array.isArray(value)) return value.map((slot) => dateMilliseconds(slot, unsetQualified));
  if (unsetQualified && value === "") return null;
  if (typeof value !== "string") return value;
  const match = /^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/u.exec(value);
  if (!match) return value;
  const [, year, month, day, hour, minute, second = "00"] = match;
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  const date = new Date(utc);
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) ||
      date.getUTCDate() !== Number(day) || date.getUTCHours() !== Number(hour) ||
      date.getUTCMinutes() !== Number(minute) || date.getUTCSeconds() !== Number(second)) return value;
  return utc - 9 * 60 * 60 * 1000;
}

/** Optional table transport; an absent mirror never becomes a known-empty playlist. */
export function adaptChallengeMusicTable(identity: TeamBuilderData["identity"], value: unknown): ChallengeMusicTable | undefined {
  if (value === undefined || value === null) return undefined;
  const table = objectRow(value), pin = objectRow(table.identity);
  if (!identity.sourceId || pin.server !== identity.server || pin.releaseId !== identity.releaseId || pin.sourceId !== identity.sourceId)
    throw new Error("Challenge music table identity mismatch");
  if (table.sourceTable !== "MasterChallengeMusic" || !["ready", "empty", "missing"].includes(String(table.status)) ||
      !Array.isArray(table.rows) || table.rows.some((row) => !row || typeof row !== "object" || Array.isArray(row)))
    throw new Error("Challenge music table malformed");
  if ((table.status === "ready" && !table.rows.length) || (table.status !== "ready" && table.rows.length))
    throw new Error("Challenge music table status mismatch");
  const gaps: EvidenceGap[] = [];
  const unsetQualified = nativeRuleSupports(identity, "challenge-context");
  const rows = table.rows.map((value) => {
    const row = nativeRow(value);
    const validTime = (value: unknown) => value === null ||
      (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
    for (const field of ["stratAt", "endAt"] as const) {
      row[field] = dateMilliseconds(row[field], unsetQualified);
      const value = row[field];
      if (!(validTime(value) || (Array.isArray(value) && value.length > 0 && value.length <= 5 && value.every(validTime))))
        gaps.push(gap("native-challenge-music-window-unresolved", `MasterChallengeMusic:${row.id}/${field}`));
    }
    return row;
  });
  return {
    identity: structuredClone({ ...identity, sourceId: identity.sourceId }), sourceTable: "MasterChallengeMusic",
    status: table.status as ChallengeMusicTable["status"], rows, gaps,
  };
}

/** Public stage inputs. Legal native cost selection and complete item lottery
 * laws remain separate from observed table rows; their gaps do not erase points/CP.
 */
export function resourcePlannerStageData(data: TeamBuilderData, eventId: number) {
  if (!data.identity.sourceId) throw new Error("Resource stage source identity required");
  const sources = nativeRewardSources(data, null), event = data.events[String(eventId)];
  const normalAvailability = sources.boostTableAvailability.normal;
  const challengeAvailability = sources.boostTableAvailability.challenge;
  const consumption = resolveChallengeConsumptionChoices(data.identity, sources.challengeBoostRows, challengeAvailability);
  const table = data.challengeMusicTable;
  if (table && (table.identity.server !== data.identity.server || table.identity.releaseId !== data.identity.releaseId ||
      table.identity.sourceId !== data.identity.sourceId)) throw new Error("Resource stage challenge table identity mismatch");
  const eventGaps = integer(eventId) && eventId > 0 && event ? [] : [gap("native-held-event-row-missing", String(eventId))];
  const challenges = (table?.rows ?? []).filter((row) => row.eventId === eventId).map((row) => {
    const parent = integer(row.liveMusicId) ? data.songs[String(row.liveMusicId)] : undefined;
    const gaps = [...(table?.gaps.filter((item) => item.source.startsWith(`MasterChallengeMusic:${row.id}/`)) ?? [])];
    if (!integer(row.id) || row.id < 1 || !integer(row.liveMusicId) || row.liveMusicId < 1 || !parent)
      gaps.push(gap("native-challenge-parent-music-unresolved", String(row.id)));
    const difficulties = dataRows(parent?.difficulty).filter((difficulty) =>
      integer(difficulty.difficulty) && integer(difficulty.scoreId) && difficulty.scoreId > 0 &&
      typeof difficulty.file === "string" && difficulty.file.startsWith(`/assets/${data.identity.server}/`),
    );
    if (!difficulties.length) gaps.push(gap("native-challenge-parent-chart-unresolved", String(row.liveMusicId)));
    return {
      challengeMusicId: row.id, underlyingSongId: row.liveMusicId,
      title: structuredClone(parent?.musicTitle), image: parent?.jacketThumbUrl ?? parent?.jacketUrl,
      row: structuredClone(row), difficulties: structuredClone(difficulties), gaps,
    };
  });
  const rewards = sources.events[String(eventId)];
  const item = objectRow(event?.eventItem);
  const resources = new Map<string, { type: number; id: number }>();
  if (integer(item.resourceType) && integer(item.resourceId))
    resources.set(`${item.resourceType}:${item.resourceId}`, { type: item.resourceType, id: item.resourceId });
  for (const row of [...(rewards?.normalItemRows ?? []), ...(rewards?.challengeItemRows ?? [])])
    resources.set(`${row.resourceType}:${row.resourceId}`, { type: row.resourceType, id: row.resourceId });
  return {
    identity: structuredClone(data.identity), eventId,
    normalConsumption: {
      sourceTable: "MasterLiveMusicBoostBonus", status: normalAvailability.status,
      counts: normalAvailability.status === "ready"
        ? [...new Set(sources.normalBoostRows.map((row) => row.consumedCount).filter((count) => count > 0))].sort((a, b) => a - b)
        : null,
      gaps: [...normalAvailability.gaps],
    },
    challengeConsumption: {
      sourceTable: "MasterChallengeMusicBoostBonus", status: challengeAvailability.status,
      multiplierRows: structuredClone(sources.challengeBoostRows), ...consumption,
    },
    challengeMusic: {
      status: table?.status ?? "missing", choices: challenges,
      gaps: [...eventGaps, ...(!table || table.status === "missing" ? [gap("native-challenge-music-table-missing", "MasterChallengeMusic")] : [])],
    },
    items: {
      resources: [...resources.values()],
      selectedResource: integer(item.resourceType) && integer(item.resourceId) ? { type: item.resourceType, id: item.resourceId } : null,
      nativeSelectionLaw: { status: "unverified" as const, gaps: [gap("native-server-item-selection-law-unresolved", "native server EventReward selection")] },
    },
  };
}
