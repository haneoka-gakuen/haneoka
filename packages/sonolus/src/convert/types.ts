import { NoteOperateType, NoteJudgementType, NoteDirection, NoteLineEaseType } from "../shared/enums.js";

// ---- Raw parsed Ss JSON ----
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
export interface SsRawNote {
  type?: "flick" | "trace" | "long" | "guide";
  t?: number;
  pos?: number | "auto";
  size?: number;
  crit?: boolean;
  dir?: "left" | "right";
  ease?: string | [string, string];
  visible?: boolean;
  node?: SsRawNote[];
}
export interface SsRoot {
  version: number;
  bpm: SsBpm[];
  sig: SsSig[];
  skill: number[];
  fever: [number, number][];
  call: SsCall[];
  notes: SsRawNote[];
}

// ---- Resolved internal chart (engine-agnostic IR) ----
export interface BpmChange {
  tick: number;
  beat: number;
  timeMs: number;
  bpm: number;
}

export interface ResolvedNote {
  id: number;
  tick: number;
  timeMs: number;
  beat: number;
  pos: number; // left-edge lane coord 0..24 (PosAuto already interpolated)
  size: number;
  laneX: number; // normalized center, -1..1
  width: number; // normalized width
  operateType: NoteOperateType;
  judgementType: NoteJudgementType;
  direction: NoteDirection;
  critical: boolean;
  judged: boolean;
  visible: boolean; // raw SsRawNote.visible (default true); standalone notes are always true
  lineIds: number[]; // native NoteInfoData.LineIndexList; endpoints can belong to multiple lines
  slideAlong: boolean; // native NoteInfoData.SlideAlong; PosAuto nodes are excluded from combo boundaries
  indexInLine: number | null;
  easeL: NoteLineEaseType | null; // ease of the segment LEAVING this node (null if last/standalone)
  easeR: NoteLineEaseType | null;
}

export interface NoteLine {
  id: number;
  kind: "long" | "guide";
  noteIds: number[]; // ordered head→tail; includes generated Combo/ComboSkip notes for long lines
}

export interface InternalChart {
  version: number;
  bpmChanges: BpmChange[];
  notes: ResolvedNote[]; // sorted by tick, then id
  lines: NoteLine[];
  durationMs: number;
  passthrough: { skill: number[]; fever: [number, number][]; sig: SsSig[]; call: SsCall[] };
}
