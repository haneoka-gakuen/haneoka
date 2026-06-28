import { NoteOperateType, NoteJudgementType, NoteDirection, NoteLineEaseType } from "../shared/enums.js";
import type { SsRawNote } from "./types.js";

// Chart "in"→runtime EaseOut, "out"→runtime EaseIn.
export function mapEase(e: string | undefined): NoteLineEaseType {
  if (e === "in") return NoteLineEaseType.EaseOut;
  if (e === "out") return NoteLineEaseType.EaseIn;
  return NoteLineEaseType.Linear;
}

export function mapDirection(dir?: "left" | "right"): NoteDirection {
  if (dir === "left") return NoteDirection.Left;
  if (dir === "right") return NoteDirection.Right;
  return NoteDirection.Normal;
}

export function resolveSingleOperateType(type: SsRawNote["type"]): NoteOperateType {
  if (type === "flick") return NoteOperateType.Flick;
  if (type === "trace") return NoteOperateType.Trace;
  return NoteOperateType.Normal; // tap (undefined)
}

const JUDGE_MAP: Record<number, NoteJudgementType> = {
  [NoteOperateType.Normal]: NoteJudgementType.Normal,
  [NoteOperateType.SlideBegin]: NoteJudgementType.SlideBegin,
  [NoteOperateType.SlideConnection]: NoteJudgementType.Trace,
  [NoteOperateType.SlideEnd]: NoteJudgementType.SlideEnd,
  [NoteOperateType.Flick]: NoteJudgementType.Flick,
  [NoteOperateType.SlideBeginFlick]: NoteJudgementType.Flick,
  [NoteOperateType.SlideEndFlick]: NoteJudgementType.Flick,
  [NoteOperateType.Trace]: NoteJudgementType.Trace,
  [NoteOperateType.SlideBeginTrace]: NoteJudgementType.Trace,
  [NoteOperateType.SlideEndTrace]: NoteJudgementType.SlideEndTrace,
  [NoteOperateType.SlideConnectionTrace]: NoteJudgementType.Trace,
  [NoteOperateType.Combo]: NoteJudgementType.Trace,
  [NoteOperateType.GuideBeginNormal]: NoteJudgementType.Normal,
  [NoteOperateType.GuideBeginFlick]: NoteJudgementType.Flick,
  [NoteOperateType.GuideBeginTrace]: NoteJudgementType.Trace,
  [NoteOperateType.GuideEndTrace]: NoteJudgementType.Trace,
};

export function resolveJudgementType(op: NoteOperateType, critical: boolean): NoteJudgementType {
  if (critical && op === NoteOperateType.Normal) return NoteJudgementType.EasyNormal;
  if (critical && op === NoteOperateType.SlideBegin) return NoteJudgementType.SlideBeginEasy;
  return JUDGE_MAP[op] ?? NoteJudgementType.None;
}

export function isJudged(op: NoteOperateType): boolean {
  // The judged set is independent of the judgement-window mapping and
  // rejects only this explicit operation set.
  return (
    op !== NoteOperateType.None &&
    op !== NoteOperateType.HiddenSlideBegin &&
    op !== NoteOperateType.HiddenSlideEnd &&
    op !== NoteOperateType.GuideBegin &&
    op !== NoteOperateType.GuideEnd &&
    op !== NoteOperateType.ComboSkip &&
    op !== NoteOperateType.Hidden &&
    op !== NoteOperateType.InvalidHidden
  );
}
