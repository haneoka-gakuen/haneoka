import type { EventRankingDto, SongRankingRowDto } from "./game-records";

export type EventCardKind = "member" | "support";
export type EventDeckSlot = { memberId: number; supportId: number | null };
export type EventCardUsage = { id: number; count: number; leaderCount: number; ranks: number[] };
export type EventCardPair = { memberId: number; supportId: number; count: number };
export type EventLevelCount = { level: number; count: number };
export type EventLineup = { members: number[]; slots: EventDeckSlot[]; count: number; ranks: number[] };
type Power = { min: number; max: number; median: number; p90: number; lowest: { rank: number; power: number } };

type TeamStatistics = {
  teamCount: number;
  members: EventCardUsage[];
  supports: EventCardUsage[];
  power: Power | null;
  awaken: EventLevelCount[];
  supportRanks: EventLevelCount[];
};

export type EventCardTier = TeamStatistics & { from: number; to: number };
export type EventCardBoard = TeamStatistics & {
  value: string;
  label: string;
  observedAtMs: number | null;
  lineups: EventLineup[];
  pairs: EventCardPair[];
  tiers: EventCardTier[];
};
export type EventCardAnalysis = {
  selected: EventCardBoard;
  boards: EventCardBoard[];
  acrossSongs: {
    players: number; same: number; reordered: number; changedSupports: number; changedMembers: number; allSongsSame: number;
  };
  unavailable: string[];
};

type CardBoardInput = { value: string; label: string; snapshot: EventRankingDto };
type ObservedTeam = {
  player: string | null;
  rank: number;
  slots: EventDeckSlot[];
  power: number | null;
  awaken: number[];
  supportRanks: number[];
};

function fullTeam(row: SongRankingRowDto, index: number): ObservedTeam[] {
  if (row.cards.length !== 5 || new Set(row.cards.map((card) => card.slot)).size !== 5) return [];
  const ordered = [...row.cards].sort((left, right) => left.slot - right.slot);
  const slots = ordered.flatMap(({ memberCardId, supportCardId }) => memberCardId && memberCardId > 0
    ? [{ memberId: memberCardId, supportId: supportCardId && supportCardId > 0 ? supportCardId : null }] : []);
  if (slots.length !== 5) return [];
  return [{
    player: row.playerId || row.profileId,
    rank: row.rank || index + 1,
    slots,
    power: row.totalPower,
    awaken: ordered.flatMap((card) => card.memberAwakeCount == null ? [] : [card.memberAwakeCount]),
    supportRanks: ordered.flatMap((card) => !card.supportCardId || card.supportRank == null ? [] : [card.supportRank]),
  }];
}

const membersOf = (team: ObservedTeam) => team.slots.map((slot) => slot.memberId).sort((a, b) => a - b);
const pairsOf = (team: ObservedTeam) => team.slots.map((slot) => `${slot.memberId}:${slot.supportId ?? ""}`);

function usage(teams: ObservedTeam[], kind: EventCardKind): EventCardUsage[] {
  const key = kind === "member" ? "memberId" : "supportId";
  const counts = new Map<number, EventCardUsage>();
  for (const team of teams) {
    const seen = new Set(team.slots.map((slot) => slot[key]));
    for (const id of seen) {
      if (id === null) continue;
      const row = counts.get(id) ?? { id, count: 0, leaderCount: 0, ranks: [] };
      row.count++;
      if (team.slots[0]?.[key] === id) row.leaderCount++;
      row.ranks.push(team.rank);
      counts.set(id, row);
    }
  }
  return [...counts.values()].sort((left, right) => right.count - left.count || left.id - right.id);
}

function levelCounts(teams: ObservedTeam[], key: "awaken" | "supportRanks"): EventLevelCount[] {
  const counts = new Map<number, number>();
  for (const team of teams) {
    for (const level of team[key]) counts.set(level, (counts.get(level) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => a - b).map(([level, count]) => ({ level, count }));
}

function teamStatistics(teams: ObservedTeam[]): TeamStatistics {
  const powers = teams.flatMap(({ rank, power }) => power != null && power > 0 ? [{ rank, power }] : [])
    .sort((a, b) => a.power - b.power || a.rank - b.rank);
  const values = powers.map(({ power }) => power);
  const middle = Math.floor(values.length / 2);
  const power = values.length ? {
    min: values[0]!, max: values.at(-1)!, lowest: powers[0]!,
    median: values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2,
    p90: values[Math.ceil(0.9 * values.length) - 1]!,
  } : null;
  return {
    teamCount: teams.length, members: usage(teams, "member"), supports: usage(teams, "support"),
    power, awaken: levelCounts(teams, "awaken"), supportRanks: levelCounts(teams, "supportRanks"),
  };
}

type LineupGroup = { members: number[]; ranks: number[]; variants: Map<string, { slots: EventDeckSlot[]; count: number }> };

function lineups(teams: ObservedTeam[]): EventLineup[] {
  const groups = new Map<string, LineupGroup>();
  for (const team of teams) {
    const members = membersOf(team), key = members.join("/");
    const group: LineupGroup = groups.get(key) ?? { members, ranks: [], variants: new Map() };
    group.ranks.push(team.rank);
    const signature = pairsOf(team).join("/");
    const variant = group.variants.get(signature) ?? { slots: team.slots, count: 0 };
    variant.count++;
    group.variants.set(signature, variant);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const representative = [...group.variants.values()].sort((a, b) => b.count - a.count)[0]!;
    return { members: group.members, slots: representative.slots, count: group.ranks.length, ranks: group.ranks };
  }).sort((a, b) => b.count - a.count || a.ranks[0]! - b.ranks[0]!);
}

function topPairs(teams: ObservedTeam[]): EventCardPair[] {
  const counts = new Map<string, EventCardPair>();
  for (const team of teams) {
    const seen = new Set<string>();
    for (const { memberId, supportId } of team.slots) {
      if (supportId === null) continue;
      const key = `${memberId}:${supportId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = counts.get(key) ?? { memberId, supportId, count: 0 };
      entry.count++;
      counts.set(key, entry);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.memberId - b.memberId || a.supportId - b.supportId);
}

function songChanges(teamsBySong: ObservedTeam[][], complete: boolean): EventCardAnalysis["acrossSongs"] {
  const byPlayer = new Map<string, ObservedTeam[]>();
  for (const teams of teamsBySong) {
    const seen = new Set<string>();
    for (const team of teams) {
      if (!team.player || seen.has(team.player)) continue;
      seen.add(team.player);
      const existing = byPlayer.get(team.player) ?? [];
      existing.push(team);
      byPlayer.set(team.player, existing);
    }
  }
  const result = { players: 0, same: 0, reordered: 0, changedSupports: 0, changedMembers: 0, allSongsSame: 0 };
  for (const teams of byPlayer.values()) {
    if (teams.length < 2) continue;
    result.players++;
    const pairs = teams.map(pairsOf);
    if (new Set(pairs.map((keys) => keys.join("/"))).size === 1) {
      result.same++;
      if (complete && teams.length === teamsBySong.length) result.allSongsSame++;
    } else if (new Set(pairs.map((keys) => [...keys].sort().join("/"))).size === 1) result.reordered++;
    else if (new Set(teams.map((team) => membersOf(team).join("/"))).size === 1) result.changedSupports++;
    else result.changedMembers++;
  }
  return result;
}

export function analyzeEventCards(
  selected: CardBoardInput, others: CardBoardInput[], unavailable: string[],
): EventCardAnalysis {
  const input = [selected, ...others];
  const teamsBySong = input.map(({ snapshot }) => snapshot.rows.slice(0, 100).flatMap(fullTeam));
  const boards = input.map(({ value, label, snapshot }, index): EventCardBoard => {
    const teams = teamsBySong[index]!;
    return {
      value, label, observedAtMs: snapshot.observedAtMs ?? snapshot.fetchedAtMs,
      ...teamStatistics(teams), lineups: lineups(teams), pairs: topPairs(teams),
      tiers: [[1, 20], [21, 50], [51, 100]].map(([from, to]) => ({
        from: from!, to: to!,
        ...teamStatistics(teams.filter((team) => team.rank >= from! && team.rank <= to!)),
      })),
    };
  });
  return { selected: boards[0]!, boards, acrossSongs: songChanges(teamsBySong, !unavailable.length), unavailable };
}
