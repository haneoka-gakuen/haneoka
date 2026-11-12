// L3 — GEB
// Input: Resource data and the current rendering context.
// Output: Visibility decisions and compatible document data.
// Pos: [Map](L2-2.md); shared content presentation boundary.
// Effects/Dependencies: Preserves complete source data and selects the current representation.
import { withEventSongRelease } from "./event-song-release";
import { contentPublished, publicationFields } from "./content-publication";
import {
  DEFAULT_VISIBILITY_RULE,
  inferredVisibilityType,
  visibilityId,
  visibilityType,
  type ContentVisibilityPolicy,
  type VisibilityType,
} from "./content-visibility-policy";
import { isPublicReleaseServer } from "./temporary-public-routing";
import type { UserGroup } from "./user-roles";

export interface ContentView {
  policy: ContentVisibilityPolicy;
  group: UserGroup;
  spoilers: boolean;
  override: boolean;
  now: number;
}
export type ContentReference = { kind: VisibilityType; id: string; publication: Record<string, unknown> };
export { spoilerOverrideEnabled as explicitContentOverride } from "./spoiler-cookie";
export function contentVisible(view: ContentView, kind: VisibilityType, value: unknown, id = ""): boolean {
  if (contentPublished(value, view.now)) return true;
  const rule = view.policy.types[kind] ?? DEFAULT_VISIBILITY_RULE;
  if (view.override && rule.allowOverride) return true;
  if (!rule.groups.includes(view.group) || rule.hide.includes(id)) return false;
  if (rule.show.includes(id) || rule.mode === "visible") return true;
  return view.spoilers;
}
export function contentReference(kind: VisibilityType, value: Record<string, unknown>, id?: string): ContentReference {
  return { kind, id: id ?? visibilityId(kind, value), publication: publicationFields(value) };
}

const aliases: Record<string, string> = {
  episodes: "stories",
  chapters: "stories",
  storyEvents: "stories",
  homeSpots: "stories",
  supportCards: "support-cards",
  memberCards: "cards",
  members: "cards",
  snapshots: "support-cards",
  gameItems: "items",
  live2dModels: "live2d",
};
export function contentFieldType(field: string): VisibilityType | undefined {
  return visibilityType(aliases[field] ?? field);
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const hasPublication = (value: Record<string, unknown>): boolean => Object.keys(publicationFields(value)).length > 0;
const dependencyFields = new Set([
  "assets", "runtime", "commands", "resolvedSkills", "progression", "growth",
  "master", "masterData", "tables", "rules",
]);
const previewFields = new Set([
  "id",
  "_key",
  "key",
  "kind",
  "cardId",
  "supportCardId",
  "musicId",
  "songId",
  "storyId",
  "storyKey",
  "chapterId",
  "comicId",
  "stampId",
  "stickerId",
  "backgroundId",
  "bandItemId",
  "itemId",
  "characterId",
  "bandId",
  "live2dKey",
  "helpSubcategoryId",
  "tipId",
  "name",
  "title",
  "cardName",
  "prefix",
  "musicTitle",
  "characterName",
  "bandName",
  "image",
  "thumbnail",
  "thumbnailImage",
  "faceImage",
  "jacketUrl",
  "jacketThumbUrl",
  "rarity",
  "attribute",
  "type",
  "mode",
]);
/** Listing previews contain identity and artwork; detail and media reads use contentVisible. */
export function contentPreview(value: Record<string, unknown>): Record<string, unknown> {
  return {
    ...Object.fromEntries(Object.entries(value).filter(([key]) => previewFields.has(key))),
    ...(object(value.images) && value.images.thumbnail ? { images: { thumbnail: value.images.thumbnail } } : {}),
    ...publicationFields(value),
    __contentPreview: true,
  };
}
export interface FilteredContent {
  value: unknown;
  changed: boolean;
}
export type ContentPublicationsByServer = Record<string, Record<string, Record<string, unknown>>>;
export function filterContentData(
  value: unknown,
  view: ContentView,
  resource?: string,
  previews = false,
  publications: Record<string, Record<string, unknown>> = {},
  publicationsByServer?: ContentPublicationsByServer,
  omitted?: ContentReference[],
): FilteredContent {
  if (object(value) && (value.schema === "haneoka-team-builder-page-v1" || value.schema === "haneoka-team-builder-data-v1"))
    return { value, changed: false };
  const sourceServer = (node: Record<string, unknown>, inherited?: string): string | undefined => {
    if (!publicationsByServer) return inherited;
    const identity = object(node.identity) ? node.identity : undefined;
    return typeof identity?.server === "string" ? identity.server : typeof node.server === "string" ? node.server : inherited;
  };
  const own = object(value) ? ((object(value.identity) ? value.identity.server : undefined) ?? value.server) : undefined;
  const publicationFor = (key: string, server?: string): Record<string, unknown> | undefined =>
    publicationsByServer && server !== undefined ? publicationsByServer[server]?.[key] : publications[key];
  /**
   * Without the per-server registry, `publications` belong to the payload's own
   * server: a row from another source keeps its own dates and takes only the
   * fields it lacks.
   */
  const withPublication = (row: Record<string, unknown>, key: string, server?: string): Record<string, unknown> => {
    const publication = publicationFor(key, server);
    if (!publication) return row;
    const foreign = !publicationsByServer && server !== undefined && typeof own === "string" && server !== own;
    return foreign ? { ...publication, ...row } : { ...row, ...publication };
  };
  if (object(value)) {
    const identity = String(value.id ?? value.entityId ?? "");
    const episode = object(value.episodes) && object(value.episodes[identity]) ? value.episodes[identity] : undefined;
    const primary = object(value.item)
      ? value.item
      : object(value.model)
        ? value.model
        : (episode ?? (value.entityId && object(value.document) ? value.document : undefined));
    const kind = visibilityType(resource ?? String(value.resource ?? value.kind ?? (episode ? "stories" : "")));
    if (primary && kind && identity) {
      const publication = publicationFor(`${kind}:${identity}`, sourceServer(value)) ?? primary;
      if (!contentVisible(view, kind, publication, identity)) {
        omitted?.push(contentReference(kind, publication, identity));
        return { value: null, changed: true };
      }
    }
  }
  let changed = false;
  const drop = Symbol();
  const primaryFields = ["item", "row", "model"];
  // `songMeta` is keyed by music id, or by source and then music id in collection payloads.
  const fieldType = (field: string): VisibilityType | undefined =>
    field === "songMeta" ? "songs" : contentFieldType(field);
  /** A resource document that is a bare id → row map. */
  const rowMap = (node: Record<string, unknown>): boolean =>
    !inferredVisibilityType(node) &&
    !hasPublication(node) &&
    !node.schema &&
    !node.entries &&
    !node.items &&
    !Object.keys(node).some((field) => contentFieldType(field));
  const members = (
    node: Record<string, unknown>,
    kind: VisibilityType | undefined,
    server: string | undefined,
    keyed = true,
  ): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(node).flatMap(([id, entry]) => {
        const item = walk(entry, kind, keyed ? id : undefined, true, Boolean(kind), server);
        return item === drop ? [] : [[id, item]];
      }),
    );
  /**
   * `forceKind` marks an entity boundary: a member of a typed collection, a
   * primary `item`/`row`/`model`, or a cross-server variant row. Only such
   * boundaries and rows with their own identity fields are matched against the
   * publication registry; other nested objects answer for their own dates only.
   * `envelope` marks a resource document, whose `items`/`entries` hold rows of
   * that resource rather than game items.
   */
  const walk = (
    node: unknown,
    inherited?: VisibilityType,
    key?: string,
    row = false,
    forceKind = false,
    inheritedServer?: string,
    envelope = false,
  ): unknown | typeof drop => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node))
      return node.flatMap((child) => {
        const result = walk(child, inherited, undefined, true, forceKind, inheritedServer);
        return result === drop ? [] : [result];
      });
    let input = node as Record<string, unknown>;
    if (input.schema === "haneoka-team-builder-page-v1" || input.schema === "haneoka-team-builder-data-v1") return input;
    const server = sourceServer(input,
      publicationsByServer && key && Object.hasOwn(publicationsByServer, key) ? key : inheritedServer);
    if (object(input.value) && typeof input.id === "string" && row) {
      const result = walk(input.value, inherited, input.id, true, forceKind, server);
      return result === drop ? drop : { ...input, value: result };
    }
    if (input.perServer && object(input.perServer) && input.resource) return crossServer(input);
    if (envelope && inherited && rowMap(input) && Object.values(input).every(object))
      return members(input, inherited, server);
    const inferred = inferredVisibilityType(input);
    const boundary = forceKind || primaryFields.includes(key ?? "") || (node === value && hasPublication(input));
    const kind = inherited && (boundary || (node === value && inferred)) ? inherited : (inferred ?? inherited);
    const entity = Boolean(kind) && (boundary || inferred !== undefined);
    const identity = kind && entity
      ? visibilityId(kind, input) || (forceKind && key !== undefined && !primaryFields.includes(key) ? key : "")
      : "";
    if (entity && identity) input = withPublication(input, `${kind}:${identity}`, server);
    if (kind === "songs" && input.musicId !== undefined && Number(input.eventPublishedAt) > 0) {
      const { eventPublishedAt, ...song } = input;
      input = withEventSongRelease(song, { [String(input.musicId)]: Number(eventPublishedAt) });
    }
    if (kind && entity && !contentVisible(view, kind, input, identity)) {
      changed = true;
      omitted?.push(contentReference(kind, input, identity));
      const rule = view.policy.types[kind] ?? DEFAULT_VISIBILITY_RULE;
      if (previews && rule.restrictedDisplay === "unpublished" && view.spoilers) return contentPreview(input);
      return drop;
    }
    const ownKind = typeof input.resource === "string" ? visibilityType(input.resource) : kind;
    const document = envelope || node === value || typeof input.schema === "string" || typeof input.resource === "string";
    const output: Record<string, unknown> = {};
    for (const [field, child] of Object.entries(input)) {
      if (field === "catalogMetadata" || dependencyFields.has(field)) {
        output[field] = child;
        continue;
      }
      // Cross-server catalogues key `documents` by source; team-builder keys them by resource.
      if (field === "documents" && object(child) && !Object.keys(child).some((source) => contentFieldType(source))) {
        output[field] = Object.fromEntries(
          Object.entries(child).flatMap(([source, entry]) => {
            const result = walk(entry, ownKind, source, false, false, server, true);
            return result === drop ? [] : [[source, result]];
          }),
        );
        continue;
      }
      const typed = document && (field === "items" || field === "entries") ? undefined : fieldType(field);
      const nextKind = typed ?? ownKind;
      const nested = object(child) && typeof child.schema === "string";
      const collection = object(child) && !nested && !inferredVisibilityType(child) && !hasPublication(child);
      let result: unknown;
      if (collection && (typed || ["entries", "items", "episodes", "chapters"].includes(field))) {
        const sources = Object.keys(child);
        // A source-keyed collection holds one map per server; chapter keys are chapter ids, not story ids.
        result =
          typed && sources.length && sources.every(isPublicReleaseServer) && Object.values(child).every(object)
            ? Object.fromEntries(
                sources.map((source) => [
                  source,
                  members(child[source] as Record<string, unknown>, nextKind, source),
                ]),
              )
            : members(child, nextKind, server, field !== "chapters");
      } else
        result = walk(
          child,
          nextKind,
          field,
          primaryFields.includes(field),
          !nested && (Boolean(typed) || primaryFields.includes(field)),
          server,
          field === "document",
        );
      if (result !== drop) output[field] = result;
    }
    return output;
  };
  /**
   * Cross-server catalogue entries and details. Every copy of a variant row —
   * `perServer`, the detail `row` and `ownershipVariant` — is filtered against
   * its own server; hidden variants leave the entry together with the peer
   * names and content merged from them.
   */
  const crossServer = (input: Record<string, unknown>): unknown | typeof drop => {
    const kind = visibilityType(String(input.resource));
    const variants = input.perServer as Record<string, unknown>;
    const perServer: Record<string, Record<string, unknown>> = {};
    for (const [server, variant] of Object.entries(variants)) {
      if (!object(variant) || !object(variant.row)) continue;
      const result = walk(variant.row, kind, String(variant.id), true, true, server);
      if (result !== drop)
        perServer[server] = { ...variant, row: result, ...(object(result) && result.__contentPreview ? { assets: {} } : {}) };
    }
    const servers = Object.keys(perServer);
    if (!servers.length) return drop;
    const removed = servers.length !== Object.keys(variants).length;
    const output: Record<string, unknown> = { ...input, perServer };
    if (removed) {
      changed = true;
      const reset: Record<string, unknown> = {
        displayServer: servers.includes(String(input.displayServer)) ? input.displayServer : servers[0],
        inSelectedServer: servers.includes(String(input.selectedServer)),
        sourceIds: servers,
        serverAvailability: Object.fromEntries(servers.map((server) => [server, true])),
        nameOverrides: {},
        nameFallbacks: [],
        content: { overrides: {}, supplements: [], fields: [] },
        variantGroups: servers.map((server) => [server]),
      };
      for (const [field, next] of Object.entries(reset)) if (Object.hasOwn(input, field)) output[field] = next;
    }
    if (object(input.row)) {
      const identity = object(input.identity) ? input.identity : {};
      const active = perServer[String(input.activeServer ?? identity.server)];
      if (!active) return drop;
      const row = removed ? active.row : walk(input.row, kind, String(active.id), true, true, String(input.activeServer ?? identity.server));
      if (row === drop) return drop;
      output.row = row;
    }
    if (object(input.ownershipVariant)) {
      const identity = object(input.ownershipVariant.identity) ? input.ownershipVariant.identity : {};
      output.ownershipVariant = perServer[String(identity.server)] ?? null;
    }
    return output;
  };
  const kind = resource && visibilityType(resource);
  const result =
    object(value) && kind && rowMap(value)
      ? members(value, kind, sourceServer(value))
      : walk(value, kind || undefined, undefined, false, Array.isArray(value) && Boolean(kind));
  return { value: result === drop ? null : result, changed };
}
