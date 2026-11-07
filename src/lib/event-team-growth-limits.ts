// L3 — GEB
// Input: Pinned character missions, released collection records, friendship rules and the current observation time.
// Output: Per-character rank ceilings from all currently obtainable character-EXP mission rewards.
// Pos: [Map](L2-2.md); attainable domains for activity-ranking inverse search.
// Effects/Dependencies: Pure cap calculation; the loader reads and caches only release-pinned public catalogues.
import { dataRows, objectRow, type DataRow, type TeamBuilderData } from "./team-builder/data";
import type { EngineMaster } from "./team-builder/engine/master";
import { maxAwake, maxMemberRank, maxSnapRank } from "./team-builder/engine/power";
import { contentPublished } from "./content-publication";

export interface EventTeamGrowthSources {
  missions: DataRow[];
  stamps: DataRow[];
  friendships: DataRow[];
  friendshipRanks: DataRow[];
}
const time = (value: unknown): number => {
  const input = Array.isArray(value) ? value.find((entry) => time(entry) > 0) : value;
  if (typeof input === "number") return input;
  return typeof input === "string" ? Number(input) || Date.parse(input) || 0 : 0;
};

export function eventCharacterRankCaps(data: TeamBuilderData, master: EngineMaster, sources: EventTeamGrowthSources, asOf: number) {
  const caps = new Map<number, number>();
  const friendCap = Math.max(0, ...sources.friendshipRanks.map((row) => Number(row.rank)));
  if (!sources.missions.length || !friendCap) throw new Error("character-growth-rules-missing");
  const counts = new Map<string, { members: number[]; supports: number[]; stamps: number; friendship: number; songs: number }>();
  const maximums = (characterId: number, cutoff: number) => {
    const key = `${characterId}/${cutoff}`;
    const prior = counts.get(key);
    if (prior) return prior;
    const members = Object.values(data.members).filter((card) => card.characterId === characterId && contentPublished(card, cutoff));
    const supports = Object.values(data.snapshots).filter((card) => card.characterIds.includes(characterId) && contentPublished(card, cutoff));
    const songs = new Set(Object.values(data.songs).filter((song) => contentPublished(song, cutoff)).map((song) => Number(song.musicId)));
    for (const challenge of data.challengeMusicTable?.rows ?? []) {
      const event = data.events[String(challenge.eventId)];
      const start = time(challenge.stratAt) || time(event?.startAt);
      if (start > 0 && start <= cutoff) songs.add(Number(challenge.liveMusicId));
    }
    const result = {
      members: members.map((card) => card.id), supports: supports.map((card) => card.id),
      stamps: sources.stamps.filter((stamp) => Array.isArray(stamp.characterIds) &&
        stamp.characterIds.includes(characterId) && contentPublished(stamp, cutoff)).length,
      friendship: sources.friendships.filter((row) => Array.isArray(row.characterIds) && row.characterIds.includes(characterId))
        .filter((row) => (row.characterIds as number[]).every((id) => Object.values(data.members)
          .some((card) => card.characterId === id && contentPublished(card, cutoff)))).length * friendCap,
      songs: songs.size,
    };
    counts.set(key, result);
    return result;
  };
  const rankRows = [...(data.progression.characterRanks ?? [])].sort((a, b) => Number(a.rank) - Number(b.rank));
  for (const id of master.characters.keys()) {
    let exp = 0;
    for (const mission of sources.missions) {
      if (time(mission.startAt) > asOf) continue;
      const reward = dataRows(mission.rewards).reduce((sum, row) =>
        sum + (row.resourceType === 1 && row.resourceId === 4 ? Number(row.resourceCount) : 0), 0);
      if (!reward) continue;
      const end = time(mission.endAt), cutoff = end > 0 ? Math.min(asOf, end) : asOf;
      const available = maximums(id, cutoff), value = Number(mission.value), type = Number(mission.missionType);
      let maximum = 0;
      if (type === 12) maximum = available.members.length;
      else if (type === 14) maximum = available.supports.length;
      else if (type === 16) maximum = available.stamps;
      else if (type === 25) maximum = available.friendship;
      else if (type === 80) maximum = Infinity;
      else if (type === 111) maximum = available.songs;
      else if ([42, 48, 54].includes(type)) {
        for (const cardId of available.members) {
          const card = master.members.get(cardId)!;
          if (type === 48) maximum += Number(maxAwake(master, card) >= value);
          else if (type === 54) maximum += Number(maxMemberRank(master, card) >= value);
          else {
            // Native MemberSkillLevelCountCharacterMission counts leader, LIVE and GEKISO skills independently.
            const leader = Math.max(1, ...[...(master.memberRanks.get(card.rankGroup)?.values() ?? [])].map((rank) => rank.leaderSkillLevel));
            const live = Math.max(1, ...(master.liveSkills.get(card.liveSkillId) ?? []).map((effect) => effect.level));
            const gekiso = Math.max(1, ...(master.gekisoSkills.get(card.gekisoSkillId)?.effects ?? []).map((effect) => effect.level));
            maximum += Number(leader >= value) + Number(live >= value) + Number(gekiso >= value);
          }
        }
      } else if (type === 66) maximum = available.supports.filter((id) => maxSnapRank(master, master.snaps.get(id)!) >= value).length;
      else throw new Error("character-growth-mission-unsupported");
      if (maximum >= Number(mission.achievementCount)) exp += reward;
    }
    const rank = rankRows.filter((row) => Number(row.exp) <= exp).at(-1);
    if (!rank) throw new Error("character-growth-rank-missing");
    caps.set(id, Number(rank.rank));
  }
  return caps;
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
