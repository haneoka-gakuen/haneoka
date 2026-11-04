import {
  createProjectId,
  resolveLinePointShape,
  structuredCloneValue,
  type Project,
  type SingleNote,
  type LinePoint,
  type NoteLine,
  type ResolvedLinePointShape,
  type JsonValue,
  type NoteType,
  type NoteDirection,
  type LineEase,
} from "../model";
import { assertValidProject } from "../validation";
import { snapTick } from "../timing";
import { resizeChartSelection } from "./authoring";
import { chartSelectionNodes, copyChartSelectionGroup, deleteChartSelectionGroup, mirrorSelectionNote, moveChartSelection } from "./selection";
import { assertEditedChartSpans } from "./span";
import { COLLECTIONS_KEY, readAuthorCollections, reconcileAuthorEdit } from "./collections";

export type LinePointMode = "visible" | "hidden" | "auto";

function inheritLinePointMembership(project: Project, lineId: string, ids: readonly string[]) {
  const collections = readAuthorCollections(project), owner = collections.members[lineId];
  if (!owner?.groupId && !owner?.layerId) return;
  for (const id of ids) collections.members[id] = {
    ...(owner.groupId ? { groupId: owner.groupId } : {}),
    ...(owner.layerId ? { layerId: owner.layerId } : {}),
  };
  project.extensions[COLLECTIONS_KEY] = collections as unknown as JsonValue;
}

export function sampleLineSpan(line: NoteLine, tick: number): ResolvedLinePointShape | undefined {
  const index = line.points.findIndex(point => point.tick >= tick);
  if (index < 0) return;
  if (line.points[index]!.tick === tick) return resolveLinePointShape(line.points, index);
  if (!index) return;
  const sample: LinePoint = { ...line.points[index - 1]!, tick, lane: "auto", autoSize: true };
  return resolveLinePointShape([...line.points.slice(0, index), sample, ...line.points.slice(index)], index);
}

/** Insert one control without replacing endpoints or existing same-tick nodes. */
export function insertLinePoint(
  project: Project,
  lineId: string,
  tick: number,
  options: { mode?: LinePointMode; shape?: ResolvedLinePointShape } = {},
): { project: Project; id: string; created: boolean } {
  const source = project.lines.find(line => line.id === lineId);
  if (!source || !Number.isSafeInteger(tick) || tick < 0) throw new RangeError("invalid_line_point");
  const existing = source.points.find(point => point.tick === tick);
  if (existing) return { project: structuredCloneValue(project), id: existing.id, created: false };
  const shape = options.shape ?? sampleLineSpan(source, tick);
  if (!shape || tick <= source.points[0]!.tick || tick >= source.points.at(-1)!.tick)
    throw new RangeError("invalid_line_point");
  const previous = source.points[source.points.findIndex(point => point.tick > tick) - 1]!;
  const mode = options.mode ?? "visible", id = createProjectId("node");
  const point: LinePoint = {
    id, tick, lane: mode === "auto" ? "auto" : shape.lane, size: mode === "auto" ? 0 : shape.size,
    ...(mode === "auto" ? { autoSize: true } : {}),
    type: "tap", critical: source.critical ?? previous.critical, direction: "none", visible: mode !== "hidden",
    ease: mode === "auto" ? { left: "linear", right: "linear" } : { ...previous.ease },
  };
  const result = structuredCloneValue(project), line = result.lines.find(line => line.id === lineId)!;
  line.points.push(point);
  line.points.sort((a, b) => a.tick - b.tick);
  inheritLinePointMembership(result, lineId, [id]);
  clearAutoCache(result, new Set([id]));
  assertValidProject(result);
  assertEditedChartSpans(project, result);
  return { project: result, id, created: true };
}

export function setLinePointMode(project: Project, ids: ReadonlySet<string>, mode: LinePointMode): Project {
  const shapes = new Map(chartSelectionNodes(project).filter(({ note }) => ids.has(note.id)).map(entry => [entry.note.id, entry]));
  const result = structuredCloneValue(project);
  for (const line of result.lines) for (const point of line.points) {
    const shape = shapes.get(point.id);
    if (!shape) continue;
    point.lane = mode === "auto" ? "auto" : shape.lane;
    point.size = mode === "auto" ? 0 : shape.size;
    point.visible = mode !== "hidden";
    if (mode === "auto") point.autoSize = true;
    else delete point.autoSize;
    delete point.resolvedLane;
    delete point.resolvedSize;
  }
  clearAutoCache(result, ids);
  assertValidProject(result);
  return result;
}

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
  beatsPerUnit = 1,
): Project {
  assertValidProject(project);
  const gridResolution = project.resolution * beatsPerUnit;
  if (!Number.isSafeInteger(gridResolution) || gridResolution < 1) throw new RangeError("invalid_division");
  if ((direction !== -1 && direction !== 1) || !Number.isSafeInteger(subdivision) || subdivision < 1 || subdivision > gridResolution)
    throw new RangeError("invalid_division");
  const anchor = chartSelectionNodes(project).find(({ note }) => note.id === primaryId && ids.has(note.id));
  if (!anchor) return structuredCloneValue(project);
  const mode = direction > 0 ? "ceil" : "floor";
  let target = snapTick(anchor.note.tick, subdivision, mode, gridResolution);
  if (target === anchor.note.tick) {
    if (!Number.isSafeInteger(anchor.note.tick + direction)) throw new RangeError("invalid_tick");
    target = snapTick(anchor.note.tick + direction, subdivision, mode, gridResolution);
  }
  if (!Number.isSafeInteger(target)) throw new RangeError("invalid_tick");
  const result = moveChartSelection(project, ids, target - anchor.note.tick, 0, { placement: "overlap" });
  assertValidProject(result);
  return result;
}

/** Pack distinct selected times one tick apart, retaining simultaneous notes and connector order. */
export function compressChartSelection(project: Project, ids: ReadonlySet<string>, anchor: "first" | "last"): Project {
  assertValidProject(project);
  const ticks = [...new Set(chartSelectionNodes(project).filter(({ note }) => ids.has(note.id)).map(({ note }) => note.tick))].sort((a, b) => a - b);
  if (ticks.length < 2) return structuredCloneValue(project);
  const start = anchor === "first" ? ticks[0]! : ticks.at(-1)! - ticks.length + 1;
  const positions = new Map(ticks.map((tick, index) => [tick, start + index]));
  const result = structuredCloneValue(project);
  for (const note of [...result.singles, ...result.lines.flatMap(line => line.points)])
    if (ids.has(note.id)) note.tick = positions.get(note.tick)!;
  for (const line of result.lines) {
    if (!line.points.some(point => ids.has(point.id))) continue;
    for (let index = 1; index < line.points.length; index++)
      if (line.points[index]!.tick < line.points[index - 1]!.tick) throw new RangeError("line_time_order");
  }
  clearAutoCache(result, ids);
  assertValidProject(result);
  assertEditedChartSpans(project, result);
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
    mirrorSelectionNote(note, result.laneBasis);
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
export function generateLinePoints(project: Project, lineIds: ReadonlySet<string>, subdivision: number, beatsPerUnit = 1) {
  const gridResolution = project.resolution * beatsPerUnit;
  if (!Number.isSafeInteger(gridResolution) || gridResolution < 1 || !Number.isSafeInteger(subdivision) || subdivision < 1 || subdivision > gridResolution)
    throw new RangeError("invalid_division");
  const result = structuredCloneValue(project),
    created: string[] = [];
  for (const line of result.lines) {
    if (!lineIds.has(line.id) || line.points.length < 2) continue;
    const firstCreated = created.length;
    const existing = new Set(line.points.map((point) => point.tick)),
      start = line.points[0]!.tick,
      end = line.points.at(-1)!.tick;
    for (
      let unit = Math.floor((start * subdivision) / gridResolution) + 1;
      unit < (end * subdivision) / gridResolution;
      unit++
    ) {
      const tick = Math.round((unit * gridResolution) / subdivision);
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
    inheritLinePointMembership(result, line.id, created.slice(firstCreated));
  }
  assertValidProject(result);
  return { project: result, created };
}

export function interpolateChartTimeScales(project: Project, ids: ReadonlySet<string>, subdivision: number) {
  if (!Number.isSafeInteger(subdivision) || subdivision < 1 || subdivision > project.resolution * 4)
    throw new Error("invalid_division");
  const selected = project.timeScales.filter(event => ids.has(event.id)).sort((a, b) => a.tick - b.tick);
  if (selected.length < 2) throw new Error("invalid_speed_selection");
  if ((selected.at(-1)!.tick - selected[0]!.tick) * subdivision / (project.resolution * 4) > 100_000)
    throw new Error("too_many_generated_notes");
  const result = structuredCloneValue(project), byTick = new Map(result.timeScales.map(event => [event.tick, event]));
  for (let index = 1; index < selected.length; index++) {
    const first = selected[index - 1]!, last = selected[index]!;
    if (first.tick === last.tick) throw new Error("invalid_speed_selection");
    for (let unit = Math.floor(first.tick / (project.resolution * 4) * subdivision) + 1; ; unit++) {
      const tick = Math.round(unit * project.resolution * 4 / subdivision);
      if (tick >= last.tick) break;
      if (tick <= first.tick) continue;
      const scale = first.scale + (last.scale - first.scale) * ((tick - first.tick) / (last.tick - first.tick));
      const existing = byTick.get(tick);
      if (existing) existing.scale = scale;
      else {
        const event = { id: createProjectId("speed"), tick, scale };
        result.timeScales.push(event);
        byTick.set(tick, event);
      }
    }
  }
  result.timeScales.sort((a, b) => a.tick - b.tick);
  assertValidProject(result);
  return result;
}
