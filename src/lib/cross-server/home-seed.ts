import type { CrossCatalogDTO, CrossCatalogIdentity, CrossCatalogResource, CrossCatalogVariant } from "./catalog";

const ASSET_FIELDS = "homeAssetFields";
type Catalogs = Partial<Record<CrossCatalogResource, CrossCatalogDTO>>;
interface Seed {
  server: string;
  releaseId: string;
  documents: Record<string, unknown>;
  crossServerCatalogs?: Catalogs;
}

/** The catalogs a home seed of this server and release reads instead of its raw documents. */
export function homeSeedCatalog(seed: Pick<Seed, "server" | "releaseId">, resource: string, dto: CrossCatalogDTO): boolean {
  return (
    dto.schema === "haneoka-cross-server-catalog-v1" &&
    dto.resource === resource &&
    dto.selectedServer === seed.server &&
    dto.identities[dto.selectedServer]?.releaseId === seed.releaseId
  );
}

const sameIdentity = (a: CrossCatalogIdentity, b: CrossCatalogIdentity | undefined) =>
  !!b &&
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(([key, value]) => b[key as keyof CrossCatalogIdentity] === value);

/** Asset fields every variant copies verbatim from its row, or undefined when one differs. */
function rowAssetFields(dto: CrossCatalogDTO): string[] | undefined {
  const variants = dto.entries.flatMap((entry) => Object.values(entry.perServer).filter((variant) => !!variant));
  const fields = [...new Set(variants.flatMap((variant) => Object.keys(variant.assets)))].sort();
  const copied = variants.every((variant) => {
    const expected = fields.filter((field) => Object.hasOwn(variant.row, field));
    return (
      expected.length === Object.keys(variant.assets).length &&
      expected.every((field) => JSON.stringify(variant.assets[field]) === JSON.stringify(variant.row[field]))
    );
  });
  return copied ? fields : undefined;
}

/**
 * Raw documents only back a missing catalog; each variant's identity repeats
 * its catalog's, and its assets repeat row fields named once per catalog.
 */
export function packHomeSeed<T extends Seed>(seed: T): T {
  const catalogs = seed.crossServerCatalogs;
  if (!catalogs) return seed;
  const documents = { ...seed.documents };
  for (const resource of ["songs", "support-cards", "events"] as const) {
    const dto = catalogs[resource];
    if (dto && homeSeedCatalog(seed, resource, dto)) delete documents[resource];
  }
  const packed = Object.fromEntries(
    Object.entries(catalogs).map(([resource, dto]) => {
      if (!dto) return [resource, dto];
      const assetFields = rowAssetFields(dto);
      return [
        resource,
        {
          ...dto,
          ...(assetFields ? { [ASSET_FIELDS]: assetFields } : {}),
          entries: dto.entries.map((entry) => ({
            ...entry,
            perServer: Object.fromEntries(
              Object.entries(entry.perServer).map(([server, variant]) => {
                if (!variant) return [server, variant];
                const { identity, assets, ...rest } = variant;
                return [
                  server,
                  {
                    ...rest,
                    ...(sameIdentity(identity, dto.identities[server]) ? {} : { identity }),
                    ...(assetFields ? {} : { assets }),
                  },
                ];
              }),
            ),
          })),
        },
      ];
    }),
  ) as Catalogs;
  return { ...seed, documents, crossServerCatalogs: packed };
}

export function unpackHomeSeedCatalogs(catalogs: Catalogs): void {
  for (const dto of Object.values(catalogs)) {
    if (!dto) continue;
    const packed = dto as CrossCatalogDTO & { [ASSET_FIELDS]?: string[] };
    const assetFields = packed[ASSET_FIELDS];
    delete packed[ASSET_FIELDS];
    for (const entry of dto.entries)
      for (const [server, stored] of Object.entries(entry.perServer)) {
        const variant = stored as Partial<CrossCatalogVariant> & Pick<CrossCatalogVariant, "row"> | undefined;
        if (!variant) continue;
        const identity = dto.identities[server];
        if (!variant.identity && identity) Object.assign(variant, { identity: { ...identity } });
        if (!variant.assets && assetFields)
          Object.assign(variant, {
            assets: Object.fromEntries(
              assetFields
                .filter((field) => Object.hasOwn(variant.row, field))
                .map((field) => [field, structuredClone(variant.row[field])]),
            ),
          });
      }
  }
}
