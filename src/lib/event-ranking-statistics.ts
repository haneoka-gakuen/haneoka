import { exactEventScore } from "./game-event-history";
import { EVENT_HISTORY_MILESTONES, type EventRankingDto, type EventRankMilestoneSample, type SongRankingRowDto } from "./game-records";

export interface StatDistribution {
  min: bigint;
  p25: bigint;
  median: bigint;
  p75: bigint;
  p90: bigint;
  max: bigint;
}

export interface EventBoardStatistics {
  observedAtMs: number | null;
  scores: StatDistribution | null;
  cuts: { rank: number; score: bigint }[];
  histogram: { from: bigint; to: bigint; count: number }[];
}

export type EventBoardComparison = Pick<EventBoardStatistics, "observedAtMs" | "scores" | "cuts"> & {
  label: string;
};

export interface EventCutoffChange {
  rank: number;
  delta: bigint | null;
  growth: number | null;
}

type TrendLine = { rank: number; points: { atMs: number; score: bigint | null; growth: number | null }[] };
export type EventRankingTrend = { fromAtMs: number; toAtMs: number; closed: boolean; lines: TrendLine[]; changes: EventCutoffChange[] };
export type EventSongSurge = {
  label: string; cutoff: bigint | null; change?: EventCutoffChange; periodHours?: number;
};

const positions = [1, 10, 20, 50, 100];
const chartRanks = new Set([10, 50, 100]);

function growthRate(score: bigint, base: bigint) {
  return base > 0n ? Number((score - base) * 1_000_000n / base) / 1_000_000 : null;
}

export function summarizeEventTrend(
  board: EventBoardStatistics, observations: EventRankMilestoneSample[], closed: boolean,
): EventRankingTrend | undefined {
  const toAtMs = board.observedAtMs;
  if (!toAtMs) return;
  const baseline = observations.find((sample) => sample.atMs < toAtMs && sample.scores.some((score) => score !== null));
  if (!baseline) return;
  const lines: TrendLine[] = [];
  const changes = board.cuts.map(({ rank, score }): EventCutoffChange => {
    const index = EVENT_HISTORY_MILESTONES.findIndex((milestone) => milestone === rank);
    const before = baseline.scores[index];
    if (before == null) return { rank, delta: null, growth: null };
    const base = BigInt(before);
    if (chartRanks.has(rank)) {
      const points = observations.filter((sample) => sample.atMs < toAtMs).map(({ atMs, scores }) => {
        const value = scores[index] == null ? null : BigInt(scores[index]!);
        return { atMs, score: value, growth: value == null ? null : growthRate(value, base) };
      });
      points.push({ atMs: toAtMs, score, growth: growthRate(score, base) });
      if (points.some((point) => point.growth !== null)) lines.push({ rank, points });
    }
    return { rank, delta: score - base, growth: growthRate(score, base) };
  });
  return { fromAtMs: baseline.atMs, toAtMs, closed, lines, changes };
}

const rowScore = (row: SongRankingRowDto) => {
  const exact = exactEventScore(row.scoreExact ?? row.score);
  return exact === null ? null : BigInt(exact);
};

export function parseStatsScore(input: string): bigint | null {
  const value = input.normalize("NFKC").replace(/[\s,]/gu, "");
  return /^[0-9]{1,19}$/u.test(value) ? BigInt(value) : null;
}

function distribution(values: bigint[]): StatDistribution | null {
  if (!values.length) return null;
  const percentile = (p: number) => values[Math.ceil(p * values.length) - 1]!;
  const mid = Math.floor(values.length / 2);
  return {
    min: values[0]!, max: values.at(-1)!,
    p25: percentile(0.25), p75: percentile(0.75), p90: percentile(0.9),
    median: values.length % 2 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2n,
  };
}

function histogram(values: bigint[]) {
  if (!values.length) return [];
  const min = values[0]!, max = values.at(-1)!;
  const width = (max - min + 10n) / 10n;
  const bins = Array.from({ length: Number((max - min) / width) + 1 }, (_, index) => {
    const from = min + BigInt(index) * width;
    const upper = from + width - 1n;
    return { from, to: upper > max ? max : upper, count: 0 };
  });
  for (const value of values) bins[Number((value - min) / width)]!.count++;
  return bins;
}

export function summarizeEventBoard(data: EventRankingDto): EventBoardStatistics {
  const rows = data.rows.slice(0, 100);
  const exact = rows.map(rowScore);
  const scores = exact.filter((value): value is bigint => value !== null).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  return {
    observedAtMs: data.observedAtMs ?? data.fetchedAtMs,
    scores: distribution(scores),
    cuts: positions.flatMap((rank) => exact[rank - 1] == null ? [] : [{ rank, score: exact[rank - 1]! }]),
    histogram: histogram(scores),
  };
}

export function eventScorePosition(data: EventRankingDto, score: bigint): number | null {
  const scores = data.rows.slice(0, 100).map(rowScore);
  if (!scores.length || scores.some((value) => value === null)) return null;
  const position = scores.filter((value) => value! > score).length + 1;
  return position <= scores.length || scores.length === 100 ? position : null;
}
