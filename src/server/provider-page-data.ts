import { BESTDORI_CATALOG_VERSION } from "@haneoka/bestdori/resources";
import { providerCatalogBase, type CatalogProvider, type ProviderCollectionPayload } from "../lib/provider-page-data";
import { readProviderStaticCollection } from "./provider-static-data";
import { staticBuildJson } from "./static-input-store";
import { sekaiUnitBands } from "../lib/sekai-units";

const origin = (process.env.STATIC_CATALOG_ORIGIN || "https://haneoka.org").replace(/\/+$/u, "");
const reads = new Map<string, Promise<Record<string, unknown>>>();
export { read as readProviderCatalog };
function read(path: string): Promise<Record<string, unknown>> {
  let pending = reads.get(path);
  if (!pending) {
    pending = staticBuildJson(`provider:${path}`, "provider", async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await fetch(`${origin}${path}`, {
            headers: {
              accept: "application/json",
              ...(process.env.STATIC_CATALOG_TOKEN
                ? { "x-haneoka-build-token": process.env.STATIC_CATALOG_TOKEN }
                : {}),
            },
            signal: AbortSignal.timeout(60_000),
          });
          if (!response.ok) throw new Error(`Provider catalog ${path}: HTTP ${response.status}`);
          return (await response.json()) as Record<string, unknown>;
        } catch (error) {
          if (attempt === 2) throw error;
          await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
        }
      }
    });
    reads.set(path, pending);
    pending.catch(() => reads.delete(path));
  }
  return pending;
}

const pages = new Map<string, Promise<ProviderCollectionPayload>>();
export function providerCollectionData(
  provider: CatalogProvider,
  locale: string,
  resource: string,
): Promise<ProviderCollectionPayload> {
  const key = `${provider}:${locale}:${resource}`;
  let pending = pages.get(key);
  if (!pending) {
    pending = staticBuildJson(`provider-collection:${key}`, "provider", async () => {
      const cached = process.env.PROVIDER_STATIC_DATA_ROOT
        ? readProviderStaticCollection(provider, locale, resource)
        : undefined;
      if (cached) return provider === "sekai" && resource === "songs" ? { ...cached, bands: sekaiUnitBands(cached.bands as Record<string, unknown>) } : cached;
      const base = providerCatalogBase(provider, locale);
      const story = resource.startsWith("stories/");
      const path = resource === "stories/card" && provider === "bestdori" ? "cards" : resource;
      const [document, bands, characters, songMeta] = await Promise.all([
        read(`${base}/${path}?lang=${encodeURIComponent(locale)}&projection=${BESTDORI_CATALOG_VERSION}`),
        story && provider === "sekai" ? {} : read(`${base}/bands`),
        story && provider === "sekai" ? {} : read(`${base}/characters`),
        resource === "songs" ? read(`${base}/song-meta?lang=${encodeURIComponent(locale)}`) : undefined,
      ]);
      return {
        schema: "haneoka-provider-collection-v1",
        provider,
        locale,
        resource,
        document,
        bands: provider === "sekai" && resource === "songs" ? sekaiUnitBands(bands) : bands,
        characters,
        ...(songMeta ? { songMeta } : {}),
      };
    });
    pages.set(key, pending);
    pending.catch(() => pages.delete(key));
  }
  return pending;
}
