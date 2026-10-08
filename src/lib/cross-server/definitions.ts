/** Collection shapes and native identities shared by every first-party browser. */
interface Definition {
  ids: readonly string[];
  rows?: string;
  api?: string;
  opaque?: boolean;
}
export const CROSS_CATALOG_DEFINITIONS = {
  cards: { ids: ["cardId", "id"] },
  "support-cards": { ids: ["supportCardId", "id"] },
  songs: { ids: ["musicId", "songId", "id"] },
  "song-meta": { ids: ["musicId", "id"] },
  characters: { ids: ["characterId", "id"] },
  bands: { ids: ["bandId", "id"] },
  comics: { ids: ["comicId", "id"] },
  stamps: { ids: ["stampId", "id"] },
  stickers: { ids: ["stickerId", "id"], rows: "entries" },
  backgrounds: { ids: ["backgroundId", "id"], rows: "entries" },
  "band-items": { ids: ["bandItemId", "itemId", "id"], rows: "items" },
  items: { ids: ["itemId", "id"], rows: "items" },
  events: { ids: ["id"], rows: "entries" },
  "real-lives": { ids: ["id"], rows: "entries", opaque: true },
  gacha: { ids: ["id"], rows: "entries" },
  "login-campaigns": { ids: ["id"], rows: "entries" },
  shop: { ids: ["id"], rows: "entries" },
  exchange: { ids: ["id"], rows: "entries" },
  circle: { ids: ["id"], rows: "entries" },
  challenge: { ids: ["id"], rows: "entries" },
  passes: { ids: ["id"], rows: "entries", opaque: true },
  missions: { ids: ["id"], rows: "entries", opaque: true },
  "tgw-card": { ids: ["id"], rows: "entries" },
  live2d: { ids: ["live2dKey", "key", "id"], opaque: true },
  spine: { ids: ["id"], rows: "models", opaque: true },
  stories: { ids: ["storyId", "id"], rows: "episodes", opaque: true },
  help: { ids: ["helpSubcategoryId", "id"], rows: "categories" },
  "help-tips": { ids: ["tipId", "id"], rows: "loadingTips", api: "help" },
  "anon-tokyo/characters": { ids: ["id"], rows: "characters", api: "anon-tokyo", opaque: true },
  "anon-tokyo/outfits": { ids: ["id"], rows: "goods.reloading", api: "anon-tokyo", opaque: true },
  "anon-tokyo/shop": { ids: ["id"], rows: "shop.stores", api: "anon-tokyo", opaque: true },
  "anon-tokyo/goods": { ids: ["id"], rows: "goods.items", api: "anon-tokyo", opaque: true },
  "anon-tokyo/decorations": { ids: ["id"], rows: "shop.decorations", api: "anon-tokyo", opaque: true },
  "anon-tokyo/staff": { ids: ["id"], rows: "staffing.clerks", api: "anon-tokyo", opaque: true },
  "anon-tokyo/customers": { ids: ["id"], rows: "staffing.customers", api: "anon-tokyo", opaque: true },
  "anon-tokyo/tasks": { ids: ["id"], rows: "tasks.main", api: "anon-tokyo", opaque: true },
  "anon-tokyo/guide": { ids: ["id"], rows: "guides.steps", api: "anon-tokyo", opaque: true },
  "anon-tokyo/fever": { ids: ["id"], rows: "stages.music", api: "anon-tokyo", opaque: true },
} as const satisfies Record<string, Definition>;
export type CrossCatalogResource = keyof typeof CROSS_CATALOG_DEFINITIONS;
export const CROSS_CATALOG_RESOURCES = Object.keys(CROSS_CATALOG_DEFINITIONS) as CrossCatalogResource[];
export const isCrossCatalogResource = (value: string): value is CrossCatalogResource =>
  Object.hasOwn(CROSS_CATALOG_DEFINITIONS, value);
export const crossCatalogDefinition = (resource: CrossCatalogResource): Definition => CROSS_CATALOG_DEFINITIONS[resource];
export const crossCatalogApi = (resource: CrossCatalogResource) => crossCatalogDefinition(resource).api || resource;
type Row = Record<string, unknown>;
export type CrossCatalogDocument = Row | Row[];
const object = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);
export function crossCatalogRowId(resource: CrossCatalogResource, row: Row): unknown {
  for (const field of crossCatalogDefinition(resource).ids) if (row[field] !== undefined) return row[field];
  return undefined;
}

/** Keep document metadata alongside rows; a missing map is not an observed empty collection. */
export function crossCatalogRows(resource: CrossCatalogResource, document: unknown, onlyId?: string): Record<string, Row> {
  if (!object(document) && !Array.isArray(document)) throw new Error("Cross-server collection must be an object or array");
  let rows: unknown = document;
  for (const field of crossCatalogDefinition(resource).rows?.split(".") || [])
    rows = object(rows) ? rows[field] : undefined;
  if (resource === "help" && object(rows))
    rows = Object.values(rows).flatMap((category) => object(category) && Array.isArray(category.subcategories) ? category.subcategories : []);
  if (rows === undefined && resource.startsWith("anon-tokyo/") && object(document) && document.available === false)
    return {};
  if (!object(rows) && !Array.isArray(rows)) throw new Error("Cross-server collection rows malformed");
  if (onlyId !== undefined && object(rows)) rows = Object.hasOwn(rows, onlyId) ? { [onlyId]: rows[onlyId] } : {};
  const result: Record<string, Row> = {};
  for (const [key, row] of Object.entries(rows as Row | Row[])) {
    if (!object(row)) throw new Error("Cross-server collection rows malformed");
    const id = Array.isArray(rows) ? String(crossCatalogRowId(resource, row) ?? key) : key;
    if (Object.hasOwn(result, id)) throw new Error("Duplicate cross-server entity identity");
    if (onlyId !== undefined && id !== onlyId) continue;
    result[id] = row;
  }
  return result;
}
