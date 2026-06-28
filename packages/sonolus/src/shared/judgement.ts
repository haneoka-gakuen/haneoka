// Assist-0 judgment windows.
import { NoteJudgementType, NoteSimulateJudgement, NoteSimulateJudgement as S, JudgeTiming } from "./enums.js";

export interface JudgeWindow {
  judgement: NoteSimulateJudgement;
  before: number;
  after: number;
}

const w = (judgement: S, before: number, after: number): JudgeWindow => ({ judgement, before, after });
const sym = (judgement: S, x: number): JudgeWindow => w(judgement, x, x);

// strictest-first (priority 1..6)
const NORMAL: JudgeWindow[] = [
  sym(S.Just, 1),
  sym(S.Perfect, 42),
  sym(S.Great, 83),
  sym(S.Good, 108),
  sym(S.Bad, 125),
  sym(S.Miss, 130),
];
const FLICK: JudgeWindow[] = [
  sym(S.Just, 1),
  w(S.Perfect, 83, 58),
  w(S.Great, 0, 83),
  w(S.Good, 0, 108),
  w(S.Bad, 0, 125),
  w(S.Miss, 0, 130),
];
const SLIDE_END: JudgeWindow[] = [
  w(S.Perfect, 42, 66),
  w(S.Great, 99, 166),
  w(S.Good, 124, 191),
  w(S.Bad, 141, 208),
  w(S.Miss, 150, 150),
];
const EASY: JudgeWindow[] = [sym(S.Just, 1), w(S.Perfect, 58, 66), w(S.Miss, 58, 130)];
const TRACE: JudgeWindow[] = [w(S.Perfect, 58, 66), w(S.Miss, 58, 130)];

export const JUDGE_WINDOWS: Record<number, JudgeWindow[]> = {
  [NoteJudgementType.Normal]: NORMAL,
  [NoteJudgementType.SlideBegin]: NORMAL,
  [NoteJudgementType.Flick]: FLICK,
  [NoteJudgementType.SlideEndFlick]: FLICK,
  [NoteJudgementType.SlideEnd]: SLIDE_END,
  [NoteJudgementType.EasyNormal]: EASY,
  [NoteJudgementType.SlideBeginEasy]: EASY,
  [NoteJudgementType.Trace]: TRACE,
  [NoteJudgementType.SlideEndTrace]: TRACE,
};

export function timingOf(diffMs: number): JudgeTiming {
  if (Math.abs(diffMs) <= 1) return JudgeTiming.None;
  return diffMs > 1 ? JudgeTiming.Late : JudgeTiming.Fast;
}

export interface JudgeResult {
  judgement: NoteSimulateJudgement;
  timing: JudgeTiming;
}

export function judge(type: NoteJudgementType, diffMs: number): JudgeResult {
  const units = JUDGE_WINDOWS[type];
  if (!units || units.length === 0) {
    return { judgement: S.Miss, timing: JudgeTiming.OutOfTime };
  }
  for (const u of units) {
    if (diffMs < -u.before) continue;
    if (diffMs <= u.after) return { judgement: u.judgement, timing: timingOf(diffMs) };
  }
  return { judgement: S.Miss, timing: JudgeTiming.OutOfTime };
}
