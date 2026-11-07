// L3 — GEB
// Input: A fixed release identity and pinned public growth catalogues.
// Output: Character missions, stamps and friendship rules for the shared Rust engine.
// Pos: [Map](L2-2.md); data inputs for native activity-ranking inverse search.
// Effects/Dependencies: Reads and caches release-pinned public catalogues; rank ceilings are calculated in Rust.
import { dataRows, objectRow, type DataRow, type TeamBuilderData } from "./team-builder/data";

export interface EventTeamGrowthSources {
  missions: DataRow[];
  stamps: DataRow[];
  friendships: DataRow[];
  friendshipRanks: DataRow[];
}
const sourceCache = new Map<string, EventTeamGrowthSources>();
export async function fetchEventTeamGrowthSources(data: TeamBuilderData, signal: AbortSignal): Promise<EventTeamGrowthSources> {
  const { server, releaseId, sourceId } = data.identity, key = `${server}/${releaseId}`;
  const cached = sourceCache.get(key);
  if (cached) return cached;
  const values = await Promise.all(["character-missions", "stamps", "friendships", "progression"].map(async (resource) => {
    const response = await fetch(`/api/v1/servers/${server}/${resource}?release=${encodeURIComponent(releaseId)}`, { signal });
    if (!response.ok || response.headers.get("x-haneoka-release-id") !== releaseId || response.headers.get("x-haneoka-source-id") !== sourceId)
      throw new Error("character-growth-source-unavailable");
    return objectRow(await response.json());
  }));
  const sources = { missions: dataRows(values[0]!.missions), stamps: dataRows(values[1]),
    friendships: dataRows(values[2]!.friendships), friendshipRanks: dataRows(values[3]!.friendshipRanks) };
  signal.throwIfAborted();
  sourceCache.set(key, sources);
  if (sourceCache.size > 4) sourceCache.delete(sourceCache.keys().next().value!);
  return sources;
}
