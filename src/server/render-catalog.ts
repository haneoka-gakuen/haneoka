import { renderWorkspacePage, useStaticLocale, type StaticWorkspacePage } from "./render-workspace";
import { CatalogScreen } from "../lit/catalog-screen";
import type { EntityPayload, StoryPayload } from "../lib/entity-graph";
import type { Locale } from "../i18n/locales";
import type { CatalogCollectionPayload } from "./catalog-collection";
import { resourcePath, resourceKindForCollection } from "../lib/resource-route";
import { eventSongPayload } from "./event-song-release";
import { eventStoryPayload } from "./story-visibility";

export async function renderCatalog(config: string, payload: EntityPayload, locale: Locale): Promise<string> {
  return (await renderCatalogPage(config, payload, locale)).body;
}

export async function renderCatalogPage(
  config: string,
  payload: EntityPayload,
  locale: Locale,
  section?: string,
): Promise<StaticWorkspacePage> {
  payload = await eventStoryPayload(await eventSongPayload(payload));
  const route = resourcePath({
    server: payload.server,
    locale,
    kind: resourceKindForCollection(payload.resource)!,
    id: payload.id,
  });
  useStaticLocale(locale, route);
  const screen = new CatalogScreen();
  await screen.prepareEntity(payload, config);
  if (section) screen.characterSection = section;
  return renderWorkspacePage(screen, locale, route);
}

export function renderCatalogCollection(
  config: string,
  payload: CatalogCollectionPayload,
  locale: Locale,
): StaticWorkspacePage {
  useStaticLocale(locale, "/catalog");
  const screen = new CatalogScreen();
  screen.prepareCollection(payload, config);
  return renderWorkspacePage(screen, locale, "/catalog");
}

export async function renderStory(payload: StoryPayload, locale: Locale): Promise<string> {
  return (await renderStoryPage(payload, locale)).body;
}

export async function renderStoryPage(payload: StoryPayload, locale: Locale): Promise<StaticWorkspacePage> {
  const { StoryWorkspace } = await import("../lit/story-workspace");
  const route = resourcePath({ server: payload.server, locale, kind: "stories", id: payload.id });
  useStaticLocale(locale, route);
  const workspace = new StoryWorkspace();
  workspace.prepareEntity(payload, locale);
  return renderWorkspacePage(workspace, locale, route);
}
