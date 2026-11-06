import { isContentVisible } from "../content-release";
import { withContentSource } from "../content-publication";
import { mergeCrossServerCatalog, type CrossCatalogDTO, type CrossCatalogSnapshot } from "./catalog";

export function releasedCatalog(dto: CrossCatalogDTO, visible = isContentVisible): CrossCatalogDTO {
  if (
    dto.entries.every((entry) =>
      Object.values(entry.perServer).every(
        (variant) =>
          !variant || visible(dto.resource, withContentSource(variant.row, variant.identity.server), variant.id),
      ),
    )
  )
    return dto;
  const sources: CrossCatalogSnapshot[] = Object.entries(dto.identities).flatMap(([server, identity]) => {
    if (!identity) return [];
    const collection = Object.fromEntries(
      dto.entries.flatMap((entry) => {
        const variant = entry.perServer[server];
        return variant && visible(dto.resource, withContentSource(variant.row, variant.identity.server), variant.id)
          ? [[variant.id, variant.row]]
          : [];
      }),
    );
    return [
      {
        identity,
        collections: dto.sourceAvailability[server] === "loaded" ? { [dto.resource]: collection } : {},
        documents: dto.documents[server] ? { [dto.resource]: dto.documents[server] } : {},
      },
    ];
  });
  return {
    ...dto,
    ...mergeCrossServerCatalog(sources, dto.resource, { selectedServer: dto.selectedServer, locale: dto.locale }),
  };
}
