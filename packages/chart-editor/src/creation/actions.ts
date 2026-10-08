import {
  createProjectId,
  structuredCloneValue,
  type Project,
  type SingleNote,
  type LinePoint,
  type NoteType,
  type NoteDirection,
  type LineEase,
} from "../model";
import { assertValidProject } from "../validation";
import { snapTick } from "../timing";
import { resizeChartSelection } from "./authoring";
import { chartSelectionNodes, copyChartSelectionGroup, deleteChartSelectionGroup, moveChartSelection } from "./selection";
import { assertEditedChartSpans } from "./span";
import { reconcileAuthorEdit } from "./collections";

export function removableLinePointIds(project: Project, ids: ReadonlySet<string>): string[] {
  return project.lines.flatMap(line => line.points.slice(1, -1).filter(point => ids.has(point.id)).map(point => point.id));
}

/** Remove selected interior controls while keeping each connector and its original endpoints. */
export function removeLineControlPoints(project: Project, ids: ReadonlySet<string>): { project: Project; removed: string[] } {
  assertValidProject(project);
  const removed = removableLinePointIds(project, ids), selected = new Set(removed);
  if (!removed.length) return { project: structuredCloneValue(project), removed };
  let result = structuredCloneValue(project);
  for (const line of result.lines) {
    if (!line.points.some(point => selected.has(point.id))) continue;
    line.points = line.points.filter(point => !selected.has(point.id));
    for (const point of line.points) if (point.lane === "auto") {
      delete point.resolvedLane;
      delete point.resolvedSize;
    }
  }
  result = reconcileAuthorEdit(project, result);
  assertValidProject(result);
  assertEditedChartSpans(project, result);
  return { project: result, removed };
}

/** Move towards the primary note's adjacent musical grid; one delta preserves spacing and neighbour bounds. */
export function nudgeChartSelectionOnGrid(
  project: Project,
  ids: ReadonlySet<string>,
  primaryId: string,
  direction: -1 | 1,
  subdivision: number,
): Project {
  assertValidProject(project);
  if ((direction !== -1 && direction !== 1) || !Number.isSafeInteger(subdivision) || subdivision < 1 || subdivision > project.resolution)
    throw new RangeError("invalid_division");
  const anchor = chartSelectionNodes(project).find(({ note }) => note.id === primaryId && ids.has(note.id));
  if (!anchor) return structuredCloneValue(project);
  const mode = direction > 0 ? "ceil" : "floor";
  let target = snapTick(anchor.note.tick, subdivision, mode, project.resolution);
  if (target === anchor.note.tick) {
    if (!Number.isSafeInteger(anchor.note.tick + direction)) throw new RangeError("invalid_tick");
    target = snapTick(anchor.note.tick + direction, subdivision, mode, project.resolution);
  }
  if (!Number.isSafeInteger(target)) throw new RangeError("invalid_tick");
  const result = moveChartSelection(project, ids, target - anchor.note.tick, 0, { placement: "overlap" });
  assertValidProject(result);
  return result;
}

export interface NoteBrush {
  size?: number;
  type?: NoteType;
  direction?: NoteDirection;
  critical?: boolean;
  visible?: boolean;
  ease?: Partial<LineEase>;
  lineKind?: "long" | "guide";
  lineCritical?: boolean;
}
function clearAutoCache(project: Project, ids: ReadonlySet<string>) {
  for (const line of project.lines)
    if (line.points.some((point) => ids.has(point.id)))
      for (const point of line.points)
        if (point.lane === "auto") {
          delete point.resolvedLane;
          delete point.resolvedSize;
        }
}
/** Actual data brush; leaves unmentioned fields and all IDs unchanged. */
export function brushChartSelection(project: Project, ids: ReadonlySet<string>, patch: NoteBrush): Project {
  const result =
    patch.size === undefined
      ? structuredCloneValue(project)
      : resizeChartSelection(project, ids, patch.size, { resolveAutoLane: true, placement: "authored" });
  const apply = (note: SingleNote | LinePoint) => {
    if (!ids.has(note.id)) return;
    if (patch.type !== undefined) note.type = patch.type;
    if (patch.critical !== undefined) note.critical = patch.critical;
    if (patch.visible !== undefined) note.visible = patch.visible;
    note.direction =
      note.type === "flick" ? (patch.direction ?? (note.direction === "none" ? "up" : note.direction)) : "none";
    if ("ease" in note && patch.ease) note.ease = { ...note.ease, ...patch.ease };
  };
  result.singles.forEach(apply);
  for (const line of result.lines) {
    if (!line.points.some((point) => ids.has(point.id))) continue;
    line.points.forEach(apply);
    if (patch.lineKind !== undefined) line.kind = patch.lineKind;
    if (patch.lineCritical !== undefined) line.critical = patch.lineCritical;
  }
  clearAutoCache(result, ids);
  assertValidProject(result);
  return result;
}
/** Mirror authored geometry, direction and independent boundary easing. Imported source remains immutable. */
export function flipChartSelection(project: Project, ids: ReadonlySet<string>): Project {
  const result = structuredCloneValue(project);
  const flip = (note: SingleNote | LinePoint) => {
    if (!ids.has(note.id)) return;
    if (typeof note.lane === "number") note.lane = result.laneBasis - note.lane - note.size;
    if (note.direction === "left") note.direction = "right";
    else if (note.direction === "right") note.direction = "left";
    if ("ease" in note) note.ease = { left: note.ease.right, right: note.ease.left };
  };
  result.singles.forEach(flip);
  result.lines.forEach((line) => line.points.forEach(flip));
  clearAutoCache(result, ids);
  assertValidProject(result);
  return result;
}
export function cutChartSelection(project: Project, ids: ReadonlySet<string>) {
  const clipboard = copyChartSelectionGroup(project, ids),
    result = structuredCloneValue(project);
  deleteChartSelectionGroup(result, ids);
  assertValidProject(result);
  return { project: result, clipboard };
}

/** Generate authored automatic line nodes on musical subdivisions, skipping every existing tick. */
export function generateLinePoints(project: Project, lineIds: ReadonlySet<string>, subdivision: number) {
  if (!Number.isSafeInteger(subdivision) || subdivision < 1 || subdivision > project.resolution)
    throw new RangeError("invalid_division");
  const result = structuredCloneValue(project),
    created: string[] = [];
  for (const line of result.lines) {
    if (!lineIds.has(line.id) || line.points.length < 2) continue;
    const existing = new Set(line.points.map((point) => point.tick)),
      start = line.points[0]!.tick,
      end = line.points.at(-1)!.tick;
    for (
      let unit = Math.floor((start * subdivision) / result.resolution) + 1;
      unit < (end * subdivision) / result.resolution;
      unit++
    ) {
      const tick = Math.round((unit * result.resolution) / subdivision);
      if (existing.has(tick)) continue;
      const parent = [...line.points].reverse().find((point) => point.tick < tick) ?? line.points[0]!;
      const id = createProjectId("node");
      line.points.push({
        ...structuredCloneValue(parent),
        id,
        tick,
        lane: "auto",
        size: 0,
        autoSize: true,
        ease: { left: "linear", right: "linear" },
      });
      const point = line.points.at(-1)!;
      delete point.resolvedLane;
      delete point.resolvedSize;
      existing.add(tick);
      created.push(id);
    }
    line.points.sort((a, b) => a.tick - b.tick);
  }
  assertValidProject(result);
  return { project: result, created };
}
