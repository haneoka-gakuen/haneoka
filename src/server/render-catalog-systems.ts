import { renderCatalogueCollection, renderWorkspacePage, useStaticLocale, type StaticWorkspacePage } from "./render-workspace";
import type { CatalogSystemPayload } from "../lib/catalog-system-data";
import type { Locale } from "../i18n/locales";

export async function renderCatalogSystem(payload: CatalogSystemPayload, locale: Locale): Promise<StaticWorkspacePage> {
  const constructors = {
    arena: () => import("../lit/arena-workspace").then(module => module.ArenaWorkspace),
    missions: () => import("../lit/mission-workspace").then(module => module.MissionWorkspace),
    studio: () => import("../lit/studio-workspace").then(module => module.StudioWorkspace),
    "tgw-card": () => import("../lit/tgw-card-workspace").then(module => module.TgwCardWorkspace),
    "anon-tokyo": () => import("../lit/anon-tokyo-workspace").then(module => module.AnonTokyoWorkspace),
  };
  const Constructor = await constructors[payload.kind]();
  const route = `/catalog/${payload.kind}${payload.kind === "anon-tokyo" ? `/${payload.mode}` : ""}`;
  useStaticLocale(locale, route);
  const create = (data: CatalogSystemPayload) => {
    const workspace = new Constructor();
    workspace.preparePage(data, locale);
    return workspace;
  };
  return payload.entityId
    ? renderWorkspacePage(create(payload), locale, route)
    : renderCatalogueCollection(payload, payload.kind, locale, route, create);
}
