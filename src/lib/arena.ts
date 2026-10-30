// L3 — GEB
// Input: Release-pinned arena seasons, league regulations and song fields.
// Output: Arena data contract, explicit time windows and effective song rules.
// Pos: [Map](L2-2.md); shared arena semantics for catalogue, calendar and API.
// Effects/Dependencies: Pure calculations; Master civil timestamps use JST.
export const ARENA_PROJECTION = 3;
export type ArenaText = string[];
export type ArenaRow = Record<string, unknown>;
export interface ArenaRule {
  id: number;
  leagueId: number;
  startAt: number;
  endAt: number;
  musicType: number;
  missions: [number, number, number];
}
export interface ArenaReward {
  id: number;
  resourceType: number;
  resourceId: number;
  count: number;
  name: ArenaText;
  image: string;
  href: string;
  leagueId: number;
  rankId: number;
  from: number;
  to: number;
}
export interface ArenaRank {
  id: number;
  name: ArenaText;
  rank: number;
  division: number;
  points: number;
  /** Points a player in this rank starts the next season with. */
  /** AP deducted when the next season starts, by the rank held at season end (0 keeps it). */
  resetPoints: number;
  top: boolean;
  /** When the rank opens; 0 when it is open from the season start. */
  startAt: number;
}
/** Base points for finishing `place` of `players` in a match at `tier`. */
export interface ArenaBasePoint {
  tier: number;
  players: number;
  place: number;
  points: number;
}
export interface ArenaLeague {
  id: number;
  bandId: number;
  name: ArenaText;
  image: string;
  rules: ArenaRule[];
  songs: ArenaRow[];
  ranks: ArenaRank[];
  promotionRewards: ArenaReward[];
}
export interface ArenaSeason extends ArenaRow {
  id: string;
  seasonId: number;
  kind: "arena-season";
  title: ArenaText;
  startAt: number;
  endAt: number;
  rankingEndAt: number;
  timeZone: string;
  leagues: ArenaLeague[];
  dailyRewards: ArenaReward[];
  seasonRewards: ArenaReward[];
  /** Final ranking-position rewards; `from`/`to` are positions, `leagueId` 0 applies to every league. */
  rankingRewards: ArenaReward[];
  events: ArenaRow[];
  exchanges: ArenaRow[];
}
export interface ArenaCatalog {
  schema: "haneoka-arena-v1";
  identity: { server: string; releaseId: string; sourceId: string };
  entries: Record<string, ArenaSeason>;
  images?: { ranks: Record<number, string>; missions: Record<number, string> };
  basePoints?: ArenaBasePoint[];
  /** `arena_*` rule values from MasterParameter, keyed without the prefix. */
  parameters?: Record<string, number>;
}

export function arenaTimestamp(value: unknown): number {
  if (!value) return 0;
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})$/u.exec(String(value));
  if (!match) throw new Error(`Invalid arena Master timestamp: ${String(value)}`);
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]) - 9,
    Number(match[5]),
    Number(match[6]),
  );
}

/** Master endAt is inclusive to its final second. */
export const arenaContains = (window: { startAt: number; endAt: number }, now: number): boolean =>
  window.startAt <= now && now < window.endAt + 1000;

export function arenaCurrentRule(season: ArenaSeason, league: ArenaLeague, now = Date.now()): ArenaRule | undefined {
  if (!arenaContains(season, now)) return undefined;
  for (let index = league.rules.length - 1; index >= 0; index--) {
    const rule = league.rules[index]!;
    if (arenaContains(rule, now)) return rule;
  }
  return undefined;
}

export function arenaSongRule(song: ArenaRow, rule: ArenaRule) {
  const original = (song.arenaMissions || [0, 0, 0]) as number[];
  return {
    musicType: rule.musicType || Number(song.musicType),
    missions: rule.missions.map((value, index) => value || original[index]),
  };
}

export function arenaBoundaries(season: ArenaSeason): number[] {
  return [
    season.startAt,
    season.endAt + 1000,
    ...season.leagues.flatMap((league) => league.rules.flatMap((rule) => [rule.startAt, rule.endAt + 1000])),
    ...season.leagues.flatMap((league) => league.songs.map((song) => Number(song.arenaPublishedAt || 0))),
  ];
}

export function arenaPeriods(season: ArenaSeason) {
  const boundaries = [
    ...new Set(season.leagues.flatMap((league) => league.rules.flatMap((rule) => [rule.startAt, rule.endAt + 1000]))),
  ].sort((a, b) => a - b);
  return boundaries.slice(0, -1).flatMap((startAt, index) => {
    const rules = season.leagues.map((league) => arenaCurrentRule(season, league, startAt));
    return rules.some(Boolean) ? [{ startAt, endAt: boundaries[index + 1]!, rules }] : [];
  });
}

/**
 * The seasons a glance needs (the live one, else the next, else the last), with
 * each league reduced to its name, art and rules: what the home Arena card shows.
 */
export function compactArenaCatalog(catalog: ArenaCatalog, now = Date.now()): ArenaCatalog {
  const seasons = Object.values(catalog.entries).sort((a, b) => a.startAt - b.startAt);
  const season =
    seasons.find((entry) => arenaContains(entry, now)) || seasons.find((entry) => entry.startAt > now) || seasons.at(-1);
  const next = season ? seasons.find((entry) => entry.startAt > season.endAt) : undefined;
  const keep = [season, next].filter((entry): entry is ArenaSeason => Boolean(entry));
  return {
    schema: catalog.schema,
    identity: catalog.identity,
    ...(catalog.images ? { images: { ranks: {}, missions: catalog.images.missions } } : {}),
    entries: Object.fromEntries(
      keep.map((entry) => [
        entry.id,
        {
          ...entry,
          dailyRewards: [],
          seasonRewards: [],
          rankingRewards: [],
          events: [],
          exchanges: [],
          leagues: entry.leagues.map((league) => ({ ...league, songs: [], ranks: [], promotionRewards: [] })),
        },
      ]),
    ),
  };
}

/** The UI marks the Arena rule marks read: stage attribute sprites and their card-attribute fallbacks. */
export function arenaRuleMarkNames(marks: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(marks).filter(([name]) => /^(?:sp_icon_live_music_type_\d+|CardType-[A-Za-z]+)\.png$/u.test(name)),
  );
}
