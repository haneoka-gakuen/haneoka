import type { SearchEvaluationControls } from "../optimizer.ts";
import {
  resolveGekisoLuckCharge,
  resolveGekisoLuckStep,
  type GekisoLuckState,
  type GekisoResolved,
  type GekisoRuleIdentity,
  type GekisoRules,
} from "./gekiso-mission-luck.ts";
import { createGekisoLuckDistributionResolver } from "./gekiso-luck-distribution.ts";
import { prepareGekisoLuckLiveScore, recordGekisoLuckRushCommand, advanceGekisoLuckLiveScore,
  summarizeGekisoLuckLiveScore, completeGekisoLuckLiveScore, type GekisoLuckLiveScorePlan, type GekisoLuckLiveScoreLedger,
  type GekisoLuckLiveScoreResult } from "./gekiso-luck-live-score.ts";
import type {
  GekisoMinimumEntry,
  GekisoRandomLaw,
  GekisoLotteryInput,
  GekisoLotteryItem,
} from "./gekiso-luck-lottery.ts";

export interface GekisoLuckTimelineNote {
  /** Original admitted target time, including a target queued before Playing. */
  timeMs: number;
  operation: number;
  judgement: number;
  rangeState: 3 | 4 | 5;
  /** Already resolved conditions, counters and factor history at timeMs. */
  gaugeUpFactor: number | null;
  probabilityUpFactor: number | null;
}
export type GekisoMinimumRegistryChange =
  { kind: "enable"; entry: GekisoMinimumEntry } | { kind: "disable"; id: number };
export interface GekisoLuckTimelineFrame {
  timeMs: number;
  /** Known global current-frame result from other ranges, before this tape. */
  externalFrameHasLotResult: boolean | null;
  clearRushBonusBeforeNotes: boolean | null;
  minimumRegistryChanges: readonly GekisoMinimumRegistryChange[] | null;
  /** Native admitted call order. Notes retain their original factor/draw time. */
  notes: readonly GekisoLuckTimelineNote[];
  pending: { rangeState: 4; probabilityUpFactor: number | null } | null;
}
export interface GekisoLuckTimelineInput {
  expectedIdentity: GekisoRuleIdentity;
  initial: {
    state: GekisoLuckState;
    minimumEntries: readonly GekisoMinimumEntry[] | null;
    rushBonusHandleActive: boolean | null;
  };
  frames: readonly GekisoLuckTimelineFrame[];
  /** Bonus prefetch law; the base-point law below is the nominal weighted law. */
  randomLaw: GekisoRandomLaw;
  itemOrder?: GekisoLotteryInput["itemOrder"];
  orderedItemsByChance?: Readonly<Partial<Record<number, readonly GekisoLotteryItem[]>>>;
  /** Point-law projection merges diagnostic count histories using exact first
   * moments. Full native states remain available for a later counter driver. */
  projection?: "full-native-state" | "points-and-count-moments" | "expectations-only";
  budget: { maxStates: number; maxTransitions: number };
  /** Fully resolved score samples for one complete native member order. */
  liveScore?: GekisoLuckLiveScorePlan;
}
export interface GekisoLuckTimelineOutcome {
  probability: number;
  state: GekisoLuckState;
  minimumEntries: readonly GekisoMinimumEntry[];
  rushBonusHandleActive: boolean;
  currentFrameHasLotResult: boolean;
  /** Present only for a complete score law; stays joint with native Luck state. */
  liveScore?: number;
}
export interface GekisoLuckTimelineResult {
  scope: "explicit-admitted-luck-frame-schedule";
  projection: "full-native-state" | "points-and-count-moments" | "expectations-only";
  outcomes: readonly GekisoLuckTimelineOutcome[] | null;
  pointOutcomes:
    | readonly (Omit<GekisoLuckTimelineOutcome, "state"> & {
        state: Omit<GekisoLuckState, "resultCounts">;
        conditionalResultCountExpectations: readonly [number, number, number, number];
      })[]
    | null;
  /** Mean-only projection preserves additive moments; thresholds need a law. */
  pointLaw: readonly { value: number; probability: number }[] | null;
  pointExpectation: number;
  pointGainExpectation: number;
  consumedLotExpectation: number;
  pendingLotExpectation: number;
  rushBonusHandleActiveProbability: number;
  resultCountExpectations: readonly [number, number, number, number];
  basePointDraws: number;
  transitions: number;
  maximumStates: number;
  assumptions: readonly string[];
  liveScore?: GekisoLuckLiveScoreResult;
}
const int = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0x7fffffff;
const fail = <T>(code: string, source: string): GekisoResolved<T> => ({ value: null, gaps: [{ code, source }] });

/** Exact state propagation under a supplied admitted-call tape. Gauge, cached
 * Next, rush and quota stay joint; only complete endpoint laws are averaged.
 * Chart range admission and skill activation belong to the native tape factory.
 */
export async function evaluateGekisoLuckTimeline(
  rules: GekisoRules,
  input: GekisoLuckTimelineInput,
  controls?: SearchEvaluationControls,
): Promise<GekisoResolved<GekisoLuckTimelineResult>> {
  const source = "explicit native Luck frame schedule";
  const projection = input.projection ?? "full-native-state";
  if (!["full-native-state", "points-and-count-moments", "expectations-only"].includes(projection))
    return fail("gekiso-luck-projection-unresolved", source);
  const meanOnly = projection === "expectations-only";
  const projected = projection !== "full-native-state";
  if (
    !rules.sourceId ||
    !input.expectedIdentity.sourceId ||
    rules.server !== input.expectedIdentity.server ||
    rules.releaseId !== input.expectedIdentity.releaseId ||
    rules.sourceId !== input.expectedIdentity.sourceId
  )
    return fail("gekiso-luck-timeline-identity-mismatch", source);
  if (
    !Array.isArray(input.frames) ||
    input.frames.length > 10000 ||
    !int(input.budget.maxStates) ||
    input.budget.maxStates < 1 ||
    input.budget.maxStates > 100000 ||
    !int(input.budget.maxTransitions) ||
    input.budget.maxTransitions < 1 ||
    input.budget.maxTransitions > 2000000 ||
    !Array.isArray(input.initial.minimumEntries) ||
    typeof input.initial.rushBonusHandleActive !== "boolean" ||
    ![rules.luckGaugeMax, rules.luckGaugeMaxRush].every((value) => int(value) && value > 0) ||
    input.initial.state.normalGaugeMax !== rules.luckGaugeMax ||
    input.initial.state.rushGaugeMax !== rules.luckGaugeMaxRush
  )
    return fail("gekiso-luck-timeline-input-unresolved", source);
  const initialProbe = resolveGekisoLuckStep(rules, {
    state: input.initial.state,
    charge: 0,
    rangeState: 4,
    kind: "pending-frame",
    currentFrameHasLotResult: true,
    probabilityUpFactor: 0,
    rushBonusHandleActive: input.initial.rushBonusHandleActive,
    initialDraw: null,
    nextDraw: null,
  });
  if (!initialProbe.value) return { value: null, gaps: initialProbe.gaps };
  const live = input.liveScore ? prepareGekisoLuckLiveScore(rules, input.liveScore,
    input.frames.map((frame) => frame.timeMs)) : null;
  if (live && !live.value) return { value: null, gaps: live.gaps };
  let previousTime = -1,
    notes = 0;
  for (const frame of input.frames) {
    if (
      !int(frame.timeMs) ||
      frame.timeMs <= previousTime ||
      !Array.isArray(frame.notes) ||
      typeof frame.externalFrameHasLotResult !== "boolean" ||
      typeof frame.clearRushBonusBeforeNotes !== "boolean" ||
      !Array.isArray(frame.minimumRegistryChanges) ||
      frame.minimumRegistryChanges.length > 4096 ||
      frame.notes.some(
        (note: GekisoLuckTimelineNote) =>
          !int(note.timeMs) || note.timeMs > frame.timeMs || ![3, 4, 5].includes(note.rangeState),
      ) ||
      (frame.pending !== null && frame.pending.rangeState !== 4) ||
      (notes += frame.notes.length) > 20000
    )
      return fail("gekiso-luck-frame-admission-unresolved", source);
    previousTime = frame.timeMs;
  }
  // Count histories do not select a branch under the supplied fixed factor and
  // registry tape. Prove every represented count remains in signed32 first.
  if (projected && input.initial.state.resultCounts.some((value) => value + notes + input.frames.length > 0x7fffffff))
    return fail("gekiso-luck-count-projection-domain-unresolved", source);
  const validEntry = (entry: GekisoMinimumEntry) =>
    int(entry.id) &&
    Number.isInteger(entry.minimum) &&
    entry.minimum >= -0x80000000 &&
    entry.minimum <= 0x7fffffff &&
    Number.isInteger(entry.remaining) &&
    entry.remaining >= -0x80000000 &&
    entry.remaining <= 0x7fffffff;
  if (
    input.initial.minimumEntries.length > 4096 ||
    !input.initial.minimumEntries.every(validEntry) ||
    new Set(input.initial.minimumEntries.map((entry) => entry.id)).size !== input.initial.minimumEntries.length
  )
    return fail("gekiso-minimum-registry-invalid", source);
  const propagate = createGekisoLuckDistributionResolver(rules);
  const maximumCalls = notes + input.frames.length;
  const additiveCountersSafe =
    input.initial.state.totalBonusPoint + maximumCalls * 10 <= 0x7fffffff &&
    input.initial.state.resultCounts.every((value) => value + maximumCalls <= 0x7fffffff);
  if (meanOnly && !additiveCountersSafe) return fail("gekiso-luck-point-projection-domain-unresolved", source);
  type InternalOutcome = GekisoLuckTimelineOutcome & {
    countMass: [number, number, number, number];
    pointMass: number;
    liveLedger?: GekisoLuckLiveScoreLedger;
    liveScoreMass: number;
    liveRangeMass: [number, number, number];
  };
  // The fixed tape supplies branch-independent factors/registry changes.
  // For additive expectations these five integers and the ordered quota
  // triples contain every scalar-step branch input; maxima are rule constants.
  const meanStateKey = (
    state: GekisoLuckState,
    entries: readonly GekisoMinimumEntry[],
    rush: boolean,
    frameLot: boolean,
  ) =>
    `${state.gaugeValue},${state.lotCount},${state.rushCombo},${state.next},${state.gaugeMax}|` +
    entries.map((entry) => `${entry.id},${entry.minimum},${entry.remaining}`).join(";") +
    `|${Number(rush)}${Number(frameLot)}`;
  let collapseLuckTail = false;
  const lastLuckCall = input.frames.reduce((last, frame, index) => frame.notes.length || frame.pending ? index : last, -1);
  const key = (value: Omit<InternalOutcome, "probability" | "countMass" | "pointMass" | "liveScoreMass" | "liveRangeMass">) => {
    if (meanOnly)
      return (collapseLuckTail ? "completed-luck-tail" : meanStateKey(
        value.state,
        value.minimumEntries,
        value.rushBonusHandleActive,
        value.currentFrameHasLotResult,
      )) + (value.liveLedger ? `|${JSON.stringify(value.liveLedger)}` : "");
    const { resultCounts, ...pointState } = value.state;
    return JSON.stringify([
      projected ? pointState : value.state,
      value.minimumEntries,
      value.rushBonusHandleActive,
      value.currentFrameHasLotResult,
      ...(value.liveLedger ? [value.liveLedger] : []),
    ]);
  };
  let states = new Map<string, InternalOutcome>();
  const initial = {
    state: initialProbe.value.state,
    minimumEntries: input.initial.minimumEntries.map((entry) => ({ ...entry })),
    rushBonusHandleActive: input.initial.rushBonusHandleActive,
    currentFrameHasLotResult: false,
    ...(live?.value ? { liveLedger: { rushAtScoredTime: input.initial.rushBonusHandleActive,
      rushCommands: [], lastScoredMs: -1, score: input.liveScore!.projection === "score-law"
        ? input.liveScore!.initialScore : 0,
      rangeScores: [...(input.liveScore!.rankBaseRemainders ?? [0, 0, 0])] as [number, number, number] } } : {}),
  };
  states.set(key(initial), {
    ...initial,
    probability: 1,
    countMass: [...input.initial.state.resultCounts] as [number, number, number, number],
    pointMass: input.initial.state.totalBonusPoint,
    liveScoreMass: input.liveScore?.initialScore ?? 0,
    liveRangeMass: [0, 0, 0],
  });
  let transitions = 0,
    maximumStates = 1,
    basePointDraws = 0;
  const assumptions = new Set([
    "explicit-admitted-native-luck-frame-schedule",
    "resolved-skill-factor-and-registry-tape",
    ...(live?.value ? ["native-per-note-rush-score-floors", "native-command-before-equal-time-note",
      "native-rank-rounded-before-Luck-expectation",
      ...(input.liveScore!.projection === "score-expectation" ? ["native-rank-score-residue-projection"] : [])] : []),
  ]);
  const interrupted = () => controls?.cancelled() || controls?.expired();
  const merge = (target: typeof states, value: InternalOutcome) => {
    if (value.probability === 0) return;
    const identity = key(value),
      old = target.get(identity);
    if (old) {
      old.probability += value.probability;
      old.pointMass += value.pointMass;
      old.liveScoreMass += value.liveScoreMass;
      value.liveRangeMass.forEach((mass, index) => { old.liveRangeMass[index]! += mass; });
      value.countMass.forEach((mass, result) => {
        old.countMass[result] += mass;
      });
    } else target.set(identity, value);
  };
  type ChargeLaw = { values: { charge: number; probability: number }[]; consumesDraw: boolean };
  const chargeLaws = new Map<string, GekisoResolved<ChargeLaw>>();
  const chargeLaw = (note: GekisoLuckTimelineNote): GekisoResolved<ChargeLaw> => {
    const identity = JSON.stringify([note.operation, note.judgement, note.gaugeUpFactor]);
    const cached = chargeLaws.get(identity);
    if (cached) return cached;
    const probe = resolveGekisoLuckCharge(rules, { ...note, basePointDraw: null });
    let result: GekisoResolved<ChargeLaw>;
    if (probe.value)
      result = {
        value: {
          values: [{ charge: probe.value.charge, probability: 1 }],
          consumesDraw: probe.value.consumesBasePointDraw,
        },
        gaps: [],
      };
    else if (probe.gaps.length === 1 && probe.gaps[0]!.code === "gekiso-base-point-random-outcome-required") {
      const rows = rules.basePointTables[probe.gaps[0]!.source];
      const total = rows?.reduce((sum, row) => sum + row.weight, 0);
      if (!rows?.length || !int(total) || total < 1 || rows.some((row) => !int(row.value) || !int(row.weight)))
        result = fail("gekiso-base-point-table-unresolved", probe.gaps[0]!.source);
      else {
        const values = new Map<number, number>();
        for (const row of rows) {
          if (!row.weight) continue;
          const resolved = resolveGekisoLuckCharge(rules, { ...note, basePointDraw: row.value });
          if (!resolved.value) return { value: null, gaps: resolved.gaps };
          values.set(resolved.value.charge, (values.get(resolved.value.charge) ?? 0) + row.weight / total);
        }
        assumptions.add("native-base-point-nominal-independent-weighted-draws");
        result = {
          value: { values: [...values].map(([charge, probability]) => ({ charge, probability })), consumesDraw: true },
          gaps: [],
        };
      }
    } else result = { value: null, gaps: probe.gaps };
    chargeLaws.set(identity, result);
    return result;
  };
  const advance = async (
    timeMs: number,
    kind: "judged-note" | "pending-frame",
    rangeState: number,
    probabilityUpFactor: number | null,
    charges: ChargeLaw["values"],
  ): Promise<GekisoResolved<GekisoLuckTimelineResult> | null> => {
    // With no queued lots a pending-frame is the identity transition on
    // every state. Validate the fixed invocation through the native scalar
    // leaf once; retain all gauge/Next/rush/score/residue state unchanged.
    // Actual nonidentity branches keep their original state/transition caps.
    if (meanOnly && kind === "pending-frame" && states.size &&
      [...states.values()].every(value => value.state.lotCount === 0)) {
      if (interrupted()) return fail("gekiso-luck-timeline-interrupted", "worker cancellation/budget");
      const value = states.values().next().value!;
      const checked = resolveGekisoLuckStep(rules, { state: value.state, charge: 0,
        kind, rangeState, currentFrameHasLotResult: value.currentFrameHasLotResult,
        probabilityUpFactor, rushBonusHandleActive: value.rushBonusHandleActive,
        initialDraw: null, nextDraw: null });
      if (!checked.value) return { value: null, gaps: checked.gaps };
      return null;
    }
    const next: typeof states = new Map();
    // The scalar step only adds to points/resultCounts. Its nonlinear kernel
    // depends on gauge/Next/rush/quota; reuse that kernel across score histories
    // after proving all restored integer counters stay inside the native domain.
    const kernels = new Map<string, ReturnType<typeof propagate>>();
    for (const state of states.values())
      for (const charge of charges) {
        if (interrupted()) return fail("gekiso-luck-timeline-interrupted", "worker cancellation/budget");
        const { totalBonusPoint, resultCounts } = state.state;
        const kernelKey = additiveCountersSafe
          ? meanOnly
            ? `${meanStateKey(state.state, state.minimumEntries, state.rushBonusHandleActive, state.currentFrameHasLotResult)}|${charge.charge}`
            : (() => {
                const { totalBonusPoint, resultCounts, ...nonlinearState } = state.state;
                return JSON.stringify([
                  nonlinearState,
                  state.minimumEntries,
                  state.rushBonusHandleActive,
                  state.currentFrameHasLotResult,
                  charge.charge,
                ]);
              })()
          : null;
        let resolved = kernelKey === null ? undefined : kernels.get(kernelKey);
        if (!resolved)
          resolved = propagate({
            step: {
              state: additiveCountersSafe
                ? { ...state.state, totalBonusPoint: 0, resultCounts: [0, 0, 0, 0] }
                : state.state,
              charge: charge.charge,
              kind,
              rangeState,
              currentFrameHasLotResult: state.currentFrameHasLotResult,
              probabilityUpFactor,
              rushBonusHandleActive: state.rushBonusHandleActive,
            },
            drawTimeMs: timeMs,
            minimumEntries: state.minimumEntries,
            randomLaw: input.randomLaw,
            itemOrder: input.itemOrder,
            orderedItemsByChance: input.orderedItemsByChance,
          });
        if (kernelKey !== null) kernels.set(kernelKey, resolved);
        if (!resolved.value) return { value: null, gaps: resolved.gaps };
        resolved.value.assumptions.forEach((value) => assumptions.add(value));
        for (const branch of resolved.value.branches) {
          if (++transitions > input.budget.maxTransitions) return fail("gekiso-luck-transition-budget", source);
          const command = branch.result.rushScoreCommand;
          const weight = charge.probability * branch.probability;
          const probability = state.probability * weight;
          let liveLedger = state.liveLedger;
          if (liveLedger && command) {
            const recorded = recordGekisoLuckRushCommand(liveLedger, timeMs, command.kind === "enable");
            if (!recorded.value) return { value: null, gaps: recorded.gaps };
            liveLedger = recorded.value;
          }
          const pointGain = branch.result.state.totalBonusPoint - (additiveCountersSafe ? 0 : totalBonusPoint);
          merge(next, {
            probability,
            pointMass: state.pointMass * weight + pointGain * probability,
            liveLedger,
            liveScoreMass: state.liveScoreMass * weight,
            liveRangeMass: state.liveRangeMass.map((mass) => mass * weight) as [number, number, number],
            // Mean-only counters are carried exclusively as probability mass.
            // Its internal scalar kernel uses zero-based additive counters and
            // exposes no representative native states or point distribution.
            state:
              additiveCountersSafe && !meanOnly
                ? {
                    ...branch.result.state,
                    totalBonusPoint: totalBonusPoint + branch.result.state.totalBonusPoint,
                    resultCounts: resultCounts.map(
                      (value, result) => value + branch.result.state.resultCounts[result],
                    ) as [number, number, number, number],
                  }
                : branch.result.state,
            countMass: state.countMass.map(
              (mass, result) => mass * weight + (branch.result.consumed === result ? probability : 0),
            ) as [number, number, number, number],
            minimumEntries: branch.minimumEntries!,
            rushBonusHandleActive: command ? command.kind === "enable" : state.rushBonusHandleActive,
            currentFrameHasLotResult: state.currentFrameHasLotResult || branch.result.consumed !== null,
          });
          if (next.size > input.budget.maxStates) return fail("gekiso-luck-state-budget", source);
          if (controls && transitions % 1024 === 0) {
            controls.progress();
            await controls.yield();
          }
        }
      }
    maximumStates = Math.max(maximumStates, next.size);
    states = next;
    return null;
  };
  for (const [frameIndex, frame] of input.frames.entries()) {
    if (interrupted()) return fail("gekiso-luck-timeline-interrupted", "worker cancellation/budget");
    if (controls && frameIndex % 16 === 0) {
      controls.progress();
      await controls.yield();
    }
    const updated: typeof states = new Map();
    let updatedCount = 0;
    for (const state of states.values()) {
      if (interrupted()) return fail("gekiso-luck-timeline-interrupted", "worker cancellation/budget");
      if (controls && ++updatedCount % 1024 === 0) {
        controls.progress();
        await controls.yield();
      }
      let entries = frame.minimumRegistryChanges!.length
        ? state.minimumEntries.map((entry) => ({ ...entry }))
        : state.minimumEntries;
      for (const change of frame.minimumRegistryChanges!) {
        if (change.kind === "enable") {
          if (!validEntry(change.entry) || entries.some((entry) => entry.id === change.entry.id))
            return fail("gekiso-minimum-enable-conflict", source);
          entries = [...entries, { ...change.entry }];
        } else if (change.kind === "disable" && int(change.id))
          entries = entries.filter((entry) => entry.id !== change.id);
        else return fail("gekiso-minimum-registry-change-unresolved", source);
        if (entries.length > 4096) return fail("gekiso-minimum-registry-invalid", source);
      }
      let liveLedger = state.liveLedger;
      if (liveLedger && frame.clearRushBonusBeforeNotes && state.rushBonusHandleActive) {
        const cleared = recordGekisoLuckRushCommand(liveLedger, frame.timeMs, false);
        if (!cleared.value) return { value: null, gaps: cleared.gaps };
        liveLedger = cleared.value;
      }
      merge(updated, {
        ...state,
        liveLedger,
        countMass: [...state.countMass],
        minimumEntries: entries,
        rushBonusHandleActive: frame.clearRushBonusBeforeNotes ? false : state.rushBonusHandleActive,
        currentFrameHasLotResult: frame.externalFrameHasLotResult!,
      });
    }
    states = updated;
    for (const note of frame.notes) {
      const charge = chargeLaw(note);
      if (!charge.value) return { value: null, gaps: charge.gaps };
      if (charge.value.consumesDraw) basePointDraws++;
      const failure = await advance(
        note.timeMs,
        "judged-note",
        note.rangeState,
        note.probabilityUpFactor,
        charge.value.values,
      );
      if (failure) return failure;
    }
    if (frame.pending) {
      const failure = await advance(frame.timeMs, "pending-frame", 4, frame.pending.probabilityUpFactor, [
        { charge: 0, probability: 1 },
      ]);
      if (failure) return failure;
    }
    if (live?.value) {
      const scored: typeof states = new Map();
      let count = 0;
      for (const state of states.values()) {
        if (interrupted()) return fail("gekiso-luck-timeline-interrupted", "worker cancellation/budget");
        const value = advanceGekisoLuckLiveScore(live.value, state.liveLedger!, input.liveScore!.frames[frameIndex]!);
        merge(scored, { ...state, liveLedger: value.ledger,
          liveScoreMass: state.liveScoreMass + value.gain * state.probability,
          liveRangeMass: state.liveRangeMass.map((mass, index) => mass +
            value.rangeGains[index]! * state.probability) as [number, number, number] });
        if (controls && ++count % 1024 === 0) { controls.progress(); await controls.yield(); }
      }
      states = scored;
    }
    // No future Luck invocation can read gauge/Next/rush after this point.
    // Preserve score residues/histories and all additive masses; endpoint
    // pending/rush values are known zero. No native-state law is exposed.
    if (meanOnly && additiveCountersSafe && !collapseLuckTail && frameIndex >= lastLuckCall &&
      [...states.values()].every((state) => state.state.lotCount === 0 &&
        !state.rushBonusHandleActive && state.minimumEntries.length === 0) &&
      input.frames.slice(frameIndex + 1).every((frame) => frame.minimumRegistryChanges!.length === 0)) {
      collapseLuckTail = true;
      assumptions.add("completed-luck-tail-expectation-projection");
      const tail: typeof states = new Map();
      for (const state of states.values()) merge(tail, state);
      states = tail;
    }
  }
  if (interrupted()) return fail("gekiso-luck-timeline-interrupted", "worker cancellation/budget");
  const outcomes = [...states.values()];
  if (Math.abs(outcomes.reduce((sum, outcome) => sum + outcome.probability, 0) - 1) > 1e-10)
    return fail("gekiso-luck-probability-mass-unresolved", source);
  const pointLaw = new Map<number, number>();
  const counts: [number, number, number, number] = [0, 0, 0, 0];
  for (const outcome of outcomes) {
    if (!meanOnly)
      pointLaw.set(
        outcome.state.totalBonusPoint,
        (pointLaw.get(outcome.state.totalBonusPoint) ?? 0) + outcome.probability,
      );
    outcome.countMass.forEach((value, result) => {
      counts[result] += value;
    });
  }
  const pointExpectation = outcomes.reduce((sum, outcome) => sum + outcome.pointMass, 0);
  const liveScore = live?.value ? summarizeGekisoLuckLiveScore(rules, live.value,
    outcomes.map((outcome) => ({ probability: outcome.probability, ledger: outcome.liveLedger!,
      scoreMass: outcome.liveScoreMass, rangeMass: outcome.liveRangeMass }))) : null;
  if (liveScore && !liveScore.value) return { value: null, gaps: liveScore.gaps };
  const jointScore = (ledger: GekisoLuckLiveScoreLedger | undefined) => live?.value &&
    input.liveScore!.projection === "score-law" && ledger
    ? { liveScore: completeGekisoLuckLiveScore(rules, live.value, ledger).value! } : {};
  return {
    value: {
      scope: "explicit-admitted-luck-frame-schedule",
      projection,
      outcomes: projected ? null : outcomes.map(({ countMass, pointMass, liveLedger, liveScoreMass, liveRangeMass, ...outcome }) =>
        ({ ...outcome, ...jointScore(liveLedger) })),
      pointOutcomes:
        projected && !meanOnly
          ? outcomes.map(({ countMass, pointMass, liveLedger, liveScoreMass, liveRangeMass, state, ...outcome }) => {
              const { resultCounts, ...pointState } = state;
              return {
                ...outcome,
                ...jointScore(liveLedger),
                state: pointState,
                conditionalResultCountExpectations: countMass.map((value) => value / outcome.probability) as [
                  number,
                  number,
                  number,
                  number,
                ],
              };
            })
          : null,
      pointLaw: meanOnly
        ? null
        : [...pointLaw].sort(([a], [b]) => a - b).map(([value, probability]) => ({ value, probability })),
      pointExpectation,
      pointGainExpectation: pointExpectation - input.initial.state.totalBonusPoint,
      consumedLotExpectation:
        counts.reduce((sum, value) => sum + value, 0) -
        input.initial.state.resultCounts.reduce((sum, value) => sum + value, 0),
      pendingLotExpectation: outcomes.reduce((sum, outcome) => sum + outcome.state.lotCount * outcome.probability, 0),
      rushBonusHandleActiveProbability: outcomes.reduce(
        (sum, outcome) => sum + (outcome.rushBonusHandleActive ? outcome.probability : 0),
        0,
      ),
      resultCountExpectations: counts,
      basePointDraws,
      transitions,
      maximumStates,
      assumptions: [...assumptions],
      ...(liveScore?.value ? { liveScore: liveScore.value } : {}),
    },
    gaps: [],
  };
}
