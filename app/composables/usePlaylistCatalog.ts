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
} from "~/features/catalog/contentSource";
import { contributingSongBandIds } from "~/features/catalog/songCredits";
import { catalogBandLogo } from "~/features/catalog/songCreditVisuals";
import { songReleaseTimestamp } from "~/features/catalog/songSources";
import { resolveArchiveValue, type ArchiveLocale } from "~/i18n/locales";
import { langOf, textOf } from "~/types/displayText";

type ReleaseOrigin = Extract<ContentOrigin, { provider: "release" }>;

interface ReleaseCatalog {
  readonly origin: ReleaseOrigin;
  readonly songs: readonly Song[];
  readonly songByTitle: ReadonlyMap<string, Song>;
  readonly songsById: ReadonlyMap<number, Song>;
  readonly bands: ReadonlyMap<number, Band>;
}

interface TrackCandidate {
  readonly origin: CatalogContentOrigin;
  readonly song: Song;
  readonly bands: ReadonlyMap<number, Band>;
  /** Lower values win source selection: current release, other releases, Bestdori. */
  readonly priority: number;
}

interface BandReference {
  readonly key: string;
  readonly origin: CatalogContentOrigin;
  readonly band: Band;
  readonly bands: ReadonlyMap<number, Band>;
  readonly priority: number;
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

const songByJapaneseTitle = (songs: readonly Song[]): ReadonlyMap<string, Song> => {
  const byTitle = new Map<string, Song>();
  for (const song of [...songs].sort((left, right) => left.musicId - right.musicId)) {
    const key = titleKey(textOf(japaneseText(song.musicTitle, String(song.musicId))));
    if (key && !byTitle.has(key)) byTitle.set(key, song);
  }
  return byTitle;
};

const releaseCatalog = (
  origin: ReleaseOrigin,
  songRecords: Readonly<Record<string, Song>>,
  bandRecords: Readonly<Record<string, Band>>,
): ReleaseCatalog => {
  const songs = recordValues(songRecords);
  const bands = recordValues(bandRecords);
  return {
    origin,
    songs,
    songByTitle: songByJapaneseTitle(songs),
    songsById: new Map(songs.map((song) => [song.musicId, song])),
    bands: new Map(bands.map((band) => [band.bandId, band])),
  };
};

const bestdoriBandKey = (bandId: number): string => `bestdori:band:${bandId}`;
const ourNotesBandKey = (bandId: number): string => `our-notes:band:${bandId}`;

/**
 * Public playlist routes are identities, not provider/release identifiers.
 * Keep the Our Notes bands aligned with their established official slugs;
 * unknown future bands retain a neutral stable fallback until a slug is added.
 */
const OUR_NOTES_BAND_PLAYLIST_SLUGS: Readonly<Record<string, string>> = {
  [titleKey("MyGO!!!!!")]: "mygo",
  [titleKey("Ave Mujica")]: "ave-mujica",
  [titleKey("夢限大みゅーたいぷ")]: "yumemita",
  [titleKey("millsage")]: "millsage",
  [titleKey("一家 Dumb Rock!")]: "ikka-dumb-rock",
};

const latinSlug = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

const ourNotesBandPlaylistId = (band: Band): string => {
  const japaneseName = textOf(japaneseText(band.bandName, String(band.bandId)));
  const knownSlug = OUR_NOTES_BAND_PLAYLIST_SLUGS[titleKey(japaneseName)];
  if (knownSlug) return knownSlug;
  const englishName = textOf(resolveArchiveValue(band.bandName, "en", { sourceHint: "ja", fallback: "" }) || "");
  return latinSlug(englishName) || `band-${band.bandId}`;
};

const bandGroupForKey = (key: string): "our-notes" | "bestdori" =>
  key.startsWith("our-notes:band:") ? "our-notes" : "bestdori";

const compareTimeline = (left: number | undefined, right: number | undefined): number => {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left - right;
};

const sourceTieOrder = (origin: CatalogContentOrigin): number => (isBestdoriOrigin(origin) ? 0 : 1);

const bandVisualsFor = (
  song: Song,
  bands: ReadonlyMap<number, Band>,
  origin: CatalogContentOrigin,
  labelForBand: (band: Band) => DisplayText,
): CompositeEntityVisual[] => {
  const bandIds = [...new Set((song.bandIds?.length ? song.bandIds : [song.bandId]).map(Number).filter(Boolean))];
  return bandIds.flatMap((bandId) => {
    const band = bands.get(bandId);
    if (!band) return [];
    const images = [
      ...new Set(
        [catalogBandLogo(band, origin), band.icon, band.logo].filter((image): image is string => Boolean(image)),
      ),
    ];
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

/**
 * Builds the intentionally mixed Garupa playlist view without mutating the
 * immutable R2 definition document. A logical song appears once: all Our
 * Notes releases are searched in priority order, then Bestdori JP is the
 * final fallback. Band playlists additionally include source-exclusive songs
 * from every catalog, while stage challenges retain their fixed master list.
 */
export const usePlaylistCatalog = () => {
  const garupa = useGarupaPlaylists();
  const { locale } = useLocale();
  const { releaseServer, fallbackReleaseServers, releases: releaseRegistry } = useReleaseServer();
  const playlistReleaseOrigins = computed<ReleaseOrigin[]>(() => {
    const releaseIds = [
      releaseServer.value,
      ...fallbackReleaseServers.value,
      ...releaseRegistry.value.map((release) => release.id),
    ];
    const seen = new Set<OurNotesReleaseId>();
    return releaseIds.flatMap((releaseId) => {
      const id = String(releaseId || "").trim();
      if (!id || seen.has(id)) return [];
      seen.add(id);
      return [ourNotesReleaseOrigin(id)];
    });
  });
  const releaseSongs = useCatalogCollectionSet<Song>("songs", playlistReleaseOrigins, "garupa:playlist-release-songs");
  const releaseBands = useCatalogCollectionSet<Band>("bands", playlistReleaseOrigins, "garupa:playlist-release-bands");

  // Garupa Master definitions are Japanese, so their final fallback is the
  // one explicit Bestdori JP provider rather than the UI locale's region.
  const bestdoriCatalogOrigin = bestdoriOrigin("jp");
  const bestdoriSongs = useCatalogCollection<Song>("songs", bestdoriCatalogOrigin);
  const bestdoriBands = useCatalogCollection<Band>("bands", bestdoriCatalogOrigin);
  const releaseCatalogs = computed<readonly ReleaseCatalog[]>(() => {
    const songsByOrigin = new Map(releaseSongs.data.value.map((source) => [contentOriginKey(source.origin), source]));
    const bandsByOrigin = new Map(releaseBands.data.value.map((source) => [contentOriginKey(source.origin), source]));
    return playlistReleaseOrigins.value.flatMap((origin) => {
      const songs = songsByOrigin.get(contentOriginKey(origin));
      const bands = bandsByOrigin.get(contentOriginKey(origin));
      return songs && bands ? [releaseCatalog(origin, songs.records, bands.records)] : [];
    });
  });
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

  const data = computed<ResolvedPlaylist[]>(() => {
    const releasePriority = new Map(
      playlistReleaseOrigins.value.map((origin, index) => [contentOriginKey(origin), index]),
    );
    const bestdoriPriority = playlistReleaseOrigins.value.length;
    const bestdoriSongValues = recordValues(bestdoriSongs.data.value);
    const bestdoriBandValues = recordValues(bestdoriBands.data.value);
    const bestdoriSongsById = new Map(bestdoriSongValues.map((song) => [song.musicId, song]));
    const bestdoriBandsById = new Map(bestdoriBandValues.map((band) => [band.bandId, band]));
    const bestdoriBandsByName = new Map(
      bestdoriBandValues
        .filter((band) => band.official !== false)
        .map((band) => [titleKey(textOf(japaneseText(band.bandName, String(band.bandId)))), band]),
    );
    /**
     * A band belongs to its game, not to a source which happens to share its
     * name.  MyGO and Ave Mujica therefore remain Our Notes bands even though
     * their Bestdori counterparts can provide fallback songs.  The alias maps
     * connect those song pools without leaking Bestdori ownership into UI.
     */
    const bestdoriAliasIdsByOurNotesKey = new Map<string, Set<number>>();
    const ourNotesKeyByBestdoriBandId = new Map<number, string>();
    for (const catalog of releaseCatalogs.value) {
      for (const band of [...catalog.bands.values()].sort((left, right) => left.bandId - right.bandId)) {
        const name = titleKey(textOf(japaneseText(band.bandName, String(band.bandId))));
        const matchingBestdoriBand = name ? bestdoriBandsByName.get(name) : undefined;
        if (!matchingBestdoriBand) continue;
        const key = ourNotesBandKey(band.bandId);
        const aliases = bestdoriAliasIdsByOurNotesKey.get(key);
        if (aliases) aliases.add(matchingBestdoriBand.bandId);
        else bestdoriAliasIdsByOurNotesKey.set(key, new Set([matchingBestdoriBand.bandId]));
        // Release catalogs are already ordered by the user's selected source
        // and fallback policy, so the first matching Our Notes band owns the
        // shared public playlist identity.
        if (!ourNotesKeyByBestdoriBandId.has(matchingBestdoriBand.bandId)) {
          ourNotesKeyByBestdoriBandId.set(matchingBestdoriBand.bandId, key);
        }
      }
    }
    const releaseBandKey = (_catalog: ReleaseCatalog, bandId: number): string => ourNotesBandKey(bandId);
    const releaseSongBandKeys = (song: Song, catalog: ReleaseCatalog): string[] =>
      [...new Set((song.bandIds?.length ? song.bandIds : [song.bandId]).map(Number).filter(Boolean))].map((bandId) =>
        releaseBandKey(catalog, bandId),
      );
    const bestdoriSongBandIds = (song: Song): number[] =>
      contributingSongBandIds(song, bestdoriBandsById.get(song.bandId || 0));
    const canonicalBandKey = (bestdoriBandId: number): string =>
      ourNotesKeyByBestdoriBandId.get(bestdoriBandId) || bestdoriBandKey(bestdoriBandId);
    const bandReferences = new Map<string, BandReference[]>();
    const addBandReference = (reference: BandReference) => {
      const references = bandReferences.get(reference.key);
      if (references) references.push(reference);
      else bandReferences.set(reference.key, [reference]);
    };
    for (const catalog of releaseCatalogs.value) {
      const priority = releasePriority.get(contentOriginKey(catalog.origin)) ?? bestdoriPriority;
      for (const band of catalog.bands.values()) {
        addBandReference({
          key: releaseBandKey(catalog, band.bandId),
          origin: catalog.origin,
          band,
          bands: catalog.bands,
          priority,
        });
      }
    }
    for (const band of bestdoriBandValues) {
      const key = canonicalBandKey(band.bandId);
      // A matching Our Notes band already owns this playlist's title, visual
      // identity and group. Bestdori remains in its track fallback pool only.
      if (bandGroupForKey(key) === "our-notes") continue;
      addBandReference({
        key,
        origin: bestdoriCatalogOrigin,
        band,
        bands: bestdoriBandsById,
        priority: bestdoriPriority,
      });
    }
    const preferredBandReference = (key: string): BandReference | undefined =>
      [...(bandReferences.get(key) || [])].sort(
        (left, right) =>
          left.priority - right.priority ||
          sourceTieOrder(left.origin) - sourceTieOrder(right.origin) ||
          left.band.bandId - right.band.bandId,
      )[0];
    const bandVisual = (reference: BandReference, variant: "logo" | "icon"): CompositeEntityVisual => {
      const logo = catalogBandLogo(reference.band, reference.origin);
      const images =
        variant === "logo"
          ? [logo, reference.band.icon, reference.band.logo]
          : [reference.band.icon, logo, reference.band.logo];
      const imageCandidates = [...new Set(images.filter((image): image is string => Boolean(image)))];
      const label = catalogText(reference.band.bandName, reference.origin, String(reference.band.bandId));
      return {
        ...(imageCandidates[0] ? { image: imageCandidates[0] } : {}),
        ...(imageCandidates.length > 1 ? { imageCandidates } : {}),
        ...(imageCandidates.length ? {} : { text: textOf(label), lang: langOf(label), icon: "groups" }),
        ...(reference.band.color ? { color: reference.band.color } : {}),
        fit: "contain",
      };
    };
    const makeResolvedTrack = (
      definition: GarupaPlaylistTrack,
      candidate: TrackCandidate,
      position = definition.position,
    ): ResolvedPlaylistTrack => {
      const sourceBand = candidate.bands.get(candidate.song.bandId || 0);
      const adjustedDefinition = position === definition.position ? definition : { ...definition, position };
      return {
        position,
        definition: adjustedDefinition,
        origin: candidate.origin,
        language: "ja",
        song: candidate.song,
        title: catalogText(
          candidate.song.musicTitle,
          candidate.origin,
          definition.title || String(candidate.song.musicId),
        ),
        artist: catalogText(
          candidate.song.artistName || sourceBand?.bandName || "",
          candidate.origin,
          definition.bandName || "",
        ),
        bandVisuals: bandVisualsFor(candidate.song, candidate.bands, candidate.origin, (band) =>
          catalogText(band.bandName, candidate.origin, String(band.bandId), null),
        ),
        available: Boolean(candidate.song.musicUrl),
        ...(candidate.song.musicUrl ? {} : { missingReason: "audio-unavailable" }),
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
    const pickCandidate = (candidates: readonly TrackCandidate[]): TrackCandidate | undefined => {
      const ordered = [...candidates].sort(
        (left, right) =>
          left.priority - right.priority ||
          sourceTieOrder(left.origin) - sourceTieOrder(right.origin) ||
          left.song.musicId - right.song.musicId,
      );
      return ordered.find((candidate) => Boolean(candidate.song.musicUrl)) || ordered[0];
    };
    const syntheticDefinition = (candidate: TrackCandidate, position: number): GarupaPlaylistTrack => {
      const sourceBand = candidate.bands.get(candidate.song.bandId || 0);
      return {
        position,
        musicId: candidate.song.musicId,
        title: textOf(japaneseText(candidate.song.musicTitle, String(candidate.song.musicId))),
        bandId: candidate.song.bandId || null,
        bandName: textOf(japaneseText(candidate.song.artistName || sourceBand?.bandName || "", "")) || null,
        available: Boolean(candidate.song.musicUrl),
        ...(isBestdoriOrigin(candidate.origin)
          ? { assetRef: { origin: candidate.origin, kind: "song" as const, musicId: candidate.song.musicId } }
          : {}),
        language: "ja",
      };
    };
    const tracksForBand = (key: string): ResolvedPlaylistTrack[] => {
      const candidates: TrackCandidate[] = [];
      for (const catalog of releaseCatalogs.value) {
        const priority = releasePriority.get(contentOriginKey(catalog.origin)) ?? bestdoriPriority;
        for (const song of catalog.songs) {
          if (!releaseSongBandKeys(song, catalog).includes(key)) continue;
          candidates.push({ origin: catalog.origin, song, bands: catalog.bands, priority });
        }
      }
      const bestdoriAliases =
        bandGroupForKey(key) === "our-notes"
          ? bestdoriAliasIdsByOurNotesKey.get(key) || new Set<number>()
          : new Set([Number(key.slice("bestdori:band:".length))]);
      for (const song of bestdoriSongValues) {
        if (!bestdoriSongBandIds(song).some((bandId) => bestdoriAliases.has(bandId))) continue;
        candidates.push({ origin: bestdoriCatalogOrigin, song, bands: bestdoriBandsById, priority: bestdoriPriority });
      }
      // Our Notes servers share music IDs for shared content. Keep that as
      // the primary identity so two server-exclusive same-title songs remain
      // distinct; only bridge a Bestdori song by title when exactly one Our
      // Notes song in this playlist can own that title.
      const ourNotesMusicIdsByTitle = new Map<string, Set<number>>();
      for (const candidate of candidates) {
        if (isBestdoriOrigin(candidate.origin)) continue;
        const title = titleKey(textOf(japaneseText(candidate.song.musicTitle, String(candidate.song.musicId))));
        if (!title) continue;
        const musicIds = ourNotesMusicIdsByTitle.get(title);
        if (musicIds) musicIds.add(candidate.song.musicId);
        else ourNotesMusicIdsByTitle.set(title, new Set([candidate.song.musicId]));
      }
      const logicalSongKey = (candidate: TrackCandidate): string => {
        if (!isBestdoriOrigin(candidate.origin)) return `our-notes:song:${candidate.song.musicId}`;
        const title = titleKey(textOf(japaneseText(candidate.song.musicTitle, String(candidate.song.musicId))));
        const musicIds = title ? ourNotesMusicIdsByTitle.get(title) : undefined;
        return musicIds?.size === 1 ? `our-notes:song:${[...musicIds][0]}` : `bestdori:song:${candidate.song.musicId}`;
      };
      const groups = new Map<string, TrackCandidate[]>();
      for (const candidate of candidates) {
        const identity = logicalSongKey(candidate);
        const group = groups.get(identity);
        if (group) group.push(candidate);
        else groups.set(identity, [candidate]);
      }
      return [...groups.values()]
        .flatMap((group) => {
          const candidate = pickCandidate(group);
          if (!candidate) return [];
          const timestamps = group
            .map((item) => songReleaseTimestamp(item.song))
            .filter((value): value is number => value !== undefined);
          const releaseAt = timestamps.length ? Math.min(...timestamps) : undefined;
          const bestdoriAtRelease = group.some(
            (item) => isBestdoriOrigin(item.origin) && songReleaseTimestamp(item.song) === releaseAt,
          );
          return [{ candidate, releaseAt, bestdoriAtRelease }];
        })
        .sort(
          (left, right) =>
            compareTimeline(left.releaseAt, right.releaseAt) ||
            Number(right.bestdoriAtRelease) - Number(left.bestdoriAtRelease) ||
            sourceTieOrder(left.candidate.origin) - sourceTieOrder(right.candidate.origin) ||
            left.candidate.song.musicId - right.candidate.song.musicId ||
            contentOriginKey(left.candidate.origin).localeCompare(contentOriginKey(right.candidate.origin)),
        )
        .map(({ candidate }, index) => {
          const definition = syntheticDefinition(candidate, index + 1);
          return makeResolvedTrack(definition, candidate);
        });
    };
    const resolveFixedTrack = (definition: GarupaPlaylistTrack): ResolvedPlaylistTrack => {
      if (!definition.available) return unavailableTrack(definition, definition.missingReason || "music-not-in-master");
      const candidates: TrackCandidate[] = [];
      const key = titleKey(definition.title);
      let matchedOurNotesMusicId: number | undefined;
      if (key) {
        for (const catalog of releaseCatalogs.value) {
          const titleMatch = catalog.songByTitle.get(key);
          const song =
            (matchedOurNotesMusicId === undefined ? undefined : catalog.songsById.get(matchedOurNotesMusicId)) ||
            titleMatch;
          if (!song) continue;
          if (matchedOurNotesMusicId === undefined) matchedOurNotesMusicId = song.musicId;
          candidates.push({
            origin: catalog.origin,
            song,
            bands: catalog.bands,
            priority: releasePriority.get(contentOriginKey(catalog.origin)) ?? bestdoriPriority,
          });
        }
      }
      const assetRef = definition.assetRef;
      if (assetRef?.kind === "song" && isBestdoriOrigin(assetRef.origin)) {
        if (contentOriginKey(assetRef.origin) === contentOriginKey(bestdoriCatalogOrigin)) {
          const song = bestdoriSongsById.get(assetRef.musicId);
          if (song) {
            candidates.push({
              origin: assetRef.origin,
              song,
              bands: bestdoriBandsById,
              priority: bestdoriPriority,
            });
          }
        }
      }
      const candidate = pickCandidate(candidates);
      return candidate ? makeResolvedTrack(definition, candidate) : unavailableTrack(definition, "no-source-match");
    };
    const sourcePlaylists = garupa.data.value?.playlists || [];
    const rawBandPlaylists = new Map<string, GarupaPlaylist>();
    for (const playlist of sourcePlaylists) {
      if (playlist.source !== "band") continue;
      const key = canonicalBandKey(playlist.sourceId);
      if (!rawBandPlaylists.has(key)) rawBandPlaylists.set(key, playlist);
    }
    const resolveBandPlaylist = (key: string, playlist: GarupaPlaylist | undefined): ResolvedPlaylist => {
      const bandGroup = bandGroupForKey(key);
      const reference = preferredBandReference(key);
      const titleText = reference
        ? catalogText(reference.band.bandName, reference.origin, playlist?.title || String(reference.band.bandId))
        : japaneseText(playlist?.title || key, playlist?.title || key);
      const logo = reference ? bandVisual(reference, "logo") : undefined;
      const icon = reference ? bandVisual(reference, "icon") : undefined;
      const fallbackId =
        reference && bandGroup === "our-notes"
          ? ourNotesBandPlaylistId(reference.band)
          : `band-${reference?.band.bandId || key.replace(/[^a-z0-9]+/giu, "-")}`;
      return {
        ...(playlist || {
          id: fallbackId,
          kind: "system" as const,
          source: "band" as const,
          sourceId: reference?.band.bandId || 0,
          title: textOf(titleText),
          tracks: [],
        }),
        language: "ja",
        title: textOf(titleText),
        titleText,
        ...(reference?.band.bandId ? { sourceId: reference.band.bandId, bandId: reference.band.bandId } : {}),
        color: reference?.band.color || playlist?.color || null,
        thumbnail: logo?.image,
        filterVisual: icon,
        bandGroup,
        bandKeys: [key],
        tracks: tracksForBand(key),
      };
    };
    const orderedOurNotesBandKeys = [...bandReferences.keys()]
      .filter((key) => bandGroupForKey(key) === "our-notes")
      .sort((left, right) => {
        const leftReference = preferredBandReference(left);
        const rightReference = preferredBandReference(right);
        return (
          (leftReference?.priority || 0) - (rightReference?.priority || 0) ||
          (leftReference?.band.bandId || 0) - (rightReference?.band.bandId || 0) ||
          left.localeCompare(right)
        );
      });
    const rawBestdoriBandKeys = [
      ...new Set(
        sourcePlaylists
          .filter((playlist) => playlist.source === "band")
          .map((playlist) => canonicalBandKey(playlist.sourceId))
          .filter((key) => bandGroupForKey(key) === "bestdori"),
      ),
    ];
    const bandPlaylists = [
      ...rawBestdoriBandKeys.map((key) => resolveBandPlaylist(key, rawBandPlaylists.get(key))),
      ...orderedOurNotesBandKeys.map((key) => resolveBandPlaylist(key, rawBandPlaylists.get(key))),
    ];
    const stageChallenges = sourcePlaylists
      .filter((playlist) => playlist.source === "stage-challenge")
      .map((playlist) => {
        const tracks = playlist.tracks.map(resolveFixedTrack);
        const stageBandKey = playlist.bandId ? canonicalBandKey(playlist.bandId) : undefined;
        const stageBand = stageBandKey ? preferredBandReference(stageBandKey) : undefined;
        const stageVisual = stageBand ? bandVisual(stageBand, "icon") : undefined;
        return {
          ...playlist,
          language: "ja",
          titleText: japaneseText(playlist.title, playlist.title),
          thumbnail: `/api/v1/garupa/bestdori/jp/media/stage-challenge/${stageAssetNumber(playlist)}`,
          filterVisual: stageVisual,
          bandKeys: stageBandKey ? [stageBandKey] : [],
          tracks,
        } satisfies ResolvedPlaylist;
      });
    return [...bandPlaylists, ...stageChallenges];
  });

  const pending = computed(
    () =>
      garupa.pending.value ||
      releaseSongs.pending.value ||
      releaseBands.pending.value ||
      bestdoriSongs.pending.value ||
      bestdoriBands.pending.value,
  );
  const error = computed(
    () =>
      garupa.error.value ||
      releaseSongs.error.value ||
      releaseBands.error.value ||
      bestdoriSongs.error.value ||
      bestdoriBands.error.value,
  );
  const refresh = async () => {
    await Promise.all([
      garupa.refresh(),
      releaseSongs.refresh(),
      releaseBands.refresh(),
      bestdoriSongs.refresh(),
      bestdoriBands.refresh(),
    ]);
  };

  return { data, pending, error, refresh };
};
