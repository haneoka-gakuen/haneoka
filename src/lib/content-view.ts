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
const rowIdentity = (kind: VisibilityType, value: Record<string, unknown>, key?: string): string =>
  visibilityId(kind, value) || key || "";
const hasPublication = (value: Record<string, unknown>): boolean => Object.keys(publicationFields(value)).length > 0;
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
export function filterContentData(
  value: unknown,
  view: ContentView,
  resource?: string,
  previews = false,
  publications: Record<string, Record<string, unknown>> = {},
): FilteredContent {
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
      const publication = publications[`${kind}:${identity}`] ?? primary;
      if (!contentVisible(view, kind, publication, identity)) return { value: null, changed: true };
    }
  }
  let changed = false;
  const drop = Symbol();
  const walk = (
    node: unknown,
    inherited?: VisibilityType,
    key?: string,
    row = false,
    forceKind = false,
  ): unknown | typeof drop => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node))
      return node.flatMap((child) => {
        const result = walk(child, inherited, undefined, true, forceKind);
        return result === drop ? [] : [result];
      });
    let input = node as Record<string, unknown>;
    if (object(input.value) && typeof input.id === "string" && row) {
      const result = walk(input.value, inherited, input.id, true, forceKind);
      return result === drop ? drop : { ...input, value: result };
    }
    if (input.perServer && object(input.perServer) && input.resource) {
      const kind = visibilityType(String(input.resource));
      const perServer = Object.fromEntries(
        Object.entries(input.perServer).flatMap(([server, variant]) => {
          if (!object(variant) || !object(variant.row)) return [];
          const result = walk(variant.row, kind, String(variant.id), true, true);
          return result === drop
            ? []
            : [
                [
                  server,
                  { ...variant, row: result, ...(object(result) && result.__contentPreview ? { assets: {} } : {}) },
                ],
              ];
        }),
      );
      const servers = Object.keys(perServer);
      if (!servers.length) return drop;
      if (servers.length !== Object.keys(input.perServer).length) {
        changed = true;
        return {
          ...input,
          perServer,
          displayServer: servers.includes(String(input.displayServer)) ? input.displayServer : servers[0],
          sourceIds: servers,
          serverAvailability: Object.fromEntries(servers.map((server) => [server, true])),
          nameOverrides: {},
          nameFallbacks: [],
          content: { overrides: {}, supplements: [], fields: [] },
          variantGroups: servers.map((server) => [server]),
        };
      }
      return { ...input, perServer };
    }
    const inferred = inferredVisibilityType(input);
    const kind =
      inherited &&
      (forceKind ||
        key === "item" ||
        key === "row" ||
        key === "model" ||
        (node === value && (inferred || hasPublication(input))))
        ? inherited
        : (inferred ?? inherited);
    const identity = kind ? rowIdentity(kind, input, key) : "";
    const publication = kind && publications[`${kind}:${identity}`];
    if (publication) input = { ...input, ...publication };
    if (kind === "songs" && input.musicId !== undefined && Number(input.eventPublishedAt) > 0) {
      const { eventPublishedAt, ...song } = input;
      input = withEventSongRelease(song, { [String(input.musicId)]: Number(eventPublishedAt) });
    }
    if (kind && (row || hasPublication(input)) && !contentVisible(view, kind, input, identity)) {
      changed = true;
      const rule = view.policy.types[kind] ?? DEFAULT_VISIBILITY_RULE;
      if (previews && rule.restrictedDisplay === "unpublished" && view.spoilers) return contentPreview(input);
      return drop;
    }
    const ownKind = typeof input.resource === "string" ? visibilityType(input.resource) : kind;
    const output: Record<string, unknown> = {};
    for (const [field, child] of Object.entries(input)) {
      if (field === "catalogMetadata") {
        output[field] = child;
        continue;
      }
      const nextKind = contentFieldType(field) ?? ownKind;
      const collection = object(child) && !inferredVisibilityType(child) && !hasPublication(child);
      let result: unknown;
      if (collection && (contentFieldType(field) || ["entries", "items", "episodes", "chapters"].includes(field))) {
        result = Object.fromEntries(
          Object.entries(child).flatMap(([id, entry]) => {
            const item = walk(entry, nextKind, id, true, Boolean(nextKind));
            return item === drop ? [] : [[id, item]];
          }),
        );
      } else
        result = walk(
          child,
          nextKind,
          field,
          ["item", "row", "model"].includes(field),
          Boolean(contentFieldType(field)) || ["item", "row", "model"].includes(field),
        );
      if (result !== drop) output[field] = result;
    }
    return output;
  };
  const kind = resource && visibilityType(resource);
  const root =
    object(value) &&
    !inferredVisibilityType(value) &&
    !hasPublication(value) &&
    kind &&
    !value.schema &&
    !value.entries &&
    !value.items;
  const result = root
    ? Object.fromEntries(
        Object.entries(value).flatMap(([id, item]) => {
          const output = walk(item, kind, id, true, true);
          return output === drop ? [] : [[id, output]];
        }),
      )
    : walk(value, kind || undefined);
  return { value: result === drop ? null : result, changed };
}
