import type { UiLocale } from "@haneoka/i18n";
import type { CatalogProvider, ProviderCollectionPayload } from "./provider-page-data.ts";

export type ProviderEntityResource = "songs" | "cards" | "stories";
export interface ProviderEntityLocator {
  provider: CatalogProvider;
  locale: UiLocale;
  resource: ProviderEntityResource;
  id: string;
  section?: string;
  cardId?: string;
}
export interface ProviderEntityPayload extends ProviderEntityLocator {
  schema: "haneoka-provider-entity-v1";
  region: string;
  /** Current record and its presentation dependencies; the full index is shared. */
  collection: ProviderCollectionPayload;
  /** Exact full record produced by the existing provider projector. */
  detail: Record<string, unknown>;
  card?: Record<string, unknown>;
  collectionUrl: string;
}
export function providerEntityResourcePath(entry: Pick<ProviderEntityLocator, "resource" | "section">): string {
  if (entry.resource !== "stories") return entry.resource;
  if (!entry.section) throw new TypeError("Story entity section is required");
  return `stories-${entry.section}`;
}
export function providerEntityHtmlPath(entry: ProviderEntityLocator): string {
  return `/provider-static/${entry.provider}/${entry.locale}/${providerEntityResourcePath(entry)}/${encodeURIComponent(entry.id)}.html`;
}
export function providerEntityJsonPath(entry: ProviderEntityLocator): string {
  return providerEntityHtmlPath(entry).replace(/\.html$/u, ".json");
}
export function providerEntityRoute(entry: ProviderEntityLocator): string {
  const { provider, locale, resource, id, section } = entry;
  if (resource === "songs")
    return `/${locale}/community/${provider === "bestdori" ? "gbp/songs" : "sekai/songs"}/detail/?${new URLSearchParams({ song: id })}`;
  if (resource === "cards") {
    if (provider !== "bestdori") throw new TypeError("This provider has no card entity view");
    return `/${locale}/community/gbp/stories/card/${encodeURIComponent(id)}/`;
  }
  if (!section) throw new TypeError("Story entity section is required");
  return `/${locale}/community/${provider === "bestdori" ? "gbp/stories" : "sekai/stories"}/${section}/${encodeURIComponent(id)}/`;
}
