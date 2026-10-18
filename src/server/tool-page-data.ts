import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  fetchStaticCatalog,
  fetchStaticApplicationJson,
  hasLocalStaticCatalog,
  fetchStaticReleaseJson,
  fetchStaticReleaseEntry,
  staticCatalogRelease,
  type StaticCatalogRelease,
} from "../lib/static-catalog-source";
import { adaptTeamBuilderData, objectRow, type TeamBuilderData } from "../lib/team-builder/data";
import { hydrateRuntimeDocuments } from "../lib/team-builder/data/complete";
import { readRuntimeRulesDocument } from "../lib/team-builder/data/runtime-rules";
import type { fetchCatalogVisuals } from "../lib/catalog-visuals";
import { goalBoard, shuffle } from "../lib/song-puzzle/model";
import { stampChoices, mergeTextlessStampManifests, type TextlessStampManifest } from "../lib/stamp-maker/catalog";
import type { HaneokaReleaseIdentity } from "../../packages/api-client/src/haneoka";
import { rankingCardCatalog } from "../lib/ranking-card-catalog";
import { PUBLIC_RELEASE_SERVERS, isPublicReleaseServer } from "../lib/temporary-public-routing.ts";
import { staticBuildJson } from "./static-input-store";
let rankingCards:
  | Promise<{
      intl: Awaited<ReturnType<typeof rankingCardCatalog>>;
      jp: Awaited<ReturnType<typeof rankingCardCatalog>>;
    }>
  | undefined;
export function rankingCardsPageData() {
  return (rankingCards ??= Promise.all([rankingCardCatalog("intl"), rankingCardCatalog("jp")]).then(([intl, jp]) => ({
    intl,
    jp,
  })));
}
export interface SonolusHubPageData {
  schema: "haneoka-sonolus-hub-page-v1";
  info: Record<string, unknown>;
  levels: Record<string, unknown>;
  playlists: Record<string, unknown>;
}
let sonolusHubPage: Promise<SonolusHubPageData> | undefined;
export function sonolusHubPageData(): Promise<SonolusHubPageData> {
  return (sonolusHubPage ??= (async () => {
    const origin = process.env.STATIC_CATALOG_ORIGIN || "https://haneoka.org";
    const read = (resource: string) =>
      staticBuildJson(`sonolus:${resource}`, "public-data", async () => {
        const response = await fetch(new URL(`/sonolus/${resource}`, origin), {
          signal: AbortSignal.timeout(30_000),
          headers: {
            accept: "application/json",
            ...(process.env.STATIC_CATALOG_TOKEN ? { "x-haneoka-build-token": process.env.STATIC_CATALOG_TOKEN } : {}),
          },
        });
        if (!response.ok) throw new Error(`Sonolus public directory ${resource} returned ${response.status}`);
        const value: unknown = await response.json();
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error(`Invalid Sonolus public directory ${resource}`);
        return value as Record<string, unknown>;
      });
    const [info, levels, playlists] = await Promise.all([read("info"), read("levels/info"), read("playlists/info")]);
    return { schema: "haneoka-sonolus-hub-page-v1", info, levels, playlists };
  })());
}

export interface PublicSongsPageData {
  schema: "haneoka-public-songs-page-v1";
  server: string;
  variants: Record<
    string,
    {
      identity: HaneokaReleaseIdentity;
      songs: Record<string, Record<string, unknown>>;
      bands: Record<string, unknown>;
      characters: Record<string, unknown>;
      marks: Record<string, unknown>;
    }
  >;
}
const publicSongPages = new Map<string, Promise<PublicSongsPageData>>();
export function publicSongsPageData(server: string): Promise<PublicSongsPageData> {
  let pending = publicSongPages.get(server);
  if (!pending) {
    pending = (async () => {
      if (!isPublicReleaseServer(server)) throw new Error(`Cannot publish tool data for ${server}`);
      const servers = [server, ...PUBLIC_RELEASE_SERVERS.filter((peer) => peer !== server)];
      const results = await Promise.allSettled(
        servers.map(async (peer) => {
          const identity = await staticCatalogRelease(peer);
          const [songs, bands, characters, marks] = await Promise.all(
            ["songs", "bands", "characters", "ui-marks"].map((resource) =>
              fetchStaticCatalog(resource, peer, identity),
            ),
          );
          return {
            identity: { schema: "haneoka-resource-release-identity-v1" as const, ...identity },
            songs: objectRow(songs) as Record<string, Record<string, unknown>>,
            bands: objectRow(bands),
            characters: objectRow(characters),
            marks: objectRow(marks),
          };
        }),
      );
      if (results[0]!.status === "rejected") throw results[0]!.reason;
      return {
        schema: "haneoka-public-songs-page-v1",
        server,
        variants: Object.fromEntries(
          results.flatMap((result, index) => (result.status === "fulfilled" ? [[servers[index]!, result.value]] : [])),
        ),
      };
    })();
    publicSongPages.set(server, pending);
  }
  return pending;
}

type Visuals = Omit<Awaited<ReturnType<typeof fetchCatalogVisuals>>, "marks"> & { marks: [string, string][] };
export interface TeamBuilderPageData {
  schema: "haneoka-team-builder-page-v1";
  server: string;
  sources: TeamBuilderData[];
  unavailableServers: string[];
  visuals: Record<string, Visuals>;
}
export interface SongPuzzlePageData {
  schema: "haneoka-song-puzzle-page-v1";
  server: string;
  songs: Record<string, Record<string, unknown>>;
  variants: Record<string, Record<string, Record<string, unknown>>>;
  cardData?: Record<string, { identity?: HaneokaReleaseIdentity; bands: Record<string, unknown>; characters: Record<string, unknown>; marks: Record<string, string> }>;
  tiles: number[];
}
export interface StampMakerPageData {
  schema: "haneoka-stamp-maker-page-v1";
  server: string;
  uiId: string;
  catalog: Record<string, unknown>;
  catalogs: Record<string, Record<string, unknown>>;
  characters: Record<string, unknown>;
  bands: Record<string, unknown>;
  textless: TextlessStampManifest;
  textlessByServer: Record<string, TextlessStampManifest>;
  manifests: unknown[];
}
const teamPages = new Map<string, Promise<TeamBuilderPageData>>();
const puzzlePages = new Map<string, Promise<SongPuzzlePageData>>();
let stampPage: Promise<StampMakerPageData> | undefined;
const resources = [
  "cards",
  "support-cards",
  "characters",
  "bands",
  "band-items",
  "songs",
  "events",
  "progression",
  "leader-skills",
  "skills",
  "gekisou-skills",
  "support-skills",
  "gekisou-support-skills",
  "skill-reference",
  "live-tools",
  "gekisou",
];
const sourceData = new Map<string, Promise<TeamBuilderData>>();
export function teamSource(server: string): Promise<TeamBuilderData> {
  let pending = sourceData.get(server);
  if (!pending) {
    pending = (async () => {
      const identity = await staticCatalogRelease(server);
      if (!hasLocalStaticCatalog(server)) {
        const data = (await fetchStaticApplicationJson(
          `/api/v1/team-builder/${encodeURIComponent(server)}`,
          identity,
        )) as TeamBuilderData;
        if (
          data.schema !== "haneoka-team-builder-data-v1" ||
          data.identity.server !== identity.server ||
          data.identity.releaseId !== identity.releaseId ||
          data.identity.sourceId !== identity.sourceId
        )
          throw new Error("Static team data projection identity mismatch");
        return data;
      }
      const read = (resource: string) => fetchStaticCatalog(resource, server, identity);
      const documents = Object.fromEntries(
        await Promise.all(resources.map(async (resource) => [resource, await read(resource)])),
      );
      documents["runtime-rules"] = await readRuntimeRulesDocument(identity, async (pin, table) => {
        const relative = `objects/master/${table}.json`;
        return (await fetchStaticReleaseEntry(relative, server, pin))
          ? fetchStaticReleaseJson(relative, server, pin)
          : null;
      });
      const events = objectRow(documents.events),
        entries = objectRow(events.entries);
      documents.events = {
        ...events,
        entries: Object.fromEntries(
          await Promise.all(
            Object.entries(entries).map(async ([id, row]) => [
              id,
              { ...objectRow(row), ...objectRow(await read(`events/${id}`)) },
            ]),
          ),
        ),
      };
      return adaptTeamBuilderData(
        identity,
        await hydrateRuntimeDocuments(documents, (resource, id) => read(`${resource}/${id}`)),
      );
    })();
    sourceData.set(server, pending);
  }
  return pending;
}
async function visuals(server: string): Promise<Visuals> {
  const identity = await staticCatalogRelease(server);
  const read = (resource: string) => fetchStaticCatalog(resource, server, identity);
  const [marks, characters, bands, songs, cards, supportCards, bandItems] = await Promise.all([
    read("ui-marks"),
    read("characters"),
    read("bands"),
    read("songs"),
    read("cards"),
    read("support-cards"),
    read("band-items"),
  ]);
  return {
    marks: Object.entries(objectRow(marks)).flatMap(([name, path]) =>
      typeof path === "string"
        ? [
            [name, `/runtime/${server}/${path.replace(/^runtime\//u, "")}?release=${identity.releaseId}`] as [
              string,
              string,
            ],
          ]
        : [],
    ),
    characters: objectRow(characters) as Record<string, Record<string, unknown>>,
    bands: objectRow(bands) as Record<string, Record<string, unknown>>,
    songs: objectRow(songs) as Record<string, Record<string, unknown>>,
    cards: objectRow(cards),
    supportCards: objectRow(supportCards),
    bandItems: objectRow(bandItems) as Record<string, Record<string, unknown>>,
  };
}
export function teamBuilderPageData(server: string): Promise<TeamBuilderPageData> {
  let pending = teamPages.get(server);
  if (!pending) {
    pending = (async () => {
      if (!isPublicReleaseServer(server)) throw new Error(`Cannot publish team data for ${server}`);
      const servers = [server, ...PUBLIC_RELEASE_SERVERS.filter((peer) => peer !== server)];
      const results = await Promise.allSettled(
        servers.map(async (peer) => ({ data: await teamSource(peer), visuals: await visuals(peer) })),
      );
      if (results[0]!.status === "rejected") throw results[0]!.reason;
      return {
        schema: "haneoka-team-builder-page-v1",
        server,
        sources: results.flatMap((result) => (result.status === "fulfilled" ? [result.value.data] : [])),
        visuals: Object.fromEntries(
          results.flatMap((result) =>
            result.status === "fulfilled" ? [[result.value.data.identity.server, result.value.visuals]] : [],
          ),
        ),
        unavailableServers: servers.filter((_, index) => results[index]!.status === "rejected"),
      };
    })();
    teamPages.set(server, pending);
  }
  return pending;
}
export function songPuzzlePageData(server: string): Promise<SongPuzzlePageData> {
  let pending = puzzlePages.get(server);
  if (!pending) {
    pending = (async () => {
      const read = async (peer: string) => {
        const identity = await staticCatalogRelease(peer);
        const [songs, bands, characters, marks] = await Promise.all(
          ["songs", "bands", "characters", "ui-marks"].map((resource) => fetchStaticCatalog(resource, peer, identity)),
        );
        return {
          songs: objectRow(songs) as Record<string, Record<string, unknown>>,
          cardData: {
            identity: { schema: "haneoka-resource-release-identity-v1" as const, ...identity, server: peer },
            bands: objectRow(bands), characters: objectRow(characters),
            marks: Object.fromEntries(Object.entries(objectRow(marks))
              .filter(([name]) => /^(?:sp_icon_live_music_type_\d+|CardType-(?:Red|Blue|Green|Yellow|Purple))\.png$/u.test(name))
              .map(([name, value]) => [name, `/runtime/${peer}/${String(value).replace(/^runtime\//u, "")}?release=${identity.releaseId}`])),
          },
        };
      };
      const servers = [server, ...["jp", "intl"].filter((peer) => peer !== server)];
      const results = await Promise.allSettled(servers.map(read));
      if (results[0]!.status === "rejected") throw results[0]!.reason;
      const variants = Object.fromEntries(
        results.flatMap((result, index) => (result.status === "fulfilled" ? [[servers[index]!, result.value.songs]] : [])),
      );
      const goal = goalBoard(3);
      return {
        schema: "haneoka-song-puzzle-page-v1",
        server,
        songs: variants[server]!,
        variants,
        cardData: Object.fromEntries(results.flatMap((result, index) => result.status === "fulfilled" ? [[servers[index]!, result.value.cardData]] : [])),
        tiles: shuffle({ size: 3, tiles: goal, goal }, 20),
      };
    })();
    puzzlePages.set(server, pending);
  }
  return pending;
}
export function stampMakerPageData(): Promise<StampMakerPageData> {
  return (stampPage ??= (async () => {
    const identity = await staticCatalogRelease("intl");
    const [catalog, characters, bands] = await Promise.all([
      fetchStaticCatalog("stamps", "intl", identity),
      fetchStaticCatalog("characters", "intl", identity),
      fetchStaticCatalog("bands", "intl", identity),
    ]);
    const catalogs = { intl: objectRow(catalog) } as Record<string, Record<string, unknown>>;
    const identities: Record<string, StaticCatalogRelease> = { intl: identity };
    const manifests: unknown[] = [];
    for (const [server, pin] of Object.entries(identities)) {
      if (await fetchStaticReleaseEntry("runtime/stamp-maker/manifest.json", server, pin))
        manifests.push(await fetchStaticReleaseJson("runtime/stamp-maker/manifest.json", server, pin));
    }
    const seen = new Set<string>();
    for (const directory of ["public", ".generated-public"]) {
      const root = path.join(process.cwd(), directory);
      for (const file of fs.globSync("tools/stamp-maker/assets/*/*/manifest.json", { cwd: root }).sort()) {
        const body = fs.readFileSync(path.join(root, file)),
          digest = createHash("sha256").update(body).digest("hex");
        if (seen.has(digest)) continue;
        seen.add(digest);
        const manifest = JSON.parse(body.toString("utf8"));
        if (isPublicReleaseServer(manifest.server)) manifests.push(manifest);
      }
    }
    const accepted: Record<string, TextlessStampManifest["records"]> = {};
    for (const input of manifests) {
      const manifest = objectRow(input);
      const server = typeof manifest.server === "string" ? manifest.server : "",
        pin = identities[server];
      if (manifest.schema !== "haneoka-textless-stamps-v1" || !pin) continue;
      const choices = stampChoices(catalogs[server]!, "ja");
      for (const value of Array.isArray(manifest.records) ? manifest.records : []) {
        const record = objectRow(value);
        if (record.publishable !== true || typeof record.id !== "string") continue;
        const choice = choices.find((choice) => choice.id === record.stampId || choice.resourceName === record.id);
        const sources = Array.isArray(record.sources) ? record.sources.map(objectRow) : [];
        if (!choice || !sources.length) continue;
        let matched = true;
        for (const source of sources) {
          if (
            typeof source.path !== "string" ||
            !source.path.startsWith(`/assets/${server}/`) ||
            !choice.sources.includes(source.path)
          ) {
            matched = false;
            break;
          }
          const original = await fetchStaticReleaseEntry(
            `assets/${source.path.slice(`/assets/${server}/`.length)}`,
            server,
            pin,
          );
          if (!original || original.sha256 !== source.sha256) {
            matched = false;
            break;
          }
        }
        if (!matched) continue;
        const artifacts = objectRow(record.artifacts),
          artifact = objectRow(artifacts.sourceImage ?? artifacts.nativeOriginal ?? artifacts.exportCandidate);
        if (typeof artifact.path !== "string" || typeof artifact.sha256 !== "string") continue;
        if (artifact.path.startsWith(`/tools/stamp-maker/assets/${server}/`)) {
          if (artifact.path.split("/").some((part) => part === ".." || part === ".")) continue;
          const file = ["public", ".generated-public"]
            .map((root) => path.join(process.cwd(), root, artifact.path as string))
            .find((file) => fs.existsSync(file));
          if (!file || createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== artifact.sha256) continue;
        } else if (artifact.path.startsWith(`/assets/${server}/`)) {
          const entry = await fetchStaticReleaseEntry(
            `assets/${artifact.path.slice(`/assets/${server}/`.length)}`,
            server,
            pin,
          );
          if (entry?.sha256 !== artifact.sha256) continue;
        } else continue;
        (accepted[server] ??= []).push({ ...record, stampId: choice.id } as TextlessStampManifest["records"][number]);
      }
    }
    return {
      schema: "haneoka-stamp-maker-page-v1",
      server: "intl",
      uiId: crypto.randomUUID(),
      catalog: objectRow(catalog),
      catalogs,
      characters: objectRow(characters),
      bands: objectRow(bands),
      manifests,
      textless: mergeTextlessStampManifests([
        { schema: "haneoka-textless-stamps-v1", server: "intl", records: accepted.intl ?? [] },
      ]),
      textlessByServer: Object.fromEntries(
        Object.entries(accepted).map(([server, records]) => [
          server,
          mergeTextlessStampManifests([{ schema: "haneoka-textless-stamps-v1", server, records }]),
        ]),
      ),
    };
  })());
}
