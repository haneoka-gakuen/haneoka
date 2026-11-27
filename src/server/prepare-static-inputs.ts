// L3 — GEB
// Input: Fixed resource releases and normal production page data producers.
// Output: Complete captured values, the current visibility snapshot and a release-consistent publication registry.
// Pos: [Map](L2-2.md); shared preparation for independent locale and route partitions.
// Effects/Dependencies: Uses captured readers and records the registry as a verified build input.
import { LOCALES } from "../i18n/locales";
import { ROUTES } from "../config/routes";
import { SEKAI_STORY_SECTIONS } from "../config/navigation";
import { ANON_TOKYO_MODES, resourceKindForCollection, type ReleaseServer } from "../lib/resource-route";
import fs from "node:fs";
import path from "node:path";
import { publicationFields } from "../lib/content-publication";
import { visibilityType } from "../lib/content-visibility-policy";
import { eventSongPayload } from "./event-song-release";
import {
  catalogEntityData,
  hasCatalogEntityData,
  staticCatalogPageServers,
  ENTITY_PAYLOAD_RESOURCES,
  ENTITY_PAYLOAD_SCHEMA,
  STORY_PAYLOAD_SCHEMA,
  entityProjectionMetrics,
} from "../lib/entity-graph";
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
import { themeCharacters } from "./theme-characters";
import { homePageData } from "./home-page-data";
import { destinationHubMedia } from "./destination-hub-data";
import { loadCalendarData } from "./calendar";
import { announcementPageData } from "./announcement-page-data";
import { catalogCollectionData } from "./catalog-collection";
import { catalogSystemData, catalogSystemEntityData } from "./catalog-system-data";
import { workspaceCollectionData } from "./workspace-page-data";
import { skillCatalogPayload, skillPageId } from "./skill-catalog";
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
import { staticBuildJson, captureStaticBuildFile, finishStaticBuildInputs } from "./static-input-store";
import { highScoreRatingPageData } from "./high-score-rating-page-data";
import { growthPageData } from "./growth-page-data";
import { captureStaticVisibility } from "./static-visibility";

async function prepareAll(tasks: Array<() => Promise<unknown>>): Promise<void> {
  let cursor = 0;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(4, tasks.length) }, async () => {
      while (cursor < tasks.length) {
        const index = cursor++,
          task = tasks[index]!;
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
  await captureStaticVisibility();
  const servers = await staticCatalogPageServers();
  const configured = await staticCatalogPageServers(true);
  const publications: Record<string, Record<string, Record<string, unknown>>> = {};
  const recordPublication = (server: string, kind: string, id: string, value: unknown) => {
    const type = visibilityType(kind);
    if (!type) return;
    (publications[server] ??= {})[`${type}:${id}`] = publicationFields(
      value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {},
    );
  };
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
      const entityPages = pages.filter((page) =>
        ENTITY_PAYLOAD_RESOURCES.includes(page.resource as (typeof ENTITY_PAYLOAD_RESOURCES)[number]),
      );
      const stories = await searchableStoryPages(server);
      publications[server] = await staticBuildJson(
        `native-publications:${JSON.stringify(pin)}`,
        "publication-registry",
        async () => {
          for (const page of entityPages) {
            const payload = await catalogEntityData(server, page.resource, page.id);
            const entity = payload?.schema === ENTITY_PAYLOAD_SCHEMA ? await eventSongPayload(payload) : undefined;
            recordPublication(
              server,
              resourceKindForCollection(page.collection) || page.resource,
              page.id,
              entity?.item,
            );
          }
          for (const page of stories) {
            const payload = await catalogEntityData(server, "stories", page.storyId);
            recordPublication(
              server,
              "stories",
              page.storyId,
              payload?.schema === STORY_PAYLOAD_SCHEMA ? payload.episodes[page.storyId] : undefined,
            );
          }
          for (const page of await searchableModelPages(server))
            recordPublication(server, page.kind, page.id, page.model);
          for (const page of await searchableHelpPages(server))
            recordPublication(server, "help", page.id, page.publication);
          for (const entry of (await skillCatalogPayload(server)).entries)
            recordPublication(server, "skills", skillPageId(entry), entry);
          for (const kind of ["missions", "tgw-card"] as const) {
            for (const page of pages.filter((page) => page.resource === kind)) {
              const entity = await catalogSystemEntityData(kind, server, page.id);
              recordPublication(server, kind, page.id, entity.document);
            }
          }
          return publications[server] || {};
        },
      );
      for (const page of entityPages)
        if (!hasCatalogEntityData(pin, page.resource, page.id)) await catalogEntityData(server, page.resource, page.id);
      for (const page of stories)
        if (!hasCatalogEntityData(pin, "stories", page.storyId))
          await catalogEntityData(server, "stories", page.storyId);
    }
    await prepareAll(
      ENTITY_PAYLOAD_RESOURCES.flatMap((resource) =>
        isCrossCatalogResource(resource)
          ? [
              async () => {
                const document = await fetchStaticCatalog(resource, server, pin);
                await primeStaticCatalogBatch(resource, Object.keys(crossCatalogRows(resource, document)), server, pin);
              },
            ]
          : [],
      ),
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
    () => themeCharacters("en"),
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
  const publicationFile = path.resolve(".output/static-inputs/publications.json");
  fs.mkdirSync(path.dirname(publicationFile), { recursive: true });
  fs.writeFileSync(publicationFile, JSON.stringify(publications));
  captureStaticBuildFile(publicationFile, "publications");
  const manifest = await finishStaticBuildInputs();
  console.log(
    JSON.stringify({
      captured: manifest?.records.length,
      entityProjection: entityProjectionMetrics(),
      files: manifest?.files.length,
      entityProjectionRecords: manifest?.records.filter((record) => record.role === "entity-projection").length,
      entityProjectionUniqueBytes: [
        ...new Map(
          manifest?.records
            .filter((record) => record.role === "entity-projection")
            .map((record) => [record.sha256, record.bytes]),
        ).values(),
      ].reduce((sum, bytes) => sum + bytes, 0),
      nativeBlobs: staticCatalogBlobMetrics(),
      nativeJson: staticCatalogJsonMetrics(),
      unavailableInputs: manifest?.records.filter((record) => record.format === "error").map((record) => record.key),
    }),
  );
}
