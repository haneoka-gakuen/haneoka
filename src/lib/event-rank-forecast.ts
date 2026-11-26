import type { EventRankSample } from "./game-records";

const MINUTE = 60_000;
const MAX_GAP = 20 * MINUTE;
const WINDOW = 90 * MINUTE;

/** Extend the recent continuous rank cutoff to the event's deadline. */
export function eventRankForecast(samples: readonly EventRankSample[], endAtMs: number, now: number) {
  const latest = samples.at(-1);
  if (!latest || latest.score === null || latest.atMs > now || now - latest.atMs > MAX_GAP || endAtMs <= now) return;
  let first = latest;
  let firstScore = BigInt(latest.score);
  for (let index = samples.length - 2; index >= 0; index--) {
    const point = samples[index];
    if (point.score === null || first.atMs - point.atMs > MAX_GAP || latest.atMs - point.atMs > WINDOW) break;
    const score = BigInt(point.score);
    if (score > firstScore) break;
    first = point;
    firstScore = score;
  }
  const duration = latest.atMs - first.atMs;
  if (duration < MAX_GAP) return;
  const elapsed = BigInt(duration);
  const score = BigInt(latest.score);
  const gained = score - firstScore;
  return {
    score: score + (gained * BigInt(endAtMs - latest.atMs) + elapsed - 1n) / elapsed,
    gainPerHour: gained * BigInt(60 * MINUTE) / elapsed,
    minutes: Math.round(duration / MINUTE),
  };
}
