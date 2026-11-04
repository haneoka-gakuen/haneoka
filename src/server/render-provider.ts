// L3 — GEB
// Input: 供应方集合、实体载荷或核心实体壳的语言与分类。
// Output: 共用故事／歌曲组件的正文和应用栏静态首屏。
// Pos: [Map](L2-2.md)；供应方页面的 SSR 与核心故事壳入口。
// Effects/Dependencies: 初始化 SSR 语言上下文；详情壳不请求供应方资料。
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
export function renderProviderStoryShell(locale: Locale, route: string): StaticWorkspacePage {
  const workspace = new StoryWorkspace();
  workspace.locale = locale;
  workspace.entityId = "_";
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
