// L3 — GEB
// Input: A release event and its optional official challenge/song identity.
// Output: A release-scoped leaderboard rule and a team-builder link that keeps the source event or regional ranking reachable.
// Pos: [Map](L2-2.md); shared by event details, the tracker and team building.
// Effects/Dependencies: Pure rule lookup and URL construction.
import type { GameRecordsRegion } from "./game-records";

// The JP, TW, EN and KR records archives agree for events 1–6. Older release
// documents serialized a missing disable flag as false, including events 1–3.
const archivedSongTotals = new Map([[1, false], [2, false], [3, false], [4, true], [5, true], [6, true]]);

export function releaseSongTotal(server: string, event: number, published: unknown): boolean | undefined {
  if (server !== "jp" && server !== "intl") return undefined;
  return archivedSongTotals.get(event) ?? (typeof published === "boolean" ? published : undefined);
}

export function eventChallengeHref(locale: string, server: string, event: string | number,
  track?: { id: string | number; musicId: string | number }, region?: GameRecordsRegion, total = false) {
  const params = new URLSearchParams({ tab: "challenge", server, event: String(event) });
  if (track) {
    params.set("challenge", String(track.id));
    params.set("song", String(track.musicId));
  }
  if (total) {
    params.set("ranking", "total");
    if (region) params.set("returnBoard", "total");
  }
  if (region) params.set("region", region);
  return `/${locale}/team-builder/?${params}`;
}
