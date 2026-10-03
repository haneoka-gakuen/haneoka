import { createProjectId, structuredCloneValue, type Project, type NoteLine, type SingleNote } from "../model";

export type ChartSelection = { kind: "single"; note: SingleNote } | { kind: "line"; line: NoteLine };
export function copyChartSelection(project: Project, id: string): ChartSelection | undefined {
  const note = project.singles.find((note) => note.id === id);
  if (note) return { kind: "single", note: structuredCloneValue(note) };
  const line = project.lines.find((line) => line.points.some((point) => point.id === id));
  return line ? { kind: "line", line: structuredCloneValue(line) } : undefined;
}
export function deleteChartSelection(project: Project, id: string): void {
  project.singles = project.singles.filter((note) => note.id !== id);
  project.lines = project.lines.filter((line) => !line.points.some((note) => note.id === id));
}
/** Copy a complete connector with its points and retained source shape; mint fresh stable IDs. */
export function pasteChartSelection(project: Project, selection: ChartSelection, tick: number): string {
  if (!Number.isSafeInteger(tick) || tick < 0) throw new RangeError("Invalid paste tick");
  const value = structuredCloneValue(selection);
  if (value.kind === "single") {
    value.note.id = createProjectId("note");
    value.note.tick = tick;
    project.singles.push(value.note);
    return value.note.id;
  }
  const start = value.line.points[0]!.tick;
  value.line.id = createProjectId("line");
  for (const point of value.line.points) {
    point.id = createProjectId("note");
    point.tick += tick - start;
  }
  project.lines.push(value.line);
  return value.line.points[0]!.id;
}
