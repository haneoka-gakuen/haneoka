// L3 — GEB
// Input: Exact scores in one event leaderboard window.
// Output: Compact samples for a chronological rank chart and their private R2 key.
// Pos: [Map](L2.md)；活动榜线采集端与读取端共用的归档合同。
// Effects/Dependencies: Reads a compact JSON object from private R2.
import type { GameRecordsRegion } from "../src/lib/game-records";

export const EVENT_RANK_HOUR_MS = 3_600_000;
export const EVENT_RANK_DAY_MS = 24 * EVENT_RANK_HOUR_MS;
export const EVENT_RANK_JST_MS = 9 * EVENT_RANK_HOUR_MS;
export const EVENT_RANK_SAMPLE_MS = 15 * 60_000;
export type EventRankKind = "total" | "challenge" | "point";
export type EventRankIdentity = [GameRecordsRegion, string, EventRankKind, string, number];
export type EventRankPoint = [atMs: number, scores: (string | null)[], pin?: "opening" | "closing" | "final"];
export interface EventRankArchive {
  contract: "haneoka:event-rank-series/1";
  points: EventRankPoint[];
  legacyBefore?: number | null;
}

export const eventRankArchiveKey = ([region, event, kind, challenge, start]: EventRankIdentity) =>
  `official/3/${region}/event-series/${event}/${kind}/${challenge || "_"}/${start}.json`;

export async function readEventRankArchive(bucket: R2Bucket, identity: EventRankIdentity) {
  const object = await bucket.get(eventRankArchiveKey(identity));
  if (!object) return null;
  if (object.size > 8 * 1024 * 1024) throw new Error("event_rank_archive_size");
  const body = object.httpMetadata?.contentEncoding === "gzip"
    ? object.body.pipeThrough(new DecompressionStream("gzip")) : object.body;
  const archive = await new Response(body).json<EventRankArchive>();
  if (archive.contract !== "haneoka:event-rank-series/1" || !Array.isArray(archive.points))
    throw new Error("event_rank_archive_contract");
  return { archive, etag: object.etag };
}

/** Latest real point per hour, then one per Japan-time day after two weeks. */
export function compactEventRankPoints(points: readonly EventRankPoint[], now: number): EventRankPoint[] {
  const slots = new Map<string, EventRankPoint>();
  for (const point of points) {
    const [at, , pin] = point;
    const age = now - at;
    const size = age > 14 * EVENT_RANK_DAY_MS ? EVENT_RANK_DAY_MS : EVENT_RANK_HOUR_MS;
    const key = pin ?? `${size}:${Math.floor((at + EVENT_RANK_JST_MS) / size)}`;
    const current = slots.get(key);
    if (!current || (pin === "opening" || pin === "final" ? at < current[0] : at > current[0])) slots.set(key, point);
  }
  return [...slots.values()].sort((left, right) => right[0] - left[0]);
}
