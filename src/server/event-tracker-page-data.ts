import { fetchStaticCatalog, fetchStaticCatalogBatch, staticCatalogRelease } from "../lib/static-catalog-source";
import { pinCrossCatalogValue } from "../lib/cross-server/presentation";
import type { EventTrackerDto, GameRecordsRegion, TrackedEventDto } from "../lib/game-records";
import type { EventTrackerSnapshot, TrackerRailEvent } from "../lib/event-tracker-page-data";
import type { TrackerPageData } from "../lib/event-tracker-page-data";
import { rankingCardCatalog } from "../lib/ranking-card-catalog";
import { entityGraph } from "../lib/entity-graph";
import { staticBuildJson } from "./static-input-store";

let page: Promise<TrackerPageData> | undefined;
export function eventTrackerPageData(): Promise<TrackerPageData> {
  return (page ||= (async () => {
    const [intl, jp, snapshots, events, musicTypeMarks, songPerformers] = await Promise.all([
      rankingCardCatalog("intl"),
      rankingCardCatalog("jp"),
      eventTrackerSnapshots(),
      Promise.all((["intl", "jp"] as const).map(async (source) => [source, await railEvents(source)] as const)).then(Object.fromEntries),
      Promise.all(
        (["intl", "jp"] as const).map(async (source) => {
          const graph = await entityGraph(source);
          return [
            source,
            Object.fromEntries(
              Object.entries(graph.marks)
                .filter(([name]) =>
                  /^(?:sp_icon_live_music_type_\d+|CardType-(?:Red|Blue|Green|Yellow|Purple))\.png$/u.test(name),
                )
                .map(([name, path]) => [name, `/runtime/${source}/${path.replace(/^runtime\//u, "")}`]),
            ),
          ];
        }),
      ).then(Object.fromEntries),
      Promise.all(
        (["intl", "jp"] as const).map(async (source) => {
          const graph = await entityGraph(source);
          const pin = { ...graph.release, server: source };
          return [
            source,
            {
              sourceId: graph.release.sourceId,
              bands: pinCrossCatalogValue([...graph.bands.values()], pin),
              characters: pinCrossCatalogValue([...graph.characters.values()], pin),
            },
          ];
        }),
      ).then(Object.fromEntries),
    ]);
    return { schema: "haneoka-event-tracker-page-v1", intl, jp, snapshots, events, musicTypeMarks, songPerformers };
  })());
}

async function railEvents(server: "intl" | "jp"): Promise<TrackerRailEvent[]> {
  const identity = await staticCatalogRelease(server);
  const list = (await fetchStaticCatalog("events", server, identity)) as { entries?: Record<string, Record<string, unknown>> } | null;
  const first = (value: unknown) => Number(Array.isArray(value) ? value[0] : value) || 0;
  return (pinCrossCatalogValue(Object.values(list?.entries ?? {}), { ...identity, server }) as Record<string, unknown>[]).map((entry) => ({
    id: String(entry.id),
    title: entry.title,
    image: String(entry.image || entry.logo || ""),
    startAtMs: first(entry.startAt),
    endAtMs: first(entry.endAt),
  }));
}

async function buildJson<T>(region: GameRecordsRegion, name: string, path: string): Promise<T | undefined> {
  return staticBuildJson(`event-tracker:${region}${name}`, "public-data", async () => {
    try {
      const response = await fetch(new URL(`/api/v1/game/records/${region}/events/${path}`, origin), {
        headers: {
          accept: "application/json",
          ...(process.env.STATIC_CATALOG_TOKEN ? { "x-haneoka-build-token": process.env.STATIC_CATALOG_TOKEN } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
      return response.ok ? ((await response.json()) as T) : undefined;
    } catch {
      return undefined;
    }
  });
}

const snapshots = new Map<GameRecordsRegion, Promise<EventTrackerSnapshot>>();
const origin = process.env.STATIC_OPERATION_ORIGIN || process.env.STATIC_CATALOG_ORIGIN || "https://haneoka.org";
export function eventTrackerSnapshots() {
  return Promise.all(
    (["jp", "tw", "en", "kr"] as const).map(async (region) => [region, await snapshot(region)] as const),
  ).then(Object.fromEntries);
}
function snapshot(region: GameRecordsRegion): Promise<EventTrackerSnapshot> {
  let pending = snapshots.get(region);
  if (!pending) {
    pending = loadSnapshot(region);
    snapshots.set(region, pending);
  }
  return pending;
}
async function loadSnapshot(region: GameRecordsRegion): Promise<EventTrackerSnapshot> {
  const preferred = region === "jp" ? "jp" : "intl";
  const [data, archived] = await Promise.all([
    buildJson<EventTrackerDto>(region, "", "current"),
    buildJson<{ events: TrackedEventDto[] }>(region, ":archive", "archive"),
  ]);
  const archive = archived?.events ?? [];
  if (!data) return { phase: "error", data: null, info: null, songs: {}, infoServer: preferred, archive };
  if (data.region !== region || !("event" in data)) throw new TypeError("Invalid event tracker snapshot identity");
  const snapshot: EventTrackerSnapshot = { phase: "ready", data, info: null, songs: {}, infoServer: preferred, archive };
  if (!data.event) return snapshot;
  const candidates = preferred === "jp" ? (["jp", "intl"] as const) : (["intl", "jp"] as const);
  for (const server of candidates) {
    const identity = await staticCatalogRelease(server);
    const ids = data.event.challenges.filter((row) => !snapshot.songs[row.musicId]).map((row) => row.musicId);
    const [event, songs] = await Promise.allSettled([
      snapshot.info ? Promise.resolve(null) : fetchStaticCatalog(`events/${data.event.id}`, server, identity),
      fetchStaticCatalogBatch("songs", ids, server, identity),
    ]);
    if (!snapshot.info && event.status === "fulfilled" && event.value) {
      snapshot.info = pinCrossCatalogValue(event.value, { ...identity, server }) as Record<string, unknown>;
      snapshot.infoServer = server;
    }
    if (songs.status === "fulfilled")
      for (const [id, song] of songs.value)
        snapshot.songs[id] = {
          ...(pinCrossCatalogValue(song, { ...identity, server }) as Record<string, unknown>),
          catalogSourceServer: server,
        };
    if (snapshot.info && data.event.challenges.every((row) => snapshot.songs[row.musicId])) break;
  }
  return snapshot;
}
