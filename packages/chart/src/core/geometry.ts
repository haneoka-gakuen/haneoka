import { NoteLineEaseType } from "./enums";
import type { ChartNote } from "./types";

export const LANE_COUNT = 24;

export function laneToX(pos: number, size: number): number {
  return ((pos + size / 2) / LANE_COUNT) * 2 - 1;
}

export function sizeToWidth(size: number): number {
  return (size / LANE_COUNT) * 2;
}

export function xToLane(x: number): number {
  return ((x + 1) / 2) * LANE_COUNT;
}

export function mirrorLane(pos: number, size: number): number {
  return LANE_COUNT - pos - size;
}

/** FTLiveSimulator.LiveCalculator.GetNoteLineTypeEasing. */
export function applyLineEase(ease: NoteLineEaseType | null | undefined, progress: number): number {
  if (ease === NoteLineEaseType.EaseIn) return (2 - progress) * progress;
  if (ease === NoteLineEaseType.EaseOut) return progress * progress;
  return progress;
}

export function interpolateNoteLine(
  head: ChartNote,
  tail: ChartNote,
  timeMs: number,
): Pick<ChartNote, "pos" | "size" | "laneX" | "width"> {
  const duration = tail.timeMs - head.timeMs;
  const progress = duration <= 0 ? 0 : Math.max(0, Math.min(1, (timeMs - head.timeMs) / duration));
  const leftProgress = applyLineEase(head.easeL, progress);
  const rightProgress = applyLineEase(head.easeR, progress);
  const pos = head.pos + (tail.pos - head.pos) * leftProgress;
  const right = head.pos + head.size + (tail.pos + tail.size - head.pos - head.size) * rightProgress;
  const size = right - pos;
  return { pos, size, laneX: laneToX(pos, size), width: sizeToWidth(size) };
}

/**
 * IsTargetLane. The judgement offset is expressed in the original 24-lane
 * coordinate system and expands both sides by 0.5 lane.
 */
export function isTargetLane(note: Pick<ChartNote, "pos" | "size">, lane: number, judgementOffsetX: number): boolean {
  const extra = judgementOffsetX * (LANE_COUNT / 24);
  // NoteBase stores LaneEndFloat as LaneIndexFloat + WidthFloat - 1.
  // IsTargetLane then expands that inclusive end by offset + 0.5 lane.
  return note.pos - extra - 0.5 <= lane && lane <= note.pos + note.size + extra - 0.5;
}
