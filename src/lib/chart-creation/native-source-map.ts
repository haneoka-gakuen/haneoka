import type { ChartDocument, SsRawNote, SsRoot } from "@haneoka/cassiopeia";
import type { Project } from "../../../packages/chart-editor/src/model";
import { assertValidProject } from "../../../packages/chart-editor/src/validation";

export interface NativeCanonicalSource {
  readonly canonicalId: string;
  readonly kind: "single" | "point" | "line";
  readonly path: string;
  readonly lineId?: string;
}

/** Compiler reports raw object identity, including every alias of a merged native note. */
export interface NativeSourceObserver {
  onSourceNote(source: SsRawNote, nativeId: number): void;
  onSourceLine(source: SsRawNote, nativeId: number): void;
}

export interface NativeCreationSourceMap {
  sourcesForNote(nativeId: number): readonly NativeCanonicalSource[];
  sourcesForLine(nativeId: number): readonly NativeCanonicalSource[];
  notesForCanonical(canonicalId: string): readonly number[];
  linesForCanonical(canonicalId: string): readonly number[];
}

const missingSource = () => new Error("our_notes_source_mapping_mismatch");
const emptySources: readonly NativeCanonicalSource[] = Object.freeze([]);
const emptyIds: readonly number[] = Object.freeze([]);

/**
 * Bind the SS export's explicit sourceOrder and stable point order to parsed raw
 * objects. Native IDs are supplied only by the compiler, never inferred from
 * timestamps, geometry or the compiler's sorted/generated noteIds arrays.
 */
export function prepareNativeSourceMap(project: Project, root: SsRoot) {
  assertValidProject(project);
  const rows = new Map<string, { kind: "single" | "line"; pointIds?: string[] }>();
  for (const single of project.singles) rows.set(single.id, { kind: "single" });
  for (const line of project.lines)
    rows.set(line.id, {
      kind: "line",
      pointIds: [...line.points].sort((a, b) => a.tick - b.tick).map(point => point.id),
    });
  const ordered: { id: string; value: { kind: "single" | "line"; pointIds?: string[] } }[] = [];
  for (const id of project.sourceOrder ?? []) {
    const value = rows.get(id);
    if (!value) continue;
    ordered.push({ id, value });
    rows.delete(id);
  }
  for (const [id, value] of rows) ordered.push({ id, value });
  if (ordered.length !== root.notes.length) throw missingSource();

  const rawSources = new Map<SsRawNote, NativeCanonicalSource>();
  for (const [index, { id, value }] of ordered.entries()) {
    const raw = root.notes[index];
    if (!raw) throw missingSource();
    const isLine = raw.type === "long" || raw.type === "guide";
    if (isLine !== (value.kind === "line")) throw missingSource();
    const path = `$.score.notes[${index}]`;
    rawSources.set(raw, Object.freeze({ canonicalId: id, kind: value.kind, path }));
    if (value.kind === "line") {
      const points = value.pointIds!;
      if (raw.node?.length !== points.length) throw missingSource();
      for (const [pointIndex, canonicalId] of points.entries())
        rawSources.set(raw.node[pointIndex]!, Object.freeze({
          canonicalId, kind: "point", lineId: id, path: `${path}.node[${pointIndex}]`,
        }));
    }
  }

  const noteSources = new Map<number, Map<string, NativeCanonicalSource>>();
  const lineSources = new Map<number, Map<string, NativeCanonicalSource>>();
  const visited = new Set<SsRawNote>();
  let finished = false;
  const record = (raw: SsRawNote, nativeId: number, line: boolean) => {
    const source = rawSources.get(raw);
    if (finished || !source || (source.kind === "line") !== line || !Number.isSafeInteger(nativeId) || nativeId < 0)
      throw missingSource();
    const table = line ? lineSources : noteSources;
    let aliases = table.get(nativeId);
    if (!aliases) table.set(nativeId, aliases = new Map());
    aliases.set(source.canonicalId, source);
    visited.add(raw);
  };
  const observer: NativeSourceObserver = {
    onSourceNote: (raw, id) => record(raw, id, false),
    onSourceLine: (raw, id) => record(raw, id, true),
  };

  const finish = (chart: ChartDocument): NativeCreationSourceMap => {
    if (finished || visited.size !== rawSources.size) throw missingSource();
    const nativeNotes = new Set(chart.notes.map(note => note.id));
    const nativeLines = new Set(chart.lines.map(line => line.id));
    if ([...noteSources.keys()].some(id => !nativeNotes.has(id)) || [...lineSources.keys()].some(id => !nativeLines.has(id)))
      throw missingSource();
    finished = true;
    const freeze = (table: Map<number, Map<string, NativeCanonicalSource>>) => {
      const forward = new Map<number, readonly NativeCanonicalSource[]>();
      const reverse = new Map<string, readonly number[]>();
      const reverseLists = new Map<string, number[]>();
      for (const [id, sources] of table) {
        forward.set(id, Object.freeze([...sources.values()]));
        for (const source of sources.values()) {
          let ids = reverseLists.get(source.canonicalId);
          if (!ids) reverseLists.set(source.canonicalId, ids = []);
          ids.push(id);
        }
      }
      for (const [id, values] of reverseLists) reverse.set(id, Object.freeze(values));
      return { forward, reverse };
    };
    const notes = freeze(noteSources), lines = freeze(lineSources);
    return Object.freeze({
      sourcesForNote: (id: number) => notes.forward.get(id) ?? emptySources,
      sourcesForLine: (id: number) => lines.forward.get(id) ?? emptySources,
      notesForCanonical: (id: string) => notes.reverse.get(id) ?? emptyIds,
      linesForCanonical: (id: string) => lines.reverse.get(id) ?? emptyIds,
    });
  };
  return { observer, finish };
}
