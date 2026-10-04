import type { EvidenceGap, ReleaseIdentity, TeamAssignment } from "../contracts.ts";
import { dataRows, nativeRow, objectRow, type DataRow, type TeamBuilderData } from "../data.ts";
import type { InventoryV1 } from "../inventory.ts";
import {
  calcClientChallengePointGain,
  calcClientEventPoints,
  calcSelectedEventItemAmount,
  resolveBoostBonus,
  sumEventEffectBP,
  type BoostBonusRow,
  type EventMember,
  type EventSnapshot,
  type NativeEventEffect,
  type NativeLeafResult,
  type SelectedEventItemAmount,
  type SelectedEventReward,
} from "./event-rewards.ts";
import { resolveNativeScoreRank, type NativeRankInput, type NativeScoreRankRow } from "./score-ranks.ts";
import type { FixedPlayRewardOutcome } from "./resource-cycle.ts";
import { nativeRuleGaps } from "./native-rule-profile.ts";

type Identity = ReleaseIdentity & { sourceId: string };
export interface NativeEventPayoutScenario {
  /** One explicitly selected held event. Automatic server-time selection is separate. */
  eventId: number;
  songId: number;
  kind: "normal" | "challenge";
  consumption: number;
  /** Global MasterLiveChallengePoint, not an event reward group. */
  challengePointTable?: { identity: Identity; rows: readonly DataRow[] };
}
export interface NativeEventPlayOutcome {
  probability: number;
  /** Complete play result, before time/consumption normalization. */
  performance: Omit<NativeRankInput, "rows">;
  /** Actual or explicitly supplied joint server-selection outcome. */
  selectedRewardId: number | null;
}
export interface NativeEventPayout {
  rank: number | null;
  eventPoints: NativeLeafResult<number>;
  eventItem: NativeLeafResult<SelectedEventItemAmount>;
  challengePoints: NativeLeafResult<number>;
  assumptions: string[];
}
const i32 = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
const positive = (value: unknown): value is number => i32(value) && value > 0;
const gap = (code: string, source: string): EvidenceGap => ({ code, source });
const unavailable = <T>(gaps: EvidenceGap[]): NativeLeafResult<T> => ({ value: null, gaps: [...gaps] });
const identityMatches = (left: TeamBuilderData["identity"], right: Identity) =>
  left.server === right.server && left.releaseId === right.releaseId && left.sourceId === right.sourceId;

/** Same-pin event tables are prepared once. Every complete score outcome is
 * ranked and rounded independently; averaging a score before rank lookup loses
 * tier crossings. Reward IDs stay joint with their performance outcome.
 */
export function createNativeEventPayoutResolver(
  data: TeamBuilderData,
  inventory: InventoryV1,
  scenario: NativeEventPayoutScenario,
) {
  const gaps: EvidenceGap[] = [];
  const pointGaps: EvidenceGap[] = [],
    itemGaps: EvidenceGap[] = [];
  gaps.push(...nativeRuleGaps(data.identity, "ordinary-event-points"));
  if (data.identity.server !== inventory.server || data.identity.releaseId !== inventory.releaseId)
    gaps.push(gap("native-event-inventory-release-mismatch", inventory.releaseId));
  if (
    new Set(inventory.members.map((row) => row.instanceId)).size !== inventory.members.length ||
    new Set(inventory.snapshots.map((row) => row.instanceId)).size !== inventory.snapshots.length ||
    new Set(inventory.members.map((row) => row.cardId)).size !== inventory.members.length ||
    new Set(inventory.snapshots.map((row) => row.cardId)).size !== inventory.snapshots.length
  )
    gaps.push(gap("native-event-inventory-identity-ambiguous", "owned member/photo records"));
  if (
    !positive(scenario.eventId) ||
    !positive(scenario.songId) ||
    !["normal", "challenge"].includes(scenario.kind) ||
    !i32(scenario.consumption) ||
    scenario.consumption < 0
  )
    gaps.push(gap("native-event-scenario-unresolved", "event/song/consumption"));
  const event = data.events[String(scenario.eventId)];
  const tables = objectRow(event?.tables ?? event?.support),
    groups = objectRow(event?.rewardGroups);
  if (!event || event.detailStatus !== "loaded")
    gaps.push(gap("native-event-detail-unresolved", String(scenario.eventId)));
  const rows = (key: string, targetGaps = gaps): DataRow[] => {
    if (!Array.isArray(tables[key])) targetGaps.push(gap("native-event-table-missing", key));
    return dataRows(tables[key]).map(nativeRow);
  };
  const effects: NativeEventEffect[] = [];
  for (const row of rows("MasterEventEffect")) {
    const fields = [
      row.eventId,
      row.eventBonusType,
      row.resourceTypeConstraint,
      row.characterId,
      row.bandId,
      row.cardType,
      row.tagId,
      row.memberCardId,
      row.supportCardId,
      ...[1, 2, 3, 4, 5].map((rank) => row[`rank${rank}EffectValue`]),
    ];
    if (fields.some((value) => !i32(value)) || ![0, 1, 2].includes(Number(row.eventBonusType))) {
      gaps.push(gap("native-event-effect-row-unresolved", String(row.id)));
      continue;
    }
    if (row.eventId !== scenario.eventId) continue;
    effects.push({
      eventId: row.eventId as number,
      bonusType: row.eventBonusType as 0 | 1 | 2,
      resourceTypeConstraint: row.resourceTypeConstraint as number,
      characterId: row.characterId as number,
      bandId: row.bandId as number,
      cardType: row.cardType as number,
      tagId: row.tagId as number,
      memberCardId: row.memberCardId as number,
      supportCardId: row.supportCardId as number,
      rankValues: [1, 2, 3, 4, 5].map((rank) => row[`rank${rank}EffectValue`]) as NativeEventEffect["rankValues"],
    });
  }
  const pointTable = scenario.kind === "normal" ? "MasterLiveEventPoint" : "MasterChallengeLiveEventPoint";
  const powerGaps = [...gaps];
  const rewardTable = scenario.kind === "normal" ? "MasterLiveEventReward" : "MasterChallengeLiveEventReward";
  const pointGroup = groups[scenario.kind === "normal" ? "liveEventPoint" : "challengeLiveEventPoint"];
  const rewardGroup = groups[scenario.kind === "normal" ? "liveEventReward" : "challengeLiveEventReward"];
  if (!positive(pointGroup)) pointGaps.push(gap("native-event-point-group-unresolved", String(scenario.eventId)));
  if (!positive(rewardGroup)) itemGaps.push(gap("native-event-item-group-unresolved", String(scenario.eventId)));
  const points = rows(pointTable, pointGaps).filter((row) => row.group === pointGroup);
  if (
    points.some((row) => !i32(row.scoreRank) || !i32(row.value)) ||
    new Set(points.map((row) => row.scoreRank)).size !== points.length
  )
    pointGaps.push(gap("native-event-point-rows-unresolved", pointTable));
  const rewards: SelectedEventReward[] = [];
  for (const row of rows(rewardTable, itemGaps)) {
    if (row.eventGroup !== rewardGroup) continue;
    if (![row.id, row.resourceType, row.resourceId, row.resourceCount].every(i32)) {
      itemGaps.push(gap("native-event-reward-row-unresolved", String(row.id)));
      continue;
    }
    rewards.push({
      rewardId: row.id as number,
      resourceType: row.resourceType as number,
      resourceId: row.resourceId as number,
      count: row.resourceCount as number,
    });
  }
  if (new Set(rewards.map((row) => row.rewardId)).size !== rewards.length)
    itemGaps.push(gap("native-event-reward-id-ambiguous", rewardTable));
  const rankGroup = data.songs[String(scenario.songId)]?.liveScoreRankGroup;
  const ranks: NativeScoreRankRow[] = dataRows(data.liveTools.scoreRanks)
    .map(nativeRow)
    .filter((row) => row.group === rankGroup)
    .map((row) => ({
      rank: Number(row.liveScoreRank),
      requiredScore: Number(row.requiredScore),
      battleRequiredScore: Number(row.battleLiveRequiredScore),
    }));
  if (
    !positive(rankGroup) ||
    !ranks.length ||
    ranks.some((row) => !i32(row.rank) || !i32(row.requiredScore) || !i32(row.battleRequiredScore)) ||
    new Set(ranks.map((row) => row.rank)).size !== ranks.length
  )
    gaps.push(gap("native-event-score-rank-group-unresolved", String(rankGroup)));
  const boostRows: BoostBonusRow[] = dataRows(
    data.liveTools[scenario.kind === "normal" ? "liveBoostBonuses" : "challengeBoostBonuses"],
  )
    .map(nativeRow)
    .map((row) => ({
      consumedCount: Number(row[scenario.kind === "normal" ? "consumedLiveBoostCount" : "consumedChallengePointCount"]),
      rewardRate: Number(row.liveMusicRewardRate),
      playerExpRate: Number(row.playerExpRate),
      memberExpRate: Number(row.memberCardExpRate),
      friendshipExpRate: Number(row.friendshipExpRate),
      eventPointRate: Number(row.eventPointRate),
    }));
  let boost: ReturnType<typeof resolveBoostBonus> = unavailable(gaps);
  try {
    boost = resolveBoostBonus(scenario.kind, scenario.consumption, boostRows);
  } catch {
    gaps.push(gap("native-event-boost-row-unresolved", "same-pin consumption boost"));
  }
  gaps.push(...boost.gaps);
  const cpRows = scenario.challengePointTable?.rows.map(nativeRow);
  const cpGaps =
    scenario.kind === "challenge"
      ? []
      : !scenario.challengePointTable
        ? [gap("native-challenge-point-table-missing", "MasterLiveChallengePoint")]
        : !identityMatches(data.identity, scenario.challengePointTable.identity)
          ? [gap("native-challenge-point-table-release-mismatch", scenario.challengePointTable.identity.releaseId)]
          : cpRows!.some((row) => !i32(row.scoreRank) || !i32(row.value)) ||
              new Set(cpRows!.map((row) => row.scoreRank)).size !== cpRows!.length
            ? [gap("native-challenge-point-rows-unresolved", "MasterLiveChallengePoint")]
            : [];
  const members = new Map<string, EventMember>();
  for (const state of inventory.members) {
    const card = data.members[String(state.cardId)];
    if (
      !card ||
      !Array.isArray(card.bestMusicTagIds) ||
      !card.bestMusicTagIds.every(positive) ||
      !positive(data.characters[String(card.characterId)]?.bandId) ||
      data.characters[String(card.characterId)]?.bandId !== card.bandId ||
      ![card.id, card.characterId, card.bandId, card.attribute, state.awakening].every(i32) ||
      state.awakening === null ||
      state.awakening < 1 ||
      state.awakening > 5
    )
      continue;
    members.set(state.instanceId, {
      cardId: card.id,
      characterId: card.characterId,
      bandId: card.bandId,
      cardType: card.attribute,
      musicTagIds: card.bestMusicTagIds,
      rank: state.awakening,
    });
  }
  const snapshots = new Map<string, EventSnapshot>();
  for (const state of inventory.snapshots) {
    const card = data.snapshots[String(state.cardId)];
    if (
      !card ||
      !Array.isArray(card.characterIds) ||
      !card.characterIds.every(positive) ||
      ![card.id, card.attribute, state.awakening].every(i32) ||
      state.awakening === null ||
      state.awakening < 1 ||
      state.awakening > 5
    )
      continue;
    const bands = card.characterIds.map((id) => data.characters[String(id)]?.bandId);
    if (!bands.every(i32)) continue;
    snapshots.set(state.instanceId, {
      cardId: card.id,
      characterIds: card.characterIds,
      bandIds: bands as number[],
      cardType: card.attribute,
      rank: state.awakening,
    });
  }
  const bonuses = new Map<string, NativeLeafResult<{ points: number; items: number }>>();
  const formationBonus = (assignment: TeamAssignment) => {
    const key = JSON.stringify(assignment),
      cached = bonuses.get(key);
    if (cached) return cached;
    const selected = assignment.memberInstanceIds.map((id) => members.get(id)),
      photos = assignment.snapshotInstanceIds.map((id) => (id === null ? null : snapshots.get(id)));
    let result: NativeLeafResult<{ points: number; items: number }>;
    if (
      selected.length !== 5 ||
      photos.length !== 5 ||
      selected.some((row) => !row) ||
      photos.some((row) => row === undefined) ||
      !assignment.memberInstanceIds.includes(assignment.leaderInstanceId) ||
      new Set(selected.map((row) => row?.cardId)).size !== 5 ||
      new Set(selected.map((row) => row?.characterId)).size !== 5 ||
      new Set(photos.filter((row) => row !== null).map((row) => row?.cardId)).size !==
        photos.filter((row) => row !== null).length
    )
      result = unavailable([gap("native-event-formation-unresolved", "selected five members/photos/ranks")]);
    else {
      try {
        result = {
          value: {
            points: sumEventEffectBP(effects, selected as EventMember[], photos as (EventSnapshot | null)[], 0),
            items: sumEventEffectBP(effects, selected as EventMember[], photos as (EventSnapshot | null)[], 1),
          },
          gaps: [],
        };
      } catch {
        result = unavailable([gap("native-event-bonus-subject-unresolved", "selected formation")]);
      }
    }
    if (bonuses.size >= 512) bonuses.delete(bonuses.keys().next().value!);
    bonuses.set(key, result);
    return result;
  };
  const resolve = (
    assignment: TeamAssignment,
    performance: Omit<NativeRankInput, "rows">,
    selectedRewardId: number | null,
  ): NativeEventPayout => {
    const local = [...gaps, ...formationBonus(assignment).gaps],
      bonus = formationBonus(assignment).value;
    if (!i32(performance.nativeLiveMode) || performance.nativeLiveMode < 0)
      local.push(gap("native-event-live-mode-unresolved", "complete play nativeLiveMode"));
    let rank: ReturnType<typeof resolveNativeScoreRank> | null = null;
    try {
      rank = resolveNativeScoreRank({ ...performance, rows: ranks });
      local.push(...rank.gaps);
    } catch {
      local.push(gap("native-event-play-rank-unresolved", "complete personal/room result"));
    }
    if (local.length || !bonus || !boost.value || rank?.rank === null || !rank)
      return {
        rank: rank?.rank ?? null,
        eventPoints: unavailable(local),
        eventItem: unavailable(local),
        challengePoints: unavailable(local),
        assumptions: ["explicit-single-held-event"],
      };
    const row = points.find((row) => row.scoreRank === rank!.rank);
    const eventPoints: NativeLeafResult<number> = pointGaps.length
      ? unavailable(pointGaps)
      : row
        ? { value: calcClientEventPoints(bonus.points, boost.value.eventPointRate, row.value as number), gaps: [] }
        : unavailable([gap("native-event-point-rank-missing", `${pointTable}:${rank.rank}`)]);
    const eventItem = itemGaps.length
      ? unavailable<SelectedEventItemAmount>(itemGaps)
      : calcSelectedEventItemAmount(selectedRewardId, bonus.items, boost.value.rewardRate, rewards);
    const cp = cpRows?.find((row) => row.scoreRank === rank!.rank);
    const challengePoints: NativeLeafResult<number> =
      scenario.kind === "challenge"
        ? { value: 0, gaps: [] }
        : cpGaps.length
          ? unavailable(cpGaps)
          : cp
            ? { value: calcClientChallengePointGain(cp.value as number, boost.value.eventPointRate), gaps: [] }
            : unavailable([gap("native-challenge-point-rank-missing", String(rank.rank))]);
    return {
      rank: rank.rank,
      eventPoints,
      eventItem,
      challengePoints,
      assumptions: ["explicit-single-held-event", "explicit-joint-server-reward-selection"],
    };
  };
  return {
    identity: { ...data.identity },
    gaps,
    powerGaps,
    pointGaps,
    itemGaps,
    challengePointGaps: cpGaps,
    resolve,
    /** Formation bonus floors consume these BP sums, before score rank, boost
     * or future server reward selection. Item BP can be known with item count unknown. */
    resolveBonuses(assignment: TeamAssignment): NativeLeafResult<{ points: number; items: number }> {
      const formation = formationBonus(assignment);
      const local = [...powerGaps, ...formation.gaps];
      return local.length || !formation.value ? unavailable(local)
        : { value: { ...formation.value }, gaps: [] };
    },
    /** Each card's power effect is applied at its own native slot, before the
     * separately floored rank/photo/band/leader contributions.
     */
    resolvePower(assignment: TeamAssignment): NativeLeafResult<{ memberBP: number[]; snapshotBP: number[] }> {
      const local = [...powerGaps, ...formationBonus(assignment).gaps];
      if (local.length) return unavailable(local);
      return {
        value: {
          memberBP: assignment.memberInstanceIds.map((id) => sumEventEffectBP(effects, [members.get(id)!], [], 2)),
          snapshotBP: assignment.snapshotInstanceIds.map((id) =>
            id === null ? 0 : sumEventEffectBP(effects, [], [snapshots.get(id)!], 2),
          ),
        },
        gaps: [],
      };
    },
    resolveLaw(
      assignment: TeamAssignment,
      outcomes: readonly NativeEventPlayOutcome[],
      resource: { type: number; id: number },
    ): NativeLeafResult<FixedPlayRewardOutcome[]> {
      if (
        !outcomes.length ||
        outcomes.length > 10000 ||
        outcomes.some((row) => !Number.isFinite(row.probability) || row.probability < 0) ||
        Math.abs(outcomes.reduce((sum, row) => sum + row.probability, 0) - 1) > 1e-12
      )
        return unavailable([gap("native-event-complete-play-law-unresolved", "probability mass")]);
      const law: FixedPlayRewardOutcome[] = [],
        local: EvidenceGap[] = [];
      for (const outcome of outcomes) {
        if (outcome.probability === 0) continue;
        const payout = resolve(assignment, outcome.performance, outcome.selectedRewardId);
        local.push(...payout.eventPoints.gaps, ...payout.eventItem.gaps, ...payout.challengePoints.gaps);
        if (
          payout.eventPoints.value === null ||
          payout.eventItem.value === null ||
          payout.challengePoints.value === null
        )
          continue;
        if (
          payout.eventItem.value.resourceType !== resource.type ||
          payout.eventItem.value.resourceId !== resource.id
        ) {
          local.push(gap("native-event-reward-resource-mismatch", "selected item type/id"));
          continue;
        }
        law.push({
          probability: outcome.probability,
          eventPoints: payout.eventPoints.value,
          eventItems: payout.eventItem.value.amount,
          challengePoints: payout.challengePoints.value,
        });
      }
      return local.length ? unavailable(local) : { value: law, gaps: [] };
    },
  };
}
