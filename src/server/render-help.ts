import { renderCatalogueCollection, renderWorkspacePage, useStaticLocale } from "./render-workspace";
import type { Locale } from "../i18n/locales";
import type { WorkspaceCollectionPayload } from "../lib/workspace-page-data";
import type { HelpCollectionPageData, HelpViewState } from "../lit/help-workspace";
import { crossCatalogPresentation } from "../lib/cross-server/presentation";

/** The existing manual/tips and topic query states, rendered with the original controls. */
export function helpStaticViews(payload: WorkspaceCollectionPayload): HelpViewState[] {
  const topics = crossCatalogPresentation(payload.catalogs.help!).items;
  return [
    { mode: "manual" },
    { mode: "tips" },
    ...topics.map((topic) => ({ mode: "manual" as const, topic: String(topic.helpSubcategoryId) })),
  ];
}

export async function renderHelpView(
  payload: WorkspaceCollectionPayload,
  locale: Locale,
  helpView: HelpViewState = { mode: "manual" },
) {
  const { HelpWorkspace } = await import("../lit/help-workspace");
  useStaticLocale(locale, "/catalog/help");
  const pageData: HelpCollectionPageData = { ...payload, helpView };
  const create = (data: HelpCollectionPageData) => {
    const workspace = new HelpWorkspace();
    workspace.prepareCollection(data, locale);
    return workspace;
  };
  const page = helpView.topic
    ? renderWorkspacePage(create(pageData), locale, "/catalog/help")
    : renderCatalogueCollection(pageData, "help", locale, "/catalog/help", create);
  return { ...page, payload: pageData };
}
