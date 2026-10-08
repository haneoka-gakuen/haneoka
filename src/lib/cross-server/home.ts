import { staticCatalogRelease, fetchStaticCatalog } from "../static-catalog-source";
import { loadCrossServerCatalogs } from "./bundle";
import { homeEventDisplay } from "../home-event-display";
import {
  OFFICIAL_CATALOG_SERVERS, type CrossCatalogDTO, type CrossCatalogRow, type CrossCatalogResource,
  type CrossCatalogIdentity, type OfficialCatalogServer,
} from "./catalog";

const HOME_FIELDS = {
  cards: ["cardId", "assetId", "prefix", "characterId", "cardType", "rarity", "releasedAt"],
  "support-cards": ["supportCardId", "assetId", "prefix", "cardName", "characterId", "characterIds", "cardType", "rarity", "releasedAt"],
  songs: ["musicId", "musicTitle", "bandId", "bandIds", "bandName", "artistId", "artistName", "musicType", "publishedAt", "jacketUrl", "jacketThumbUrl",
    "vocalCharacterIds", "composer", "lyricist", "arranger"],
  characters: ["characterId", "characterName", "englishName", "nickname", "bandId", "bandPart", "colorCode", "birthday", "slug",
    "faceImage", "thumbnailImage", "profileImage", "voiceActor", "description"],
  bands: ["bandId", "bandName", "description", "logo", "icon", "color", "colorCode"],
  events: ["id", "kind", "sourceTable", "sourceTables", "raw", "title", "image", "backgroundImage", "logo", "startAt", "endAt", "eventType", "homeStoryId", "effects"],
} satisfies Partial<Record<CrossCatalogResource, string[]>>;
type HomeResource = keyof typeof HOME_FIELDS;
function compact(row: CrossCatalogRow, resource: HomeResource): CrossCatalogRow {
  if (resource === "events") return homeEventDisplay(row);
  const keys = HOME_FIELDS[resource], result = Object.fromEntries(Object.entries(row).filter(([key]) => keys.includes(key)));
  const images = row.images as CrossCatalogRow | undefined;
  if (images?.thumbnail !== undefined) result.images = { thumbnail: images.thumbnail };
  return structuredClone(result);
}
/** Association happens on full source evidence first; compacting must never weaken the matcher. */
export function compactCrossServerHomeCatalog(dto: CrossCatalogDTO): CrossCatalogDTO {
  if (!Object.hasOwn(HOME_FIELDS, dto.resource)) throw new Error("Resource has no compact home projection");
  const output = structuredClone({ ...dto, documents: {} }), resource = dto.resource as HomeResource;
  for (const entry of output.entries) {
    for (const variant of Object.values(entry.perServer)) if (variant) {
      variant.row = compact(variant.row, resource);
      variant.assets = compact(variant.assets, resource);
    }
    entry.nameOverrides = compact(entry.nameOverrides, resource);
    entry.content.overrides = compact(entry.content.overrides, resource);
    entry.content.supplements = entry.content.supplements.filter((item) => HOME_FIELDS[resource].includes(item.field) || item.field === "images.thumbnail");
    entry.content.fields = entry.content.fields.filter((item) => HOME_FIELDS[resource].includes(item.field));
  }
  return output;
}

/** Feed the existing HomeSeed contract. The configured build cache observes current once per server. */
export async function loadStaticCrossServerHome(selectedServer: OfficialCatalogServer, locale: string) {
  const reader = {
    async readIdentity(server: OfficialCatalogServer) {
      const identity = await staticCatalogRelease(server);
      return { ...identity, server };
    },
    readCollection: (resource: CrossCatalogResource, identity: CrossCatalogIdentity) => fetchStaticCatalog(resource, identity.server, identity),
    readEntity: (resource: CrossCatalogResource, identity: CrossCatalogIdentity, id: string) => fetchStaticCatalog(`${resource}/${encodeURIComponent(id)}`, identity.server, identity),
  };
  const catalogs = await loadCrossServerCatalogs(["cards", "support-cards", "songs", "characters", "bands", "events"], { selectedServer, locale, reader, servers: selectedServer === "intl-test" ? ["jp", "intl", "intl-test"] : ["jp", "intl"] });
  const serverMarks: Partial<Record<OfficialCatalogServer, { identity: CrossCatalogIdentity; marks: Record<string, string> }>> = {};
  await Promise.all(OFFICIAL_CATALOG_SERVERS.map(async (server) => {
    const identity = catalogs.cards?.identities[server];
    if (!identity) return;
    try {
      const value = await fetchStaticCatalog("ui-marks", server, identity);
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const marks = Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      serverMarks[server] = { identity: { ...identity }, marks };
    } catch { /* Unavailable marks do not borrow another server's symbols. */ }
  }));
  return { crossServerCatalogs: Object.fromEntries(Object.entries(catalogs).map(([key, dto]) => [key, compactCrossServerHomeCatalog(dto)])), serverMarks };
}
