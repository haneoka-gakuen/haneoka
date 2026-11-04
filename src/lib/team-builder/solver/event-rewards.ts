import type { EvidenceGap } from "../model.ts";
import { settleEventPoints, settleEventReward } from "../event-settlement.ts";

export interface BoostBonusRow {
  consumedCount: number;
  rewardRate: number;
  playerExpRate: number;
  memberExpRate: number;
  friendshipExpRate: number;
  eventPointRate: number;
}
export interface BoostBonus {
  rewardRate: number;
  playerExpRate: number;
  memberExpRate: number;
  friendshipExpRate: number;
  eventPointRate: number;
}
export interface NativeLeafResult<T> {
  value: T | null;
  gaps: EvidenceGap[];
}
const integer = (value: number): number => {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new RangeError("reward-int32-input");
  return value;
};
const allOne = (): BoostBonus => ({
  rewardRate: 1,
  playerExpRate: 1,
  memberExpRate: 1,
  friendshipExpRate: 1,
  eventPointRate: 1,
});

/** CalculateBoostBonus / CalculateChallengePointBonus: exact Master lookup.
 * Ordinary count<1 and challenge count<201 use the native all-one tuple.
 */
export function resolveBoostBonus(
  mode: "normal" | "challenge",
  consumedCount: number,
  rows: readonly BoostBonusRow[],
): NativeLeafResult<BoostBonus> {
  integer(consumedCount);
  if (consumedCount < (mode === "challenge" ? 201 : 1)) return { value: allOne(), gaps: [] };
  const row = rows.find((entry) => entry.consumedCount === consumedCount);
  if (!row) return { value: null, gaps: [{ code: "native-boost-row-missing", source: `${mode}:${consumedCount}` }] };
  const { rewardRate, playerExpRate, memberExpRate, friendshipExpRate, eventPointRate } = row;
  for (const value of [rewardRate, playerExpRate, memberExpRate, friendshipExpRate, eventPointRate]) integer(value);
  return { value: { rewardRate, playerExpRate, memberExpRate, friendshipExpRate, eventPointRate }, gaps: [] };
}
/** ApplyEventBonus widens the product before division, then caps the result. */
function eventAmount(bonusBP: number, rate: number, baseAmount: number): number {
  integer(bonusBP);
  integer(rate);
  integer(baseAmount);
  return settleEventReward(baseAmount, bonusBP, rate);
}
export function calcClientEventPoints(pointBonusBP: number, eventPointRate: number, baseRankPoint: number): number {
  return settleEventPoints(integer(baseRankPoint), integer(pointBonusBP), integer(eventPointRate));
}
/** ConsumeLiveBoost: MasterLiveChallengePoint.Value uses the resolved Boost
 * eventPointRate directly. Member/snapshot point bonuses do not enter CP.
 */
export function calcClientChallengePointGain(baseRankCP: number, eventPointRate: number): number {
  integer(baseRankCP);
  integer(eventPointRate);
  return Math.imul(baseRankCP, eventPointRate);
}
/** Native madd32 followed by ChallengeLive's direct integer setter. */
export function updateClientChallengePointBalance(current: number, baseRankCP: number, eventPointRate: number): number {
  integer(current);
  return (current + calcClientChallengePointGain(baseRankCP, eventPointRate)) | 0;
}
export interface SelectedEventReward {
  rewardId: number;
  resourceType: number;
  resourceId: number;
  count: number;
}
export interface SelectedEventItemAmount extends SelectedEventReward {
  amount: number;
}
/** The server's selected reward ID is required; probability is not rolled here. */
export function calcSelectedEventItemAmount(
  selectedRewardId: number | null,
  itemBonusBP: number,
  rewardRate: number,
  rows: readonly SelectedEventReward[],
): NativeLeafResult<SelectedEventItemAmount> {
  if (selectedRewardId === null)
    return {
      value: null,
      gaps: [{ code: "selected-event-reward-id-unresolved", source: "native server EventReward.RewardId" }],
    };
  const row = rows.find((entry) => entry.rewardId === selectedRewardId);
  if (!row)
    return { value: null, gaps: [{ code: "selected-event-reward-row-missing", source: String(selectedRewardId) }] };
  return { value: { ...row, amount: eventAmount(itemBonusBP, rewardRate, row.count) }, gaps: [] };
}
/** ChallengeLive.ConsumeChallengeLivePoint: signed i32 subtraction, zero floor. */
export function consumeChallengePoint(current: number, configuredConsumption: number): number {
  integer(current);
  integer(configuredConsumption);
  return Math.max((current - configuredConsumption) | 0, 0);
}
export interface NativeEventEffect {
  eventId: number;
  bonusType: 0 | 1 | 2;
  resourceTypeConstraint: number;
  characterId: number;
  bandId: number;
  cardType: number;
  tagId: number;
  memberCardId: number;
  supportCardId: number;
  rankValues: [number, number, number, number, number];
}
export interface EventMember {
  cardId: number;
  characterId: number;
  bandId: number | null;
  cardType: number;
  musicTagIds: number[];
  rank: number;
}
export interface EventSnapshot {
  cardId: number;
  characterIds: number[];
  bandIds: number[];
  cardType: number;
  rank: number;
}
function rankValue(effect: NativeEventEffect, rank: number): number {
  if (!Number.isInteger(rank) || rank < 1 || rank > 5) throw new RangeError("event-rank");
  return integer(effect.rankValues[rank - 1]!);
}
function memberMatches(effect: NativeEventEffect, member: EventMember): boolean {
  if (effect.resourceTypeConstraint !== 2) return false;
  if (effect.characterId >= 1 && effect.characterId !== member.characterId) return false;
  if (effect.bandId >= 1 && member.bandId === null) throw new RangeError("event-member-band-unresolved");
  return (
    (effect.characterId < 1 || effect.characterId === member.characterId) &&
    (effect.bandId < 1 || effect.bandId === member.bandId) &&
    (!effect.cardType || effect.cardType === member.cardType) &&
    (effect.tagId < 1 || member.musicTagIds.includes(effect.tagId)) &&
    (effect.memberCardId < 1 || effect.memberCardId === member.cardId)
  );
}
function snapshotMatches(effect: NativeEventEffect, snapshot: EventSnapshot): boolean {
  return (
    effect.resourceTypeConstraint === 3 &&
    effect.tagId < 1 &&
    (effect.characterId < 1 || snapshot.characterIds.includes(effect.characterId)) &&
    (effect.bandId < 1 || snapshot.bandIds.includes(effect.bandId)) &&
    (!effect.cardType || effect.cardType === snapshot.cardType) &&
    (effect.supportCardId < 1 || effect.supportCardId === snapshot.cardId)
  );
}
/** Native default body adds every matching row for every card/event, using i32.
 * The caller has already selected held events against liveStartServerTime.
 */
export function sumEventEffectBP(
  effects: readonly NativeEventEffect[],
  members: readonly (EventMember | null)[],
  snapshots: readonly (EventSnapshot | null)[],
  bonusType: 0 | 1 | 2,
): number {
  let total = 0;
  for (const effect of effects) {
    if (effect.bonusType !== bonusType) continue;
    for (const member of members)
      if (member && memberMatches(effect, member)) total = (total + rankValue(effect, member.rank)) | 0;
    for (const snapshot of snapshots)
      if (snapshot && snapshotMatches(effect, snapshot)) total = (total + rankValue(effect, snapshot.rank)) | 0;
  }
  return total;
}
