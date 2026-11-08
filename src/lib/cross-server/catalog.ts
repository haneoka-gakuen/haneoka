/** Browse-only associations. Inventory, progression and scoring keep their own server identity. */
import { eventStoryStarts, withEventStart } from "../content-publication";
import { sharedEventStoryContent } from "./events";
import { exclusiveCatalogServer } from "./availability";
import { crossCatalogDefinition, crossCatalogRowId, type CrossCatalogDocument } from "./definitions";
import type { CrossCatalogResource } from "./definitions";
import { CONTENT_SOURCE_IDS, isContentSourceId } from "../content-access-state";
import { sourceVariantGroups, visibleSourceVariants, isFormalCatalogSource, semanticOwnerKey, semanticOwnersConflict, preferredCatalogVariant } from "./content";
export type { CrossCatalogResource } from "./definitions";
export const OFFICIAL_CATALOG_SERVERS = CONTENT_SOURCE_IDS;
export type OfficialCatalogServer = string;
export type CrossCatalogRow = Record<string, unknown>;
export interface CrossCatalogIdentity {
  server: OfficialCatalogServer;
  releaseId: string;
  sourceId: string;
}
export interface CrossCatalogSnapshot {
  identity: CrossCatalogIdentity;
  /** An absent collection is unknown, while an observed empty object is complete. */
  collections: Partial<Record<CrossCatalogResource, Record<string, CrossCatalogRow>>>;
  documents?: Partial<Record<CrossCatalogResource, CrossCatalogDocument>>;
}
export interface CrossCatalogVariant {
  identity: CrossCatalogIdentity;
  id: string;
  row: CrossCatalogRow;
  /** Present in this current catalogue; gameplay entitlement is not inferred. */
  available: true;
  releasedAt: unknown;
  href: string | null;
  assets: CrossCatalogRow;
}
export interface CrossCatalogEntry {
  key: string;
  resource: CrossCatalogResource;
  selectedServer: OfficialCatalogServer;
  displayServer: OfficialCatalogServer;
  inSelectedServer: boolean;
  perServer: Partial<Record<OfficialCatalogServer, CrossCatalogVariant>>;
  serverAvailability: Partial<Record<OfficialCatalogServer, boolean>>;
  exclusive: OfficialCatalogServer | null;
  association: { status: "verified" | "independent" | "ambiguous"; evidence: string[]; reason?: string };
  /** Only entity-name slots may cross an established association. */
  nameOverrides: CrossCatalogRow;
  nameFallbacks: { field: string; slot: number; fromServer: OfficialCatalogServer }[];
  content: CrossServerContent;
  sourceIds: OfficialCatalogServer[];
  /** Summary equality is presentation metadata, not entity or asset-byte identity. */
  variantGroups: OfficialCatalogServer[][];
}
export interface CrossServerContent {
  overrides: CrossCatalogRow;
  supplements: {
    field: string; value: unknown; fromServer: OfficialCatalogServer;
    identity: CrossCatalogIdentity; href: string | null;
    classification: "same-text-edition" | "recording-credit" | "source-asset" | "foreign-variant-content";
  }[];
  fields: { field: string; classification: "same-text-edition" | "recording-credit" | "source-asset" | "different-edition" | "server-variant" }[];
}
export interface CrossCatalogDTO {
  schema: "haneoka-cross-server-catalog-v1";
  resource: CrossCatalogResource;
  selectedServer: OfficialCatalogServer;
  locale: string;
  identities: Partial<Record<OfficialCatalogServer, CrossCatalogIdentity>>;
  sourceAvailability: Partial<Record<OfficialCatalogServer, "loaded" | "unavailable">>;
  entries: CrossCatalogEntry[];
  documents: Partial<Record<OfficialCatalogServer, CrossCatalogDocument>>;
}
const object = (value: unknown): CrossCatalogRow =>
  value && typeof value === "object" && !Array.isArray(value) ? value as CrossCatalogRow : {};
const text = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
};
const japanese = (value: unknown) => Array.isArray(value) ? text(value[0]) : null;
type Signature = { key: string; evidence: string[] };
const signature = (parts: unknown[], evidence: string[]): Signature => ({ key: JSON.stringify(parts), evidence });
/** Official catalogue maps use original IDs within their resource namespace. */
function entitySignature(resource: CrossCatalogResource, row: CrossCatalogRow, id: string, server: OfficialCatalogServer): Signature | null {
  if (isFormalCatalogSource(server))
    return signature(["original-entity-id", resource, id], ["original-entity-id", "resource-namespace"]);
  if (crossCatalogDefinition(resource).opaque) {
    if (!id || id.length > 256 || /[\\/\u0000-\u001f\u007f]/u.test(id) || id === "." || id === "..") return null;
  } else if (!/^[1-9]\d*$/u.test(id) || !Number.isSafeInteger(Number(id))) return null;
  if (resource === "events") {
    const raw = object(row.raw);
    const fromMaster = row.sourceTable === "MasterEvent" ||
      (Array.isArray(row.sourceTables) && row.sourceTables.includes("MasterEvent"));
    if (row.kind !== "game-event" || !fromMaster ||
        (raw._id !== undefined && String(raw._id) !== id)) return null;
  }
  const owner = semanticOwnerKey(row, resource);
  if (owner === undefined) return null;
  return signature(["original-entity-id", resource, id, owner],
    ["original-entity-id", "resource-namespace", "native-owner-fields", ...(resource === "events" ? ["native-MasterEvent-kind-and-id"] : [])]);
}

const NAME_FIELDS = ["prefix", "cardName", "musicTitle", "characterName", "bandName", "title", "name"];
function nameFallbacks(primary: CrossCatalogVariant, peer?: CrossCatalogVariant) {
  const overrides: CrossCatalogRow = {}, provenance: CrossCatalogEntry["nameFallbacks"] = [];
  if (peer) for (const field of NAME_FIELDS) {
    const value = primary.row[field], other = peer.row[field];
    if (!Array.isArray(value) || !Array.isArray(other)) continue;
    const slots = [...value];
    for (let slot = 0; slot < Math.min(5, other.length); slot++) {
      if (text(slots[slot]) || !text(other[slot])) continue;
      slots[slot] = other[slot];
      provenance.push({ field, slot, fromServer: peer.identity.server });
    }
    if (provenance.some((entry) => entry.field === field)) overrides[field] = slots;
  }
  return { overrides, provenance };
}
const EDITORIAL_TEXT_FIELDS = ["englishName", "nickname", "voiceActor", "description", "catchCopy", "height", "constellation",
  "school", "schoolClass", "favoriteFood", "hatedFood", "hobby", "diary", "composer", "lyricist", "arranger", "artistName"];
const MEDIA_FIELDS = ["image", "backgroundImage", "logo", "icon", "profileImage", "faceImage", "spriteImage", "thumbnailImage", "jacketUrl", "jacketThumbUrl"];
function sharedContent(resource: CrossCatalogResource, primary: CrossCatalogVariant, peer?: CrossCatalogVariant): CrossServerContent {
  const result: CrossServerContent = { overrides: {}, supplements: [], fields: [] };
  if (!peer) return result;
  if (resource === "events") {
    const story = sharedEventStoryContent(primary, peer, japanese);
    Object.assign(result.overrides, story.overrides);
    result.fields.push(...story.fields); result.supplements.push(...story.supplements);
  }
  const supplement = (field: string, value: unknown, classification: CrossServerContent["supplements"][number]["classification"]) =>
    result.supplements.push({ field, value: structuredClone(value), fromServer: peer.identity.server,
      identity: { ...peer.identity }, href: peer.href, classification });
  for (const field of EDITORIAL_TEXT_FIELDS) {
    const own = primary.row[field], other = peer.row[field];
    if (!Array.isArray(other)) continue;
    const ownJP = japanese(own), otherJP = japanese(other);
    const recordingCredit = resource === "songs" && ["composer", "lyricist", "arranger", "artistName"].includes(field);
    const sameEdition = !!ownJP && ownJP === otherJP;
    const classification = sameEdition ? "same-text-edition" : recordingCredit && !ownJP ? "recording-credit" : "different-edition";
    result.fields.push({ field, classification });
    if (classification === "different-edition") {
      if (other.some((slot) => text(slot))) supplement(field, other, "foreign-variant-content");
      continue;
    }
    const slots = Array.isArray(own) ? [...own] : [];
    let changed = false;
    for (let slot = 0; slot < Math.min(5, other.length); slot++) {
      if (text(slots[slot]) || !text(other[slot])) continue;
      slots[slot] = other[slot]; changed = true;
    }
    if (changed) {
      result.overrides[field] = slots;
      supplement(field, slots, classification);
    }
  }
  for (const field of MEDIA_FIELDS) {
    if (typeof peer.row[field] !== "string" || !peer.row[field]) continue;
    result.fields.push({ field, classification: "source-asset" });
    if (!primary.row[field]) {
      result.overrides[field] = peer.row[field];
      supplement(field, peer.row[field], "source-asset");
    }
  }
  const images = object(primary.row.images), foreignImages = object(peer.row.images), overlaid = { ...images };
  let imageChanged = false;
  for (const [key, value] of Object.entries(foreignImages)) if (!images[key] && typeof value === "string" && value) {
    overlaid[key] = value; imageChanged = true; supplement(`images.${key}`, value, "source-asset");
  }
  if (imageChanged) result.overrides.images = overlaid;
  // These fields can be inspected through the variant switch, never supplemented into another server.
  for (const field of ["stat", "difficulty", "resolvedSkills", "skillId", "liveSkillId", "leaderSkillId", "gekisouSkillId",
    "releasedAt", "publishedAt", "startAt", "endAt", "rewardGroups", "effects", "support", "characterId", "characterIds", "bandId", "bandIds",
    "musicUrl", "mvUrl", "musicVideos", "diarySound", "movies", "storyChapterId", "musicId", "song", "eventItem", "rewards", "rankings"])
    if (primary.row[field] !== undefined || peer.row[field] !== undefined) result.fields.push({ field, classification: "server-variant" });
  for (const field of ["musicUrl", "mvUrl", "musicVideos", "diarySound", "movies"])
    if (!primary.row[field] && peer.row[field]) supplement(field, peer.row[field], "foreign-variant-content");
  return result;
}
function href(resource: CrossCatalogResource, server: OfficialCatalogServer, locale: string, id: string): string | null {
  const kind = resource === "cards" ? "member-cards" : resource === "song-meta" ? "songs" : resource;
  if (kind === "bands" || kind === "help-tips" || kind.startsWith("anon-tokyo/")) return null;
  return `/${server}/${locale}/${kind}/${encodeURIComponent(id)}/`;
}
function assets(row: CrossCatalogRow): CrossCatalogRow {
  const result: CrossCatalogRow = {};
  for (const field of ["images", "image", "backgroundImage", "logo", "icon", "profileImage", "faceImage", "spriteImage",
    "thumbnailImage", "jacketUrl", "jacketThumbUrl", "musicUrl", "mvUrl"])
    if (row[field] !== undefined) result[field] = structuredClone(row[field]);
  return result;
}

/** Original IDs join only within one official resource; source pins remain per-server provenance. */
export function mergeCrossServerCatalog(
  snapshots: readonly CrossCatalogSnapshot[], resource: CrossCatalogResource,
  options: { selectedServer: OfficialCatalogServer; locale: string },
): CrossCatalogDTO {
  if (!isContentSourceId(options.selectedServer) || !/^[A-Za-z0-9-]+$/u.test(options.locale))
    throw new Error("Invalid cross-server view");
  const identities: CrossCatalogDTO["identities"] = {}, availability: CrossCatalogDTO["sourceAvailability"] = { jp: "unavailable", intl: "unavailable" };
  const documents: CrossCatalogDTO["documents"] = {};
  const buckets = new Map<string, { sources: Partial<Record<OfficialCatalogServer, CrossCatalogVariant[]>>; signature: Signature | null }>();
  for (const source of snapshots) {
    const identity = source.identity, server = identity.server;
    if (!isContentSourceId(server) || identities[server] || !/^r-[a-f0-9]{20}$/u.test(identity.releaseId) ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(identity.sourceId)) throw new Error("Invalid or repeated cross-server source pin");
    identities[server] = { ...identity };
    availability[server] = "unavailable";
    const collection = source.collections[resource];
    if (!collection) continue;
    availability[server] = "loaded";
    if (source.documents?.[resource]) documents[server] = source.documents[resource];
    const starts = resource === "stories" ? eventStoryStarts(source.documents?.[resource]) : undefined;
    for (const [id, original] of Object.entries(collection)) {
      const row = starts ? withEventStart(structuredClone(original), starts) : structuredClone(original), ownId = crossCatalogRowId(resource, row);
      if (ownId !== undefined && String(ownId) !== id) throw new Error(`Cross-server row identity mismatch:${server}/${resource}/${id}`);
      if (!isFormalCatalogSource(server) && snapshots.some(source => {
        const formal = isFormalCatalogSource(source.identity.server) && source.collections[resource]?.[id];
        return formal && !semanticOwnersConflict(formal, original, resource);
      })) continue;
      const sig = entitySignature(resource, row, id, server), key = sig?.key ?? `independent:${server}:${id}`;
      const bucket = buckets.get(key) ?? { sources: {}, signature: sig };
      (bucket.sources[server] ??= []).push({ identity: { ...identity }, id, row, available: true,
        releasedAt: structuredClone(row.releasedAt ?? row.publishedAt ?? row.publicStartAt ?? row.startAt ?? null), href: href(resource, server, options.locale, id), assets: assets(row) });
      buckets.set(key, bucket);
    }
  }
  const servers = ["jp", "intl", ...Object.keys(identities).filter((server) => !isFormalCatalogSource(server)).sort()];
  const entries: CrossCatalogEntry[] = [];
  const complete = availability.jp === "loaded" && availability.intl === "loaded";
  function add(variants: CrossCatalogVariant[], sig: Signature | null, ambiguous: boolean) {
    const perServer: CrossCatalogEntry["perServer"] = {};
    for (const variant of variants) perServer[variant.identity.server] = variant;
    const selected = perServer[options.selectedServer], display = selected ?? preferredCatalogVariant(variants, options.selectedServer)!;
    const peer = variants.find((variant) => variant.identity.server !== display.identity.server);
    const names = nameFallbacks(display, peer);
    const both = variants.length >= 2;
    const exclusive = complete && sig && !ambiguous
      ? exclusiveCatalogServer(servers.filter((server) => !!perServer[server])) ?? null
      : null;
    // Resource plus original ID is stable across independently updated server releases.
    const key = both ? `${resource}:shared:${sig!.key}` : `${resource}:${display.identity.server}:${display.id}`;
    entries.push({ key, resource, selectedServer: options.selectedServer, displayServer: display.identity.server,
      inSelectedServer: !!selected, perServer, serverAvailability: Object.fromEntries(servers.map((server) => [server, !!perServer[server]])),
      exclusive,
      association: { status: both ? "verified" : ambiguous ? "ambiguous" : "independent", evidence: sig?.evidence ?? [],
        ...(!both ? { reason: ambiguous ? "multiple-candidates-with-the-same-signature" : sig ? "original-id-not-in-peer-catalogue" : "insufficient-identity-evidence" } : {}) },
      nameOverrides: names.overrides, nameFallbacks: names.provenance, content: sharedContent(resource, display, peer),
      sourceIds: variants.map((variant) => variant.identity.server), variantGroups: sourceVariantGroups(variants) });
  }
  for (const bucket of buckets.values()) {
    if (bucket.signature && servers.every((server) => (bucket.sources[server]?.length ?? 0) <= 1))
      { const variants = visibleSourceVariants(servers.flatMap((server) => bucket.sources[server] ?? []), complete);
        if (variants.length) add(variants, bucket.signature, false); }
    else {
      const ambiguous = servers.some((server) => (bucket.sources[server]?.length ?? 0) > 1);
      for (const variant of servers.flatMap((server) => bucket.sources[server] ?? []))
        if (isFormalCatalogSource(variant.identity.server) || (complete && !snapshots.some((source) =>
          isFormalCatalogSource(source.identity.server) && Object.hasOwn(source.collections[resource] ?? {}, variant.id))))
          add([variant], bucket.signature, ambiguous);
    }
  }
  return { schema: "haneoka-cross-server-catalog-v1", resource, selectedServer: options.selectedServer, locale: options.locale,
    identities, sourceAvailability: availability, entries, documents };
}
/** UI-only text fallback; skills, dates, assets and every other field come from the display variant. */
export function crossServerDisplayRow(entry: CrossCatalogEntry): CrossCatalogRow {
  const variant = entry.perServer[entry.displayServer];
  if (!variant) throw new Error("Cross-server display variant missing");
  return { ...structuredClone(variant.row), ...structuredClone(entry.nameOverrides), ...structuredClone(entry.content.overrides) };
}
/** Calculation/ownership callers must use this accessor, never the display fallback. */
export function crossServerSelectedVariant(entry: CrossCatalogEntry): CrossCatalogVariant | null {
  return entry.perServer[entry.selectedServer] ?? null;
}
/** A unified detail can switch variants without changing the global inventory/scoring server. */
export function crossServerDetail(entry: CrossCatalogEntry, activeServer = entry.displayServer) {
  const variant = entry.perServer[activeServer];
  if (!variant) throw new Error("Requested cross-server variant is unavailable");
  const peerServer = [entry.selectedServer, ...OFFICIAL_CATALOG_SERVERS]
    .find((server) => server !== activeServer && entry.perServer[server]);
  const peer = peerServer ? entry.perServer[peerServer] : undefined;
  const names = nameFallbacks(variant, peer), content = sharedContent(entry.resource, variant, peer);
  return {
    schema: "haneoka-cross-server-detail-v1", key: entry.key, resource: entry.resource,
    selectedServer: entry.selectedServer, activeServer, identity: { ...variant.identity },
    row: { ...structuredClone(variant.row), ...names.overrides, ...content.overrides },
    perServer: entry.perServer, serverAvailability: entry.serverAvailability,
    sourceIds: Object.keys(entry.perServer),
    variantGroups: sourceVariantGroups(Object.values(entry.perServer).filter((value): value is CrossCatalogVariant => !!value)),
    href: variant.href, nameFallbacks: names.provenance, content,
    ownershipVariant: activeServer === entry.selectedServer ? variant : null,
  };
}
