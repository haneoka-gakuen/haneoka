import { LOCALES } from "../i18n/locales";
import { ROUTES } from "../config/routes";
import { SEKAI_STORY_SECTIONS } from "../config/navigation";
import { ANON_TOKYO_MODES, type ReleaseServer } from "../lib/resource-route";
import { catalogEntityData, staticCatalogPageServers, ENTITY_PAYLOAD_RESOURCES, entityProjectionMetrics } from "../lib/entity-graph";
import { searchableCatalogPages } from "../lib/searchable-catalog";
import { searchableModelPages } from "../lib/searchable-models";
import { searchableStoryPages } from "../lib/searchable-stories";
import { searchableHelpPages } from "../lib/searchable-help";
import { crossCatalogRows, isCrossCatalogResource } from "../lib/cross-server/definitions";
import {
  fetchStaticCatalog,
  primeStaticCatalogBatch,
  staticCatalogRelease,
  staticCatalogBlobMetrics,
  staticCatalogJsonMetrics,
} from "../lib/static-catalog-source";
import { appRelease } from "./app-release";
import { sponsorList } from "./sponsors";
import { publicForumDirectory } from "./public-forum-directory";
import { homePageData } from "./home-page-data";
import { destinationHubMedia } from "./destination-hub-data";
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
import { chartRates } from "./chart-rates";
import { finishStaticBuildInputs } from "./static-input-store";
import { highScoreRatingPageData } from "./high-score-rating-page-data";
import { growthPageData } from "./growth-page-data";

async function prepareAll(tasks: Array<() => Promise<unknown>>): Promise<void> {
  let cursor = 0;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(4, tasks.length) }, async () => {
      while (cursor < tasks.length) {
        const index = cursor++, task = tasks[index]!;
        try {
          await task();
        } catch (error) {
          throw new Error(`Static input producer ${task.name || index} failed`, { cause: error });
        }
      }
    }),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

/** Execute production data producers once before locale render workers start. */
export async function prepareStaticInputs(): Promise<void> {
  if (process.env.STATIC_BUILD_INPUT_MODE !== "capture") throw new Error("Static preparation requires capture mode");
  const servers = await staticCatalogPageServers();
  const configured = await staticCatalogPageServers(true);
  for (const server of servers) {
    const pin = await staticCatalogRelease(server);
    console.log(`capture native ${server}/${pin.releaseId}`);
    const pages = await searchableCatalogPages(server);
    await prepareAll([
      () => assetPageData(server),
      () => skillCatalogPayload(server),
      () => publicSongsPageData(server),
      () => teamBuilderPageData(server),
      () => chartRates(server),
      () => songPuzzlePageData(server),
      () => highScoreRatingPageData(server),
    ]);
    if (configured.includes(server)) {
      await prepareAll([
        () => searchableModelPages(server),
        () => searchableStoryPages(server),
        () => searchableHelpPages(server),
      ]);
      for (const page of pages) {
        if (ENTITY_PAYLOAD_RESOURCES.includes(page.resource as (typeof ENTITY_PAYLOAD_RESOURCES)[number]))
          await catalogEntityData(server, page.resource, page.id);
      }
      for (const page of await searchableStoryPages(server))
        await catalogEntityData(server, "stories", page.storyId);
      for (const kind of ["missions", "tgw-card"] as const) {
        const first = pages.find((page) => page.resource === kind);
        if (first) await catalogSystemEntityData(kind, server, first.id);
      }
    }
    await prepareAll(
      ENTITY_PAYLOAD_RESOURCES.flatMap((resource) => isCrossCatalogResource(resource) ? [async () => {
        const document = await fetchStaticCatalog(resource, server, pin);
        await primeStaticCatalogBatch(resource, Object.keys(crossCatalogRows(resource, document)), server, pin);
      }] : []),
    );
    for (const locale of LOCALES) {
      console.log(`capture localized ${server}/${locale}`);
      const tasks: Array<() => Promise<unknown>> = [
        () => homePageData(server, locale),
        () => loadCalendarData(server, locale),
        () => announcementPageData(server, locale),
        () => growthPageData(server, locale),
      ];
      for (const route of ROUTES) {
        if (
          route.kind === "catalog" &&
          route.resource &&
          !route.resource.startsWith("anon-tokyo/") &&
          !["live2d", "spine", "stories", "help"].includes(route.resource)
        )
          tasks.push(() => catalogCollectionData(route.resource!, server, locale));
      }
      for (const kind of ["missions", "studio", "tgw-card", "arena"] as const)
        tasks.push(() => catalogSystemData(kind, server, locale));
      for (const mode of ANON_TOKYO_MODES) tasks.push(() => catalogSystemData("anon-tokyo", server, locale, mode));
      for (const resource of ["stories", "live2d", "spine", "help"] as const)
        tasks.push(() => workspaceCollectionData(resource, server, locale));
      for (const id of ["catalog", "stories", "tools", "games", "community"] as const)
        tasks.push(() => destinationHubMedia(id, server, locale));
      await prepareAll(tasks);
    }
  }
  await prepareAll([
    appRelease,
    sponsorList,
    publicForumDirectory,
    rankingCardsPageData,
    eventTrackerPageData,
    stampMakerPageData,
    sonolusHubPageData,
    playlistPageData,
  ]);
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
      entityProjection: entityProjectionMetrics(),
      files: manifest?.files.length,
      entityProjectionRecords: manifest?.records.filter(record => record.role === "entity-projection").length,
      entityProjectionUniqueBytes: [...new Map(manifest?.records.filter(record => record.role === "entity-projection")
        .map(record => [record.sha256, record.bytes])).values()].reduce((sum, bytes) => sum + bytes, 0),
      nativeBlobs: staticCatalogBlobMetrics(),
      nativeJson: staticCatalogJsonMetrics(),
      unavailableInputs: manifest?.records.filter((record) => record.format === "error").map((record) => record.key),
    }),
  );
}
