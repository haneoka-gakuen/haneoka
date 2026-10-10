/** A score ceiling for counter/lottery/judgement effects and a restricted, bounded note-score effect family.
 * Unsupported effect families deliberately return Infinity: this is a pruning proof, not a score approximation. */
import type { EngineMaster, SkillEffectRow } from "./master";
import type { MemberState, SnapState } from "./power";
import type { GekisoChart } from "./gekiso";
import { resolveSlotSkill, windowMs } from "./skills";
import { noteFactorMill } from "./full/score";

// These cases in LiveModel.apply/applyGekisou only change mission state or Conversion.
const COUNTER_ONLY = new Set([
  11000, 11001, 11002, 11003, 11004, 11005, 12000, 12002, 12003, 12004, 12006, 13000, 13002, 13003, 13004, 13005,
]);
const f = Math.fround;
const bits = new DataView(new ArrayBuffer(8));
/** Outward rounding of positive binary64 arithmetic, including products/sums used to build the proof. */
const up = (x: number) => {
  if (!Number.isFinite(x)) return Infinity;
  if (x < 0) throw new Error("negative-score-bound");
  bits.setFloat64(0, x);
  bits.setBigUint64(0, bits.getBigUint64(0) + 1n);
  return bits.getFloat64(0);
};
const add = (a: number, b: number) => up(a + b);
const mul = (a: number, b: number) => up(a * b);

export interface GekisoScoreBound {
  supported: boolean;
  score(power: number): number;
}
const unsupported = (): GekisoScoreBound => ({ supported: false, score: () => Infinity });

/** The only admitted note effects have at most one activation at each of the three range starts. Fixed team
 * cumulative counts (3000..3005) never change during the live, so 2001 never replaces its command while executing.
 * Other triggers, resets and dynamic cumulative counts retain the unrestricted reward-table fallback. */
function rangeStartNoteDelta(master: EngineMaster, row: SkillEffectRow): number | null {
  if (row.type !== 2000 && row.type !== 2001) return null;
  if (row.triggerType !== 1 || row.resetGroup !== 0 || !Number.isSafeInteger(row.value)) return null;
  const sets = master.conditionSets.get(row.triggerGroup);
  if (sets?.length !== 1 || sets[0]?.length !== 1) return null;
  const trigger = master.conditions.get(sets[0][0]!);
  if (trigger?.type !== 7010 || !trigger.positive) return null;
  let value = row.value;
  if (row.type === 2001) {
    if (!row.cumulativeId) value = 0;
    else {
      const cumulative = master.cumulative.get(row.cumulativeId);
      if (
        !cumulative ||
        ![3000, 3001, 3002, 3003, 3004, 3005].includes(cumulative.type) ||
        !Number.isSafeInteger(cumulative.cap) ||
        cumulative.cap < 0
      )
        return null;
      // Every admitted fixed count counts either performers or distinct performer attributes: at most five.
      const count = Math.min(5, cumulative.cap < 1 ? 5 : cumulative.cap);
      // The model compares the stored, quantized factor against the requested float on every executing frame.
      // Some decimal factors quantize differently and are replaced again even with a fixed count. Admit only
      // values for which all possible fixed counts reconstruct exactly, so the six-command proof still holds.
      for (let n = 0; n <= count; n++) {
        let current = row.value * n;
        if (row.maxValue > 0) current = Math.min(current, row.maxValue);
        const factor = f(f(current) / 10000);
        if (f(f(noteFactorMill(factor)) / 100000) !== factor) return null;
      }
      value *= count;
      if (value >= 2 ** 31) return null; // the native (value * count) | 0 must not wrap negative
      if (row.maxValue > 0) value = Math.min(value, row.maxValue);
    }
  }
  const mill = noteFactorMill(f(f(value) / 10000));
  if (mill < 0 || mill >= 2 ** 31 - 1) return null;
  return f(f(mill) / 100000);
}

export function gekisoScoreBound(
  master: EngineMaster,
  chart: GekisoChart,
  members: readonly MemberState[],
  snaps: readonly SnapState[],
  /** Complete-team mode: each member may use only its actual bound photo, never a different member's photo. */
  bindings?: readonly (SnapState | null)[],
): GekisoScoreBound {
  if (bindings && (bindings.length !== members.length || members.length > 5)) return unsupported();
  const activeSnaps = bindings ? bindings.filter((snap): snap is SnapState => snap !== null) : snaps;
  type NoteBudget = { positive: number; commands: number };
  const admitted = (rows: readonly SkillEffectRow[] | undefined, level: number) => {
    const active = rows?.filter((row) => row.level === level);
    if (!active?.length) return null;
    const budget: NoteBudget = { positive: 0, commands: 0 };
    for (const row of active) {
      if (
        !Number.isFinite(row.value) ||
        row.value < 0 ||
        row.value > 1e6 ||
        !Number.isFinite(row.seconds) ||
        row.seconds < 0 ||
        !Number.isFinite(row.maxValue) ||
        row.maxValue < 0 ||
        row.maxValue > 1e6
      )
        return null;
      if (COUNTER_ONLY.has(row.type)) continue;
      const delta = rangeStartNoteDelta(master, row);
      if (delta === null) return null;
      budget.positive = add(budget.positive, mul(3, delta));
      budget.commands += 6; // three activations, each followed by at most one cancellation
    }
    return budget;
  };
  const memberBudgets: NoteBudget[] = [],
    snapBudgets: NoteBudget[] = [];
  for (const member of members) {
    if (!member.card.gekisoSkillId) continue;
    const budget = admitted(
      master.gekisoSkills.get(member.card.gekisoSkillId)?.effects,
      member.growth.gekisoSkillLevel,
    );
    if (!budget) return unsupported();
    memberBudgets.push(budget);
  }
  for (const snap of activeSnaps) {
    const total: NoteBudget = { positive: 0, commands: 0 };
    for (let i = 0; i < snap.card.gekisoSupportSkillIds.length; i++) {
      const id = snap.card.gekisoSupportSkillIds[i]!;
      if (!id) continue;
      const budget = admitted(master.gekisoSupportSkills.get(id)?.effects, snap.gekisoSkillLevels[i]!);
      if (!budget) return unsupported();
      total.positive = add(total.positive, budget.positive);
      total.commands += budget.commands;
    }
    snapBudgets.push(total);
  }
  const largestFive = (budgets: NoteBudget[], field: keyof NoteBudget) =>
    budgets
      .map((budget) => budget[field])
      .sort((a, b) => b - a)
      .slice(0, 5)
      .reduce(add, 0);
  const notePositive = add(largestFive(memberBudgets, "positive"), largestFive(snapBudgets, "positive"));
  const commandCount = (budgets: NoteBudget[]) =>
    budgets
      .map((budget) => budget.commands)
      .sort((a, b) => b - a)
      .slice(0, 5)
      .reduce((a, b) => a + b, 0);
  const noteCommands = commandCount(memberBudgets) + commandCount(snapBudgets);
  if (
    !(master.live.lifeOnus >= 0 && master.live.lifeOnus <= 1) ||
    chart.full.convertedCount < 1 ||
    chart.full.convertedCount > 1e9 ||
    chart.rangePercent.some((x) => x < 0 || !Number.isFinite(x))
  )
    return unsupported();
  if (
    [...chart.judgeFrac].some((x) => x < 0 || !Number.isFinite(x)) ||
    (master.live.combo.get(1) ?? []).some(([, cumulative]) => cumulative < 0 || !Number.isFinite(cumulative)) ||
    !(master.live.gekiso.rushPercent >= 0 && master.live.gekiso.rushPercent <= 100)
  )
    return unsupported();

  // Each real trigger may choose only one unused member. Letting every trigger independently choose the best
  // member/photo pair relaxes that constraint and can only raise its positive score contribution.
  const shapes: { duration: number; value: number }[][] = [];
  const seen = new Set<string>();
  let maxAbsolute = 0,
    maxActions = 0;
  for (const [memberIndex, member] of members.entries())
    for (const snap of bindings ? [bindings[memberIndex]!] : [null, ...snaps]) {
      const slot = resolveSlotSkill(master, member, snap);
      const shape: { duration: number; value: number }[] = [];
      let absolute = 0,
        actions = 0;
      for (const effect of slot.effects) {
        const multiplicity = effect.type === 2000 ? 1 : effect.judgements.length;
        const diff = f(effect.delta / 100000);
        const duration = windowMs(effect.seconds, slot.extensionMs);
        if (!Number.isFinite(diff) || !Number.isFinite(duration)) return unsupported();
        actions += multiplicity;
        absolute = add(absolute, mul(Math.abs(diff), multiplicity));
        if (duration > 0 && diff > 0) shape.push({ duration, value: mul(diff, multiplicity) });
      }
      maxActions = Math.max(maxActions, actions);
      maxAbsolute = Math.max(maxAbsolute, absolute);
      const key = JSON.stringify(shape);
      if (!seen.has(key)) {
        seen.add(key);
        shapes.push(shape);
      }
    }
  const durations = [...new Set(shapes.flatMap((shape) => shape.map((e) => e.duration)))].sort((a, b) => a - b);
  const envelope = durations.map((duration) =>
    shapes.reduce(
      (maximum, shape) =>
        Math.max(
          maximum,
          shape.filter((e) => e.duration >= duration).reduce((sum, e) => add(sum, e.value), 0),
        ),
      0,
    ),
  );
  const events = chart.full.events.slice(0, 5).map(([, time]) => time);
  const u = 2 ** -24;
  // LiveModel calls IncrementalScore.calculate twice per simulated frame, plus twice on each of at most three
  // completed ranges. A command can be replayed at most once per calculate call. Each replay contributes one
  // FactorState addition and one FrameDiff addition; each nonzero FrameDiff undo accounts for a prior replay.
  // Thus N = 3 * (2F + 6) * Q bounds every relevant float32 operation, including arbitrary backwards rewinds.
  // In exact arithmetic, all intermediate state/frame sums have absolute magnitude <= M = 1 + 2*notePositive.
  // Track the sum of absolute rounding errors in the state and the frame-diff registers. Undo transfers a diff's
  // error to the state then clears that diff, so errors are not copied. Each operation increases this budget by
  // at most u*(M+E)+eta. Therefore E <= (N*u*M + N*eta)/(1-N*u), eta = 2^-149. This bound does not assume that
  // additions and later cancellations are exact inverses, nor infer a tolerance from observed scores.
  const noteOperations = 3 * (2 * chart.play.frames.length + 6) * noteCommands;
  if (!Number.isSafeInteger(noteOperations) || noteOperations * u >= 0.25) return unsupported();
  const noteError = noteCommands
    ? mul(
        add(mul(noteOperations * u, add(1, mul(2, notePositive))), mul(noteOperations, 2 ** -149)),
        up(1 / (1 - noteOperations * u)),
      )
    : 0;
  const noteMultiplier = add(add(1, notePositive), noteError);
  const operations = 10 * maxActions + 1; // five activations + five expirations, then factor + judgement channel
  if (operations * u > 0.25) return unsupported();
  // For N float32 additions/subtractions, the standard recurrence |e'| <= (1+u)|e| + u*S + eta gives
  // |e| <= N*u*S/(1-N*u) + N*eta/(1-N*u). S <= five slots' absolute sums. The factor 8 covers both channels,
  // the final addition, and subnormal rounding; it is an analytic bound, independent of observed test errors.
  const residual = add(mul(8 * operations * u, mul(5, maxAbsolute)), 4 * operations * 2 ** -149);
  const rho = up(1 / (1 - u));
  let roundFactor = 1;
  for (let i = 0; i < 12; i++) roundFactor = mul(roundFactor, rho);
  const fraction = Math.max(...chart.judgeFrac);
  // Normal-range operands make the relative-rounding proof applicable. Exotic data keeps the loose bound.
  const scalar = [master.live.adjustment, chart.difficultyFactor, fraction];
  if (scalar.some((v) => v < 2 ** -10 || v > 1e4 || !Number.isFinite(v))) return unsupported();
  let coefficient = 0;
  for (let i = 0; i < chart.notes.length; i++) {
    const note = chart.notes[i]!;
    const noteFrac = chart.noteFrac[i]!;
    const combo = chart.comboFactor[i]!;
    if (noteFrac === 0) continue;
    if (noteFrac < 2 ** -10 || noteFrac > 100 || combo < 2 ** -10 || combo > 4) return unsupported();
    let live = residual;
    for (const start of events) {
      const delta = chart.times[i]! - start;
      if (delta < 0) continue;
      const at = durations.findIndex((duration) => duration > delta);
      if (at >= 0) live = add(live, envelope[at]!);
    }
    if (live > 1e5) return unsupported();
    // ScoreCalculator.gekisouComboFactor reads exactly these inclusive Combo ranges and caps its table at 1.
    const gk = chart.setup.fevers.some(
      ([start, end], r) => chart.setup.missions[r] === 1 && start <= note.timeMs && note.timeMs <= end,
    )
      ? 2
      : 1;
    // Native luckPercent is capped at 200. Taking 2 for every note also safely covers range-end carry-over.
    const luck = chart.luck ? 2 : 1;
    let c = mul(master.live.adjustment, chart.difficultyFactor);
    for (const term of [noteFrac, fraction, combo, gk, luck, add(noteMultiplier, live), roundFactor]) c = mul(c, term);
    c = up(c / chart.full.convertedCount);
    const range = chart.rangeOf[i]!;
    if (range >= 0) c = mul(c, add(1, up(chart.rangePercent[range]! / 100)));
    coefficient = add(coefficient, c);
  }
  return {
    supported: true,
    // All note floors and range floors are <= the unrounded sum. The 12 upward float32 factors cover either
    // scoreOrdersGekiso arithmetic branch and lifeOnus rounding, with power restricted to normal game magnitudes.
    score(power) {
      if (power < 1 || power > 2 ** 31 || !Number.isFinite(power)) return Infinity;
      const bound = mul(coefficient, power);
      return bound <= Number.MAX_SAFE_INTEGER ? bound : Infinity;
    },
  };
}
