// L3 — GEB
// Input: Region and event identity for previously observed leaderboard participants.
// Output: A published count of distinct players actually seen in official ranking responses.
// Pos: [Map](L2.md)；活动人数观测的公开读取合同。
// Effects/Dependencies: Reads only a compact aggregate from private R2.
import type { GameRecordsRegion } from "../src/lib/game-records";

export interface EventParticipationObservation {
  contract: "haneoka:event-participation/1";
  region: GameRecordsRegion;
  eventId: string;
  coverage: "observed-lower-bound";
  observedPlayers: number;
  firstObservedAtMs: number;
  lastObservedAtMs: number;
}

export const eventParticipationKey = (region: GameRecordsRegion, eventId: string) =>
  `official/3/${region}/event-participation/${eventId}.json`;

export async function readEventParticipation(bucket: R2Bucket, region: GameRecordsRegion, eventId: string) {
  const object = await bucket.get(eventParticipationKey(region, eventId));
  if (!object) return null;
  if (object.size > 1024) throw new Error("event_participation_size");
  const value = await object.json<EventParticipationObservation>();
  if (value.contract !== "haneoka:event-participation/1" || value.region !== region || value.eventId !== eventId)
    throw new Error("event_participation_identity");
  return value;
}
