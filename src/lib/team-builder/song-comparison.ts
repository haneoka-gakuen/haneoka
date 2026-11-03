// L3 — GEB
// Input: 当前资料、已拥有队伍、选定谱面与演奏条件。
// Output: 固定激奏请求、最终结果校验、房间贡献指标与歌曲分组。
// Pos: [Map](L2-2.md)；激奏选曲对比的输入和结果边界。
// Effects/Dependencies: 复用 Box 最低档解析和房间门槛公式；不执行搜索或持久化。
import { activeSongRules, readSongRules, type SongRules } from "./arena";
import { roomRequiredScore } from "../chart-rates";
import type { EngineHit, EngineRequest, EngineResponse, SongRef } from "./engine/api";
import { resolveBox } from "./engine/box";
import { missionPattern } from "./engine/full/gekisou";
import type { EngineMaster } from "./engine/master";
import type { TeamBuilderData } from "./data";
import { engineInputs, type BoxView } from "./sync/box-view";

export interface ComparisonSettings {
  songRules?: SongRules;
  songs: SongRef[];
  target: "S" | "SS";
  players: number;
  mode: "ap" | "custom" | null;
  great: number | null;
  just: number | null;
  missEvery: number | null;
  rank: number | null;
  ranks: [number | null, number | null, number | null];
  sort: "contribution" | "score" | "remaining";
}
export const comparisonDefaults = (): ComparisonSettings => ({
  songs: [],
  target: "SS",
  players: 5,
  mode: null,
  great: 0,
  just: null,
  missEvery: 0,
  rank: null,
  ranks: [null, null, null],
  sort: "contribution",
});
export interface Formation {
  members: (number | null)[];
  snaps: (number | null)[];
  leader: number;
}
export interface ComparisonIssue {
  field: string;
  reason: string;
  slot?: number;
}
export const chartKey = (song: SongRef) => `${song.songId}:${song.difficulty}`;
const percent = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

/** Preferences cross the persisted-document boundary; incomplete fields remain visibly unselected. */
export function readComparisonSettings(value: unknown): ComparisonSettings {
  const defaults = comparisonDefaults();
  if (!value || typeof value !== "object") return defaults;
  const saved = value as Partial<ComparisonSettings>;
  const players = integer(saved.players, 2, 5) ? saved.players : 5;
  const songs = Array.isArray(saved.songs)
    ? saved.songs.filter(
        (song) => song && integer(song.songId, 1, Number.MAX_SAFE_INTEGER) && integer(song.difficulty, 0, 4),
      )
    : [];
  return {
    songs: [
      ...new Map(songs.map((song) => [chartKey(song), { songId: song.songId, difficulty: song.difficulty }])).values(),
    ],
    players,
    songRules: readSongRules(saved.songRules),
    target: saved.target === "S" ? "S" : "SS",
    mode: saved.mode === "ap" || saved.mode === "custom" ? saved.mode : null,
    great: percent(saved.great) ? saved.great : null,
    just: percent(saved.just) ? saved.just : null,
    missEvery: integer(saved.missEvery, 0, Number.MAX_SAFE_INTEGER) ? saved.missEvery : null,
    rank: integer(saved.rank, 1, players) ? saved.rank : null,
    ranks: [0, 1, 2].map(range => {
      const value = Array.isArray(saved.ranks) ? saved.ranks[range] : saved.rank;
      return integer(value, 1, players) ? value : null;
    }) as ComparisonSettings["ranks"],
    sort: saved.sort === "score" || saved.sort === "remaining" ? saved.sort : "contribution",
  };
}

export function fixedFormation(master: EngineMaster, view: BoxView, formation: Formation) {
  const owned = engineInputs(view, true);
  const members = formation.members.flatMap((id) => owned.members.filter((row) => row.cardId === id));
  const snaps = formation.snaps.flatMap((id) => owned.snaps.filter((row) => row.cardId === id));
  const issues: ComparisonIssue[] = [];
  const characters = new Set<number>();
  for (let slot = 0; slot < 5; slot++) {
    const id = formation.members[slot];
    const card = id == null ? undefined : master.members.get(id);
    if (!card || !members.some((row) => row.cardId === id))
      issues.push({ field: `sc-slot-${slot}`, reason: "memberMissing", slot });
    else if (characters.has(card.characterId))
      issues.push({ field: `sc-slot-${slot}`, reason: "duplicateCharacter", slot });
    else characters.add(card.characterId);
    const snap = formation.snaps[slot];
    if (snap !== null && (snap === undefined || !master.snaps.has(snap) || !snaps.some((row) => row.cardId === snap)))
      issues.push({ field: `sc-slot-${slot}`, reason: "snapMissing", slot });
    else if (snap !== null && formation.snaps.indexOf(snap) !== slot)
      issues.push({ field: `sc-slot-${slot}`, reason: "duplicateSnap", slot });
  }
  if (formation.members.length !== 5 || formation.snaps.length !== 5 || !integer(formation.leader, 0, 4))
    issues.push({ field: "sc-formation", reason: "formation" });
  const box = resolveBox(master, members, snaps, "min");
  if (box.unknown.length) issues.push({ field: "sc-formation", reason: "formation" });
  const bindings: [string, string | null][] = formation.members.map((id, index) => [
    `m${id}`,
    formation.snaps[index] === null ? null : `s${formation.snaps[index]}`,
  ]);
  return {
    members,
    snaps,
    player: view.player,
    unknownPolicy: "min" as const,
    box,
    issues,
    bindings,
    leader: `m${formation.members[formation.leader]}`,
  };
}
export type FixedFormation = ReturnType<typeof fixedFormation>;

export function comparisonIssues(s: ComparisonSettings): ComparisonIssue[] {
  const issues: ComparisonIssue[] = [];
  if (!s.songs.length) issues.push({ field: "sc-songs", reason: "songs" });
  if (!integer(s.players, 2, 5)) issues.push({ field: "sc-players", reason: "players" });
  if (!s.mode) issues.push({ field: "sc-mode", reason: "mode" });
  if (!percent(s.just)) issues.push({ field: "sc-just", reason: "percent" });
  if (s.mode === "custom" && !percent(s.great)) issues.push({ field: "sc-great", reason: "percent" });
  if (s.mode === "custom" && !integer(s.missEvery, 0, Number.MAX_SAFE_INTEGER))
    issues.push({ field: "sc-miss", reason: "miss" });
  if (s.ranks.some(rank => !integer(rank, 1, s.players))) issues.push({ field: "sc-rank", reason: "rank" });
  return issues;
}
export function comparisonRequest(
  team: FixedFormation,
  s: ComparisonSettings,
  song: SongRef,
  contextKey: string,
): EngineRequest {
  return {
    songRules: activeSongRules(s.songRules,true),
    members: team.members,
    snaps: team.snaps,
    player: team.player,
    unknownPolicy: "min",
    goal: {
      kind: "gekiso",
      songs: [song],
      criterion: "mean",
      accuracy: {
        great: s.mode === "ap" ? 0 : s.great! / 100,
        just: s.just! / 100,
        missEvery: s.mode === "ap" ? 0 : s.missEvery!,
      },
      rank: s.ranks[0]!,
      ranks: s.ranks as [number, number, number],
      seeds: 0,
    },
    constraints: {
      requiredMembers: team.members.map((row) => row.key),
      excludedMembers: [],
      requiredSnaps: team.snaps.map((row) => row.key),
      excludedSnaps: [],
      leader: team.leader,
      bindings: team.bindings,
      noSnaps: false,
      minBonusPercent: null,
    },
    k: 1,
    timeLimitMs: null,
    requestId: crypto.randomUUID(),
    contextKey,
  };
}

export function availableOnServer(data: TeamBuilderData, collection: string, id: number) {
  return data.crossServer
    ? !!data.crossServer.availability[collection]?.[String(id)]?.includes(data.identity.server)
    : true;
}
export function chartIssue(master: EngineMaster, data: TeamBuilderData, song: SongRef, ranks: readonly (number | null)[], rules?: SongRules): string | null {
  const row = master.songs.get(song.songId);
  if (!row || !availableOnServer(data, "songs", song.songId) || !["jp", "intl"].includes(data.identity.server))
    return "source";
  if (!row.difficulties.find((level) => level.difficulty === song.difficulty)?.file) return "chart";
  const missions = row.gekisoMissions.map((mission,index)=>rules?.missions[index] || mission);
  if (missions.length !== 3 || missions.some((mission) => ![1, 2, 3].includes(mission))) return "missions";
  const pattern = missionPattern(missions[0]!, missions[1]!, missions[2]!);
  if (
    !ranks.every(rank => [1, 2, 3].every((count) =>
      master.live.gekiso.rankingBonuses.some(
        (bonus) =>
          bonus.pattern === pattern && bonus.count === count && bonus.rank === rank && Number.isFinite(bonus.percent),
      ),
    ))
  )
    return "rewards";
  return null;
}

/** Called only for the client's normal final Worker result, before snapshot merging. */
export function acceptComparisonResult(request: EngineRequest, response: EngineResponse): EngineHit {
  const song = request.goal.kind === "gekiso" ? request.goal.songs[0]! : null;
  if (!song || response.error || response.unknownCards.length) throw new Error("incomplete-score");
  const result = response.results.find((row) => row.song && chartKey(row.song) === chartKey(song));
  const hit = result?.hits[0];
  const score = hit?.score;
  const bindings = new Map(request.constraints.bindings);
  if (
    !hit ||
    !hit.song ||
    chartKey(hit.song) !== chartKey(song) ||
    hit.members.length !== 5 ||
    new Set(hit.members).size !== 5 ||
    hit.snaps.length !== 5 ||
    hit.members[0] !== request.constraints.leader ||
    hit.members.some((key, index) => !bindings.has(key) || bindings.get(key) !== hit.snaps[index]) ||
    !score ||
    score.orders.length !== 120 ||
    [...score.orders, score.mean, score.min, score.max, score.median].some(
      (value) => !Number.isFinite(value) || value < 0,
    )
  )
    throw new Error("incomplete-score");
  return structuredClone(hit);
}

export function roomMetrics(base: number | undefined, players: number, personal: number) {
  if (
    !integer(players, 2, 5) ||
    !Number.isFinite(personal) ||
    personal < 0 ||
    base === undefined ||
    !Number.isFinite(base) ||
    base <= 0
  )
    return null;
  const total = roomRequiredScore(base, players);
  if (!Number.isFinite(total) || total <= 0 || total >= 2147483647) return null;
  const average = total / players;
  return {
    total,
    average,
    contribution: (personal / average) * 100,
    remaining: Math.max(0, total - personal) / (players - 1),
  };
}
export function songMetrics(master: EngineMaster, song: SongRef, s: ComparisonSettings, personal: number) {
  const group = master.songs.get(song.songId)?.rankGroup;
  const base =
    group === undefined
      ? undefined
      : master.scoreRanks.get(group)?.find((row) => row.rank === (s.target === "SS" ? 7 : 6))?.battleRequired;
  return roomMetrics(base, s.players, personal);
}

export interface ComparisonRow {
  song: SongRef;
  status: "pending" | "running" | "complete" | "failed" | "cancelled";
  hit?: EngineHit;
  reason?: string;
  elapsedMs?: number;
}
export function groupedSongs(rows: readonly ComparisonRow[], master: EngineMaster, settings: ComparisonSettings) {
  const groups = new Map<number, ComparisonRow[]>();
  for (const row of rows) {
    const group = groups.get(row.song.songId) ?? [];
    group.push(row);
    groups.set(row.song.songId, group);
  }
  const level = (row: ComparisonRow) =>
    master.songs.get(row.song.songId)?.difficulties.find((d) => d.difficulty === row.song.difficulty)?.playLevel ??
    Infinity;
  return [...groups]
    .map(([id, charts]) => {
      const valid = charts.filter(
        (row) =>
          row.status === "complete" && row.hit?.score && songMetrics(master, row.song, settings, row.hit.score.mean),
      );
      valid.sort(
        (a, b) =>
          songMetrics(master, b.song, settings, b.hit!.score!.mean)!.contribution -
            songMetrics(master, a.song, settings, a.hit!.score!.mean)!.contribution ||
          level(a) - level(b) ||
          a.song.difficulty - b.song.difficulty,
      );
      const representative =
        valid[0] ??
        charts
          .filter((row) => row.status === "complete" && row.hit?.score)
          .sort(
            (a, b) =>
              b.hit!.score!.mean - a.hit!.score!.mean || level(a) - level(b) || a.song.difficulty - b.song.difficulty,
          )[0];
      return {
        id,
        charts: [...charts].sort((a, b) => a.song.difficulty - b.song.difficulty),
        representative,
        metrics: representative
          ? songMetrics(master, representative.song, settings, representative.hit!.score!.mean)!
          : null,
      };
    })
    .sort((a, b) => {
      if (!a.metrics || !b.metrics) return Number(!!b.metrics) - Number(!!a.metrics) || a.id - b.id;
      const delta =
        settings.sort === "score"
          ? b.representative!.hit!.score!.mean - a.representative!.hit!.score!.mean
          : settings.sort === "remaining"
            ? a.metrics.remaining - b.metrics.remaining
            : b.metrics.contribution - a.metrics.contribution;
      return delta || a.id - b.id;
    });
}
