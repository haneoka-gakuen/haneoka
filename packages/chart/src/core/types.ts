import type {
  FeverState,
  JudgementAreaOffsetType,
  JudgeTiming,
  NoteDirection,
  NoteJudgementType,
  NoteLineEaseType,
  NoteOperateType,
  NoteSimulateJudgement,
} from "./enums";

export interface SsBpm {
  t: number;
  bpm: number;
}

export interface SsSig {
  t: number;
  sig: [number, number];
}

export interface SsCall {
  t: number;
  timing: number[];
}

export type SsNoteType = "tap" | "flick" | "trace" | "long" | "guide" | "node";
export type SsFlickDirection = "up" | "left" | "right" | "down";
export type SsEase = "linear" | "in" | "out";
export type SsFadeType = "none" | "in" | "out";

export interface SsRawNote {
  type: SsNoteType;
  t: number;
  pos: number | "auto";
  size: number;
  crit: boolean;
  dir: SsFlickDirection;
  ease: SsEase | [SsEase, SsEase];
  visible: boolean;
  /** Parsed by the native reader but reserved by the current converter. */
  alpha: SsFadeType;
  node?: SsRawNote[];
}

export interface SsRoot {
  /** Source-envelope metadata only. The native score converter does not read it. */
  version: number;
  bpm: SsBpm[];
  sig: SsSig[];
  skill: number[];
  fever: [number, number][];
  call: SsCall[];
  notes: SsRawNote[];
}

export interface BpmChange {
  tick: number;
  beat: number;
  timeMs: number;
  bpm: number;
}

export interface ChartSignatureChange {
  tick: number;
  beat: number;
  timeMs: number;
  numerator: number;
  denominator: number;
}

export interface ChartSkillEvent {
  /** Input-list index retained by BuildSkillList. */
  index: number;
  tick: number;
  timeMs: number;
}

export interface ChartFeverSection {
  /** Index after BuildFeverList sorts sections by their first tick. */
  index: number;
  startTick: number;
  endTick: number;
  startTimeMs: number;
  endTimeMs: number;
}

export interface ChartFeverTransitionEvent {
  section: ChartFeverSection;
  state: FeverState.Fever | FeverState.End;
  timeMs: number;
}

export interface ChartCallChangeEvent {
  /** Index after BuildCallList sorts entries by source tick. */
  index: number;
  tick: number;
  timeMs: number;
  /** One-based positions for source Timing entries whose value is exactly 1. */
  rhythms: readonly number[];
}

export interface ChartTimeline {
  skills: readonly ChartSkillEvent[];
  fever: readonly ChartFeverSection[];
  callChanges: readonly ChartCallChangeEvent[];
}

/** Render-only scroll-time change. Judgement and audio remain on real time. */
export interface ChartTimeScaleChange {
  timeMs: number;
  scale: number;
}

export interface ChartNote {
  id: number;
  tick: number;
  timeMs: number;
  beat: number;
  /** Left edge in the original 0..24 score coordinate space. */
  pos: number;
  size: number;
  /** Center and width normalized to -1..1 stage coordinates. */
  laneX: number;
  width: number;
  operateType: NoteOperateType;
  judgementType: NoteJudgementType;
  /** Native hit-area profile; this is independent of judgement timing type. */
  judgementAreaOffsetType: JudgementAreaOffsetType;
  direction: NoteDirection;
  critical: boolean;
  judged: boolean;
  visible: boolean;
  /** All native slide/guide line IDs sharing this judgement endpoint. */
  lineIds: number[];
  /** Native NoteInfoData.SlideAlong; true for PosAuto-authored line nodes. */
  slideAlong: boolean;
  indexInLine: number | null;
  easeL: NoteLineEaseType | null;
  easeR: NoteLineEaseType | null;
}

export interface ChartLine {
  id: number;
  kind: "long" | "guide";
  critical: boolean;
  noteIds: number[];
}

export interface ChartDocument {
  version: number;
  bpmChanges: BpmChange[];
  signatureChanges: ChartSignatureChange[];
  timeScaleChanges: ChartTimeScaleChange[];
  notes: ChartNote[];
  lines: ChartLine[];
  timeline: ChartTimeline;
  durationMs: number;
}

export interface JudgementEvent {
  note: ChartNote;
  judgement: NoteSimulateJudgement;
  timing: JudgeTiming;
  diffMs: number;
  judgedAtMs: number;
  combo: number;
  maxCombo: number;
  score: number;
  scoreDelta: number;
  life: number;
}

/**
 * Render-only lane feedback request emitted by raw pointer input. It is kept
 * separate from JudgementEvent so an empty tap cannot mutate score or combo.
 */
export interface LaneInputEffectEvent {
  pointerId: number;
  /** Left edge in the original continuous 0..24 lane coordinate space. */
  lane: number;
  width: number;
  timeMs: number;
  phase: "tap" | "move";
}

/**
 * Allocation-free live lookup used by the renderer to mirror the native
 * note-view pool. The object is stable for a session; callers cannot mutate
 * the underlying processed-note set or enumerate it.
 */
export interface SessionNoteState {
  isProcessed(noteId: number): boolean;
}

/** Allocation-free lookup for native per-line SlideLoop effect ownership. */
export interface SessionLineState {
  isActive(lineId: number): boolean;
}

export interface SessionSnapshot {
  timeMs: number;
  durationMs: number;
  /**
   * Native UpdateLongLineSe active predicate: a Long line is Playing,
   * pressed, and startTime <= currentTime < endTime.
   */
  activeLongLine: boolean;
  combo: number;
  perfectCombo: boolean;
  maxCombo: number;
  score: number;
  life: number;
  processed: number;
  total: number;
  lastJudgement: JudgementEvent | null;
  /** Last skill callback reached on the current deterministic timeline. */
  lastSkill: ChartSkillEvent | null;
  /** Last call-rhythm change reached on the current deterministic timeline. */
  callChange: ChartCallChangeEvent | null;
  /** Latest global fever transition observed by the simulator. */
  feverState: FeverState;
  /** Section which produced feverState; null while every updater is waiting. */
  feverSection: ChartFeverSection | null;
  /**
   * LiveAllNoteView releases a note after its simulator result reaches Done.
   * This stable live query avoids copying every processed ID on each rAF.
   */
  noteState: SessionNoteState;
  /** Playing long lines, including pointer ownership in play mode. */
  lineState: SessionLineState;
}
