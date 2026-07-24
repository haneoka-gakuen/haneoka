import type { Band, Song } from "~/types/archive";
import type { CompositeEntityVisual } from "~/types/compositeVisual";
import type { DisplayText } from "~/types/displayText";
import type { CatalogContentOrigin, ContentOrigin, OurNotesReleaseId } from "~/features/catalog/contentSource";
import type { GarupaPlaylist, GarupaPlaylistTrack, ResolvedPlaylist, ResolvedPlaylistTrack } from "~/types/playlists";
import {
  bestdoriOrigin,
  contentLocaleForOrigin,
  contentOriginKey,
  isBestdoriOrigin,
  ourNotesReleaseOrigin,
  releaseFallbackOrder,
} from "~/features/catalog/contentSource";
import { songReleaseTimestamp } from "~/features/catalog/songSources";
import { resolveArchiveValue, type ArchiveLocale } from "~/i18n/locales";
import { langOf, textOf } from "~/types/displayText";

type ReleaseOrigin = Extract<ContentOrigin, { provider: "release" }>;

interface ReleaseCatalogRequest {
  origin: MaybeRefOrGetter<ReleaseOrigin>;
  songs: ReturnType<typeof useCatalogCollection<Song>>;
  bands: ReturnType<typeof useCatalogCollection<Band>>;
}

interface ReleaseCatalog {
  origin: ReleaseOrigin;
  songByTitle: ReadonlyMap<string, Song>;
  songsById: ReadonlyMap<number, Song>;
  bands: ReadonlyMap<number, Band>;
}

const titleKey = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("ja")
    .replace(/[\p{P}\p{S}\s]+/gu, "");

const stageAssetNumber = (playlist: GarupaPlaylist): string => {
  const match = playlist.assetBundleName?.match(/(\d+)$/u);
  return match?.[1] || String(playlist.sourceId);
};

const japaneseText = (value: Parameters<typeof resolveArchiveValue>[0], fallback = ""): DisplayText =>
  resolveArchiveValue(value, "ja", { sourceHint: "ja", fallback }) || fallback;

const bandVisualsFor = (
  song: Song,
  bands: ReadonlyMap<number, Band>,
  labelForBand: (band: Band) => DisplayText,
): CompositeEntityVisual[] => {
  const bandIds = [...new Set((song.bandIds?.length ? song.bandIds : [song.bandId]).map(Number).filter(Boolean))];
  return bandIds.flatMap((bandId) => {
    const band = bands.get(bandId);
    if (!band) return [];
    const images = [band.logo, band.icon].filter((image): image is string => Boolean(image));
    const label = labelForBand(band);
    return [
      {
        ...(images[0] ? { image: images[0] } : {}),
        ...(images.length > 1 ? { imageCandidates: images } : {}),
        ...(images.length ? {} : { text: textOf(label), lang: langOf(label), icon: "groups" }),
        ...(band.color ? { color: band.color } : {}),
        fit: "contain" as const,
      },
    ];
  });
};

const songByJapaneseTitle = (songs: readonly Song[]): ReadonlyMap<string, Song> => {
  const byTitle = new Map<string, Song>();
  for (const song of [...songs].sort((left, right) => left.musicId - right.musicId)) {
    const key = titleKey(textOf(japaneseText(song.musicTitle, String(song.musicId))));
    if (key && !byTitle.has(key)) byTitle.set(key, song);
  }
  return byTitle;
};

const releaseCatalog = (request: ReleaseCatalogRequest): ReleaseCatalog => {
  const songs = recordValues(request.songs.data.value);
  const bands = recordValues(request.bands.data.value);
  return {
    origin: toValue(request.origin),
    songByTitle: songByJapaneseTitle(songs),
    songsById: new Map(songs.map((song) => [song.musicId, song])),
    bands: new Map(bands.map((band) => [band.bandId, band])),
  };
};

/**
 * R2's v1 positions remain immutable Garupa Master definition positions.
 * Band playlists get their user-visible IDs in release order only after their
 * concrete source has been resolved: publication time, Bestdori before an
 * Our Notes release on equal timestamps, then a stable music/definition tie.
 */
const chronologicalBandTracks = (tracks: readonly ResolvedPlaylistTrack[]): ResolvedPlaylistTrack[] =>
  [...tracks]
    .sort((left, right) => {
      const leftTimestamp = left.song ? songReleaseTimestamp(left.song) : undefined;
      const rightTimestamp = right.song ? songReleaseTimestamp(right.song) : undefined;
      if (leftTimestamp === undefined && rightTimestamp !== undefined) return 1;
      if (leftTimestamp !== undefined && rightTimestamp === undefined) return -1;
      if (leftTimestamp !== undefined && rightTimestamp !== undefined && leftTimestamp !== rightTimestamp)
        return leftTimestamp - rightTimestamp;

      const sourceOrder = (track: ResolvedPlaylistTrack) => (isBestdoriOrigin(track.origin) ? 0 : track.origin ? 1 : 2);
      const sourceDifference = sourceOrder(left) - sourceOrder(right);
      if (sourceDifference) return sourceDifference;

      const musicDifference =
        (left.song?.musicId || left.definition.musicId) - (right.song?.musicId || right.definition.musicId);
      return musicDifference || left.definition.position - right.definition.position;
    })
    .map((track, index) => ({ ...track, position: index + 1 }));

/**
 * Resolves Garupa definition tracks without treating Bestdori as an Our Notes
 * resource server. The selected release wins, configured releases form the
 * ordered fallback chain, and the track's explicit Bestdori region is last.
 */
export const usePlaylistCatalog = () => {
  const garupa = useGarupaPlaylists();
  const { locale } = useLocale();
  const { releaseServer, fallbackReleaseServers, releases: releaseRegistry } = useReleaseServer();
  const catalogText = (
    value: Parameters<typeof resolveArchiveValue>[0],
    origin: CatalogContentOrigin,
    fallback = "",
    fallbackSourceHint: ArchiveLocale | null = "ja",
  ): DisplayText => {
    const sourceLocale = contentLocaleForOrigin(origin, releaseRegistry.value);
    return (
      resolveArchiveValue(value, locale.value, {
        sourceHint: sourceLocale,
        fallback,
        fallbackSourceHint,
      }) || fallback
    );
  };

  // Always request the currently selected release reactively: an active
  // release discovered through the registry may not be part of the configured
  // fallback policy, but it still gets first chance to resolve a playlist
  // track. The remaining requests are the deliberate fallback chain.
  const selectedReleaseOrigin = computed<ReleaseOrigin>(() => ourNotesReleaseOrigin(releaseServer.value));
  const configuredReleaseIds = [
    ...new Set(fallbackReleaseServers.value.map((value) => String(value).trim()).filter(Boolean)),
  ] as OurNotesReleaseId[];
  const releaseRequests: ReleaseCatalogRequest[] = [
    {
      origin: selectedReleaseOrigin,
      songs: useCatalogCollection<Song>("songs", selectedReleaseOrigin),
      bands: useCatalogCollection<Band>("bands", selectedReleaseOrigin),
    },
    ...configuredReleaseIds.map((releaseId) => {
      const origin = ourNotesReleaseOrigin(releaseId);
      return {
        origin,
        songs: useCatalogCollection<Song>("songs", origin),
        bands: useCatalogCollection<Band>("bands", origin),
      };
    }),
  ];

  // Garupa Master definitions are Japanese, so their fallback asset reference
  // is explicitly Bestdori JP rather than the UI locale's Bestdori region.
  const bestdoriCatalogOrigin = bestdoriOrigin("jp");
  const bestdoriSongs = useCatalogCollection<Song>("songs", bestdoriCatalogOrigin);
  const bestdoriBands = useCatalogCollection<Band>("bands", bestdoriCatalogOrigin);

  const data = computed<ResolvedPlaylist[]>(() => {
    const releases = releaseRequests.map(releaseCatalog);
    const releasesById = new Map<OurNotesReleaseId, ReleaseCatalog>();
    // The reactive selected request appears first, so it wins over a static
    // request for the same release while that request is changing sources.
    for (const release of releases) {
      if (!releasesById.has(release.origin.releaseId)) releasesById.set(release.origin.releaseId, release);
    }
    const bestdoriSongsById = new Map(recordValues(bestdoriSongs.data.value).map((song) => [song.musicId, song]));
    const bestdoriBandsById = new Map(recordValues(bestdoriBands.data.value).map((band) => [band.bandId, band]));
    const fallbackOrigins = releaseFallbackOrder(releaseServer.value, fallbackReleaseServers.value);

    const makeResolvedTrack = (
      definition: GarupaPlaylistTrack,
      origin: CatalogContentOrigin,
      song: Song,
      bands: ReadonlyMap<number, Band>,
    ): ResolvedPlaylistTrack => {
      const sourceBand = bands.get(song.bandId || 0);
      return {
        position: definition.position,
        definition,
        origin,
        language: "ja",
        song,
        title: catalogText(song.musicTitle, origin, definition.title || String(song.musicId)),
        artist: catalogText(song.artistName || sourceBand?.bandName || "", origin, definition.bandName || ""),
        bandVisuals: bandVisualsFor(song, bands, (band) =>
          catalogText(band.bandName, origin, String(band.bandId), null),
        ),
        available: Boolean(song.musicUrl),
        ...(song.musicUrl ? {} : { missingReason: "audio-unavailable" }),
      };
    };

    const unavailableTrack = (definition: GarupaPlaylistTrack, missingReason: string): ResolvedPlaylistTrack => ({
      position: definition.position,
      definition,
      origin: null,
      language: "ja",
      song: null,
      title: japaneseText(definition.title, String(definition.musicId)),
      artist: japaneseText(definition.bandName || "", ""),
      bandVisuals: [],
      available: false,
      missingReason,
    });

    const resolveTrack = (definition: GarupaPlaylistTrack): ResolvedPlaylistTrack => {
      if (!definition.available) return unavailableTrack(definition, definition.missingReason || "music-not-in-master");

      const key = titleKey(definition.title);
      let matchedOurNotesMusicId: number | undefined;
      if (key) {
        for (const origin of fallbackOrigins) {
          const catalog = releasesById.get(origin.releaseId);
          const titleMatch = catalog?.songByTitle.get(key);
          // The first cross-game title match identifies an Our Notes music ID.
          // Release servers share that ID, so later fallbacks prefer it over a
          // second potentially ambiguous title match.
          const song =
            (matchedOurNotesMusicId === undefined ? undefined : catalog?.songsById.get(matchedOurNotesMusicId)) ||
            titleMatch;
          if (song && matchedOurNotesMusicId === undefined) matchedOurNotesMusicId = song.musicId;
          if (song?.musicUrl && catalog) return makeResolvedTrack(definition, origin, song, catalog.bands);
        }
      }

      const assetRef = definition.assetRef;
      if (assetRef?.kind === "song" && isBestdoriOrigin(assetRef.origin)) {
        // The JP Garupa projection currently emits this one exact origin. Do
        // not silently substitute a locale-selected Bestdori region.
        if (contentOriginKey(assetRef.origin) === contentOriginKey(bestdoriCatalogOrigin)) {
          const song = bestdoriSongsById.get(assetRef.musicId);
          if (song?.musicUrl) return makeResolvedTrack(definition, assetRef.origin, song, bestdoriBandsById);
        }
      }

      return unavailableTrack(definition, "no-source-match");
    };

    return (garupa.data.value?.playlists || []).map((playlist) => {
      const band = playlist.bandId ? bestdoriBandsById.get(playlist.bandId) : undefined;
      const bandImages = band ? [band.logo, band.icon].filter((image): image is string => Boolean(image)) : [];
      const tracks = playlist.tracks.map(resolveTrack);
      return {
        ...playlist,
        language: "ja",
        // A stage challenge may carry a band ID for filtering/visual context,
        // but its own master-data title remains the playlist title.
        titleText: japaneseText(
          playlist.source === "band" ? band?.bandName || playlist.title : playlist.title,
          playlist.title,
        ),
        thumbnail:
          playlist.source === "band"
            ? bandImages[0]
            : `/api/v1/garupa/bestdori/jp/media/stage-challenge/${stageAssetNumber(playlist)}`,
        filterVisual:
          playlist.source === "band" && band
            ? {
                ...(bandImages[0] ? { image: bandImages[0] } : {}),
                ...(bandImages.length > 1 ? { imageCandidates: bandImages } : {}),
                ...(bandImages.length ? {} : { text: textOf(japaneseText(band.bandName, String(band.bandId))) }),
                ...(band.color ? { color: band.color } : {}),
                fit: "contain" as const,
              }
            : undefined,
        bandKeys: playlist.bandId ? [`garupa:bestdori:jp:band:${playlist.bandId}`] : [],
        tracks: playlist.source === "band" ? chronologicalBandTracks(tracks) : tracks,
      } satisfies ResolvedPlaylist;
    });
  });

  const pending = computed(
    () =>
      garupa.pending.value ||
      releaseRequests.some((request) => request.songs.pending.value || request.bands.pending.value) ||
      bestdoriSongs.pending.value ||
      bestdoriBands.pending.value,
  );
  const error = computed(() => garupa.error.value);
  const refresh = async () => {
    await Promise.all([
      garupa.refresh(),
      bestdoriSongs.refresh(),
      bestdoriBands.refresh(),
      ...releaseRequests.flatMap((request) => [request.songs.refresh(), request.bands.refresh()]),
    ]);
  };

  return { data, pending, error, refresh };
};
