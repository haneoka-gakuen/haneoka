import { createProjectId, createEmptyProject, structuredCloneValue, type Project, type JsonValue } from "../model";
import { assertValidProject } from "../validation";

export const COLLECTIONS_KEY = "authoringCollections";
export interface AuthorGroup {
  id: string;
  name: string;
  forceNoteSpeed?: number;
}
/** Editor visibility is independent of authored note.visible and of game judgement. */
export interface AuthorLayer {
  id: string;
  name: string;
  visible: boolean;
}
export interface AuthorMembership {
  groupId?: string;
  layerId?: string;
  source?: { contextId: string; entityId: string };
}
export interface AuthorCollections {
  schema: "haneoka.authoring.collections";
  version: 1;
  groups: AuthorGroup[];
  layers: AuthorLayer[];
  members: Record<string, AuthorMembership>;
  sourceContexts: Record<string, JsonValue>;
}
export type CollectionKind = "group" | "layer";
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function entityIds(project: Project): Set<string> {
  return new Set([
    ...project.singles.map((n) => n.id),
    ...project.lines.flatMap((l) => [l.id, ...l.points.map((p) => p.id)]),
    ...project.tempos.map((n) => n.id),
    ...project.meters.map((n) => n.id),
    ...project.timeScales.map((n) => n.id),
  ]);
}
/** Reconcile only an editor transaction from a previously valid document, never a corrupt import. */
export function reconcileAuthorEdit(before: Project, after: Project): Project {
  readAuthorCollections(before);
  if (after.extensions[COLLECTIONS_KEY] === undefined) return after;
  const result = structuredCloneValue(after),
    state = result.extensions[COLLECTIONS_KEY];
  if (!record(state) || !record(state.members)) throw new Error("invalid_authoring_collections");
  const previous = entityIds(before),
    current = entityIds(after);
  for (const id of Object.keys(state.members)) if (previous.has(id) && !current.has(id)) delete state.members[id];
  readAuthorCollections(result);
  return result;
}
export function authorEntityIds(project: Project) {
  return entityIds(project);
}
function text(value: unknown): value is string {
  return typeof value === "string" && !/[\u0000-\u001f\u007f]/u.test(value);
}
export function readAuthorCollections(project: Project): AuthorCollections {
  const value = project.extensions[COLLECTIONS_KEY];
  if (value === undefined)
    return {
      schema: "haneoka.authoring.collections",
      version: 1,
      groups: [],
      layers: [],
      members: {},
      sourceContexts: {},
    };
  if (
    !record(value) ||
    value.schema !== "haneoka.authoring.collections" ||
    value.version !== 1 ||
    !Array.isArray(value.groups) ||
    !Array.isArray(value.layers) ||
    !record(value.members) ||
    !record(value.sourceContexts)
  )
    throw new Error("invalid_authoring_collections");
  const groups = value.groups as unknown as AuthorGroup[],
    layers = value.layers as unknown as AuthorLayer[];
  const seen = new Set<string>();
  for (const item of [...groups, ...layers]) {
    if (!record(item) || !text(item.id) || !item.id || seen.has(item.id) || !text(item.name))
      throw new Error("invalid_authoring_collection");
    seen.add(item.id);
  }
  for (const group of groups)
    if (group.forceNoteSpeed !== undefined && (!Number.isFinite(group.forceNoteSpeed) || group.forceNoteSpeed <= 0))
      throw new Error("invalid_group_speed");
  for (const layer of layers) if (typeof layer.visible !== "boolean") throw new Error("invalid_layer_visibility");
  const ids = entityIds(project),
    groupIds = new Set(groups.map((g) => g.id)),
    layerIds = new Set(layers.map((l) => l.id));
  for (const [id, member] of Object.entries(value.members)) {
    if (
      !ids.has(id) ||
      !record(member) ||
      (member.groupId !== undefined && !groupIds.has(member.groupId as string)) ||
      (member.layerId !== undefined && !layerIds.has(member.layerId as string))
    )
      throw new Error("invalid_authoring_membership");
    if (
      member.source !== undefined &&
      (!record(member.source) ||
        !text(member.source.contextId) ||
        !text(member.source.entityId) ||
        !Object.hasOwn(value.sourceContexts, member.source.contextId))
    )
      throw new Error("invalid_authoring_source");
  }
  return structuredCloneValue(value) as unknown as AuthorCollections;
}
function write(project: Project, state: AuthorCollections): Project {
  const result = structuredCloneValue(project);
  result.extensions[COLLECTIONS_KEY] = structuredCloneValue(state) as unknown as JsonValue;
  assertValidProject(result);
  readAuthorCollections(result);
  return result;
}
/** Collection assignment keeps complete connector ownership, including every point. */
export function expandAuthorSelection(project: Project, selection: ReadonlySet<string>): Set<string> {
  const known = entityIds(project),
    result = new Set([...selection].filter((id) => known.has(id)));
  const collections = readAuthorCollections(project);
  for (const [id, member] of Object.entries(collections.members))
    if ((member.groupId && selection.has(member.groupId)) || (member.layerId && selection.has(member.layerId)))
      result.add(id);
  for (const line of project.lines)
    if (result.has(line.id) || line.points.some((point) => result.has(point.id))) {
      result.add(line.id);
      for (const point of line.points) result.add(point.id);
    }
  return result;
}
export function createAuthorCollection(
  project: Project,
  kind: CollectionKind,
  name: string,
  options: { forceNoteSpeed?: number; visible?: boolean } = {},
) {
  const state = readAuthorCollections(project),
    id = createProjectId(kind);
  if (kind === "group")
    state.groups.push({
      id,
      name,
      ...(options.forceNoteSpeed === undefined ? {} : { forceNoteSpeed: options.forceNoteSpeed }),
    });
  else state.layers.push({ id, name, visible: options.visible ?? true });
  return { project: write(project, state), id };
}
export function renameAuthorCollection(project: Project, kind: CollectionKind, id: string, name: string): Project {
  const state = readAuthorCollections(project),
    item = (kind === "group" ? state.groups : state.layers).find((item) => item.id === id);
  if (!item) throw new Error("collection_missing");
  item.name = name;
  return write(project, state);
}
export function reorderAuthorCollection(project: Project, kind: CollectionKind, id: string, index: number): Project {
  const state = readAuthorCollections(project),
    items = kind === "group" ? state.groups : state.layers;
  const previous = items.findIndex((item) => item.id === id);
  if (previous < 0) throw new Error("collection_missing");
  if (!Number.isSafeInteger(index) || index < 0 || index >= items.length) throw new Error("invalid_collection_order");
  const [item] = items.splice(previous, 1);
  items.splice(index, 0, item!);
  return write(project, state);
}
export function setAuthorGroupSpeed(project: Project, id: string, speed: number | null): Project {
  const state = readAuthorCollections(project),
    group = state.groups.find((group) => group.id === id);
  if (!group) throw new Error("group_missing");
  if (speed === null) delete group.forceNoteSpeed;
  else group.forceNoteSpeed = speed;
  return write(project, state);
}
export function cycleAuthorCollection(
  project: Project,
  kind: CollectionKind,
  current: string | undefined,
  step: -1 | 1,
): string | undefined {
  const state = readAuthorCollections(project),
    ids = (kind === "group" ? state.groups : state.layers).map((item) => item.id);
  const index = current === undefined ? -1 : ids.indexOf(current);
  if (index < 0) return step === 1 ? ids[0] : ids.at(-1);
  return ids[index + step];
}
export function setAuthorLayerVisibility(project: Project, id: string, visible: boolean): Project {
  const state = readAuthorCollections(project),
    layer = state.layers.find((layer) => layer.id === id);
  if (!layer) throw new Error("layer_missing");
  layer.visible = visible;
  return write(project, state);
}
export function assignAuthorSelection(
  project: Project,
  selection: ReadonlySet<string>,
  assignment: { groupId?: string | null; layerId?: string | null },
): Project {
  const state = readAuthorCollections(project);
  if (assignment.groupId != null && !state.groups.some((g) => g.id === assignment.groupId))
    throw new Error("group_missing");
  if (assignment.layerId != null && !state.layers.some((l) => l.id === assignment.layerId))
    throw new Error("layer_missing");
  for (const id of expandAuthorSelection(project, selection)) {
    const member = Object.hasOwn(state.members, id) ? state.members[id]! : {};
    if (assignment.groupId !== undefined) {
      if (assignment.groupId === null) delete member.groupId;
      else member.groupId = assignment.groupId;
    }
    if (assignment.layerId !== undefined) {
      if (assignment.layerId === null) delete member.layerId;
      else member.layerId = assignment.layerId;
    }
    if (Object.keys(member).length)
      Object.defineProperty(state.members, id, { value: member, writable: true, enumerable: true, configurable: true });
    else delete state.members[id];
  }
  return write(project, state);
}
export function ungroupAuthorSelection(project: Project, selection: ReadonlySet<string>): Project {
  return assignAuthorSelection(project, selection, { groupId: null });
}
/** Explicit deletion policy distinguishes ungrouping from Next's remove-members command. */
export function deleteAuthorCollection(
  project: Project,
  kind: CollectionKind,
  id: string,
  members: "detach" | "delete",
): Project {
  const state = readAuthorCollections(project);
  if (!(kind === "group" ? state.groups : state.layers).some((item) => item.id === id))
    throw new Error("collection_missing");
  const memberKey = kind === "group" ? "groupId" : "layerId",
    affected = new Set(
      Object.entries(state.members)
        .filter(([, m]) => m[memberKey] === id)
        .map(([id]) => id),
    );
  const removed = members === "delete" ? expandAuthorSelection(project, affected) : new Set<string>();
  const result = structuredCloneValue(project);
  if (members === "delete") {
    // Never remove the tempo origin or all meters: global time still needs a valid map.
    if (result.tempos.some((t) => removed.has(t.id) && t.tick === 0) || result.meters.every((m) => removed.has(m.id)))
      throw new Error("protected_timing_origin");
    result.singles = result.singles.filter((n) => !removed.has(n.id));
    result.lines = result.lines.filter((l) => !removed.has(l.id));
    result.timeScales = result.timeScales.filter((n) => !removed.has(n.id));
    result.tempos = result.tempos.filter((n) => !removed.has(n.id));
    result.meters = result.meters.filter((n) => !removed.has(n.id));
    if (result.sourceOrder) result.sourceOrder = result.sourceOrder.filter((id) => !removed.has(id));
    for (const extension of Object.values(result.extensions))
      if (record(extension) && record(extension.records))
        for (const removedId of removed) delete extension.records[removedId];
  }
  for (const [entity, member] of Object.entries(state.members)) {
    if (removed.has(entity)) {
      delete state.members[entity];
      continue;
    }
    if (member[memberKey] === id) delete member[memberKey];
    if (!Object.keys(member).length) delete state.members[entity];
  }
  if (kind === "group") state.groups = state.groups.filter((g) => g.id !== id);
  else state.layers = state.layers.filter((l) => l.id !== id);
  return write(result, state);
}
export function authorSelectionForScope(
  project: Project,
  scope: { groupId?: string; layerId?: string; includeHidden?: boolean } = {},
): Set<string> {
  const state = readAuthorCollections(project),
    hidden = new Set(state.layers.filter((layer) => !layer.visible).map((layer) => layer.id));
  return new Set(
    [...entityIds(project)].filter((id) => {
      const member = Object.hasOwn(state.members, id) ? state.members[id] : undefined;
      return (
        (!scope.groupId || member?.groupId === scope.groupId) &&
        (!scope.layerId || member?.layerId === scope.layerId) &&
        (scope.includeHidden || !member?.layerId || !hidden.has(member.layerId))
      );
    }),
  );
}

export interface AuthorClipboard {
  schema: "haneoka.authoring.clipboard";
  version: 1;
  laneBasis: number;
  resolution: number;
  sourceFormat?: string;
  entities: Pick<Project, "singles" | "lines" | "tempos" | "meters" | "timeScales">;
  sourceOrder: string[];
  collections: AuthorCollections;
  sourceExtensions: Record<string, JsonValue>;
}
export function copyAuthorSelection(project: Project, selection: ReadonlySet<string>): AuthorClipboard {
  const ids = expandAuthorSelection(project, selection),
    all = readAuthorCollections(project);
  const groups = new Set(all.groups.filter((group) => selection.has(group.id)).map((group) => group.id)),
    layers = new Set(all.layers.filter((layer) => selection.has(layer.id)).map((layer) => layer.id)),
    members: AuthorCollections["members"] = {};
  for (const id of ids) {
    const member = Object.hasOwn(all.members, id) ? all.members[id] : undefined;
    if (!member) continue;
    Object.defineProperty(members, id, {
      value: structuredCloneValue(member),
      writable: true,
      enumerable: true,
      configurable: true,
    });
    if (member.groupId) groups.add(member.groupId);
    if (member.layerId) layers.add(member.layerId);
  }
  const contexts = new Set(Object.values(members).flatMap((m) => (m.source ? [m.source.contextId] : [])));
  for (const id of contexts) {
    const context = all.sourceContexts[id];
    if (record(context) && Array.isArray(context.parents))
      for (const parent of context.parents) if (typeof parent === "string") contexts.add(parent);
  }
  return structuredCloneValue({
    schema: "haneoka.authoring.clipboard",
    version: 1,
    laneBasis: project.laneBasis,
    resolution: project.resolution,
    sourceFormat: project.meta.source ?? "authored",
    entities: {
      singles: project.singles.filter((n) => ids.has(n.id)),
      lines: project.lines.filter((l) => ids.has(l.id)),
      tempos: project.tempos.filter((n) => ids.has(n.id)),
      meters: project.meters.filter((n) => ids.has(n.id)),
      timeScales: project.timeScales.filter((n) => ids.has(n.id)),
    },
    sourceOrder: (
      project.sourceOrder ?? [...project.singles.map((n) => n.id), ...project.lines.map((l) => l.id)]
    ).filter((id) => ids.has(id)),
    collections: {
      ...all,
      groups: all.groups.filter((g) => groups.has(g.id)),
      layers: all.layers.filter((l) => layers.has(l.id)),
      members,
      sourceContexts: Object.fromEntries(Object.entries(all.sourceContexts).filter(([id]) => contexts.has(id))),
    },
    sourceExtensions: Object.fromEntries(Object.entries(project.extensions).filter(([key]) => key !== COLLECTIONS_KEY)),
  } as AuthorClipboard);
}
export function pasteAuthorSelection(project: Project, clipboard: AuthorClipboard, tick: number) {
  if (
    clipboard.schema !== "haneoka.authoring.clipboard" ||
    clipboard.version !== 1 ||
    !Number.isSafeInteger(tick) ||
    tick < 0
  )
    throw new Error("invalid_authoring_clipboard");
  if (clipboard.resolution !== project.resolution || !Number.isFinite(clipboard.laneBasis) || clipboard.laneBasis <= 0)
    throw new Error("clipboard_basis_conversion_required");
  if (clipboard.laneBasis !== project.laneBasis) {
    const ratio = project.laneBasis / clipboard.laneBasis;
    clipboard = structuredCloneValue(clipboard);
    for (const note of [...clipboard.entities.singles, ...clipboard.entities.lines.flatMap((line) => line.points)]) {
      if (typeof note.lane === "number") note.lane *= ratio;
      note.size *= ratio;
      if ("ease" in note) {
        delete note.resolvedLane;
        delete note.resolvedSize;
      }
    }
    clipboard.laneBasis = project.laneBasis;
  }
  const carrier = createEmptyProject();
  carrier.laneBasis = clipboard.laneBasis;
  carrier.singles = structuredCloneValue(clipboard.entities.singles);
  carrier.lines = structuredCloneValue(clipboard.entities.lines);
  carrier.timeScales = structuredCloneValue(clipboard.entities.timeScales);
  carrier.tempos = structuredCloneValue(clipboard.entities.tempos);
  if (!carrier.tempos.some((item) => item.tick === 0))
    carrier.tempos.push({ id: createProjectId("clipboard-origin"), tick: 0, bpm: 120 });
  carrier.meters = clipboard.entities.meters.length ? structuredCloneValue(clipboard.entities.meters) : carrier.meters;
  carrier.extensions[COLLECTIONS_KEY] = structuredCloneValue(clipboard.collections) as unknown as JsonValue;
  assertValidProject(carrier);
  readAuthorCollections(carrier);
  const result = structuredCloneValue(project),
    state = readAuthorCollections(project),
    idMap: Record<string, string> = Object.create(null),
    groupMap: Record<string, string> = Object.create(null),
    layerMap: Record<string, string> = Object.create(null);
  const foreignSource =
    (clipboard.sourceFormat && !["ss", "authored"].includes(clipboard.sourceFormat)) ||
    record(clipboard.sourceExtensions.bestdoriSource);
  if (
    foreignSource &&
    (clipboard.entities.singles.length || clipboard.entities.lines.length) &&
    (!result.meta.source || ["ss", "authored"].includes(result.meta.source))
  ) {
    result.meta.extra = {
      ...result.meta.extra,
      sourceFormats: [result.meta.source ?? "authored", clipboard.sourceFormat ?? "bestdori"],
    };
    result.meta.source = "mixed";
  }
  for (const group of clipboard.collections.groups) {
    const id = createProjectId("group");
    groupMap[group.id] = id;
    state.groups.push({ ...structuredCloneValue(group), id });
  }
  for (const layer of clipboard.collections.layers) {
    const id = createProjectId("layer");
    layerMap[layer.id] = id;
    state.layers.push({ ...structuredCloneValue(layer), id });
  }
  const incoming = structuredCloneValue(clipboard.entities),
    all = [
      ...incoming.singles,
      ...incoming.lines.flatMap((l) => l.points),
      ...incoming.tempos,
      ...incoming.meters,
      ...incoming.timeScales,
    ];
  if (!all.length) return { project: write(result, state), ids: [], idMap, groupMap, layerMap };
  const first = Math.min(...all.map((n) => n.tick)),
    delta = tick - first;
  for (const line of incoming.lines) {
    idMap[line.id] = createProjectId("line");
    line.id = idMap[line.id]!;
  }
  for (const entity of all) {
    const old = entity.id,
      id = createProjectId("item");
    idMap[old] = id;
    entity.id = id;
    entity.tick += delta;
    if (!Number.isSafeInteger(entity.tick)) throw new Error("clipboard_tick_overflow");
  }
  if (
    incoming.tempos.some((t) => result.tempos.some((existing) => existing.tick === t.tick)) ||
    incoming.meters.some((m) => result.meters.some((existing) => existing.tick === m.tick))
  )
    throw new Error("clipboard_timing_collision");
  result.singles.push(...incoming.singles);
  result.lines.push(...incoming.lines);
  result.tempos.push(...incoming.tempos);
  result.meters.push(...incoming.meters);
  result.timeScales.push(...incoming.timeScales);
  const contextId = createProjectId("source");
  for (const [id, context] of Object.entries(clipboard.collections.sourceContexts)) {
    if (Object.hasOwn(state.sourceContexts, id) && JSON.stringify(state.sourceContexts[id]) !== JSON.stringify(context))
      throw new Error("clipboard_source_context_conflict");
    Object.defineProperty(state.sourceContexts, id, {
      value: structuredCloneValue(context),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  state.sourceContexts[contextId] = {
    sourceExtensions: structuredCloneValue(clipboard.sourceExtensions),
    parents: [
      ...new Set(
        Object.values(clipboard.collections.members).flatMap((member) =>
          member.source ? [member.source.contextId] : [],
        ),
      ),
    ],
  };
  for (const [old, id] of Object.entries(idMap)) {
    const member = Object.hasOwn(clipboard.collections.members, old) ? clipboard.collections.members[old]! : {};
    state.members[id] = {
      ...(member.groupId ? { groupId: groupMap[member.groupId] } : {}),
      ...(member.layerId ? { layerId: layerMap[member.layerId] } : {}),
      source: { contextId, entityId: old },
    };
  }
  // T12's id-indexed format SourceRecord dictionaries migrate, not just geometry.
  for (const [key, value] of Object.entries(clipboard.sourceExtensions)) {
    if (key === COLLECTIONS_KEY || !record(value) || !record(value.records)) continue;
    const target = record(result.extensions[key])
      ? (structuredCloneValue(result.extensions[key]) as Record<string, JsonValue>)
      : (Object.fromEntries(Object.entries(value).filter(([key]) => key === "schema")) as Record<string, JsonValue>);
    const records = record(target.records) ? (target.records as Record<string, JsonValue>) : {};
    for (const [old, id] of Object.entries(idMap))
      if (Object.hasOwn(value.records, old))
        Object.defineProperty(records, id, {
          value: structuredCloneValue(value.records[old]) as JsonValue,
          writable: true,
          enumerable: true,
          configurable: true,
        });
    target.records = records;
    result.extensions[key] = target;
  }
  const order = result.sourceOrder ?? [...project.singles.map((n) => n.id), ...project.lines.map((l) => l.id)];
  result.sourceOrder = [...order, ...clipboard.sourceOrder.map((id) => idMap[id]).filter((id): id is string => !!id)];
  const candidate = write(result, state);
  return { project: candidate, ids: Object.values(idMap), idMap, groupMap, layerMap };
}
