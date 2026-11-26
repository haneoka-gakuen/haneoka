// L3 — GEB
// Input: A release event and its optional official challenge/song identity.
// Output: A team-builder link that keeps the source event or regional ranking reachable.
// Pos: [Map](L2-2.md); shared by event details, the tracker and team building.
// Effects/Dependencies: Pure URL construction.
import type { GameRecordsRegion } from "./game-records";

export function eventChallengeHref(locale: string, server: string, event: string | number,
  track?: { id: string | number; musicId: string | number }, region?: GameRecordsRegion) {
  const params = new URLSearchParams({ tab: "challenge", server, event: String(event) });
  if (track) {
    params.set("challenge", String(track.id));
    params.set("song", String(track.musicId));
  }
  if (region) params.set("region", region);
  return `/${locale}/team-builder/?${params}`;
}
