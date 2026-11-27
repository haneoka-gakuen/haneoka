import { renderCatalogueCollection, useStaticLocale, type StaticWorkspacePage } from "./render-workspace";
import type { WorkspaceCollectionPayload } from "../lib/workspace-page-data";
import type { Locale } from "../i18n/locales";
import type { StoryMode } from "../lib/resource-route";

export async function renderCollectionWorkspace(payload: WorkspaceCollectionPayload, locale: Locale, mode: StoryMode = "band"): Promise<StaticWorkspacePage> {
  const route = payload.resource === "stories" ? `/catalog/stories/${mode}` : `/catalog/${payload.resource}`;
  const constructors = {
    stories: () => import("../lit/story-workspace").then((module) => module.StoryWorkspace),
    live2d: () => import("../lit/live2d-workspace").then((module) => module.Live2DWorkspace),
    spine: () => import("../lit/spine-workspace").then((module) => module.SpineWorkspace),
    help: () => import("../lit/help-workspace").then((module) => module.HelpWorkspace),
  };
  const Constructor = await constructors[payload.resource]();
  useStaticLocale(locale, route);
  return renderCatalogueCollection(payload, payload.resource, locale, route, (data) => {
    const workspace = new Constructor();
    workspace.prepareCollection(data, locale, mode);
    return workspace;
  });
}
