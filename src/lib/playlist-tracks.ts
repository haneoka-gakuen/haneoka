type RecordValue = Record<string, unknown>;
import { resolveSongPerformer, type PerformerRegistry, type PerformerPortrait } from "./song-performer";
import { resourcePath, isReleaseServer } from "./resource-route";
import { preferredLocale } from "../lit/shared/catalog";
import type { Locale } from "../i18n/locales";
export interface PlaylistCatalogSource {
  provider: "our-notes" | "bestdori";
  server: string;
  releaseId?: string;
  sourceId?: string;
  songs: Record<string, RecordValue>;
  registry: PerformerRegistry;
}
const sources = new Map<string, Promise<PlaylistCatalogSource>>();
export async function loadPlaylistCatalogSource(
  provider: "our-notes" | "bestdori",
  server: string,
): Promise<PlaylistCatalogSource> {
  const key = `${provider}:${server}`;
  let request = sources.get(key);
  if (!request) {
    request = (async () => {
      const base =
        provider === "bestdori"
          ? `/api/v1/garupa/bestdori/${encodeURIComponent(server)}`
          : `/api/v1/servers/${encodeURIComponent(server)}`;
      let releaseId: string | undefined, sourceId: string | undefined;
      if (provider === "our-notes") {
        const identity = await fetch(`${base}/release?projection=identity`, { method: "HEAD" });
        if (!identity.ok) throw new Error(`HTTP ${identity.status}`);
        releaseId = identity.headers.get("x-haneoka-release-id") || undefined;
        sourceId = identity.headers.get("x-haneoka-source-id") || undefined;
        if (!releaseId || !sourceId) throw new Error("Catalogue source identity unavailable");
      }
      const read = async (resource: string) => {
        const response = await fetch(
          `${base}/${resource}${releaseId ? `?release=${encodeURIComponent(releaseId)}` : ""}`,
          { headers: { accept: "application/json" } },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (
          provider === "our-notes" &&
          (response.headers.get("x-haneoka-release-id") !== releaseId ||
            response.headers.get("x-haneoka-source-id") !== sourceId)
        )
          throw new Error("Catalogue source identity changed");
        return (await response.json()) as RecordValue;
      };
      const [songRows, bandRows, charRows] = await Promise.all([read("songs"), read("bands"), read("characters")]);
      const rows = (document: RecordValue) =>
        Object.entries(document.items ?? document).filter(
          ([, value]) => value && typeof value === "object" && !Array.isArray(value),
        ) as Array<[string, RecordValue]>;
      return {
        provider,
        server,
        releaseId,
        sourceId,
        songs: Object.fromEntries(rows(songRows).map(([id, row]) => [String(row.musicId ?? row.id ?? id), row])),
        registry: {
          game: provider === "bestdori" ? "gbp" : "our-notes",
          server,
          sourceId,
          bands: new Map(rows(bandRows).map(([id, row]) => [Number(row.bandId ?? id), row])),
          characters: new Map(rows(charRows).map(([id, row]) => [Number(row.characterId ?? id), row])),
        },
      };
    })();
    sources.set(key, request);
    request.catch(() => sources.delete(key));
  }
  return request;
}

export function auditedCryChicPortraits(source: PlaylistCatalogSource): PerformerPortrait[] {
  // Display-only fallback from the authorized source: unique full Japanese identities.
  const names = new Set(["若葉睦", "豊川祥子"]);
  const japaneseIdentity = (row: RecordValue) => {
    const raw = Array.isArray(row.characterName) ? row.characterName[0] : row.characterName;
    return typeof raw === "string"
      ? raw
          .split(/[／/]/u)
          .map((name) => name.normalize("NFKC").replace(/\s+/gu, ""))
          .filter((name) => names.has(name))
      : [];
  };
  return [...source.registry.characters].flatMap(([id, row]) => {
    const identities = japaneseIdentity(row);
    if (identities.length !== 1) return [];
    const name = identities[0]!;
    if ([...source.registry.characters.values()].filter((other) => japaneseIdentity(other).includes(name)).length !== 1)
      return [];
    return [
      {
        key: `our-notes:${source.server}:${source.sourceId ?? source.releaseId ?? ""}:${id}`,
        provider: "our-notes" as const,
        server: source.server,
        sourceId: source.sourceId,
        id,
        name,
        image: String(row.faceImage ?? ""),
      },
    ];
  });
}
export async function resolvePlaylistTracks(tracks: RecordValue[], defaultServer: string): Promise<RecordValue[]> {
  return Promise.all(
    tracks.map(async (track) => {
      const ref = track.assetRef as RecordValue | undefined;
      if (ref?.kind !== "song") return track;
      if (ref.provider !== "bestdori" && ref.provider !== "our-notes") return { ...track, musicUrl: "", url: "" };
      const bestdori = ref.provider === "bestdori";
      const server = String(ref.server || defaultServer);
      const id = String(ref.musicId || track.musicId || "");
      const source = await loadPlaylistCatalogSource(bestdori ? "bestdori" : "our-notes", server);
      const song = source.songs[id];
      if (bestdori && !source.registry.portraitFallbacks) {
        try {
          source.registry = {
            ...source.registry,
            portraitFallbacks: auditedCryChicPortraits(await loadPlaylistCatalogSource("our-notes", defaultServer)),
          };
        } catch {
          /* Preserve actual GBP names when the portrait source is unavailable. */
        }
      }
      const performer = song ? resolveSongPerformer(song, source.registry) : undefined;
      return {
        ...track,
        ...song,
        assetRef: ref,
        id: `${String(ref.provider)}:${server}:${id}`,
        musicId: id,
        title: song?.musicTitle || song?.title || track.title,
        musicUrl: song?.musicUrl || track.musicUrl || "",
        ...(performer ? { displayPerformer: performer } : {}),
        detailPath: bestdori
          ? `/${preferredLocale()}/community/songs-bestdori/detail/?song=${encodeURIComponent(id)}`
          : isReleaseServer(server)
            ? resourcePath({ server, locale: preferredLocale() as Locale, kind: "songs", id })
            : `/catalog/songs?song=${encodeURIComponent(id)}`,
      };
    }),
  );
}
