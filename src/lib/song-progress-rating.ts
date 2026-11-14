// Input: Published chart levels, Box marks and owned card growth.
// Output: Independent R1 skill summary and ordinary-Live benchmark requests.
// Pos: [Map](L2-2.md); song progress ratings shared by the page and offline reference producer.
// Effects/Dependencies: Pure calculations; the caller owns publication, storage and engine execution.
import type { EngineRequest, SongRef } from "./team-builder/engine/api";
import type { MemberInput, SnapInput } from "./team-builder/engine/box";

export interface RatingChart extends SongRef {
  key: string;
  level: number;
}
export interface SkillBest<T extends RatingChart = RatingChart> {
  chart: T;
  status: number;
  value: number;
}
export function skillRating<T extends RatingChart>(charts: readonly T[], mark: (chart: T) => number) {
  const songs = new Map<number, SkillBest<T>>();
  let ap: number | null = null,
    fc: number | null = null;
  for (const chart of charts) {
    const status = mark(chart);
    if (status < 2) continue;
    if (status >= 3) ap = Math.max(ap ?? 0, chart.level);
    fc = Math.max(fc ?? 0, chart.level);
    const value = status >= 3 ? chart.level : Math.max(0, chart.level - 1);
    const old = songs.get(chart.songId);
    if (
      !old ||
      value > old.value ||
      (value === old.value &&
        (status > old.status || (status === old.status && chart.difficulty > old.chart.difficulty)))
    )
      songs.set(chart.songId, { chart, status, value });
  }
  const best = [...songs.values()]
    .sort((a, b) => b.value - a.value || b.status - a.status || a.chart.songId - b.chart.songId)
    .slice(0, 20);
  return {
    value: best[0]?.value ?? null,
    ap,
    fc,
    best,
    best20: best.length === 20 ? best.reduce((sum, row) => sum + row.value, 0) / 20 : null,
  };
}
export interface RosterReference {
  schema: "haneoka-roster-rating-r1";
  id: string;
  server: string;
  calculatedAt: string;
  identity: { server: string; releaseId: string; sourceId?: string };
  engineRevision: string;
  charts: import("./team-builder/engine/protocol").EngineChart[];
  songs: Record<string, Record<string, unknown>>;
  cases: { song: SongRef; score: number; members: string[]; snaps: (string | null)[] }[];
}
export function rosterRequest(
  members: MemberInput[],
  snaps: SnapInput[],
  songs: SongRef[],
  timeLimitMs: number | null = 30_000,
): EngineRequest {
  return {
    members,
    snaps,
    player: {
      characterRanks: {},
      characterTotalRank: 0,
      bandItems: {},
      vipRank: 1,
      characterMemory: {},
      musicMemory: {},
    },
    unknownPolicy: "max",
    goal: {
      kind: "score",
      songs,
      criterion: "mean",
      play: { great: 0, good: 0, bad: 0, miss: 0 },
      challengeEventId: null,
    },
    constraints: {
      requiredMembers: [],
      excludedMembers: [],
      requiredSnaps: [],
      excludedSnaps: [],
      leader: null,
      bindings: [],
      noSnaps: false,
      minBonusPercent: null,
    },
    k: 1,
    timeLimitMs,
  };
}
export const fullGrowthMember = (cardId: number): MemberInput => ({
  key: `m${cardId}`,
  cardId,
  level: null,
  awake: null,
  rank: null,
  liveSkillLevel: null,
  gekisoSkillLevel: null,
});
export const fullGrowthSnap = (cardId: number): SnapInput => ({ key: `s${cardId}`, cardId, level: null, rank: null });
