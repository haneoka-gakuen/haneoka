import {
  resolveLinePointShape,
  structuredCloneValue,
  type Project,
  type SingleNote,
  type LinePoint,
  type JsonValue,
} from "../model";
import { copyChartSelection, deleteChartSelection, pasteChartSelection, type ChartSelection } from "./editing";
import {
  assertEditedChartSpans,
  authoredSpanOverlaps,
  constrainLaneValue,
  selectionLaneDeltaBounds,
  type LaneGrid,
} from "./span";

export function chartSelectionNodes(project: Project): { note: SingleNote | LinePoint; lane: number; size: number }[] {
  return [
    ...project.singles.map((note) => ({ note, lane: note.lane, size: note.size })),
    ...project.lines.flatMap((line) =>
      line.points.map((note, index) => ({ note, ...resolveLinePointShape(line.points, index) })),
    ),
  ];
}
export function chartSelectionInBox(
  project: Project,
  tickA: number,
  tickB: number,
  laneA: number,
  laneB: number,
): string[] {
  const start = Math.min(tickA, tickB),
    end = Math.max(tickA, tickB),
    left = Math.min(laneA, laneB),
    right = Math.max(laneA, laneB);
  return chartSelectionNodes(project)
    .filter(
      ({ note, lane, size }) =>
        note.tick >= start && note.tick <= end && lane <= right && lane + Math.max(size, 0.25) >= left,
    )
    .map(({ note }) => note.id);
}

/** One common delta preserves relative spacing. Clamp against unselected line neighbours; keep authored auto markers. */
export function moveChartSelection(
  project: Project,
  ids: ReadonlySet<string>,
  tickDelta: number,
  laneDelta: number,
  options: { placement?: "overlap"; grid?: LaneGrid } = {},
): Project {
  if (!Number.isSafeInteger(tickDelta) || !Number.isFinite(laneDelta)) throw new RangeError("Invalid selection delta");
  if (!tickDelta && !laneDelta) return structuredCloneValue(project);
  const selected = chartSelectionNodes(project).filter(({ note }) => ids.has(note.id));
  if (!selected.length) return structuredCloneValue(project);
  let tickMin = -Math.min(...selected.map(({ note }) => note.tick)),
    tickMax = Number.MAX_SAFE_INTEGER - Math.max(...selected.map(({ note }) => note.tick));
  for (const line of project.lines)
    for (let index = 0; index < line.points.length; index++) {
      const point = line.points[index]!;
      if (!ids.has(point.id)) continue;
      const previous = line.points[index - 1],
        next = line.points[index + 1];
      if (previous && !ids.has(previous.id)) tickMin = Math.max(tickMin, previous.tick - point.tick);
      if (next && !ids.has(next.id)) tickMax = Math.min(tickMax, next.tick - point.tick);
    }
  const deltaTick = Math.max(tickMin, Math.min(tickMax, tickDelta));
  const concrete = selected.filter(({ note }) => typeof note.lane === "number");
  const left = Math.min(0, ...concrete.map(({ note }) => note.lane as number));
  const right = Math.max(project.laneBasis, ...concrete.map(({ note }) => (note.lane as number) + note.size));
  let deltaLane = concrete.length
    ? Math.max(
        Math.max(...concrete.map(({ note }) => left - (note.lane as number))),
        Math.min(Math.min(...concrete.map(({ note }) => right - (note.lane as number) - note.size)), laneDelta),
      )
    : 0;
  if (options.placement === "overlap" && laneDelta && concrete.length) {
    const bounds = selectionLaneDeltaBounds(project, ids)!;
    // Imported off-stage controls may move into overlap, but must never jump against the requested drag direction.
    if (concrete.some(({ lane, size }) => !authoredSpanOverlaps(lane, size, project.laneBasis))) {
      concrete.forEach(({ lane, size }) => {
        if (!authoredSpanOverlaps(lane + laneDelta, size, project.laneBasis))
          throw new RangeError("authored_span_outside_stage");
      });
      deltaLane = laneDelta;
    } else deltaLane = constrainLaneValue(laneDelta, bounds, options.grid);
  } else if (options.placement === "overlap") deltaLane = 0;
  if (!deltaTick && !deltaLane) return structuredCloneValue(project);
  const result = structuredCloneValue(project);
  const move = (note: SingleNote | LinePoint) => {
    if (ids.has(note.id)) {
      note.tick += deltaTick;
      if (typeof note.lane === "number") note.lane += deltaLane;
    }
  };
  result.singles.forEach(move);
  for (const line of result.lines) {
    if (!line.points.some((point) => ids.has(point.id))) continue;
    line.points.forEach(move);
    for (const point of line.points)
      if (point.lane === "auto") {
        delete point.resolvedLane;
        delete point.resolvedSize;
      }
  }
  if (options.placement === "overlap") assertEditedChartSpans(project, result);
  return result;
}

export interface SelectionSourceRecords {
  schema?: JsonValue;
  records: Record<string, JsonValue>;
}
/** Optional metadata travels on each existing clipboard item; old ChartSelection[] callers remain compatible. */
export type SourceAwareChartSelection = ChartSelection & { sourceRecords?: Record<string, SelectionSourceRecords> };
function record(value: unknown): value is Record<string, JsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function captureSelectionRecords(project: Project, item: ChartSelection): Record<string, SelectionSourceRecords> {
  const ids = item.kind === "single" ? [item.note.id] : [item.line.id, ...item.line.points.map((point) => point.id)];
  return Object.fromEntries(
    Object.entries(project.extensions).flatMap(([key, source]) => {
      if (!record(source) || !record(source.records)) return [];
      const records = Object.fromEntries(
        ids
          .filter((id) => Object.hasOwn(source.records as object, id))
          .map((id) => [id, structuredCloneValue((source.records as Record<string, JsonValue>)[id])!]),
      );
      return Object.keys(records).length
        ? [[key, { ...(source.schema === undefined ? {} : { schema: structuredCloneValue(source.schema) }), records }]]
        : [];
    }),
  );
}
function pasteSelectionRecords(project: Project, item: ChartSelection, mapping: Record<string, string>) {
  const sources = (item as SourceAwareChartSelection).sourceRecords;
  if (!sources) return;
  for (const [key, source] of Object.entries(sources)) {
    const target = record(project.extensions[key])
      ? (structuredCloneValue(project.extensions[key]) as Record<string, JsonValue>)
      : {};
    if (
      target.schema !== undefined &&
      source.schema !== undefined &&
      JSON.stringify(target.schema) !== JSON.stringify(source.schema)
    )
      throw new Error("clipboard_source_schema_mismatch");
    if (target.schema === undefined && source.schema !== undefined) target.schema = structuredCloneValue(source.schema);
    const records = record(target.records) ? target.records : {};
    for (const [old, id] of Object.entries(mapping))
      if (Object.hasOwn(source.records, old))
        Object.defineProperty(records, id, {
          value: structuredCloneValue(source.records[old]),
          writable: true,
          configurable: true,
          enumerable: true,
        });
    target.records = records;
    project.extensions[key] = target;
  }
}

/** A connector is copied once even when several of its points are selected. */
export function copyChartSelectionGroup(project: Project, ids: ReadonlySet<string>): SourceAwareChartSelection[] {
  const seen = new Set<string>(),
    result: SourceAwareChartSelection[] = [];
  for (const id of ids) {
    const item = copyChartSelection(project, id);
    if (!item) continue;
    const key = item.kind === "single" ? item.note.id : item.line.id;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ ...item, sourceRecords: captureSelectionRecords(project, item) });
    }
  }
  return result;
}
export function deleteChartSelectionGroup(project: Project, ids: ReadonlySet<string>): void {
  for (const id of ids) deleteChartSelection(project, id);
}
export function pasteChartSelectionGroup(project: Project, items: readonly ChartSelection[], tick: number): string[] {
  if (!items.length) return [];
  const start = Math.min(...items.map((item) => (item.kind === "single" ? item.note.tick : item.line.points[0]!.tick))),
    selected: string[] = [];
  for (const item of items) {
    const first = item.kind === "single" ? item.note.tick : item.line.points[0]!.tick;
    const id = pasteChartSelection(project, item, tick + first - start);
    if (item.kind === "single") {
      selected.push(id);
      pasteSelectionRecords(project, item, { [item.note.id]: id });
    } else {
      const line = project.lines.at(-1)!;
      selected.push(...line.points.map((point) => point.id));
      pasteSelectionRecords(
        project,
        item,
        Object.fromEntries([
          [item.line.id, line.id],
          ...item.line.points.map((point, index) => [point.id, line.points[index]!.id]),
        ]),
      );
    }
  }
  return selected;
}
