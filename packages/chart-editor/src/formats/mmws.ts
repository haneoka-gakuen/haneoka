// L3 — GEB
// Input: MMWS／CCMMWS／UCMMWS 二进制工程或创作工程。
// Output: Our Notes 可表达的工程模型与 CCMMWS v6 文件；保留图层和路标。
// Pos: [Map](../../L2-2.md)；MikuMikuWorld 工程适配器。
// Effects/Dependencies: 纯转换；不读取工程中记录的音频或封面路径。
import { importedId, resolveLinePointShape, type JsonValue, type LinePoint, type NoteLine, type Project, type SingleNote } from "../model";
import { COLLECTIONS_KEY, readAuthorCollections, type AuthorCollections } from "../creation/collections";
import { assertValidProject } from "../validation";
import { ChartFormatError, finishImport, importedMeta, importedProject, isRecord, type FormatWarning, type ImportResult } from "./shared";
import { projectMeasureMap } from "./sus-export";
const unsupported = () => new ChartFormatError("mmws", "mmws_unsupported");
class Reader {
  position = 0;
  readonly view: DataView;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) { this.bytes = bytes; this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  ensure(length: number) { if (this.position + length > this.bytes.length) throw new ChartFormatError("mmws", "mmws_invalid"); }
  u16() { this.ensure(2); const value = this.view.getUint16(this.position, true); this.position += 2; return value; }
  u32() { this.ensure(4); const value = this.view.getUint32(this.position, true); this.position += 4; return value; }
  f32() { this.ensure(4); const value = this.view.getFloat32(this.position, true); this.position += 4; if (!Number.isFinite(value)) throw new ChartFormatError("mmws", "mmws_invalid"); return value; }
  text() { const end = this.bytes.indexOf(0, this.position); if (end < 0) throw new ChartFormatError("mmws", "mmws_invalid"); const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(this.bytes.subarray(this.position, end)); this.position = end + 1; return value; }
  seek(position: number) { if (position < 0 || position >= this.bytes.length) throw new ChartFormatError("mmws", "mmws_invalid"); this.position = position; }
  count() { const count = this.u32(); if (count > this.bytes.length - this.position) throw new ChartFormatError("mmws", "mmws_invalid"); return count; }
}
export function isMmws(input: unknown): input is Uint8Array {
  if (!(input instanceof Uint8Array)) return false;
  return /^(?:MMWS|CCMMWS|UCMMWS)\0/u.test(new TextDecoder().decode(input.subarray(0, 8)));
}
const easeNames = ["linear", "in", "out"] as const;
const directions = ["none", "up", "left", "right"] as const;
export function importMmws(input: Uint8Array): ImportResult {
  const reader = new Reader(input), signature = reader.text();
  let base = 4, cc = 0, uc = 0;
  if (signature === "MMWS") base = reader.u32();
  else if (signature === "CCMMWS") { base = reader.u16(); cc = reader.u16() || 1; }
  else if (signature === "UCMMWS") { uc = reader.u32(); cc = 6; }
  else throw new ChartFormatError("mmws", "mmws_invalid");
  if (base < 1 || base > 4 || cc > 6 || uc > 4) throw new ChartFormatError("mmws", "mmws_version");
  const extended = uc >= 3, addresses = base >= 3;
  const offsets = addresses ? Array.from({ length: cc >= 5 ? 7 : cc >= 4 ? 6 : cc >= 1 ? 5 : 4 }, () => reader.u32()) : [];
  if (addresses) reader.seek(offsets[0]!);
  const title = reader.text(), charter = reader.text(), artist = reader.text(), musicFile = reader.text(), musicOffset = reader.f32();
  const jacketFile = base >= 2 ? reader.text() : "", laneExtension = cc >= 1 ? reader.u32() : 0;
  if (extended) { reader.u32(); reader.u32(); }
  const project = importedProject("mmws", { audioOffset: musicOffset / -1000, meta: importedMeta("mmws", { title, charter, artist }) });
  project.extensions.mmws = { signature, base, cc, uc, musicFile, jacketFile, laneExtension };
  const collections: AuthorCollections = { schema: "haneoka.authoring.collections", version: 1, groups: [], layers: [], members: {}, sourceContexts: {} };
  const forced: number[] = [];
  if (cc >= 4) {
    reader.seek(offsets[5]!);
    const count = reader.count();
    for (let i = 0; i < count; i++) {
      const name = reader.text(), speed = uc >= 4 ? reader.f32() : 0;
      collections.layers.push({ id: importedId("mmws", "layer", i), name, visible: true });
      forced.push(speed);
      if (speed > 0) collections.groups.push({ id: importedId("mmws", "speed-group", i), name, forceNoteSpeed: speed });
    }
  } else collections.layers.push({ id: importedId("mmws", "layer", 0), name: "", visible: true });
  const layerGroups = new Map<number, string>();
  forced.forEach((speed, index) => { if (speed > 0) layerGroups.set(index, importedId("mmws", "speed-group", index)); });
  const assign = (id: string, layer: number) => {
    const target = collections.layers[layer];
    if (!target) throw new ChartFormatError("mmws", "mmws_invalid");
    collections.members[id] = { layerId: target.id, ...(layerGroups.has(layer) ? { groupId: layerGroups.get(layer)! } : {}) };
  };
  if (addresses) reader.seek(offsets[1]!);
  const signatures = Array.from({ length: reader.count() }, () => ({ measure: reader.u32(), numerator: reader.u32(), denominator: reader.u32() })).sort((a, b) => a.measure - b.measure);
  let measure = 0, tick = 0, length = 1920;
  project.meters = signatures.map((meter, index) => {
    tick += (meter.measure - measure) * length;
    measure = meter.measure; length = 1920 * meter.numerator / meter.denominator;
    return { id: importedId("mmws", "meter", index), tick, numerator: meter.numerator, denominator: meter.denominator };
  });
  project.tempos = Array.from({ length: reader.count() }, (_, index) => ({ id: importedId("mmws", "tempo", index), tick: reader.u32(), bpm: reader.f32() }));
  if (base >= 3) {
    const count = reader.count(), timelines = new Map<number, Map<number, number>>();
    for (let i = 0; i < count; i++) {
      const tick = reader.u32(), scale = reader.f32(), layer = cc >= 4 ? reader.u32() : 0;
      const skip = uc >= 2 ? reader.f32() : 0, ease = uc >= 2 ? reader.u16() : 0, hidden = uc >= 2 ? reader.u16() : 0;
      if (skip || ease || hidden) throw unsupported();
      const speeds = timelines.get(layer) ?? new Map<number, number>();
      speeds.set(tick, scale); timelines.set(layer, speeds);
    }
    const speeds = timelines.get(0) ?? new Map<number, number>([[0, 1]]);
    const normalize = (timeline: Map<number, number>) => JSON.stringify([...new Map([[0, 1], ...timeline])].sort((a, b) => a[0] - b[0]).filter((event, index, all) => index === 0 || event[1] !== all[index - 1]![1]));
    for (const layer of timelines.keys()) if (!collections.layers[layer]) throw new ChartFormatError("mmws", "mmws_invalid");
    const shared = collections.layers.every((_, index) => normalize(timelines.get(index) ?? new Map()) === normalize(speeds));
    if (shared) project.timeScales = [...speeds].map(([tick, scale], index) => ({ id: importedId("mmws", "speed", index), tick, scale }));
    else collections.layers.forEach((layer, index) => {
      let group = collections.groups.find(group => group.id === layerGroups.get(index));
      if (!group) {
        group = { id: importedId("mmws", "speed-group", index), name: layer.name };
        collections.groups.push(group); layerGroups.set(index, group.id);
      }
      group.timeScales = [...(timelines.get(index) ?? new Map<number, number>())].sort((a, b) => a[0] - b[0])
        .map(([tick, scale], at) => ({ id: importedId("mmws", "group-speed", index, at), tick, scale }));
    });
  }
  if (base >= 2) {
    const count = reader.count();
    for (let i = 0; i < count; i++) {
      project.markers.skill.push(reader.u32());
      if (extended) { const effect = reader.u32(); reader.u32(); if (effect) throw unsupported(); }
    }
    const start = reader.u32(), end = reader.u32();
    if (start !== 0xffffffff && end !== 0xffffffff) project.markers.fever.push([start, end]);
  }
  let noteIndex = 0;
  const readNote = (role: "single" | "head" | "mid" | "tail"): SingleNote & { layer: number; flags: number; easeValue: number } => {
    const tick = reader.u32(), lane = cc >= 6 ? reader.f32() : reader.u32() | 0, width = cc >= 6 ? reader.f32() : reader.u32();
    const sound = extended ? reader.u32() : 0, layer = cc >= 4 ? reader.u32() : 0;
    let flick = 0, flags = 0, type = 0, easeValue = 0;
    if (extended) { type = reader.u32(); flags = reader.u32(); flick = reader.u32(); easeValue = reader.u32(); const alpha = reader.f32(); if (alpha !== 1) throw unsupported(); }
    else { if (role === "single" || role === "tail") flick = reader.u32(); flags = reader.u32(); }
    if (sound || type > 1 || flags & 4 || flick > 3 || easeValue > 2) throw unsupported();
    return { id: importedId("mmws", "note", noteIndex++), tick, lane: lane * 2, size: width * 2,
      type: flags & 2 ? "trace" : flick ? "flick" : "tap", direction: directions[flick]!, critical: !!(flags & 1), visible: !(flags & 16), layer, flags, easeValue };
  };
  const clean = ({ layer: _layer, flags: _flags, easeValue: _ease, ...note }: ReturnType<typeof readNote>): SingleNote => note;
  const point = (raw: ReturnType<typeof readNote>, ease: number): LinePoint => {
    if (ease > 2) throw unsupported();
    return { ...clean(raw), ease: { left: easeNames[ease]!, right: easeNames[ease]! } };
  };
  if (addresses) reader.seek(offsets[2]!);
  const noteCount = reader.count();
  for (let i = 0; i < noteCount; i++) { const note = readNote("single"); project.singles.push(clean(note)); assign(note.id, note.layer); }
  if (addresses) reader.seek(offsets[3]!);
  const holdCount = reader.count();
  for (let i = 0; i < holdCount; i++) {
    const flags = base >= 4 ? reader.u32() : 0;
    if (flags & (extended ? 2 : 8)) throw unsupported();
    const head = readNote("head"), startEase = extended ? head.easeValue : reader.u32();
    const fade = cc >= 2 ? reader.u32() : 0, color = cc >= 3 ? reader.u32() : head.critical ? 4 : 2;
    const holdLayer = extended ? reader.u32() : 0;
    if (![0, 4].includes(fade) || ![2, 4].includes(color) || holdLayer > 1) throw unsupported();
    const kind = flags & 4 ? "guide" : "long", line: NoteLine = { id: importedId("mmws", "line", i), kind, critical: extended ? !!(flags & 1) : head.critical, points: [] };
    const first = point(head, startEase);
    if (!extended) first.visible = !(flags & 1) && kind !== "guide";
    line.points.push(first); assign(line.id, head.layer); assign(first.id, head.layer);
    const count = reader.count();
    for (let j = 0; j < count; j++) {
      const raw = readNote("mid"), mode = extended ? raw.flags & 8 ? 2 : raw.flags & 16 ? 1 : 0 : reader.u32(), ease = extended ? raw.easeValue : reader.u32();
      const mid = point(raw, ease); mid.visible = mode === 0;
      if (mode === 2) { mid.lane = "auto"; mid.autoSize = true; mid.size = 0; }
      line.points.push(mid); assign(mid.id, raw.layer);
    }
    const tail = readNote("tail"), last = point(tail, tail.easeValue);
    if (!extended) last.visible = !(flags & 2) && kind !== "guide";
    line.points.push(last); assign(last.id, tail.layer);
    if (extended && reader.count()) throw unsupported();
    project.lines.push(line);
  }
  if (cc >= 1) { reader.seek(offsets[4]!); if (reader.count()) throw unsupported(); }
  if (cc >= 5) {
    reader.seek(offsets[6]!);
    project.waypoints = Array.from({ length: reader.count() }, (_, index) => {
      const name = reader.text(), tick = reader.u32(); return { id: importedId("mmws", "waypoint", index), name, tick };
    });
  }
  project.extensions[COLLECTIONS_KEY] = collections as unknown as JsonValue;
  return finishImport("mmws", project, []);
}

class Writer {
  private buffer = new ArrayBuffer(4096);
  private view = new DataView(this.buffer);
  position = 0;
  private ensure(length: number) {
    if (this.position + length <= this.buffer.byteLength) return;
    const next = new ArrayBuffer(Math.max(this.buffer.byteLength * 2, this.position + length));
    new Uint8Array(next).set(new Uint8Array(this.buffer)); this.buffer = next; this.view = new DataView(next);
  }
  u16(value: number) { this.ensure(2); this.view.setUint16(this.position, value, true); this.position += 2; }
  u32(value: number) { this.ensure(4); this.view.setUint32(this.position, value, true); this.position += 4; }
  f32(value: number) { this.ensure(4); this.view.setFloat32(this.position, value, true); this.position += 4; }
  text(value: string) { if (value.includes("\0")) throw new ChartFormatError("mmws", "mmws_invalid"); const bytes = new TextEncoder().encode(value); this.ensure(bytes.length + 1); new Uint8Array(this.buffer, this.position, bytes.length).set(bytes); this.position += bytes.length; this.u8(0); }
  private u8(value: number) { this.ensure(1); this.view.setUint8(this.position++, value); }
  patch(at: number, value: number) { this.view.setUint32(at, value, true); }
  finish() { return new Uint8Array(this.buffer.slice(0, this.position)); }
}
const warning = (code: string, path: string, message: string): FormatWarning => ({ code: `mmws.export.${code}`, path, message });
export function mmwsExportDiagnostics(project: Project) {
  const errors: FormatWarning[] = [], warnings: FormatWarning[] = [];
  const speedEvents = [...project.timeScales, ...readAuthorCollections(project).groups.flatMap(group => group.timeScales ?? [])];
  try { projectMeasureMap(project); } catch { errors.push(warning("mmwMeasureBoundary", "$.meters", "MMWS requires meter changes on measure boundaries")); }
  if (project.markers.fever.length > 1) errors.push(warning("singleFever", "$.markers.fever", "MMWS carries one FEVER section"));
  if (project.lines.some(line => line.points.slice(0, -1).some(point => point.ease.left !== point.ease.right)))
    errors.push(warning("mmwEdgeEase", "$.lines", "MMWS cannot carry different left and right easing"));
  const ticks = [...project.singles.map(note => note.tick), ...project.lines.flatMap(line => line.points.map(point => point.tick)),
    ...project.tempos.map(event => event.tick), ...speedEvents.map(event => event.tick), ...(project.waypoints ?? []).map(point => point.tick),
    ...project.markers.skill, ...project.markers.fever.flat()];
  if (ticks.some(tick => tick > 0x7fffffff) || project.meters.some(meter => meter.numerator > 0xffffffff || meter.denominator > 0xffffffff)) errors.push(warning("tickLimit", "$", "MMWS ticks must fit a signed 32-bit integer"));
  const floats = [project.audioOffset * 1000, ...project.tempos.map(event => event.bpm), ...speedEvents.map(event => event.scale),
    ...project.singles.flatMap(note => [note.lane * 12 / project.laneBasis, note.size * 12 / project.laneBasis]),
    ...project.lines.flatMap(line => line.points.flatMap((_, index) => { const shape = resolveLinePointShape(line.points, index); return [shape.lane * 12 / project.laneBasis, shape.size * 12 / project.laneBasis]; }))];
  if (floats.some(value => !Number.isFinite(Math.fround(value))) || [...project.tempos.map(event => event.bpm), ...speedEvents.map(event => event.scale)].some(value => value !== 0 && Math.fround(value) === 0)) errors.push(warning("floatRange", "$", "MMW value exceeds the 32-bit float range"));
  if (project.markers.call.length) warnings.push(warning("callUnsupported", "$.markers.call", "MMWS does not carry Our Notes CALL rhythms"));
  if (project.lines.some(line => line.kind === "guide" && line.points.some(point => point.visible || point.lane === "auto")))
    warnings.push(warning("guideJudgementsUnsupported", "$.lines", "MMW guide nodes are not judged"));
  if (project.lines.some(line => line.points.slice(0, -1).some(point => point.type === "flick")))
    warnings.push(warning("nonEndFlickUnsupported", "$.lines", "CCMMWS holds carry flick direction only at their tail"));
  if (project.lines.some(line => line.critical !== undefined && line.critical !== line.points[0]!.critical))
    warnings.push(warning("mmwCritical", "$.lines", "CCMMWS derives connector criticality from its head"));
  if (project.meta.difficulty || project.meta.level || project.meta.tags?.length)
    warnings.push(warning("metadataPartial", "$.meta", "MMW omits difficulty, level and tags"));
  if (project.lines.some(line => line.points.some(point => point.lane === "auto" && point.visible)))
    warnings.push(warning("autoVisibilityUnsupported", "$.lines", "MMW automatic middle nodes are hidden"));
  const collections = readAuthorCollections(project);
  if (collections.groups.some(group => group.forceNoteSpeed !== undefined)) warnings.push(warning("groupsUnsupported", "$.extensions", "CCMMWS retains layers, but not Haneoka groups or their forced note speed"));
  if (collections.layers.some(layer => !layer.visible)) warnings.push(warning("layerVisibilityUnsupported", "$.extensions", "MMWS does not save editor layer visibility"));
  if (project.singles.some(note => !note.visible)) warnings.push(warning("singleVisibilityIgnored", "$.singles", "CCMMWS standalone notes remain visible"));
  if (Object.keys(project.extensions).some(key => key !== "mmws" && key !== COLLECTIONS_KEY))
    warnings.push(warning("extensionsUnsupported", "$.extensions", "Source extensions are omitted"));
  warnings.push(warning("floatPrecision", "$", "MMWS stores lanes, widths, BPM and audio offset as 32-bit floats"));
  return { errors, warnings };
}
/** CCMMWS v6 opens in MMW4CC and MMW4UC and retains fractional lane geometry. */
export function serializeMmws(project: Project): Uint8Array<ArrayBuffer> {
  assertValidProject(project);
  const diagnostics = mmwsExportDiagnostics(project);
  if (diagnostics.errors.length) throw new ChartFormatError("mmws", diagnostics.errors.map(issue => issue.message).join("; "));
  const writer = new Writer(), map = projectMeasureMap(project), collections = readAuthorCollections(project);
  const groups = new Map(collections.groups.map(group => [group.id, group]));
  const parents = new Map(project.lines.flatMap(line => line.points.map(point => [point.id, line.id])));
  const membership = (id: string) => {
    const own = collections.members[id], parent = collections.members[parents.get(id) ?? ""];
    return { layerId: own?.layerId ?? parent?.layerId ?? "", groupId: own?.groupId ?? parent?.groupId };
  };
  const layers = collections.layers.map(layer => ({ ...layer, timeScales: project.timeScales }));
  const noteIds = [...project.singles.map(note => note.id), ...project.lines.flatMap(line => [line.id, ...line.points.map(point => point.id)])];
  if (!layers.length || noteIds.some(id => !membership(id).layerId)) layers.unshift({ id: "", name: "", visible: true, timeScales: project.timeScales });
  const assignments = new Map<string, number>();
  const signature = (events: Project["timeScales"]) => JSON.stringify([...events].sort((a, b) => a.tick - b.tick).map(event => [event.tick, event.scale]));
  for (const id of noteIds) {
    const member = membership(id), group = member.groupId ? groups.get(member.groupId) : undefined;
    const timeline = group?.timeScales ?? project.timeScales, key = signature(timeline);
    let index = layers.findIndex(layer => layer.id === member.layerId && signature(layer.timeScales) === key);
    if (index < 0) {
      const layer = collections.layers.find(layer => layer.id === member.layerId);
      index = layers.length;
      layers.push({ id: member.layerId, name: [layer?.name, group?.name].filter(Boolean).join(" / "), visible: true, timeScales: timeline });
    }
    assignments.set(id, index);
  }
  const layerFor = (id: string) => assignments.get(id) ?? 0;
  writer.text("CCMMWS"); writer.u16(4); writer.u16(6);
  const offsetsAt = writer.position;
  for (let i = 0; i < 7; i++) writer.u32(0);
  const offsets: number[] = [writer.position];
  const meta = isRecord(project.extensions.mmws) ? project.extensions.mmws : {};
  writer.text(project.meta.title); writer.text(project.meta.charter); writer.text(project.meta.artist);
  writer.text(typeof meta.musicFile === "string" ? meta.musicFile : ""); writer.f32(-project.audioOffset * 1000);
  writer.text(typeof meta.jacketFile === "string" ? meta.jacketFile : ""); writer.u32(0);
  offsets.push(writer.position);
  writer.u32(map.segments.length);
  map.segments.forEach(segment => { writer.u32(segment.measure); writer.u32(segment.numerator); writer.u32(segment.denominator); });
  writer.u32(project.tempos.length);
  project.tempos.forEach(event => { writer.u32(event.tick); writer.f32(event.bpm); });
  writer.u32(layers.reduce((count, layer) => count + layer.timeScales.length, 0));
  layers.forEach((layer, index) => layer.timeScales.forEach(event => { writer.u32(event.tick); writer.f32(event.scale); writer.u32(index); }));
  writer.u32(project.markers.skill.length); project.markers.skill.forEach(tick => writer.u32(tick));
  writer.u32(project.markers.fever[0]?.[0] ?? 0xffffffff); writer.u32(project.markers.fever[0]?.[1] ?? 0xffffffff);
  const note = (value: SingleNote, role: "single" | "head" | "mid" | "tail", lane = value.lane, size = value.size) => {
    writer.u32(value.tick); writer.f32(lane * 12 / project.laneBasis); writer.f32(size * 12 / project.laneBasis); writer.u32(layerFor(value.id));
    if (role === "single" || role === "tail") writer.u32(directions.indexOf(value.type === "flick" ? value.direction === "none" ? "up" : value.direction : "none"));
    writer.u32((value.critical ? 1 : 0) | (value.type === "trace" ? 2 : 0));
  };
  offsets.push(writer.position); writer.u32(project.singles.length); project.singles.forEach(value => note(value, "single"));
  offsets.push(writer.position); writer.u32(project.lines.length);
  project.lines.forEach(line => {
    const first = line.points[0]!, last = line.points.at(-1)!;
    writer.u32((!first.visible ? 1 : 0) | (!last.visible ? 2 : 0) | (line.kind === "guide" ? 4 : 0));
    const writePoint = (point: LinePoint, index: number, role: "head" | "mid" | "tail") => {
      const shape = resolveLinePointShape(line.points, index);
      note({ ...point, lane: shape.lane }, role, shape.lane, shape.size);
    };
    writePoint(first, 0, "head"); writer.u32(easeNames.indexOf(first.ease.left)); writer.u32(0); writer.u32(first.critical ? 4 : 2);
    writer.u32(line.points.length - 2);
    line.points.slice(1, -1).forEach((point, index) => { writePoint(point, index + 1, "mid"); writer.u32(point.lane === "auto" ? 2 : point.visible ? 0 : 1); writer.u32(easeNames.indexOf(point.ease.left)); });
    writePoint(last, line.points.length - 1, "tail");
  });
  offsets.push(writer.position); writer.u32(0);
  offsets.push(writer.position); writer.u32(layers.length); layers.forEach(layer => writer.text(layer.name));
  offsets.push(writer.position); writer.u32(project.waypoints?.length ?? 0);
  project.waypoints?.forEach(point => { writer.text(point.name); writer.u32(point.tick); });
  offsets.forEach((offset, index) => writer.patch(offsetsAt + index * 4, offset));
  return writer.finish();
}
