import { calcNativeNoteScore, nativeLuckFactorPercent, type NativeNoteScoreInput } from "../score.ts";
import { resolveGekisoRankingBonus, type GekisoResolved, type GekisoRules } from "./gekiso-mission-luck.ts";

export interface GekisoLuckLiveScoreSample {
  timeMs: number;
  /** Both values have already passed the original two note-score floors. */
  idleScore: number;
  rushScore: number;
}
export interface GekisoLuckLiveScorePlan {
  projection: "score-law" | "score-expectation";
  initialScore: number;
  expectedNoteCount: number;
  /** Score-calculator sample order, after this frame's Luck updates. */
  frames: readonly (readonly GekisoLuckLiveScoreSample[])[];
  ranges: readonly { startTimeMs: number; endTimeMs: number; rank: number }[];
  /** Expectation only: resolve score/rank gains relative to these known base residues. */
  rankBaseRemainders?: readonly [number, number, number];
}
export interface GekisoLuckLiveScoreLedger {
  rushAtScoredTime: boolean;
  rushCommands: readonly { timeMs: number; active: boolean }[];
  lastScoredMs: number;
  score: number;
  /** Full integers for score-law; exact payout residues for score-expectation. */
  rangeScores: readonly [number, number, number];
}
export interface PreparedGekisoLuckLiveScore {
  plan: GekisoLuckLiveScorePlan;
  percent: readonly number[];
  divisor: readonly number[];
  starts: readonly number[];
  ends: readonly number[];
}
export interface GekisoLuckLiveScoreResult {
  scope: "complete-play" | "score-delta-from-rank-base";
  projection: GekisoLuckLiveScorePlan["projection"];
  mean: number;
  law: readonly { score: number; probability: number }[] | null;
  range: { minimum: number; maximum: number } | null;
}
const int = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) &&
  value >= 0 && value <= 0x7fffffff;
const fail = <T>(code: string): GekisoResolved<T> => ({ value: null,
  gaps: [{ code, source: "joint native Luck/Live score schedule" }] });
const frameEnd = (timeMs: number) => Math.ceil(Math.fround(Math.fround(timeMs) / Math.fround(40))) * 40;
const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;

export function createGekisoLuckLiveScoreSample(
  timeMs: number, input: Omit<NativeNoteScoreInput, "luckFactorPercent">, rules: GekisoRules,
): GekisoResolved<GekisoLuckLiveScoreSample> {
  if (!int(timeMs)) return fail("gekiso-luck-live-note-time-unresolved");
  try {
    return { value: { timeMs, idleScore: calcNativeNoteScore({ ...input, luckFactorPercent: 100 }),
      rushScore: calcNativeNoteScore({ ...input,
        luckFactorPercent: nativeLuckFactorPercent(rules.luckRushScoreBonusPercent) }) }, gaps: [] };
  } catch { return fail("gekiso-luck-live-note-input-unresolved"); }
}

export function prepareGekisoLuckLiveScore(
  rules: GekisoRules, plan: GekisoLuckLiveScorePlan, frameTimes: readonly number[],
): GekisoResolved<PreparedGekisoLuckLiveScore> {
  if (!plan || !["score-law", "score-expectation"].includes(plan.projection) || !int(plan.initialScore) ||
    !int(plan.expectedNoteCount) || plan.expectedNoteCount < 1 ||
    !Array.isArray(plan.frames) || plan.frames.length !== frameTimes.length ||
    !Array.isArray(plan.ranges) || plan.ranges.length !== 3 || plan.ranges.some((range, index) =>
      !int(range.startTimeMs) || !int(range.endTimeMs) || range.endTimeMs <= range.startTimeMs ||
      !int(range.rank) || range.rank < 1 || range.rank > 5 ||
      (index > 0 && range.startTimeMs <= plan.ranges[index - 1]!.endTimeMs)))
    return fail("gekiso-luck-live-plan-unresolved");
  const percent = plan.ranges.map((range, index) => rules.rankingPercents[index]?.[range.rank - 1]);
  if (!percent.every(int)) return fail("gekiso-luck-live-rank-percent-unresolved");
  const divisor = percent.map((value) => 100 / gcd(value, 100));
  if (plan.rankBaseRemainders && (plan.projection !== "score-expectation" ||
    plan.rankBaseRemainders.length !== 3 || plan.rankBaseRemainders.some((value, index) =>
      !int(value) || value >= divisor[index]!))) return fail("gekiso-luck-live-rank-base-unresolved");
  let time = -1, count = 0, maximum = plan.initialScore;
  for (const [frame, samples] of plan.frames.entries()) {
    if (!Array.isArray(samples)) return fail("gekiso-luck-live-sample-order-unresolved");
    for (const sample of samples) {
      if (!sample || !int(sample.timeMs) || sample.timeMs < time || sample.timeMs > frameTimes[frame]! ||
        !int(sample.idleScore) || !int(sample.rushScore) || ++count > 25000)
        return fail("gekiso-luck-live-sample-order-unresolved");
      time = sample.timeMs; maximum += Math.max(sample.idleScore, sample.rushScore);
    }
  }
  if (count !== plan.expectedNoteCount) return fail("gekiso-luck-live-note-count-mismatch");
  if ((frameTimes.at(-1) ?? -1) < Math.max(...plan.ranges.map((range) => frameEnd(range.endTimeMs))))
    return fail("gekiso-luck-live-incomplete-horizon");
  // Signed32 range/total safety makes the modular expectation identity exact.
  if (!int(maximum) || maximum * (1 + percent.reduce((sum, value) => sum + value, 0) / 100) > 0x7fffffff)
    return fail("gekiso-luck-live-score-domain-unresolved");
  return { value: { plan, percent, divisor,
    starts: plan.ranges.map((range) => frameEnd(range.startTimeMs)),
    ends: plan.ranges.map((range) => frameEnd(range.endTimeMs)) }, gaps: [] };
}

export function recordGekisoLuckRushCommand(
  ledger: GekisoLuckLiveScoreLedger, timeMs: number, active: boolean,
): GekisoResolved<GekisoLuckLiveScoreLedger> {
  // Backdated commands require the calculator's undo/replay path. This driver
  // scores each admitted prefix once and rejects such a tape explicitly.
  if (!int(timeMs) || timeMs <= ledger.lastScoredMs ||
    timeMs < (ledger.rushCommands.at(-1)?.timeMs ?? -1))
    return fail("gekiso-luck-live-retroactive-command-unresolved");
  return { value: { ...ledger, rushCommands: [...ledger.rushCommands, { timeMs, active }] }, gaps: [] };
}

export function advanceGekisoLuckLiveScore(
  prepared: PreparedGekisoLuckLiveScore, ledger: GekisoLuckLiveScoreLedger,
  samples: readonly GekisoLuckLiveScoreSample[],
): { ledger: GekisoLuckLiveScoreLedger; gain: number; rangeGains: readonly [number, number, number] } {
  let rush = ledger.rushAtScoredTime, command = 0, gain = 0;
  const rangeGains: [number, number, number] = [0, 0, 0];
  for (const sample of samples) {
    // ExecuteCommand applies a factor command before a note at the same time.
    while (command < ledger.rushCommands.length && ledger.rushCommands[command]!.timeMs <= sample.timeMs)
      rush = ledger.rushCommands[command++]!.active;
    const score = rush ? sample.rushScore : sample.idleScore;
    gain += score;
    for (let index = 0; index < 3; index++)
      if (sample.timeMs > prepared.starts[index]! && sample.timeMs <= prepared.ends[index]!) rangeGains[index]! += score;
  }
  return { ledger: { rushAtScoredTime: rush, rushCommands: ledger.rushCommands.slice(command),
    lastScoredMs: samples.at(-1)?.timeMs ?? ledger.lastScoredMs,
    score: prepared.plan.projection === "score-law" ? ledger.score + gain : 0,
    rangeScores: ledger.rangeScores.map((value, index) => prepared.plan.projection === "score-law"
      ? value + rangeGains[index]! : (value + rangeGains[index]!) % prepared.divisor[index]!) as [number, number, number],
  }, gain, rangeGains };
}

export function summarizeGekisoLuckLiveScore(
  rules: GekisoRules, prepared: PreparedGekisoLuckLiveScore,
  states: readonly { probability: number; ledger: GekisoLuckLiveScoreLedger;
    scoreMass: number; rangeMass: readonly [number, number, number] }[],
): GekisoResolved<GekisoLuckLiveScoreResult> {
  const law = new Map<number, number>();
  let mean = 0;
  for (const state of states) {
    if (prepared.plan.projection === "score-law") {
      const complete = completeGekisoLuckLiveScore(rules, prepared, state.ledger);
      if (complete.value === null) return { value: null, gaps: complete.gaps };
      const score = complete.value;
      law.set(score, (law.get(score) ?? 0) + state.probability);
      mean += score * state.probability;
    } else {
      mean += state.scoreMass;
      for (let index = 0; index < 3; index++) {
        const percent = prepared.percent[index]!;
        // E[floor(S*p/100)] = p*E[S]/100 - E[(S*p) mod100]/100.
        // Keep S mod(100/gcd(p,100)) joint with gauge/Next/rush/quota.
        mean += (state.rangeMass[index]! * percent -
          (state.ledger.rangeScores[index]! * percent % 100) * state.probability +
          ((prepared.plan.rankBaseRemainders?.[index] ?? 0) * percent % 100) * state.probability) / 100;
      }
    }
  }
  const outcomes = [...law].sort(([a], [b]) => a - b).map(([score, probability]) => ({ score, probability }));
  return { value: { scope: prepared.plan.rankBaseRemainders ? "score-delta-from-rank-base" : "complete-play",
    projection: prepared.plan.projection, mean,
    law: prepared.plan.projection === "score-law" ? outcomes : null,
    range: outcomes.length ? { minimum: outcomes[0]!.score, maximum: outcomes.at(-1)!.score } : null }, gaps: [] };
}

export function completeGekisoLuckLiveScore(
  rules: GekisoRules, prepared: PreparedGekisoLuckLiveScore, ledger: GekisoLuckLiveScoreLedger,
): GekisoResolved<number> {
  if (prepared.plan.projection !== "score-law") return fail("gekiso-luck-live-score-law-required");
  let score = ledger.score;
  for (let index = 0; index < 3; index++) {
    const bonus = resolveGekisoRankingBonus({ rules, rangeIndex: index, complete: true,
      rank: prepared.plan.ranges[index]!.rank, startTimingScore: 0, endTimingScore: ledger.rangeScores[index]! });
    if (!bonus.value) return { value: null, gaps: bonus.gaps };
    score += bonus.value.fixedScore;
  }
  return int(score) ? { value: score, gaps: [] } : fail("gekiso-luck-live-score-domain-unresolved");
}
