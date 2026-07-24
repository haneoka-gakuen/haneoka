import { JudgeTiming, NoteDirection, NoteJudgementType, NoteSimulateJudgement } from "./enums";

export interface JudgeWindow {
  judgement: NoteSimulateJudgement;
  before: number;
  after: number;
}

const symmetric = (judgement: NoteSimulateJudgement, value: number): JudgeWindow => ({
  judgement,
  before: value,
  after: value,
});
const window = (judgement: NoteSimulateJudgement, before: number, after: number): JudgeWindow => ({
  judgement,
  before,
  after,
});
const J = NoteSimulateJudgement;

/**
 * MasterLiveSettings.note_direction_flick_angle.
 *
 * This value looks surprising, but it is passed to `atan(angle * Deg2Rad)` by
 * the native function rather than to `cos`. At 180 degrees the resulting
 * threshold is greater than one, so a left/right candidate cannot satisfy it.
 */
export const DIRECTION_FLICK_ANGLE = 180;

export interface FlickMoveVector {
  /** Browser screen-space delta: positive X points right. */
  dx: number;
  /** Browser screen-space delta: positive Y points down. */
  dy: number;
}

/**
 * `FTLiveSimulator.NoteJudgementLogic.IsTargetDirectionFlick`.
 *
 * Direction 0 is unconditional. Direction 1/2 creates a left/right unit
 * vector, normalizes both operands, takes their dot product and compares it to
 * `atan(directionFlickAngle * Deg2Rad)`. Unity screen Y points up, hence the
 * browser Y delta is negated before normalization (the target has Y=0, but the
 * conversion is kept explicit to preserve the native coordinate convention).
 */
export function isTargetDirectionFlick(
  direction: NoteDirection,
  move: FlickMoveVector,
  directionFlickAngle = DIRECTION_FLICK_ANGLE,
): boolean {
  if (direction === NoteDirection.Normal) return true;

  const unityX = move.dx;
  const unityY = -move.dy;
  const moveLength = Math.hypot(unityX, unityY);
  const normalizedMoveX = moveLength > 0 ? unityX / moveLength : 0;
  const normalizedMoveY = moveLength > 0 ? unityY / moveLength : 0;

  const targetX = direction === NoteDirection.Left ? -1 : direction === NoteDirection.Right ? 1 : 0;
  const targetY = 0;
  const targetLength = Math.hypot(targetX, targetY);
  const normalizedTargetX = targetLength > 0 ? targetX / targetLength : 0;
  const normalizedTargetY = targetLength > 0 ? targetY / targetLength : 0;
  const dot = normalizedMoveX * normalizedTargetX + normalizedMoveY * normalizedTargetY;
  const threshold = Math.atan(directionFlickAngle * (Math.PI / 180));
  return dot >= threshold;
}

// MasterLiveJudgmentRangeParameter, assist level 0. Priority is strictest-first.
const NORMAL = [
  symmetric(J.Just, 1),
  symmetric(J.Perfect, 42),
  symmetric(J.Great, 83),
  symmetric(J.Good, 108),
  symmetric(J.Bad, 125),
  symmetric(J.Miss, 130),
];
const FLICK = [
  symmetric(J.Just, 1),
  window(J.Perfect, 83, 58),
  window(J.Great, 0, 83),
  window(J.Good, 0, 108),
  window(J.Bad, 0, 125),
  window(J.Miss, 0, 130),
];
const SLIDE_END = [
  window(J.Perfect, 42, 66),
  window(J.Great, 99, 166),
  window(J.Good, 124, 191),
  window(J.Bad, 141, 208),
  symmetric(J.Miss, 150),
];
const EASY = [symmetric(J.Just, 1), window(J.Perfect, 58, 66), window(J.Miss, 58, 130)];
const TRACE = [window(J.Perfect, 58, 66), window(J.Miss, 58, 130)];

export const JUDGE_WINDOWS: Readonly<Record<number, readonly JudgeWindow[]>> = {
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

export const MAXIMUM_EARLY_WINDOW = Math.max(
  0,
  ...Object.values(JUDGE_WINDOWS).flatMap((windows) => windows.map((item) => item.before)),
);

export interface JudgeResult {
  judgement: NoteSimulateJudgement;
  timing: JudgeTiming;
}

export function judge(noteType: NoteJudgementType, diffMs: number): JudgeResult {
  const windows = JUDGE_WINDOWS[noteType];
  if (!windows?.length) return { judgement: J.Miss, timing: JudgeTiming.OutOfTime };
  for (const item of windows) {
    if (diffMs < -item.before) continue;
    if (diffMs <= item.after) {
      const timing = Math.abs(diffMs) <= 1 ? JudgeTiming.None : diffMs > 1 ? JudgeTiming.Late : JudgeTiming.Fast;
      return { judgement: item.judgement, timing };
    }
  }
  return { judgement: J.Miss, timing: JudgeTiming.OutOfTime };
}

export function maximumLateWindow(noteType: NoteJudgementType): number {
  return Math.max(0, ...(JUDGE_WINDOWS[noteType] ?? []).map((item) => item.after));
}

export function maximumEarlyWindow(noteType: NoteJudgementType): number {
  return Math.max(0, ...(JUDGE_WINDOWS[noteType] ?? []).map((item) => item.before));
}
