import { NoteOperateType, type ChartDocument } from "@haneoka/cassiopeia";
import type { Project } from "../../../packages/chart-editor/src/model";
import { assertValidProject } from "../../../packages/chart-editor/src/validation";
import { readAuthorCollections } from "../../../packages/chart-editor/src/creation/collections";
import type { NativeCanonicalSource, NativeCreationSourceMap } from "./native-source-map";

export interface AuthorSpeedSource {
  readonly canonicalId: string;
  readonly lineId?: string;
  readonly groupId?: string;
  /** Omitted means inherit the current global speed, not a fixed copy of it. */
  readonly noteSpeed?: number;
}
export interface AuthorSpeedDiagnostic {
  readonly code: "speed_out_of_range" | "line_profile_conflict" | "alias_profile_conflict" | "source_mapping_mismatch";
  readonly nativeNoteId?: number;
  readonly nativeLineId?: number;
  readonly canonicalLineId?: string;
  readonly sources: readonly AuthorSpeedSource[];
}
/** Author compile result; the child runtime adapter is connected only after its exact contract is ready. */
export interface AuthorNativeSpeedPlan {
  readonly notes: readonly { readonly nativeNoteId: number; readonly noteSpeed: number }[];
  readonly lines: readonly { readonly nativeLineId: number; readonly noteSpeed: number }[];
  /** Derived display identity only; generated notes remain absent from the editable source map. */
  readonly generated: readonly { readonly nativeNoteId: number; readonly noteSpeed: number }[];
}
export class AuthorNativeSpeedError extends Error {
  readonly diagnostics: readonly AuthorSpeedDiagnostic[];
  constructor(diagnostics: readonly AuthorSpeedDiagnostic[]) {
    super("our_notes_visual_profile_conflict");
    this.name = "AuthorNativeSpeedError";
    this.diagnostics = diagnostics;
  }
}

/** Resolve groups on actual source IDs, preserving native note/line identity and judgement/audio time. */
export function compileAuthorNativeSpeedPlan(
  project: Project,
  chart: ChartDocument,
  mapping: NativeCreationSourceMap,
): AuthorNativeSpeedPlan | undefined {
  assertValidProject(project);
  if (project.meta.source && !["ss", "authored"].includes(project.meta.source))
    throw new Error("our_notes_source_mismatch");
  const collections = readAuthorCollections(project);
  if (!collections.groups.some(group => group.forceNoteSpeed !== undefined)) return undefined;
  const groups = new Map(collections.groups.map(group => [group.id, group]));
  const singles = new Set(project.singles.map(note => note.id));
  const lines = new Map(project.lines.map(line => [line.id, line]));
  const parents = new Map(project.lines.flatMap(line => line.points.map(point => [point.id, line.id] as const)));
  const diagnostics: AuthorSpeedDiagnostic[] = [];
  const resolved = new Map<string, AuthorSpeedSource>();
  const source = (id: string): AuthorSpeedSource => {
    const previous = resolved.get(id);
    if (previous) return previous;
    const lineId = parents.get(id);
    const groupId = collections.members[id]?.groupId ?? (lineId ? collections.members[lineId]?.groupId : undefined);
    const noteSpeed = groupId ? groups.get(groupId)?.forceNoteSpeed : undefined;
    const value: AuthorSpeedSource = Object.freeze({
      canonicalId: id, ...(lineId ? { lineId } : {}), ...(groupId ? { groupId } : {}),
      ...(noteSpeed === undefined ? {} : { noteSpeed }),
    });
    resolved.set(id, value);
    if (noteSpeed !== undefined && (noteSpeed < 1 || noteSpeed > 14))
      diagnostics.push({ code: "speed_out_of_range", sources: [value] });
    return value;
  };
  const same = (values: readonly AuthorSpeedSource[]) =>
    values.every(value => value.noteSpeed === values[0]?.noteSpeed);
  const lineSpeeds = new Map<string, number | undefined>();
  for (const line of project.lines) {
    const header = source(line.id), points = line.points.map(point => source(point.id));
    const values = [header, ...points];
    if (!same(values)) diagnostics.push({ code: "line_profile_conflict", canonicalLineId: line.id, sources: [header, ...points] });
    lineSpeeds.set(line.id, values[0]?.noteSpeed);
  }
  const valid = (entry: NativeCanonicalSource, line: boolean) => line
    ? entry.kind === "line" && lines.has(entry.canonicalId)
    : entry.kind === "single" ? singles.has(entry.canonicalId)
      : entry.kind === "point" && parents.has(entry.canonicalId) && parents.get(entry.canonicalId) === entry.lineId;
  const noteSpeeds = new Map<number, number | undefined>();
  const nativeLineSpeeds = new Map<number, number | undefined>();
  for (const line of chart.lines) {
    const aliases = mapping.sourcesForLine(line.id);
    if (!aliases.length || aliases.some(entry => !valid(entry, true))) {
      diagnostics.push({ code: "source_mapping_mismatch", nativeLineId: line.id, sources: [] });
      continue;
    }
    const values = aliases.map(entry => {
      const { noteSpeed: _stored, ...identity } = source(entry.canonicalId);
      const noteSpeed = lineSpeeds.get(entry.canonicalId);
      return { ...identity, ...(noteSpeed === undefined ? {} : { noteSpeed }) };
    });
    if (!same(values)) diagnostics.push({ code: "alias_profile_conflict", nativeLineId: line.id, sources: values });
    nativeLineSpeeds.set(line.id, values[0]?.noteSpeed);
  }
  const generated: { nativeNoteId: number; noteSpeed: number }[] = [];
  for (const note of chart.notes) {
    const aliases = mapping.sourcesForNote(note.id);
    if (!aliases.length) {
      const derived = note.operateType === NoteOperateType.Combo || note.operateType === NoteOperateType.ComboSkip;
      if (!derived || !note.lineIds.length || note.lineIds.some(id => !nativeLineSpeeds.has(id))) {
        diagnostics.push({ code: "source_mapping_mismatch", nativeNoteId: note.id, sources: [] });
        continue;
      }
      const speeds = note.lineIds.map(id => nativeLineSpeeds.get(id));
      if (speeds.some(speed => speed !== speeds[0])) diagnostics.push({ code: "alias_profile_conflict", nativeNoteId: note.id, sources: [] });
      if (speeds[0] !== undefined) generated.push({ nativeNoteId: note.id, noteSpeed: speeds[0] });
      continue;
    }
    if (aliases.some(entry => !valid(entry, false))) {
      diagnostics.push({ code: "source_mapping_mismatch", nativeNoteId: note.id, sources: [] });
      continue;
    }
    const values = aliases.map(entry => source(entry.canonicalId));
    if (!same(values)) diagnostics.push({ code: "alias_profile_conflict", nativeNoteId: note.id, sources: values });
    noteSpeeds.set(note.id, values[0]?.noteSpeed);
  }
  if (diagnostics.length) throw new AuthorNativeSpeedError(diagnostics);
  const notes = [...noteSpeeds].flatMap(([nativeNoteId, noteSpeed]) => noteSpeed === undefined ? [] : [{ nativeNoteId, noteSpeed }]).sort((a, b) => a.nativeNoteId - b.nativeNoteId);
  const nativeLines = [...nativeLineSpeeds].flatMap(([nativeLineId, noteSpeed]) => noteSpeed === undefined ? [] : [{ nativeLineId, noteSpeed }]).sort((a, b) => a.nativeLineId - b.nativeLineId);
  if (!notes.length && !nativeLines.length && !generated.length) return undefined;
  return { notes, lines: nativeLines, generated: generated.sort((a, b) => a.nativeNoteId - b.nativeNoteId) };
}
