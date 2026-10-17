import { LOCALES } from "../i18n/locales";
import { ROUTES } from "../config/routes";
import { SEKAI_STORY_SECTIONS } from "../config/navigation";
import { ANON_TOKYO_MODES, type ReleaseServer } from "../lib/resource-route";
import { catalogEntityData, staticCatalogPageServers, ENTITY_PAYLOAD_RESOURCES } from "../lib/entity-graph";
import { searchableCatalogPages } from "../lib/searchable-catalog";
import { searchableModelPages } from "../lib/searchable-models";
import { searchableStoryPages } from "../lib/searchable-stories";
import { searchableHelpPages } from "../lib/searchable-help";
import { crossCatalogRows, isCrossCatalogResource } from "../lib/cross-server/definitions";
import { fetchStaticCatalog, primeStaticCatalogBatch, staticCatalogRelease } from "../lib/static-catalog-source";
import { appRelease } from "./app-release";
import { publicForumDirectory } from "./public-forum-directory";
import { homePageData } from "./home-page-data";
import { loadCalendarData } from "./calendar";
import { announcementPageData } from "./announcement-page-data";
import { catalogCollectionData } from "./catalog-collection";
import { catalogSystemData, catalogSystemEntityData } from "./catalog-system-data";
import { workspaceCollectionData } from "./workspace-page-data";
import { skillCatalogPayload } from "./skill-catalog";
import { eventTrackerPageData } from "./event-tracker-page-data";
import { providerCollectionData } from "./provider-page-data";
import { playlistPageData } from "./playlist-page-data";
import { assetPageData, assetStaticPaths, assetViewData } from "./asset-page-data";
import { providerEntityManifest, readProviderEntityPayload } from "./provider-entity-manifest";
import { staticPageGroupEnabled } from "./static-build";
import {
  publicSongsPageData,
  rankingCardsPageData,
  sonolusHubPageData,
  teamBuilderPageData,
  songPuzzlePageData,
  stampMakerPageData,
} from "./tool-page-data";
import { finishStaticBuildInputs } from "./static-input-store";

/** Execute production data producers once before locale render workers start. */
export async function prepareStaticInputs(): Promise<void> {
  if (process.env.STATIC_BUILD_INPUT_MODE !== "capture") throw new Error("Static preparation requires capture mode");
  const servers = await staticCatalogPageServers();
  const configured = await staticCatalogPageServers(true);
  for (const server of servers) {
    const pin = await staticCatalogRelease(server);
    console.log(`capture native ${server}/${pin.releaseId}`);
    const pages = await searchableCatalogPages(server);
    await assetPageData(server);
    if (configured.includes(server)) {
      await searchableModelPages(server);
      await searchableStoryPages(server);
      await searchableHelpPages(server);
      const first = pages.find((page) =>
        ENTITY_PAYLOAD_RESOURCES.includes(page.resource as (typeof ENTITY_PAYLOAD_RESOURCES)[number]),
      );
      if (first) await catalogEntityData(server, first.resource, first.id);
      for (const kind of ["missions", "tgw-card"] as const) {
        const first = pages.find((page) => page.resource === kind);
        if (first) await catalogSystemEntityData(kind, server, first.id);
      }
    }
    for (const resource of ENTITY_PAYLOAD_RESOURCES) {
      if (!isCrossCatalogResource(resource)) continue;
      const document = await fetchStaticCatalog(resource, server, pin);
      await primeStaticCatalogBatch(resource, Object.keys(crossCatalogRows(resource, document)), server, pin);
    }
    await skillCatalogPayload(server);
    await publicSongsPageData(server);
    await teamBuilderPageData(server);
    await songPuzzlePageData(server);
    for (const locale of LOCALES) {
      console.log(`capture localized ${server}/${locale}`);
      await homePageData(server, locale);
      await loadCalendarData(server, locale);
      await announcementPageData(server, locale);
      for (const route of ROUTES) {
        if (
          route.kind === "catalog" &&
          route.resource &&
          !route.resource.startsWith("anon-tokyo/") &&
          !["live2d", "spine", "stories", "help"].includes(route.resource)
        )
          await catalogCollectionData(route.resource, server, locale);
      }
      for (const kind of ["missions", "studio", "tgw-card"] as const) await catalogSystemData(kind, server, locale);
      for (const mode of ANON_TOKYO_MODES) await catalogSystemData("anon-tokyo", server, locale, mode);
      for (const resource of ["stories", "live2d", "spine", "help"] as const)
        await workspaceCollectionData(resource, server, locale);
    }
  }
  await appRelease();
  await publicForumDirectory();
  await rankingCardsPageData();
  await eventTrackerPageData();
  await stampMakerPageData();
  await sonolusHubPageData();
  await playlistPageData();
  for (const locale of LOCALES) {
    console.log(`capture provider ${locale}`);
    await providerCollectionData("bestdori", locale, "songs");
    await providerCollectionData("sekai", locale, "songs");
    for (const section of ["event", "band", "main", "afterlive", "card"])
      await providerCollectionData("bestdori", locale, `stories/${section}`);
    for (const section of SEKAI_STORY_SECTIONS) await providerCollectionData("sekai", locale, `stories/${section}`);
  }
  if (staticPageGroupEnabled("provider")) {
    for (const entry of providerEntityManifest().entries) readProviderEntityPayload(entry);
  }
  if (staticPageGroupEnabled("assets")) {
    for (const entry of await assetStaticPaths())
      await assetViewData(
        entry.params.server as ReleaseServer,
        entry.params.locale,
        entry.props.path,
        entry.props.selected,
      );
  }
  const manifest = await finishStaticBuildInputs();
  console.log(
    JSON.stringify({
      captured: manifest?.records.length,
      files: manifest?.files.length,
      unavailableInputs: manifest?.records.filter((record) => record.format === "error").map((record) => record.key),
    }),
  );
}
