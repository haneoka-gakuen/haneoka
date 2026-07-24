import type { Band, Character, Song } from "~/types/archive";
import type { GarupaPlaylist, PlaylistTrackSource, ResolvedPlaylist, ResolvedPlaylistTrack } from "~/types/playlists";
import { contributingSongBandIds } from "~/features/catalog/songCredits";
import { createSongCreditVisualResolver } from "~/features/catalog/songCreditVisuals";
import { resolveArchiveValue } from "~/i18n/locales";
import { textOf, type DisplayText } from "~/types/displayText";

const titleKey = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("ja")
    .replace(/[\p{P}\p{S}\s]+/gu, "");

const stageAssetNumber = (playlist: GarupaPlaylist): string => {
  const match = playlist.assetBundleName?.match(/(\d+)$/u);
  return match?.[1] || String(playlist.sourceId);
};

export const usePlaylistCatalog = () => {
  const garupa = useGarupaPlaylists();
  const catalogSongs = useCatalogCollection<Song>("songs", "jp-cbt");
  const catalogBands = useCatalogCollection<Band>("bands", "jp-cbt");
  const catalogCharacters = useCatalogCollection<Character>("characters", "jp-cbt");
  const bestdoriSongs = useCatalogCollection<Song>("songs", "bestdori");
  const bestdoriBands = useCatalogCollection<Band>("bands", "bestdori");
  const bestdoriCharacters = useCatalogCollection<Character>("characters", "bestdori");

  const japaneseText = (value: Parameters<typeof resolveArchiveValue>[0], fallback = ""): DisplayText =>
    resolveArchiveValue(value, "ja", { sourceHint: "ja", fallback }) || fallback;
  const bandName = (band: Band): string => textOf(japaneseText(band.bandName));

  const data = computed<ResolvedPlaylist[]>(() => {
    const sourcePlaylists = garupa.data.value?.playlists || [];
    const localBands = recordValues(catalogBands.data.value);
    const localSongs = recordValues(catalogSongs.data.value);
    const localCharacters = recordValues(catalogCharacters.data.value);
    const remoteBands = recordValues(bestdoriBands.data.value);
    const remoteSongs = recordValues(bestdoriSongs.data.value);
    const remoteCharacters = recordValues(bestdoriCharacters.data.value);
    const visualResolver = createSongCreditVisualResolver({
      catalogBands: localBands,
      catalogCharacters: localCharacters,
      bestdoriBands: remoteBands,
      bestdoriCharacters: remoteCharacters,
    });
    const localBandMap = new Map(localBands.map((band) => [band.bandId, band]));
    const remoteBandMap = new Map(remoteBands.map((band) => [band.bandId, band]));
    const remoteBandByName = new Map(
      remoteBands.filter((band) => band.official !== false).map((band) => [titleKey(bandName(band)), band]),
    );

    const localBandKey = new Map<number, string>();
    for (const band of localBands) {
      const remote = remoteBandByName.get(titleKey(bandName(band)));
      localBandKey.set(band.bandId, remote ? `bestdori:${remote.bandId}` : `catalog:${band.bandId}`);
    }

    const makeTrack = (
      song: Song,
      source: PlaylistTrackSource,
      position: number,
      bands: Map<number, Band>,
    ): ResolvedPlaylistTrack => {
      const sourceBand = bands.get(song.bandId || 0);
      const sourceServer = source === "bestdori" ? "bestdori" : "jp-cbt";
      return {
        position,
        source,
        sourceServer: source === "user-upload" ? "user-upload" : sourceServer,
        sourceId: song.musicId,
        language: "ja",
        song,
        title: japaneseText(song.musicTitle, String(song.musicId)),
        artist: japaneseText(song.artistName || sourceBand?.bandName || "", ""),
        bandVisuals: visualResolver.song(song, sourceServer),
      };
    };

    const tracksForBand = (canonicalKey: string): ResolvedPlaylistTrack[] => {
      const candidates: Array<{
        song: Song;
        source: PlaylistTrackSource;
        bands: Map<number, Band>;
      }> = [];
      const remoteId = canonicalKey.startsWith("bestdori:") ? Number(canonicalKey.slice(9)) : 0;
      if (remoteId) {
        for (const song of remoteSongs) {
          const ids = contributingSongBandIds(song, remoteBandMap.get(song.bandId || 0));
          if (ids.includes(remoteId)) {
            candidates.push({
              song,
              source: "bestdori",
              bands: remoteBandMap,
            });
          }
        }
      }
      for (const song of localSongs) {
        const ids = song.bandIds?.length ? song.bandIds : [song.bandId];
        if (ids.some((id) => id && localBandKey.get(id) === canonicalKey)) {
          candidates.push({ song, source: "catalog", bands: localBandMap });
        }
      }
      const releaseTimestamp = (song: Song): number => {
        const canonical = Number(song.releaseAt);
        if (Number.isFinite(canonical) && canonical > 0) return canonical;
        if (!Array.isArray(song.publishedAt)) return 0;
        const japanese = Number(song.publishedAt[0]);
        return Number.isFinite(japanese) && japanese > 0 ? japanese : 0;
      };
      const sourceOrder = (source: PlaylistTrackSource) => (source === "bestdori" ? 0 : source === "catalog" ? 1 : 2);
      // Band playlists receive stable, compact IDs ordered by their shared
      // release timeline. Source only breaks ties, with Bestdori first.
      candidates.sort(
        (left, right) =>
          releaseTimestamp(left.song) - releaseTimestamp(right.song) ||
          sourceOrder(left.source) - sourceOrder(right.source) ||
          left.song.musicId - right.song.musicId,
      );
      const unique = new Map<string, (typeof candidates)[number]>();
      // A local catalog song carries the preferred playable metadata whenever
      // the same title is also available from Bestdori. Keep source ordering
      // for the final playlist IDs separate from this source-selection rule.
      for (const candidate of [...candidates].sort((left, right) => sourceOrder(right.source) - sourceOrder(left.source))) {
        const key = titleKey(textOf(japaneseText(candidate.song.musicTitle, String(candidate.song.musicId))));
        if (!unique.has(key)) unique.set(key, candidate);
      }
      return [...unique.values()]
        .sort(
          (left, right) =>
            releaseTimestamp(left.song) - releaseTimestamp(right.song) ||
            sourceOrder(left.source) - sourceOrder(right.source) ||
            left.song.musicId - right.song.musicId,
        )
        .map((candidate, index) => makeTrack(candidate.song, candidate.source, index + 1, candidate.bands));
    };

    const catalogSongByTitle = new Map(
      localSongs.map((song) => [titleKey(textOf(japaneseText(song.musicTitle, String(song.musicId)))), song]),
    );
    const bestdoriSongById = new Map(remoteSongs.map((song) => [song.musicId, song]));

    const resolved = sourcePlaylists.map<ResolvedPlaylist>((playlist) => {
      if (playlist.source === "band") {
        const canonicalKey = `bestdori:${playlist.sourceId}`;
        const localBand = localBands.find((band) => localBandKey.get(band.bandId) === canonicalKey);
        const remoteBand = remoteBandMap.get(playlist.sourceId);
        const visualBand = localBand || remoteBand;
        const visualSource = localBand ? "jp-cbt" : "bestdori";
        const logoVisual = visualBand ? visualResolver.band(visualBand, visualSource, "logo") : undefined;
        return {
          ...playlist,
          language: "ja",
          titleText: japaneseText(remoteBand?.bandName || playlist.title, playlist.title),
          thumbnail: logoVisual?.image,
          filterVisual: visualBand ? visualResolver.band(visualBand, visualSource, "icon") : undefined,
          bandKeys: [canonicalKey],
          tracks: tracksForBand(canonicalKey),
        };
      }
      const tracks = playlist.tracks.flatMap((track) => {
        const key = titleKey(track.title);
        const catalogSong = catalogSongByTitle.get(key);
        if (catalogSong) {
          return [makeTrack(catalogSong, "catalog", track.position, localBandMap)];
        }
        const bestdoriSong = bestdoriSongById.get(track.musicId);
        return bestdoriSong ? [makeTrack(bestdoriSong, "bestdori", track.position, remoteBandMap)] : [];
      });
      const bandKeys = [
        ...new Set(
          tracks.flatMap((track) => {
            if (track.source === "catalog") {
              const ids = track.song.bandIds?.length ? track.song.bandIds : [track.song.bandId];
              return ids.flatMap((id) => (id && localBandKey.get(id) ? [localBandKey.get(id)!] : []));
            }
            return contributingSongBandIds(track.song, remoteBandMap.get(track.song.bandId || 0)).map(
              (id) => `bestdori:${id}`,
            );
          }),
        ),
      ];
      return {
        ...playlist,
        language: "ja",
        titleText: japaneseText(playlist.title, playlist.title),
        thumbnail: `/api/v1/bestdori/media/stage-challenge/${stageAssetNumber(playlist)}`,
        bandKeys,
        tracks,
      };
    });

    const existingBandKeys = new Set(
      resolved.filter((item) => item.source === "band").flatMap((item) => item.bandKeys),
    );
    for (const band of localBands) {
      const canonicalKey = localBandKey.get(band.bandId)!;
      if (existingBandKeys.has(canonicalKey)) continue;
      const title = bandName(band);
      const logoVisual = visualResolver.band(band, "jp-cbt", "logo");
      resolved.push({
        id: `catalog:jp-cbt:band:${band.bandId}`,
        kind: "system",
        source: "band",
        sourceId: band.bandId,
        title,
        language: "ja",
        titleText: japaneseText(band.bandName, title),
        bandId: band.bandId,
        color: band.color || null,
        thumbnail: logoVisual.image,
        filterVisual: visualResolver.band(band, "jp-cbt", "icon"),
        bandKeys: [canonicalKey],
        tracks: tracksForBand(canonicalKey),
      });
    }
    return resolved;
  });

  const pending = computed(
    () =>
      garupa.pending.value ||
      catalogSongs.pending.value ||
      catalogBands.pending.value ||
      catalogCharacters.pending.value ||
      bestdoriSongs.pending.value ||
      bestdoriBands.pending.value ||
      bestdoriCharacters.pending.value,
  );
  const error = computed(
    () =>
      garupa.error.value ||
      catalogSongs.error.value ||
      catalogBands.error.value ||
      catalogCharacters.error.value ||
      bestdoriSongs.error.value ||
      bestdoriBands.error.value ||
      bestdoriCharacters.error.value,
  );
  const refresh = async () => {
    await Promise.all([
      garupa.refresh(),
      catalogSongs.refresh(),
      catalogBands.refresh(),
      catalogCharacters.refresh(),
      bestdoriSongs.refresh(),
      bestdoriBands.refresh(),
      bestdoriCharacters.refresh(),
    ]);
  };

  return { data, pending, error, refresh };
};
