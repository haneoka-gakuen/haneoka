import type { OptimizationInput, TeamAssignment } from "../contracts.ts";
import type { TeamBuilderData } from "../data.ts";
import type { SearchEvaluationControls } from "../optimizer.ts";
import {
  createGekisoLuckState,
  resolveGekisoLuckCharge,
  type GekisoResolved,
  type GekisoRuleIdentity,
  type GekisoRules,
} from "./gekiso-mission-luck.ts";
import { evaluateGekisoLuckTimeline, type GekisoLuckTimelineInput, type GekisoLuckTimelineResult } from "./gekiso-luck-timeline.ts";
import type { GekisoLuckLiveScorePlan } from "./gekiso-luck-live-score.ts";
import {
  replayGekisoPerfectCounters,
  type GekisoPerfectCounters,
  type GekisoPerfectHistoryNote,
} from "./gekiso-perfect-counters.ts";
import { createNativeGekisoPhaseResolver, type NativeGekisoPhaseFrame, type NativeGekisoBasicPhasePlan } from "./native-gekiso-phases.ts";

export interface NativeGekisoAdmittedPerfectNote extends GekisoPerfectHistoryNote {
  rangeIndex: 0 | 1 | 2;
  operation: number;
  rangeState: 3 | 4 | 5;
}
export interface NativeGekisoRuntimeFrame extends NativeGekisoPhaseFrame {
  /** Controller._judgementSequence before this frame's phase2 appliers.
   * Add/SubtractGekisouComboBonus records this value minus one. */
  judgementSequenceBeforePhase2?: number;
  /** Exact native admitted call order, after conversion; every note occurs once. */
  notes: readonly NativeGekisoAdmittedPerfectNote[];
}
export interface NativeGekisoBasicRuntimeInput {
  expectedIdentity: GekisoRuleIdentity;
  assignment: TeamAssignment;
  /** Master mission pattern for the three native ranges. */
  missions: readonly [1 | 2 | 3, 1 | 2 | 3, 1 | 2 | 3];
  frames: readonly NativeGekisoRuntimeFrame[];
  randomLaw: GekisoLuckTimelineInput["randomLaw"];
  projection?: GekisoLuckTimelineInput["projection"];
  budget: GekisoLuckTimelineInput["budget"];
  liveScore?: GekisoLuckLiveScorePlan;
  /** Event reduction requires every note to generate and consume at most one lot. */
  requireNoPendingLots?: boolean;
}
export interface NativeGekisoBasicRuntimeResult {
  phases: NativeGekisoBasicPhasePlan;
  counters: readonly GekisoPerfectCounters[];
  luck: GekisoLuckTimelineResult;
  luckInput: GekisoLuckTimelineInput;
  assumptions: readonly string[];
}
const f = Math.fround;
const int = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0x7fffffff;
const fail = <T>(code: string, source: string): GekisoResolved<T> => ({ value: null, gaps: [{ code, source }] });

/** Actual selected member levels -> native start checker/timed effects ->
 * PERFECT counter replay and joint Luck law. The complete admitted frame tape
 * is shared by both paths, including range removal clearing the global rush.
 */
export function createNativeGekisoBasicRuntimeResolver(data: TeamBuilderData, input: OptimizationInput) {
  const phases = createNativeGekisoPhaseResolver(data, input);
  return {
    async evaluate(rules: GekisoRules, runtime: NativeGekisoBasicRuntimeInput, controls?: SearchEvaluationControls)
      : Promise<GekisoResolved<NativeGekisoBasicRuntimeResult>> {
      const phase = phases.compileBasic(runtime.assignment, runtime.expectedIdentity, runtime.frames);
      if (!phase.value) return { value: null, gaps: phase.gaps };
      if (
        rules.server !== runtime.expectedIdentity.server ||
        rules.releaseId !== runtime.expectedIdentity.releaseId ||
        !rules.sourceId ||
        rules.sourceId !== runtime.expectedIdentity.sourceId
      )
        return fail("native-gekiso-runtime-source-mismatch", "selected skills and Luck rules");
      if (
        !Array.isArray(runtime.missions) ||
        runtime.missions.length !== 3 ||
        runtime.missions.some((mission) => ![1, 2, 3].includes(mission)) ||
        runtime.missions.filter((mission) => mission === 2).length > 1
      )
        return fail("native-gekiso-basic-runtime-missions-unresolved", "one Luck range and three Master missions");
      const states = [0, 0, 0],
        seen = new Set<string>();
      let noteCount = 0;
      for (const frame of runtime.frames) {
        if (frame.judgementSequenceBeforePhase2 !== undefined && !int(frame.judgementSequenceBeforePhase2))
          return fail("native-gekiso-runtime-command-sequence-unresolved", "phase2 native judgement sequence");
        for (const update of frame.rangeUpdates) {
          if (runtime.missions[update.rangeIndex] !== update.mission)
            return fail("native-gekiso-runtime-range-mission-mismatch", `range:${update.rangeIndex}`);
          states[update.rangeIndex] = update.simulateState;
        }
        if (!Array.isArray(frame.notes) || (noteCount += frame.notes.length) > 25000)
          return fail("native-gekiso-runtime-admission-unresolved", "bounded complete admitted note tape");
        for (const note of frame.notes) {
          const key = `${note.rangeIndex}/${note.timeMs}/${note.sequence}`;
          if (
            ![0, 1, 2].includes(note.rangeIndex) ||
            note.judgement !== 5 ||
            !int(note.sequence) ||
            !int(note.timeMs) ||
            note.timeMs > frame.timeMs ||
            !int(note.operation) ||
            ![3, 4, 5].includes(note.rangeState) ||
            states[note.rangeIndex] !== note.rangeState ||
            seen.has(key)
          )
            return fail("native-gekiso-runtime-admission-unresolved", key);
          seen.add(key);
        }
      }
      // For these integer factors all additions commute exactly in f32. Notes
      // at a command timestamp still need the original command/note sequence.
      const windows = phase.value.windows;
      if (
        windows.some((window) => !Number.isInteger(window.factor) || window.factor < 0) ||
        windows.reduce((sum, window) => sum + window.factor * 2, 1) > 0xffffff
      )
        return fail("native-gekiso-basic-factor-order-unresolved", "exact integer additive domain");
      const comboBonuses = windows
        .filter((window) => window.family === "combo")
        .flatMap((window) => [
          { timeMs: window.executeMs, sequence: 0, diff: window.factor, frameMs: window.frameMs },
          { timeMs: window.finishMs, sequence: 0, diff: -window.factor, frameMs: window.finishFrameMs },
        ])
        .sort((a, b) => a.timeMs - b.timeMs);
      const allNotes = runtime.frames.flatMap((frame) => frame.notes);
      const frameSequences = new Map(runtime.frames.map((frame) => [frame.timeMs, frame.judgementSequenceBeforePhase2]));
      for (const command of comboBonuses) {
        const sequence = frameSequences.get(command.frameMs);
        if (sequence !== undefined) command.sequence = sequence - 1;
        else if (allNotes.some((note) => command.timeMs === note.timeMs))
          return fail("native-gekiso-basic-command-note-order-unresolved", "same-time combo command and judgement");
      }
      const emitted = [...comboBonuses].sort((a, b) => a.frameMs - b.frameMs);
      if (emitted.some((command, i) => i > 0 &&
        ((command.frameMs === emitted[i - 1]!.frameMs && command.timeMs !== emitted[i - 1]!.timeMs) ||
          command.timeMs < emitted[i - 1]!.timeMs ||
          (command.timeMs === emitted[i - 1]!.timeMs && command.sequence < emitted[i - 1]!.sequence))))
        return fail("native-gekiso-basic-command-emission-order-unresolved", "chronological native command stack");
      comboBonuses.sort((a, b) => a.timeMs - b.timeMs || a.sequence - b.sequence);
      const counters: GekisoPerfectCounters[] = [];
      for (const rangeIndex of [0, 1, 2] as const) {
        const result = replayGekisoPerfectCounters({
          rangeIndex,
          notes: allNotes.filter((note) => note.rangeIndex === rangeIndex),
          comboBonuses,
          addCombo: [],
          addJust: [],
        });
        if (!result.value) return { value: null, gaps: result.gaps };
        counters.push(result.value);
      }
      const gaugeAt = (frameMs: number, noteMs: number) => {
        let factor = f(0);
        for (const window of windows) {
          if (window.family !== "gauge") continue;
          if (window.frameMs <= frameMs && window.executeMs <= noteMs) factor = f(factor + window.factor);
          if (window.finishFrameMs <= frameMs && window.finishMs <= noteMs) factor = f(factor - window.factor);
        }
        return factor;
      };
      const luckIndex = runtime.missions.indexOf(2);
      if (runtime.requireNoPendingLots) for (const frame of runtime.frames) for (const note of frame.notes) {
        if (note.rangeIndex !== luckIndex) continue;
        const factor = gaugeAt(frame.timeMs, note.timeMs);
        const probe = resolveGekisoLuckCharge(rules, { ...note, gaugeUpFactor: factor, basePointDraw: null });
        let charges: number[];
        if (probe.value) charges = [probe.value.charge];
        else if (probe.gaps.length === 1 && probe.gaps[0]!.code === "gekiso-base-point-random-outcome-required") {
          const rows = rules.basePointTables[probe.gaps[0]!.source];
          if (!rows?.length) return { value: null, gaps: probe.gaps };
          charges = [];
          for (const row of rows) if (row.weight > 0) {
            const charge = resolveGekisoLuckCharge(rules, { ...note, gaugeUpFactor: factor, basePointDraw: row.value });
            if (!charge.value) return { value: null, gaps: charge.gaps };
            charges.push(charge.value.charge);
          }
        } else return { value: null, gaps: probe.gaps };
        if (!charges.length || charges.some((charge) => charge < 0 ||
          charge >= Math.min(rules.luckGaugeMax, rules.luckGaugeMaxRush)))
          return fail("native-gekiso-luck-update-cadence-required", "selected maximum note charge can leave pending lots");
      }
      const currentStates = [0, 0, 0];
      const luckInput: GekisoLuckTimelineInput = {
          expectedIdentity: runtime.expectedIdentity,
          initial: { state: createGekisoLuckState(rules), minimumEntries: [], rushBonusHandleActive: false },
          frames: runtime.frames.map((frame) => {
            for (const update of frame.rangeUpdates) currentStates[update.rangeIndex] = update.simulateState;
            return {
              timeMs: frame.timeMs,
              externalFrameHasLotResult: false,
              clearRushBonusBeforeNotes: frame.rangeUpdates.some((update) => update.simulateState === 8),
              minimumRegistryChanges: [],
              notes: frame.notes
                .filter((note) => note.rangeIndex === luckIndex)
                .map((note) => ({
                  timeMs: note.timeMs,
                  operation: note.operation,
                  judgement: note.judgement,
                  rangeState: note.rangeState,
                  gaugeUpFactor: gaugeAt(frame.timeMs, note.timeMs),
                  probabilityUpFactor: f(0),
                })),
              pending:
                luckIndex >= 0 && currentStates[luckIndex] === 4
                  ? { rangeState: 4 as const, probabilityUpFactor: f(0) }
                  : null,
            };
          }),
          randomLaw: runtime.randomLaw,
          projection: runtime.projection,
          budget: runtime.budget,
          liveScore: runtime.liveScore,
      };
      const luck = await evaluateGekisoLuckTimeline(rules, luckInput, controls);
      if (!luck.value) return { value: null, gaps: luck.gaps };
      return {
        value: {
          phases: phase.value,
          counters,
          luck: luck.value,
          luckInput,
          assumptions: [
            ...phase.value.assumptions,
            "native-admitted-perfect-history",
            "exact-integer-basic-factor-domain",
            "single-Luck-range-global-frame-order",
          ],
        },
        gaps: [],
      };
    },
  };
}
