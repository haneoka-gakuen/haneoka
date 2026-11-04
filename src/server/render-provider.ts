import { renderWorkspacePage, useStaticLocale, type StaticWorkspacePage } from "./render-workspace";
import { CatalogScreen } from "../lit/catalog-screen";
import { StoryWorkspace } from "../lit/story-workspace";
import type { ProviderCollectionPayload } from "../lib/provider-page-data";
import type { Locale } from "../i18n/locales";
import type { ProviderEntityPayload } from "../lib/provider-entity-data";
import { providerEntityCollection } from "./provider-entity-data";
import { catalogConfig } from "../config/catalog-labels";
import { STATIC_DOCUMENT_UNDERLAY_START, STATIC_DOCUMENT_UNDERLAY_END } from "../lib/static-documents";
import { serializePageData } from "../lib/page-data";

export function renderProviderSongs(
  config: string,
  payload: ProviderCollectionPayload,
  locale: Locale,
  route: string,
): StaticWorkspacePage {
  useStaticLocale(locale, route);
  const workspace = new CatalogScreen();
  workspace.prepareProviderCollection(payload, config);
  return renderWorkspacePage(workspace, locale, route);
}
export function renderProviderStories(
  payload: ProviderCollectionPayload,
  locale: Locale,
  mode: string,
  route: string,
): StaticWorkspacePage {
  useStaticLocale(locale, route);
  const workspace = new StoryWorkspace();
  workspace.prepareProviderCollection(payload, locale, mode);
  return renderWorkspacePage(workspace, locale, route);
}

const collectionScripts = new WeakMap<ProviderCollectionPayload, string>();
export async function renderProviderEntity(
  payload: ProviderEntityPayload,
  locale: Locale,
  route: string,
): Promise<StaticWorkspacePage> {
  if (payload.resource !== "songs") {
    const workspace = new StoryWorkspace();
    useStaticLocale(locale, route);
    await workspace.prepareProviderEntity(payload, payload.collection);
    return renderWorkspacePage(workspace, locale, route);
  }
  const collection = providerEntityCollection(payload);
  let collectionData = collectionScripts.get(collection);
  if (!collectionData) {
    collectionData = `<script id="provider-entity-collection" type="application/json">${serializePageData(collection)}</script>`;
    collectionScripts.set(collection, collectionData);
  }
  const workspace = new CatalogScreen();
  useStaticLocale(locale, route);
  await workspace.prepareProviderEntity(
    payload,
    catalogConfig({ resource: "songs", locale, origin: payload.provider, entityId: payload.id, entityContext: true }),
  );
  const page = renderWorkspacePage(workspace, locale, route);
  return {
    ...page,
    body: STATIC_DOCUMENT_UNDERLAY_START + collectionData + STATIC_DOCUMENT_UNDERLAY_END + page.body,
  };
}
