export const LANE_WIDTH = 24;

export function laneToX(pos: number, size: number): number {
  return ((pos + size / 2) / LANE_WIDTH) * 2 - 1;
}

export function sizeToWidth(size: number): number {
  return (size / LANE_WIDTH) * 2;
}

export function applyMirror(pos: number, size: number): number {
  return LANE_WIDTH - pos - size;
}
