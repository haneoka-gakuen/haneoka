import { crossServerDisplayRow, type CrossCatalogDTO, type CrossCatalogEntry, type CrossCatalogIdentity, type CrossCatalogRow } from "./catalog";

/** Pin media to its actual source release, including nested preview/runtime records. */
export function pinCrossCatalogValue(value: unknown, identity: CrossCatalogIdentity): unknown {
  if (typeof value === "string" && /^\/(?:assets|runtime|objects)\//u.test(value)) {
    const url = new URL(value, "https://asset.invalid");
    if (!new RegExp(`^/(?:assets|runtime|objects)/${identity.server}/`, "u").test(url.pathname))
      throw new Error("Cross-server media source mismatch");
    url.searchParams.set("release", identity.releaseId);
    return url.pathname + url.search;
  }
  if (Array.isArray(value)) return value.map((entry) => pinCrossCatalogValue(entry, identity));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, pinCrossCatalogValue(entry, identity)]));
  return value;
}

export function crossCatalogPresentation(dto: CrossCatalogDTO) {
  const entries = new WeakMap<CrossCatalogRow, CrossCatalogEntry>();
  const byId = new Map<string, CrossCatalogEntry>();
  const items = dto.entries.map((entry) => {
    const variant = entry.perServer[entry.displayServer]!;
    const row = crossServerDisplayRow(entry);
    for (const supplement of entry.content.supplements) if (supplement.classification === "source-asset") {
      const field = supplement.field.split(".")[0]!;
      if (variant.row[field] === undefined) delete row[field];
      else row[field] = structuredClone(variant.row[field]);
    }
    const pinned = pinCrossCatalogValue(row, variant.identity) as CrossCatalogRow;
    entries.set(pinned, entry);
    if (!byId.has(variant.id) || entry.inSelectedServer) byId.set(variant.id, entry);
    return pinned;
  });
  return { dto, items, entries, byId };
}
export type CrossCatalogPresentation = ReturnType<typeof crossCatalogPresentation>;
