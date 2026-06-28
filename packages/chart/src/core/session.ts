import {
  FeverState,
  JudgementAreaOffsetType,
  JudgeTiming,
  NoteJudgementType,
  NoteOperateType,
  NoteSimulateJudgement,
} from "./enums";
import type { ChartMode } from "./enums";
import { isTargetLane, LANE_COUNT } from "./geometry";
import {
  isTargetDirectionFlick,
  judge,
  MAXIMUM_EARLY_WINDOW,
  maximumEarlyWindow as calculateMaximumEarlyWindow,
  maximumLateWindow as calculateMaximumLateWindow,
} from "./judgement";
import { contribution, LIFE_BASE, lifeDamage, normalizeScore, perfectCeiling, preservesCombo } from "./scoring";
import type {
  ChartCallChangeEvent,
  ChartDocument,
  ChartFeverSection,
  ChartFeverTransitionEvent,
  ChartNote,
  ChartSkillEvent,
  JudgementEvent,
  SessionLineState,
  SessionNoteState,
  SessionSnapshot,
} from "./types";

export interface SessionOptions {
  mode?: ChartMode;
  judgementOffsetMs?: number;
}

export interface InputVector {
  dx: number;
  dy: number;
}

type PointerToken = number | typeof DEFAULT_POINTER;

const DEFAULT_POINTER = Symbol("default-pointer");
const EMPTY_LINE_IDS: readonly number[] = Object.freeze([]);

const MAXIMUM_EARLY_BY_TYPE: number[] = [];
const MAXIMUM_LATE_BY_TYPE: number[] = [];

function maximumEarlyWindow(type: NoteJudgementType): number {
  return (MAXIMUM_EARLY_BY_TYPE[type] ??= calculateMaximumEarlyWindow(type));
}

function maximumLateWindow(type: NoteJudgementType): number {
  return (MAXIMUM_LATE_BY_TYPE[type] ??= calculateMaximumLateWindow(type));
}

export type ChartSessionEventMap = {
  judgement: JudgementEvent;
  skill: ChartSkillEvent;
  fever: ChartFeverTransitionEvent;
  callChange: ChartCallChangeEvent;
  update: SessionSnapshot;
  reset: SessionSnapshot;
};

/**
 * LiveJudgementAreaOffsetSettings.GetJudgementAreaOffset using assist level 0
 * master data. Slide offsets interpolate by native note-lane width (4 -> 5).
 */
export function nativeJudgementAreaOffsetX(type: JudgementAreaOffsetType, noteLaneWidth: number): number {
  switch (type) {
    case JudgementAreaOffsetType.Slide: {
      const progress = Math.max(0, Math.min(1, (noteLaneWidth - 4) / (5 - 4)));
      return 2 + (1 - 2) * progress;
    }
    case JudgementAreaOffsetType.SlideBegin:
    case JudgementAreaOffsetType.SlideMin:
      return 2;
    case JudgementAreaOffsetType.SlideEnd:
    case JudgementAreaOffsetType.Flick:
      return 3;
    case JudgementAreaOffsetType.Trace:
    case JudgementAreaOffsetType.EasyDefault:
    case JudgementAreaOffsetType.EasySlideBegin:
      return 2.8;
    case JudgementAreaOffsetType.SlideMax:
    case JudgementAreaOffsetType.Default:
    case JudgementAreaOffsetType.EnumMax:
    default:
      return 1;
  }
}

function isFlick(note: ChartNote): boolean {
  return (
    note.operateType === NoteOperateType.Flick ||
    note.operateType === NoteOperateType.SlideBeginFlick ||
    note.operateType === NoteOperateType.SlideEndFlick ||
    note.operateType === NoteOperateType.GuideBeginFlick
  );
}

function isRelease(note: ChartNote): boolean {
  return note.operateType === NoteOperateType.SlideEnd;
}

function isTrace(note: ChartNote): boolean {
  return note.judgementType === NoteJudgementType.Trace || note.judgementType === NoteJudgementType.SlideEndTrace;
}

function isTap(note: ChartNote): boolean {
  return !isFlick(note) && !isRelease(note) && !isTrace(note);
}

function acceptsAnyInput(_note: ChartNote): boolean {
  return true;
}

function isLineEnd(note: ChartNote): boolean {
  return (
    note.operateType === NoteOperateType.SlideEnd ||
    note.operateType === NoteOperateType.SlideEndFlick ||
    note.operateType === NoteOperateType.SlideEndTrace
  );
}

function notesOverlap(left: ChartNote, right: ChartNote): boolean {
  return left.pos <= right.pos + right.size && right.pos <= left.pos + left.size;
}

export class ChartSession {
  mode: ChartMode;
  private readonly listeners = new Map<keyof ChartSessionEventMap, Set<(event: never) => void>>();
  private readonly processed = new Set<number>();
  private readonly noteState: SessionNoteState = Object.freeze({
    isProcessed: (noteId: number): boolean => this.processed.has(noteId),
  });
  private readonly lineState: SessionLineState = Object.freeze({
    isActive: (lineId: number): boolean => this.isLongLineActive(lineId),
  });
  private readonly playableNotes: ChartNote[];
  private readonly longLineIdsByNoteId: ReadonlyMap<number, readonly number[]>;
  private readonly longLineStartIdsByNoteId: ReadonlyMap<number, readonly number[]>;
  private readonly longLineEndIdsByNoteId: ReadonlyMap<number, readonly number[]>;
  private readonly watchLongLineSpans: ReadonlyArray<{ startTimeMs: number; endTimeMs: number }>;
  private readonly longLineSpanById: ReadonlyMap<number, { startTimeMs: number; endTimeMs: number }>;
  private readonly maximumLateMs: number;
  private readonly pointerLines = new Map<PointerToken, number>();
  private readonly linePointers = new Map<number, PointerToken>();
  private readonly ceiling: number;
  private readonly reusableSnapshot: SessionSnapshot;
  private readonly executedSkills: Uint8Array;
  private readonly skillTimelineIsMonotonic: boolean;
  private readonly activeFeverSections: number[] = [];
  private judgementOffsetMs: number;
  private contributionSum = 0;
  private score = 0;
  private combo = 0;
  private perfectCombo = true;
  private maxCombo = 0;
  private life = LIFE_BASE;
  private lastJudgement: JudgementEvent | null = null;
  private lastSkill: ChartSkillEvent | null = null;
  private callChange: ChartCallChangeEvent | null = null;
  private feverState = FeverState.Wait;
  private feverSection: ChartFeverSection | null = null;
  private timeMs = 0;
  private skillCursor = 0;
  private feverStartCursor = 0;
  private callChangeCursor = 0;
  /** First note which has not already been consumed; keeps rAF updates O(new notes). */
  private updateCursor = 0;

  constructor(
    readonly chart: ChartDocument,
    options: SessionOptions = {},
  ) {
    this.mode = options.mode ?? "watch";
    this.judgementOffsetMs = options.judgementOffsetMs ?? 0;
    this.playableNotes = chart.notes.filter((note) => note.judged);
    const longLines = chart.lines.filter((line) => line.kind === "long");
    const memberships = new Map<number, number[]>();
    const starts = new Map<number, number[]>();
    const ends = new Map<number, number[]>();
    const include = (index: Map<number, number[]>, noteId: number | undefined, lineId: number) => {
      if (noteId === undefined) return;
      const lineIds = index.get(noteId);
      if (lineIds) lineIds.push(lineId);
      else index.set(noteId, [lineId]);
    };
    for (const line of longLines) {
      for (const noteId of line.noteIds) include(memberships, noteId, line.id);
      include(starts, line.noteIds[0], line.id);
      include(ends, line.noteIds.at(-1), line.id);
    }
    this.longLineIdsByNoteId = memberships;
    this.longLineStartIdsByNoteId = starts;
    this.longLineEndIdsByNoteId = ends;
    const noteById = new Map(chart.notes.map((note) => [note.id, note] as const));
    const longLineSpans = longLines
      .map((line) => {
        const notes = line.noteIds
          .map((id) => noteById.get(id))
          .filter((note): note is ChartNote => note !== undefined);
        return {
          id: line.id,
          startTimeMs: notes.reduce((minimum, note) => Math.min(minimum, note.timeMs), Number.POSITIVE_INFINITY),
          endTimeMs: notes.reduce((maximum, note) => Math.max(maximum, note.timeMs), Number.NEGATIVE_INFINITY),
        };
      })
      .filter((line) => Number.isFinite(line.startTimeMs) && line.endTimeMs > line.startTimeMs);
    this.longLineSpanById = new Map(longLineSpans.map((line) => [line.id, line] as const));
    const sortedSpans = longLineSpans
      .map(({ startTimeMs, endTimeMs }) => ({ startTimeMs, endTimeMs }))
      .sort((left, right) => left.startTimeMs - right.startTimeMs || left.endTimeMs - right.endTimeMs);
    const mergedSpans: Array<{ startTimeMs: number; endTimeMs: number }> = [];
    for (const span of sortedSpans) {
      const previous = mergedSpans[mergedSpans.length - 1];
      if (previous && span.startTimeMs <= previous.endTimeMs)
        previous.endTimeMs = Math.max(previous.endTimeMs, span.endTimeMs);
      else mergedSpans.push(span);
    }
    this.watchLongLineSpans = mergedSpans;
    this.maximumLateMs = this.playableNotes.reduce(
      (maximum, note) => Math.max(maximum, maximumLateWindow(note.judgementType)),
      0,
    );
    this.ceiling = perfectCeiling(this.playableNotes.map((note) => note.operateType));
    this.executedSkills = new Uint8Array(chart.timeline.skills.length);
    this.skillTimelineIsMonotonic = chart.timeline.skills.every(
      (event, index, events) => index === 0 || events[index - 1]!.timeMs <= event.timeMs,
    );
    this.reusableSnapshot = {
      timeMs: 0,
      durationMs: chart.durationMs,
      activeLongLine: false,
      combo: 0,
      perfectCombo: false,
      maxCombo: 0,
      score: 0,
      life: LIFE_BASE,
      processed: 0,
      total: this.playableNotes.length,
      lastJudgement: null,
      lastSkill: null,
      callChange: null,
      feverState: FeverState.Wait,
      feverSection: null,
      noteState: this.noteState,
      lineState: this.lineState,
    };
  }

  on<K extends keyof ChartSessionEventMap>(type: K, listener: (event: ChartSessionEventMap[K]) => void): () => void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener as (event: never) => void);
    this.listeners.set(type, set);
    return () => set.delete(listener as (event: never) => void);
  }

  setOffset(milliseconds: number): void {
    this.judgementOffsetMs = milliseconds;
  }

  setMode(mode: ChartMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.reset(this.timeMs);
  }

  update(timeMs: number): SessionSnapshot {
    this.advance(timeMs);
    const snapshot = this.snapshot();
    this.emit("update", snapshot);
    return snapshot;
  }

  /**
   * Allocation-free rAF variant. The returned object is overwritten by the
   * next reusable update and therefore must not be retained as history.
   */
  updateReusable(timeMs: number): SessionSnapshot {
    this.advance(timeMs);
    const snapshot = this.writeSnapshot(this.reusableSnapshot);
    this.emit("update", snapshot);
    return snapshot;
  }

  private advance(timeMs: number): void {
    const nextTimeMs = Number.isFinite(timeMs) ? timeMs : 0;
    if (nextTimeMs + 5 < this.timeMs) this.reset(nextTimeMs);
    // Positive BGM offsets create a real pre-roll before chart time zero.
    // Keeping that time negative prevents watch mode from consuming tick-zero
    // notes as soon as the media element starts.
    this.timeMs = nextTimeMs;
    this.advanceTimeline();
    this.advanceUpdateCursor();
    if (this.mode === "watch") {
      while (this.updateCursor < this.playableNotes.length) {
        const note = this.playableNotes[this.updateCursor]!;
        if (note.timeMs > this.timeMs) break;
        if (this.processed.has(note.id)) this.updateCursor++;
        else this.apply(note, NoteSimulateJudgement.Perfect, JudgeTiming.Auto, 0, this.timeMs);
      }
    } else if (this.mode === "play") {
      while (this.updateCursor < this.playableNotes.length) {
        const note = this.playableNotes[this.updateCursor]!;
        if (this.processed.has(note.id)) {
          this.updateCursor++;
          continue;
        }
        if (note.timeMs + maximumLateWindow(note.judgementType) >= this.timeMs + this.judgementOffsetMs) break;
        this.apply(
          note,
          NoteSimulateJudgement.Miss,
          JudgeTiming.OutOfTime,
          this.timeMs + this.judgementOffsetMs - note.timeMs,
          this.timeMs,
        );
      }
    }
  }

  tap(lane: number, timeMs = this.timeMs, pointerId?: number): JudgementEvent | null {
    return this.consume(lane, timeMs, isTap, pointerId);
  }

  release(lane: number, timeMs = this.timeMs, pointerId?: number): JudgementEvent | null {
    const pointer = this.pointerToken(pointerId);
    const result = this.consume(lane, timeMs, isRelease, pointerId);
    // A lifted finger no longer maintains its long-note line even when the
    // release happened before the end judgment window.
    this.unbindPointer(pointer);
    return result;
  }

  flick(lane: number, vector: InputVector, timeMs = this.timeMs, pointerId?: number): JudgementEvent | null {
    return this.consume(lane, timeMs, isFlick, pointerId, vector);
  }

  trace(lane: number, timeMs = this.timeMs, pointerId?: number): JudgementEvent | null {
    return this.consume(lane, timeMs, isTrace, pointerId);
  }

  /**
   * Reports whether this pointer is currently over any consumable note,
   * regardless of gesture. LiveLaneFingerState suppresses InVain feedback for
   * a claimed input before a later trace/flick phase performs the judgement;
   * this read-only query lets the browser input adapter preserve that order.
   */
  hasInputCandidate(lane: number, inputTimeMs = this.timeMs, pointerId?: number): boolean {
    if (this.mode !== "play") return false;
    if (!Number.isFinite(lane) || lane < 0 || lane > LANE_COUNT - 1) return false;
    const adjustedTime = inputTimeMs + this.judgementOffsetMs;
    const pointer = this.pointerToken(pointerId);
    let low = 0;
    let high = this.playableNotes.length;
    const earliestCandidateTime = adjustedTime - this.maximumLateMs;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.playableNotes[middle]!.timeMs < earliestCandidateTime) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < this.playableNotes.length; index++) {
      const note = this.playableNotes[index]!;
      const diff = adjustedTime - note.timeMs;
      if (diff < -MAXIMUM_EARLY_WINDOW) break;
      if (this.candidateDistance(note, diff, lane, pointer, acceptsAnyInput) >= 0) return true;
    }
    return false;
  }

  cancel(pointerId?: number): void {
    this.unbindPointer(this.pointerToken(pointerId));
  }

  reset(timeMs = 0): SessionSnapshot {
    this.processed.clear();
    this.contributionSum = 0;
    this.score = 0;
    this.combo = 0;
    this.perfectCombo = true;
    this.maxCombo = 0;
    this.life = LIFE_BASE;
    this.lastJudgement = null;
    this.lastSkill = null;
    this.callChange = null;
    this.feverState = FeverState.Wait;
    this.feverSection = null;
    const nextTimeMs = Number.isFinite(timeMs) ? timeMs : 0;
    this.timeMs = nextTimeMs;
    this.updateCursor = 0;
    this.executedSkills.fill(0);
    this.skillCursor = 0;
    this.activeFeverSections.length = 0;
    this.feverStartCursor = 0;
    this.callChangeCursor = 0;
    this.pointerLines.clear();
    this.linePointers.clear();
    if (nextTimeMs > 0) this.rebuildTimeline(nextTimeMs);
    if (this.mode === "watch" && nextTimeMs > 0) {
      // Rebuild watch state without replaying every historical judgement into
      // host UI listeners. A seek has one reset notification; it is not a burst
      // of new player input events.
      while (this.updateCursor < this.playableNotes.length) {
        const note = this.playableNotes[this.updateCursor]!;
        if (note.timeMs > this.timeMs) break;
        this.apply(note, NoteSimulateJudgement.Perfect, JudgeTiming.Auto, 0, this.timeMs, false);
      }
    } else if (this.mode === "play" && nextTimeMs > 0) {
      // A transport seek is not a gameplay miss. Notes whose complete late
      // window is already behind the new playhead become inert without life,
      // score, combo or judgment-event side effects.
      const adjustedTime = this.timeMs + this.judgementOffsetMs;
      for (const note of this.playableNotes) {
        if (note.timeMs + maximumLateWindow(note.judgementType) >= adjustedTime) break;
        this.processed.add(note.id);
      }
      // Seeking into the middle of a long note cannot recreate its original
      // finger claim. Once its start is behind the transport position, skip
      // the remaining nodes as one inert line instead of emitting unavoidable
      // trace/end Miss events after the seek.
      const skippedLongLines = new Set<number>();
      for (const note of this.playableNotes) {
        if (this.processed.has(note.id)) {
          for (const lineId of this.longLineStartIds(note)) skippedLongLines.add(lineId);
        }
      }
      for (const note of this.playableNotes) {
        if (this.longLineIdsFor(note).some((lineId) => skippedLongLines.has(lineId))) this.processed.add(note.id);
      }
      this.advanceUpdateCursor();
    }
    const snapshot = this.snapshot();
    this.emit("reset", snapshot);
    return snapshot;
  }

  snapshot(): SessionSnapshot {
    return this.writeSnapshot({ ...this.reusableSnapshot });
  }

  private writeSnapshot(target: SessionSnapshot): SessionSnapshot {
    target.timeMs = this.timeMs;
    target.durationMs = this.chart.durationMs;
    target.activeLongLine = this.hasActiveLongLine();
    target.combo = this.combo;
    target.perfectCombo = this.combo > 0 && this.perfectCombo;
    target.maxCombo = this.maxCombo;
    target.score = this.score;
    target.life = this.life;
    target.processed = this.processed.size;
    target.total = this.playableNotes.length;
    target.lastJudgement = this.lastJudgement;
    target.lastSkill = this.lastSkill;
    target.callChange = this.callChange;
    target.feverState = this.feverState;
    target.feverSection = this.feverSection;
    target.noteState = this.noteState;
    target.lineState = this.lineState;
    return target;
  }

  private consume(
    lane: number,
    inputTimeMs: number,
    predicate: (note: ChartNote) => boolean,
    pointerId?: number,
    flickVector?: InputVector,
  ): JudgementEvent | null {
    if (this.mode !== "play") return null;
    if (!Number.isFinite(lane) || lane < 0 || lane > LANE_COUNT - 1) return null;
    const adjustedTime = inputTimeMs + this.judgementOffsetMs;
    const pointer = this.pointerToken(pointerId);
    let low = 0;
    let high = this.playableNotes.length;
    const earliestCandidateTime = adjustedTime - this.maximumLateMs;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.playableNotes[middle]!.timeMs < earliestCandidateTime) low = middle + 1;
      else high = middle;
    }
    let end = this.playableNotes.length;
    let candidate: ChartNote | undefined;
    let candidateDistance = Number.POSITIVE_INFINITY;
    for (let index = low; index < this.playableNotes.length; index++) {
      const note = this.playableNotes[index]!;
      const diff = adjustedTime - note.timeMs;
      if (diff < -MAXIMUM_EARLY_WINDOW) {
        end = index;
        break;
      }
      const distance = this.candidateDistance(note, diff, lane, pointer, predicate);
      if (distance < 0) continue;
      if (distance < candidateDistance || (distance === candidateDistance && note.id < candidate!.id)) {
        candidate = note;
        candidateDistance = distance;
      }
    }
    if (!candidate) return null;

    if (flickVector) {
      // The native caller uses IsTargetDirectionFlick only to select a higher
      // priority input unit. Mirror that as a tie-break among coincident,
      // overlapping candidates; a failed direction check never rejects the
      // fallback candidate or changes its judgment.
      let directional: ChartNote | undefined;
      for (let index = low; index < end; index++) {
        const note = this.playableNotes[index]!;
        const diff = adjustedTime - note.timeMs;
        if (this.candidateDistance(note, diff, lane, pointer, predicate) !== candidateDistance) continue;
        if (note.timeMs !== candidate.timeMs || !notesOverlap(note, candidate)) continue;
        if (!isTargetDirectionFlick(note.direction, flickVector)) continue;
        if (!directional || note.id < directional.id) directional = note;
      }
      if (directional) candidate = directional;
    }

    const diffMs = adjustedTime - candidate.timeMs;
    const result = judge(candidate.judgementType, diffMs);
    const event = this.apply(candidate, result.judgement, result.timing, diffMs, inputTimeMs);
    const startLineId = this.availableStartLine(candidate, pointer);
    if (startLineId !== null && result.judgement !== NoteSimulateJudgement.Miss) {
      this.bindPointer(pointer, startLineId);
    }
    if (isLineEnd(candidate)) this.unbindEndingLines(candidate);
    return event;
  }

  private candidateDistance(
    note: ChartNote,
    diff: number,
    lane: number,
    pointer: PointerToken,
    predicate: (note: ChartNote) => boolean,
  ): number {
    if (this.processed.has(note.id) || !predicate(note)) return -1;
    if (diff < -maximumEarlyWindow(note.judgementType) || diff > maximumLateWindow(note.judgementType)) return -1;
    if (!isTargetLane(note, lane, nativeJudgementAreaOffsetX(note.judgementAreaOffsetType, note.size))) return -1;
    if (!this.isAvailableToPointer(note, pointer)) return -1;
    return Math.abs(diff);
  }

  private apply(
    note: ChartNote,
    judgement: NoteSimulateJudgement,
    timing: JudgeTiming,
    diffMs: number,
    judgedAtMs = note.timeMs + diffMs,
    notify = true,
  ): JudgementEvent {
    const previousScore = this.score;
    this.processed.add(note.id);
    this.advanceUpdateCursor();
    if (isLineEnd(note)) this.unbindEndingLines(note);
    if (preservesCombo(judgement)) {
      if (this.combo === 0) this.perfectCombo = true;
      this.perfectCombo =
        this.perfectCombo && (judgement === NoteSimulateJudgement.Perfect || judgement === NoteSimulateJudgement.Just);
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
    } else {
      this.combo = 0;
      this.perfectCombo = true;
    }
    this.life = Math.max(0, this.life - lifeDamage(judgement));
    this.contributionSum += contribution(judgement, note.operateType, this.combo);
    const score = normalizeScore(this.contributionSum, this.ceiling, this.life);
    this.score = score;
    const event: JudgementEvent = {
      note,
      judgement,
      timing,
      diffMs,
      judgedAtMs,
      combo: this.combo,
      maxCombo: this.maxCombo,
      score,
      scoreDelta: Math.max(0, score - previousScore),
      life: this.life,
    };
    this.lastJudgement = event;
    if (notify) this.emit("judgement", event);
    return event;
  }

  private pointerToken(pointerId: number | undefined): PointerToken {
    return pointerId ?? DEFAULT_POINTER;
  }

  private advanceUpdateCursor(): void {
    while (
      this.updateCursor < this.playableNotes.length &&
      this.processed.has(this.playableNotes[this.updateCursor]!.id)
    ) {
      this.updateCursor++;
    }
  }

  /**
   * Mirrors the independent native event updaters without allocating on rAF.
   * FeverEventUpdater.Update (0x4fc5b04) advances only one state per updater
   * call, so a frame which jumps over both bounds emits Fever now and End on
   * the following update instead of collapsing both transitions.
   */
  private advanceTimeline(): void {
    if (this.skillTimelineIsMonotonic) {
      while (this.skillCursor < this.chart.timeline.skills.length) {
        const event = this.chart.timeline.skills[this.skillCursor]!;
        if (event.timeMs > this.timeMs) break;
        this.executedSkills[this.skillCursor] = 1;
        this.skillCursor++;
        this.lastSkill = event;
        this.emit("skill", event);
      }
    } else {
      // BuildSkillList preserves source order. Keep that observable order for
      // malformed/non-monotonic inputs even though ordinary scores use the
      // allocation-free cursor path above.
      for (let index = 0; index < this.chart.timeline.skills.length; index++) {
        if (this.executedSkills[index]) continue;
        const event = this.chart.timeline.skills[index]!;
        if (event.timeMs > this.timeMs) continue;
        this.executedSkills[index] = 1;
        this.lastSkill = event;
        this.emit("skill", event);
      }
    }

    let retainedFeverCount = 0;
    for (const index of this.activeFeverSections) {
      const section = this.chart.timeline.fever[index]!;
      if (section.endTimeMs <= this.timeMs) this.applyFeverTransition(section, FeverState.End);
      else this.activeFeverSections[retainedFeverCount++] = index;
    }
    this.activeFeverSections.length = retainedFeverCount;

    while (this.feverStartCursor < this.chart.timeline.fever.length) {
      const section = this.chart.timeline.fever[this.feverStartCursor]!;
      if (section.startTimeMs > this.timeMs) break;
      this.feverStartCursor++;
      this.activeFeverSections.push(section.index);
      this.applyFeverTransition(section, FeverState.Fever);
    }

    while (this.callChangeCursor < this.chart.timeline.callChanges.length) {
      const event = this.chart.timeline.callChanges[this.callChangeCursor]!;
      if (event.timeMs > this.timeMs) break;
      this.callChangeCursor++;
      this.callChange = event;
      this.emit("callChange", event);
    }
  }

  private applyFeverTransition(section: ChartFeverSection, state: FeverState.Fever | FeverState.End): void {
    this.feverState = state;
    this.feverSection = section;
    this.emit("fever", {
      section,
      state,
      timeMs: state === FeverState.Fever ? section.startTimeMs : section.endTimeMs,
    });
  }

  /** Reconstructs a seek target without replaying historical host callbacks. */
  private rebuildTimeline(timeMs: number): void {
    if (this.skillTimelineIsMonotonic) {
      while (this.skillCursor < this.chart.timeline.skills.length) {
        const event = this.chart.timeline.skills[this.skillCursor]!;
        if (event.timeMs > timeMs) break;
        this.executedSkills[this.skillCursor] = 1;
        this.skillCursor++;
        this.lastSkill = event;
      }
    } else {
      for (let index = 0; index < this.chart.timeline.skills.length; index++) {
        const event = this.chart.timeline.skills[index]!;
        if (event.timeMs > timeMs) continue;
        this.executedSkills[index] = 1;
        this.lastSkill = event;
      }
    }

    let latestFeverTime = Number.NEGATIVE_INFINITY;
    let latestFeverOrder = -1;
    while (this.feverStartCursor < this.chart.timeline.fever.length) {
      const section = this.chart.timeline.fever[this.feverStartCursor]!;
      if (section.startTimeMs > timeMs) break;
      this.feverStartCursor++;
      if (section.endTimeMs <= timeMs) {
        if (
          section.endTimeMs > latestFeverTime ||
          (section.endTimeMs === latestFeverTime && section.index * 2 + 1 >= latestFeverOrder)
        ) {
          latestFeverTime = section.endTimeMs;
          latestFeverOrder = section.index * 2 + 1;
          this.feverState = FeverState.End;
          this.feverSection = section;
        }
      } else {
        this.activeFeverSections.push(section.index);
      }
      if (
        section.startTimeMs > latestFeverTime ||
        (section.startTimeMs === latestFeverTime && section.index * 2 >= latestFeverOrder)
      ) {
        latestFeverTime = section.startTimeMs;
        latestFeverOrder = section.index * 2;
        this.feverState = FeverState.Fever;
        this.feverSection = section;
      }
    }

    while (this.callChangeCursor < this.chart.timeline.callChanges.length) {
      const event = this.chart.timeline.callChanges[this.callChangeCursor]!;
      if (event.timeMs > timeMs) break;
      this.callChangeCursor++;
      this.callChange = event;
    }
  }

  private longLineIdsFor(note: ChartNote): readonly number[] {
    return this.longLineIdsByNoteId.get(note.id) ?? EMPTY_LINE_IDS;
  }

  private longLineStartIds(note: ChartNote): readonly number[] {
    return this.longLineStartIdsByNoteId.get(note.id) ?? EMPTY_LINE_IDS;
  }

  private longLineEndIds(note: ChartNote): readonly number[] {
    return this.longLineEndIdsByNoteId.get(note.id) ?? EMPTY_LINE_IDS;
  }

  private isLongLineActive(lineId: number): boolean {
    if (this.mode !== "watch" && this.mode !== "play") return false;
    const span = this.longLineSpanById.get(lineId);
    return Boolean(
      span &&
      span.startTimeMs <= this.timeMs &&
      this.timeMs < span.endTimeMs &&
      (this.mode === "watch" || this.linePointers.has(lineId)),
    );
  }

  /** LiveSoundPlayer.UpdateLongLineSe. */
  private hasActiveLongLine(): boolean {
    if (this.mode === "watch") {
      // Spans are merged once, so the rightmost start <= time is sufficient.
      let low = 0;
      let high = this.watchLongLineSpans.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (this.watchLongLineSpans[middle]!.startTimeMs <= this.timeMs) low = middle + 1;
        else high = middle;
      }
      const span = this.watchLongLineSpans[low - 1];
      return Boolean(span && this.timeMs < span.endTimeMs);
    }
    if (this.mode === "play") {
      // At most four native pointers can own a line, independent of chart size.
      for (const lineId of this.linePointers.keys()) {
        const span = this.longLineSpanById.get(lineId);
        if (span && span.startTimeMs <= this.timeMs && this.timeMs < span.endTimeMs) return true;
      }
    }
    return false;
  }

  private isAvailableToPointer(note: ChartNote, pointer: PointerToken): boolean {
    const lineIds = this.longLineIdsFor(note);
    if (lineIds.length === 0) return true;
    if (this.longLineStartIds(note).length > 0) return this.availableStartLine(note, pointer) !== null;
    const lineId = this.pointerLines.get(pointer);
    return lineId !== undefined && lineIds.includes(lineId) && this.linePointers.get(lineId) === pointer;
  }

  private availableStartLine(note: ChartNote, pointer: PointerToken): number | null {
    const startIds = this.longLineStartIds(note);
    const currentLine = this.pointerLines.get(pointer);
    if (currentLine !== undefined && startIds.includes(currentLine) && this.linePointers.get(currentLine) === pointer) {
      return currentLine;
    }
    for (const lineId of startIds) {
      const currentPointer = this.linePointers.get(lineId);
      if (currentLine === undefined && (currentPointer === undefined || currentPointer === pointer)) return lineId;
    }
    return null;
  }

  private unbindEndingLines(note: ChartNote): void {
    for (const lineId of this.longLineEndIds(note)) this.unbindLine(lineId);
  }

  private bindPointer(pointer: PointerToken, lineId: number): void {
    this.unbindPointer(pointer);
    this.unbindLine(lineId);
    this.pointerLines.set(pointer, lineId);
    this.linePointers.set(lineId, pointer);
  }

  private unbindPointer(pointer: PointerToken): void {
    const lineId = this.pointerLines.get(pointer);
    if (lineId === undefined) return;
    this.pointerLines.delete(pointer);
    if (this.linePointers.get(lineId) === pointer) this.linePointers.delete(lineId);
  }

  private unbindLine(lineId: number): void {
    const pointer = this.linePointers.get(lineId);
    if (pointer === undefined) return;
    this.linePointers.delete(lineId);
    if (this.pointerLines.get(pointer) === lineId) this.pointerLines.delete(pointer);
  }

  private emit<K extends keyof ChartSessionEventMap>(type: K, event: ChartSessionEventMap[K]): void {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) listener(event as never);
  }
}
