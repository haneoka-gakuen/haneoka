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
export function authoredLaneBounds(size: number, basis: number): LaneBounds {
  geometry(0, size, basis);
  return { min: -size, max: basis, minInclusive: size === 0, maxInclusive: size === 0 };
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
/** Width bounds for the fixed left/right/center anchor; there is no empirical corpus width ceiling. */
export function authoredWidthBounds(
  lane: number,
  size: number,
  basis: number,
  anchor: "left" | "center" | "right" = "left",
): LaneBounds | undefined {
  geometry(lane, size, basis);
  const fixed = anchor === "right" ? lane + size : anchor === "center" ? lane + size / 2 : lane;
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
function nodes(project: Project): { note: SingleNote | LinePoint; lane: number; size: number; kind?: string }[] {
  return [
    ...project.singles.map((note) => ({ note, lane: note.lane, size: note.size })),
    ...project.lines.flatMap((line) =>
      line.points.map((note, index) => ({ note, ...resolveLinePointShape(line.points, index), kind: line.kind })),
    ),
  ];
}
/** Preserve original GuideEnd/Hidden geometry on import; enforce overlap on newly authored or changed spans. */
export function assertEditedChartSpans(before: Project, after: Project) {
  const previous = new Map(nodes(before).map((entry) => [entry.note.id, entry]));
  for (const entry of nodes(after)) {
    const old = previous.get(entry.note.id);
    if (
      !old ||
      old.lane !== entry.lane ||
      old.size !== entry.size ||
      old.note.type !== entry.note.type ||
      old.note.visible !== entry.note.visible ||
      old.kind !== entry.kind ||
      before.laneBasis !== after.laneBasis
    )
      assertAuthoredSpanOverlap(entry.lane, entry.size, after.laneBasis);
  }
}
/** Intersect common translation bounds so group geometry keeps its relative offsets. */
export function selectionLaneDeltaBounds(project: Project, ids: ReadonlySet<string>): LaneBounds | undefined {
  let result: LaneBounds | undefined;
  for (const entry of nodes(project)) {
    if (!ids.has(entry.note.id) || typeof entry.note.lane !== "number") continue;
    const bound = authoredLaneBounds(entry.size, project.laneBasis);
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
  for (const entry of nodes(project)) {
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
