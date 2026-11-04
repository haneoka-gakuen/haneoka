// L3 — GEB
// Input: 规范工程、单音符与滑条几何、拖动网格。
// Output: 统一的重叠／自由控制点边界及选区限制。
// Pos: [Map](../../L2-2.md)；所有来源共用的创作几何。
// Effects/Dependencies: 纯运算；有效判定区域由宿主的原生转换器统一检查。
import { resolveLinePointShape, type Project, type SingleNote, type LinePoint } from "../model";

export type AuthoredPlacement = "stage" | "authored" | "overlap";
export interface LaneBounds {
  min: number;
  max: number;
  minInclusive: boolean;
  maxInclusive: boolean;
}
export interface LaneGrid {
  step: number;
  /** Preserve the caller's absolute or relative snapping phase. */
  origin?: number;
}
function geometry(lane: number, size: number, basis: number) {
  if (
    !Number.isFinite(lane) ||
    !Number.isFinite(size) ||
    size < 0 ||
    !Number.isFinite(basis) ||
    basis <= 0 ||
    !Number.isFinite(lane + size)
  )
    throw new RangeError("invalid_authored_span");
}
/** A positive-width note must have positive overlap; zero-width markers use the closed stage. */
export function authoredSpanOverlaps(lane: number, size: number, basis: number): boolean {
  geometry(lane, size, basis);
  return size === 0 ? lane >= 0 && lane <= basis : lane < basis && lane + size > 0;
}
export function assertAuthoredSpanOverlap(lane: number, size: number, basis: number) {
  if (!authoredSpanOverlaps(lane, size, basis)) throw new RangeError("authored_span_outside_stage");
}
export function authoredLaneBounds(
  size: number,
  basis: number,
  placement: AuthoredPlacement = "overlap",
): LaneBounds {
  geometry(0, size, basis);
  if (placement === "authored") return { min: -Infinity, max: Infinity, minInclusive: false, maxInclusive: false };
  if (placement === "stage") return { min: 0, max: basis - size, minInclusive: true, maxInclusive: true };
  return { min: -size, max: basis, minInclusive: size === 0, maxInclusive: size === 0 };
}
export function authoredSpanInBounds(
  lane: number,
  size: number,
  basis: number,
  placement: AuthoredPlacement = "stage",
): boolean {
  return laneValueInBounds(lane, authoredLaneBounds(size, basis, placement));
}
export function laneValueInBounds(value: number, bounds: LaneBounds) {
  return (
    Number.isFinite(value) &&
    (bounds.minInclusive ? value >= bounds.min : value > bounds.min) &&
    (bounds.maxInclusive ? value <= bounds.max : value < bounds.max)
  );
}
/** Clamp only when necessary, to a real interior grid point; preserve legal fractional source values exactly. */
export function constrainLaneValue(value: number, bounds: LaneBounds, grid?: LaneGrid): number {
  if (!Number.isFinite(value)) throw new RangeError("invalid_lane_value");
  if (laneValueInBounds(value, bounds)) return value;
  if (!grid || !Number.isFinite(grid.step) || grid.step <= 0 || !Number.isFinite(grid.origin ?? 0))
    throw new RangeError("overlap_requires_lane_grid");
  const origin = grid.origin ?? 0,
    step = grid.step;
  const first = bounds.minInclusive
    ? Math.ceil((bounds.min - origin) / step)
    : Math.floor((bounds.min - origin) / step) + 1;
  const last = bounds.maxInclusive
    ? Math.floor((bounds.max - origin) / step)
    : Math.ceil((bounds.max - origin) / step) - 1;
  if (
    (!Number.isSafeInteger(first) && first !== -Infinity) ||
    (!Number.isSafeInteger(last) && last !== Infinity) ||
    first > last
  )
    throw new RangeError("no_overlapping_lane_grid_point");
  const below = value <= bounds.min,
    index = below ? first : last;
  const result = origin + index * step;
  if (laneValueInBounds(result, bounds)) return result;
  // A decimal grid can round its calculated edge onto an exclusive boundary.
  const next = index + (below ? 1 : -1),
    adjusted = origin + next * step;
  if (next >= first && next <= last && laneValueInBounds(adjusted, bounds)) return adjusted;
  throw new RangeError("overlap_grid_precision");
}
export function constrainAuthoredLane(lane: number, size: number, basis: number, grid?: LaneGrid) {
  return constrainLaneValue(lane, authoredLaneBounds(size, basis), grid);
}
/** Keep the chosen edge or center fixed while enforcing the node's stage rule. */
export function authoredWidthBounds(
  lane: number,
  size: number,
  basis: number,
  anchor: "left" | "center" | "right" = "left",
  placement: AuthoredPlacement = "overlap",
): LaneBounds | undefined {
  geometry(lane, size, basis);
  if (placement === "authored") return { min: 0, max: Infinity, minInclusive: true, maxInclusive: false };
  const fixed = anchor === "right" ? lane + size : anchor === "center" ? lane + size / 2 : lane;
  if (placement === "stage") {
    if (fixed < 0 || fixed > basis) return;
    const maximum = anchor === "left" ? basis - fixed : anchor === "right" ? fixed : 2 * Math.min(fixed, basis - fixed);
    return { min: 0, max: maximum, minInclusive: true, maxInclusive: true };
  }
  if ((anchor === "left" && fixed > basis) || (anchor === "right" && fixed < 0)) return;
  if ((anchor === "left" && fixed === basis) || (anchor === "right" && fixed === 0))
    return { min: 0, max: 0, minInclusive: true, maxInclusive: true };
  const minimum =
    anchor === "left"
      ? Math.max(0, -fixed)
      : anchor === "right"
        ? Math.max(0, fixed - basis)
        : Math.max(0, -2 * fixed, 2 * (fixed - basis));
  return { min: minimum, max: Infinity, minInclusive: fixed >= 0 && fixed <= basis, maxInclusive: false };
}
/** Singles overlap the stage; connector geometry is authored without source-dependent bounds. */
export function authoredSpanNodes(project: Project): {
  note: SingleNote | LinePoint;
  lane: number;
  size: number;
  kind?: string;
  placement: AuthoredPlacement;
}[] {
  return [
    ...project.singles.map((note) => ({ note, lane: note.lane, size: note.size, placement: "overlap" as const })),
    ...project.lines.flatMap((line) =>
      line.points.map((note, index) => ({
        note,
        ...resolveLinePointShape(line.points, index),
        kind: line.kind,
        placement: "authored" as const,
      })),
    ),
  ];
}
/** The same span rules apply to imported notes, copies and newly authored notes. */
export function assertEditedChartSpans(_before: Project, after: Project) {
  for (const entry of authoredSpanNodes(after)) {
    if (!authoredSpanInBounds(entry.lane, entry.size, after.laneBasis, entry.placement))
      throw new RangeError("authored_span_outside_stage");
  }
}
/** Intersect common translation bounds so group geometry keeps its relative offsets. */
export function selectionLaneDeltaBounds(project: Project, ids: ReadonlySet<string>): LaneBounds | undefined {
  let result: LaneBounds | undefined;
  for (const entry of authoredSpanNodes(project)) {
    if (!ids.has(entry.note.id) || typeof entry.note.lane !== "number") continue;
    const bound = authoredLaneBounds(entry.size, project.laneBasis, entry.placement);
    bound.min -= entry.lane;
    bound.max -= entry.lane;
    if (!result) {
      result = bound;
      continue;
    }
    if (bound.min > result.min) {
      result.min = bound.min;
      result.minInclusive = bound.minInclusive;
    } else if (bound.min === result.min) result.minInclusive &&= bound.minInclusive;
    if (bound.max < result.max) {
      result.max = bound.max;
      result.maxInclusive = bound.maxInclusive;
    } else if (bound.max === result.max) result.maxInclusive &&= bound.maxInclusive;
  }
  return result;
}
/** Actual source/control-point bounds plus the fixed stage, with a caller-chosen authoring gutter. */
export function authoredSpanViewport(project: Project, padding = 0) {
  if (!Number.isFinite(padding) || padding < 0) throw new RangeError("invalid_lane_padding");
  geometry(0, 0, project.laneBasis);
  let min = 0,
    max = project.laneBasis;
  for (const entry of authoredSpanNodes(project)) {
    geometry(entry.lane, entry.size, project.laneBasis);
    min = Math.min(min, entry.lane);
    max = Math.max(max, entry.lane + entry.size);
  }
  return { min: min - padding, max: max + padding, stageMin: 0, stageMax: project.laneBasis };
}
function viewport(view: { min: number; max: number }, width: number) {
  if (
    !Number.isFinite(view.min) ||
    !Number.isFinite(view.max) ||
    !Number.isFinite(view.max - view.min) ||
    view.max <= view.min ||
    !Number.isFinite(width) ||
    width <= 0
  )
    throw new RangeError("invalid_lane_viewport");
}
export function viewportXToAuthoredLane(x: number, width: number, view: { min: number; max: number }) {
  viewport(view, width);
  if (!Number.isFinite(x)) throw new RangeError("invalid_lane_pointer");
  return view.min + (x / width) * (view.max - view.min);
}
export function authoredLaneToViewportX(lane: number, width: number, view: { min: number; max: number }) {
  viewport(view, width);
  if (!Number.isFinite(lane)) throw new RangeError("invalid_authored_lane");
  return ((lane - view.min) / (view.max - view.min)) * width;
}
/** Native ports use the 24-unit left edge, including negative positions; this conversion does not clip. */
export function nativeLaneToAuthoredLane(lane: number, basis: number) {
  geometry(lane, 0, basis);
  const result = (lane / 24) * basis;
  if (!Number.isFinite(result)) throw new RangeError("invalid_native_lane");
  return result;
}
