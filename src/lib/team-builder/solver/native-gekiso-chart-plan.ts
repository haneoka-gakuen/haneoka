import type { SongOption } from "../contracts.ts";
import { dataRows, nativeRow, type TeamBuilderData } from "../data.ts";
import { tickToTimeMs } from "../song-metrics.ts";
import type { NativeGekisoSongPlan } from "./native-gekiso-evaluation.ts";
import type { NativeGekisoRuntimeFrame } from "./native-gekiso-runtime.ts";
import type { GekisoResolved } from "./gekiso-mission-luck.ts";
import { nativeGekisoAllComboDriverSupports } from "./native-gekiso-driver-profile.ts";

const f = Math.fround;
const int = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) &&
  value >= 0 && value <= 0x7fffffff;
const fail = (code: string, source: string): GekisoResolved<NativeGekisoSongPlan> =>
  ({ value: null, gaps: [{ code, source }] });
export interface NativeGekisoChartTiming {
  bpmChanges: readonly { bpm: number; tick: number; timeMs: number }[];
  fever: readonly (readonly [number, number])[];
}

/** Original LiveMusicUtility.GetGekisouMissionPattern (492B). */
export function nativeGekisoMissionPattern(missions: readonly number[]): number | null {
  if (missions.length !== 3 || missions.some((value) => !int(value) || value > 3)) return null;
  const [a, b, c] = missions;
  if (!a || !b || !c) return 0;
  return a === b && a === c ? 1 : a !== b && a !== c && b !== c ? 2 : 3;
}

/** Score-equivalent event reduction of native fever/BeforeUpdate for uninterrupted
 * PERFECT Solo playback with three Combo missions. All score-affecting note,
 * source, effect and stopwatch boundaries are dispatched. There is no fixed FPS.
 * Luck, natural JUST, overlapping ranges and stalled playback require another driver.
 */
export function createNativeGekisoAllComboChartPlan(
  data: TeamBuilderData,
  song: SongOption,
  timing: NativeGekisoChartTiming,
  options?: { effectTypes: readonly number[] },
): GekisoResolved<NativeGekisoSongPlan> {
  const identity = data.identity;
  if (!nativeGekisoAllComboDriverSupports(identity))
    return fail("native-gekiso-chart-driver-source-unreviewed", identity.sourceId ?? "sourceId");
  const missions = song.segments.map((range) => range.mission);
  if (missions.length !== 3 || missions.some((mission) => mission !== 1) || timing.fever.length !== 3 || song.gaps.length)
    return fail("native-gekiso-chart-driver-all-combo-required", song.key);
  if (!timing.bpmChanges.length || timing.bpmChanges.some((change, i) => !Number.isFinite(change.bpm) ||
    change.bpm <= 0 || !int(change.tick) || !int(change.timeMs) ||
    (i > 0 && change.tick < timing.bpmChanges[i - 1]!.tick)))
    return fail("native-gekiso-chart-driver-timing-unresolved", song.key);
  const ranges = timing.fever.map(([start, end], i) => ({
    startTimeMs: tickToTimeMs(timing.bpmChanges, start),
    endTimeMs: tickToTimeMs(timing.bpmChanges, end), rank: 1,
    startTick: start, endTick: end, index: i,
  }));
  if (ranges.some((range, i) => !int(range.startTimeMs) || !int(range.endTimeMs) ||
    range.endTimeMs <= range.startTimeMs || range.startTick !== song.segments[i]!.startTick ||
    range.endTick !== song.segments[i]!.endTick ||
    (i > 0 && range.startTimeMs <= ranges[i - 1]!.endTimeMs)))
    return fail("native-gekiso-chart-driver-range-unresolved", song.key);
  const timingRows = dataRows(data.liveTools.judgementTiming).map(nativeRow);
  if (!timingRows.length || timingRows.some((row) => !int(row.afterMs)))
    return fail("native-gekiso-chart-driver-slow-delay-unresolved", "all MasterLiveJudgementTiming.AfterMs");
  // CreateGekisouLiveSettings: complete delay literal500; last slow delay is
  // max(GetAllLiveJudgementTimingIDs -> record.AfterMs), including assist rows.
  const slowDelay = Math.max(0, ...timingRows.map((row) => row.afterMs as number)), completeDelay = 500;
  if (ranges.some((range, i) => i < 2 && range.endTimeMs + slowDelay + completeDelay + 8 >= ranges[i + 1]!.startTimeMs))
    return fail("native-gekiso-chart-driver-completion-overlap", song.key);
  const durations = new Set<number>();
  for (const skill of Object.values(data.skills.gekiso ?? {}))
    for (const row of dataRows(skill.effects).map(nativeRow))
      if (row.skillTriggerType === 1 && (options?.effectTypes ?? [12000]).includes(Number(row.skillEffectType)) &&
        typeof row.activationTimeSecond === "number" && Number.isFinite(f(row.activationTimeSecond)) &&
        row.activationTimeSecond > 0) durations.add(Math.ceil(f(f(row.activationTimeSecond) * f(1000))));
  const pending = new Set<number>([0]);
  for (const range of ranges) {
    pending.add(Math.max(0, range.startTimeMs - 4000));
    pending.add(range.startTimeMs); pending.add(range.startTimeMs + 1);
    pending.add(range.endTimeMs);
    for (const duration of durations) for (const offset of [0, 1, 2])
      pending.add(range.startTimeMs + duration + offset);
  }
  const noteGroups = new Map<number, { rangeIndex: 0 | 1 | 2; operation: number }[]>();
  let previousNote = -1;
  for (const event of song.events) {
    if (!int(event.timeMs) || event.timeMs < previousNote || !int(event.operateType))
      return fail("native-gekiso-chart-driver-note-unresolved", song.key);
    previousNote = event.timeMs;
    const byTick = ranges.findIndex((range) => range.startTick <= event.tick && event.tick <= range.endTick);
    const byTime = ranges.findIndex((range) => range.startTimeMs <= event.timeMs && event.timeMs <= range.endTimeMs);
    if (byTick !== byTime) return fail("native-gekiso-chart-driver-target-boundary", song.key);
    pending.add(event.timeMs);
    if (byTime >= 0) {
      const notes = noteGroups.get(event.timeMs) ?? [];
      notes.push({ rangeIndex: byTime as 0 | 1 | 2, operation: event.operateType });
      noteGroups.set(event.timeMs, notes);
    }
  }
  const state = [1, 1, 1], sourcePhase = [1, 1, 1], elapsed = [f(0), f(0), f(0)];
  const frames: NativeGekisoRuntimeFrame[] = [];
  let previous = 0, sequence = 0;
  const clockMs = (seconds: number) => Math.trunc(f(seconds * f(1000)));
  const nextClockBoundary = (now: number, index: number, delay: number) => {
    let next = now + Math.max(1, delay - clockMs(elapsed[index]!));
    while (clockMs(f(elapsed[index]! + f((next - now) / 1000))) < delay) next++;
    pending.add(next);
  };
  while (pending.size) {
    const now = Math.min(...pending); pending.delete(now);
    if (!int(now) || frames.length >= 10000) return fail("native-gekiso-chart-driver-frame-budget", song.key);
    const deltaSeconds = f((now - previous) / 1000), updates: NativeGekisoRuntimeFrame["rangeUpdates"][number][] = [];
    const changed = (i: number) => updates.push({ rangeIndex: i, simulateState: state[i]!, mission: 1,
      startTimeMs: ranges[i]!.startTimeMs });
    // Original BeforeUpdate advances existing states before source transitions.
    for (let i = 0; i < 3; i++) {
      if (state[i] === 3) { state[i] = 4; changed(i); }
      else if (state[i] === 5 || state[i] === 6) {
        elapsed[i] = f(elapsed[i]! + deltaSeconds);
        const delay = state[i] === 5 ? slowDelay : completeDelay;
        if (clockMs(elapsed[i]!) >= delay) {
          state[i] = state[i]! + 1; elapsed[i] = f(0); changed(i);
          pending.add(now + 1);
        } else nextClockBoundary(now, i, delay);
      } else if (state[i] === 7) { state[i] = 8; changed(i); }
    }
    // FeverEventUpdater: one transition/update; start/end thresholds inclusive.
    for (let i = 0; i < 3; i++) {
      if (sourcePhase[i] === 1 && now >= ranges[i]!.startTimeMs) {
        sourcePhase[i] = 2; state[i] = 3; changed(i); pending.add(now + 1);
      } else if (sourcePhase[i] === 2 && now >= ranges[i]!.endTimeMs) {
        sourcePhase[i] = 3; state[i] = 5; elapsed[i] = f(0); changed(i);
        nextClockBoundary(now, i, slowDelay);
      }
    }
    for (let i = 0; i < 3; i++) if (state[i] === 1 && ranges[i]!.startTimeMs - now <= 4000) {
      state[i] = 2; changed(i);
    }
    const before = sequence;
    const notes = (noteGroups.get(now) ?? []).map((note) => ({ ...note, timeMs: now,
      judgement: 5 as const, sequence: sequence++, rangeState: state[note.rangeIndex] as 3 | 4 | 5 }));
    if (notes.some((note) => ![3, 4, 5].includes(note.rangeState)))
      return fail("native-gekiso-chart-driver-admission-unresolved", song.key);
    frames.push({ timeMs: now, rangeUpdates: updates, notes, judgementSequenceBeforePhase2: before });
    previous = now;
  }
  if (state.some((value) => value !== 8)) return fail("native-gekiso-chart-driver-incomplete", song.key);
  return { value: { producer: "native-all-combo-ap-event-reduction-v1",
    identity: { server: identity.server, releaseId: identity.releaseId, sourceId: identity.sourceId! },
    missionPattern: nativeGekisoMissionPattern(missions)!, frames,
    ranges: ranges.map(({ startTimeMs, endTimeMs, rank }) => ({ startTimeMs, endTimeMs, rank })),
  }, gaps: [] };
}
