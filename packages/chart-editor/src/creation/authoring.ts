import {
  createProjectId,
  structuredCloneValue,
  resolveLinePointShape,
  type Project,
  type SingleNote,
  type NoteType,
  type NoteDirection,
} from "../model";
import { assertValidProject } from "../validation";

export interface AuthoredNoteInput {
  tick: number;
  /** Authored left edge, in the project's laneBasis units. */
  lane: number;
  /** Required authored span; this is independent from renderer noteSize. Zero-width markers remain valid. */
  size: number;
  type?: NoteType;
  direction?: NoteDirection;
  critical?: boolean;
  visible?: boolean;
  /** Clamp only the new placement, never alter imported source geometry. */
  placement?: "stage" | "authored";
}
export type WidthAnchor = "left" | "center" | "right";

function width(project: Project, value: number, placement: "stage" | "authored") {
  if (!Number.isFinite(value) || value < 0 || (placement === "stage" && value > project.laneBasis))
    throw new RangeError("invalid_note_width");
  return value;
}
/** Each call receives a configurable width. No fixed laneBasis/6 is hidden in the constructor. */
export function createAuthoredNote(project: Project, input: AuthoredNoteInput): SingleNote {
  const placement = input.placement ?? "stage",
    size = width(project, input.size, placement),
    type = input.type ?? "tap";
  if (!Number.isSafeInteger(input.tick) || input.tick < 0 || !Number.isFinite(input.lane))
    throw new RangeError("invalid_note_position");
  const note: SingleNote = {
    id: createProjectId("note"),
    tick: input.tick,
    lane: placement === "stage" ? Math.max(0, Math.min(project.laneBasis - size, input.lane)) : input.lane,
    size,
    type,
    direction: type === "flick" ? (input.direction ?? "up") : "none",
    critical: input.critical ?? false,
    visible: input.visible ?? true,
  };
  const candidate = structuredCloneValue(project);
  candidate.singles.push(note);
  assertValidProject(candidate);
  return note;
}
export function addAuthoredNote(project: Project, input: AuthoredNoteInput): Project {
  const result = structuredCloneValue(project);
  result.singles.push(createAuthoredNote(project, input));
  return result;
}
/** Set widths atomically. Center/right anchors retain the chosen edge; source IDs and semantic fields survive. */
export function resizeChartSelection(
  project: Project,
  ids: ReadonlySet<string>,
  size: number,
  options: { anchor?: WidthAnchor; placement?: "stage" | "authored"; resolveAutoLane?: boolean } = {},
): Project {
  const placement = options.placement ?? "stage",
    anchor = options.anchor ?? "left",
    newSize = width(project, size, placement),
    result = structuredCloneValue(project);
  // Resolve every selected automatic point from the unchanged source, before any group edits.
  const automaticShapes = new Map<string, ReturnType<typeof resolveLinePointShape>>();
  if (options.resolveAutoLane)
    for (const line of project.lines)
      line.points.forEach((point, index) => {
        if (point.lane === "auto" && ids.has(point.id))
          automaticShapes.set(point.id, resolveLinePointShape(line.points, index));
      });
  const change = (note: SingleNote | Project["lines"][number]["points"][number]) => {
    if (!ids.has(note.id)) return;
    const shape = automaticShapes.get(note.id);
    if (shape && "ease" in note) {
      note.lane = shape.lane;
      note.size = shape.size;
      delete note.autoSize;
      delete note.resolvedLane;
      delete note.resolvedSize;
    }
    if (typeof note.lane === "number") {
      const lane =
        note.lane + (anchor === "center" ? (note.size - newSize) / 2 : anchor === "right" ? note.size - newSize : 0);
      note.lane = placement === "stage" ? Math.max(0, Math.min(result.laneBasis - newSize, lane)) : lane;
    } else if ("ease" in note) note.autoSize = false;
    note.size = newSize;
  };
  result.singles.forEach(change);
  for (const line of result.lines) {
    if (!line.points.some((point) => ids.has(point.id))) continue;
    line.points.forEach(change);
    for (const point of line.points)
      if (point.lane === "auto") {
        delete point.resolvedLane;
        delete point.resolvedSize;
      }
  }
  assertValidProject(result);
  return result;
}
