import type { Band, Character, Song } from "~/types/archive";
import type { CompositeEntityVisual } from "~/types/compositeVisual";
import { resolveArchiveValue } from "~/i18n/locales";
import { contributingSongBandIds, uniqueSongCreditIds } from "~/features/catalog/songCredits";
import { contentOriginKey, type CatalogContentOrigin } from "~/features/catalog/contentSource";
import { runtimeRootForRelease } from "~/composables/useReleaseServer";
import { langOf, textOf, type DisplayText } from "~/types/displayText";
import { entityAvatarText } from "~/utils/entityAvatar";

export type SongCreditVisualVariant = "logo" | "icon";

/** The exact catalog that supplied the entities used to render a credit. */
export interface SongCreditCatalogSource {
  readonly origin: CatalogContentOrigin;
  readonly bands: readonly Band[];
  readonly characters: readonly Character[];
}

export interface SongCreditCatalogs {
  readonly sources: readonly SongCreditCatalogSource[];
}

export interface SongCreditIdentity {
  bandIds: number[];
  characterIds: number[];
  memberNames: string[];
  sourceBand?: Band;
}

export interface SongCreditVisualResolver {
  identity: (song: Song, origin: CatalogContentOrigin) => SongCreditIdentity;
  songKey: (song: Song, origin: CatalogContentOrigin) => string;
  bandCreditKey: (band: Band, origin: CatalogContentOrigin) => string;
  song: (song: Song, origin: CatalogContentOrigin, variant?: SongCreditVisualVariant) => CompositeEntityVisual[];
  band: (band: Band, origin: CatalogContentOrigin, variant?: SongCreditVisualVariant) => CompositeEntityVisual;
  character: (
    character: Character,
    origin: CatalogContentOrigin,
    variant?: SongCreditVisualVariant,
  ) => CompositeEntityVisual;
  bandCredit: (band: Band, origin: CatalogContentOrigin, variant?: SongCreditVisualVariant) => CompositeEntityVisual[];
}

const identityKey = (value: unknown): string =>
  String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ja")
    .replace(/[\p{P}\p{S}\s]+/gu, "");

const japaneseDisplayText = (value: Parameters<typeof resolveArchiveValue>[0], fallback = ""): DisplayText =>
  resolveArchiveValue(value, "ja", {
    sourceHint: "ja",
    fallback,
    fallbackSourceHint: "ja",
  }) || fallback;
const japaneseText = (value: Parameters<typeof resolveArchiveValue>[0]): string => textOf(japaneseDisplayText(value));
const localizedAliases = (value: unknown): string[] => {
  const values =
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.flatMap(localizedAliases)
        : value && typeof value === "object"
          ? Object.values(value).flatMap(localizedAliases)
          : [];
  return [...new Set(values.map((entry) => identityKey(entry)).filter(Boolean))];
};

/**
 * Some releases omit the special MUGENDAI MYUTYPE logo from their catalog
 * metadata. Keep the fallback in the same release namespace as the catalog
 * that supplied the band; it must never silently point at `jp-cbt`.
 */
export const catalogBandLogo = (band: Band | undefined, origin: CatalogContentOrigin): string | undefined => {
  if (!band) return undefined;
  if (band.logo) return band.logo;
  if (
    origin.provider === "release" &&
    band.bandId === 3 &&
    identityKey(japaneseText(band.bandName)) === identityKey("夢限大みゅーたいぷ")
  ) {
    return `${runtimeRootForRelease(origin.releaseId)}/unity/Assets/AddressableResources/UI/Atlas/FixUiSpriteAtlas.spriteatlasv2/band_logo_mugendai--Sprite-1531089103092969011.png`;
  }
  return band.icon;
};

const uniqueImages = (...values: Array<string | null | undefined>): string[] => [
  ...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))),
];
const fallbackText = (value: string) => entityAvatarText(value, { cjkLength: 4 });
const memberVisual = (name: string): CompositeEntityVisual => {
  const label = japaneseDisplayText(name);
  return {
    text: fallbackText(textOf(label)),
    lang: langOf(label),
    icon: "person",
    fit: "cover",
  };
};

const emptyCatalog = { bands: [], characters: [] } as const satisfies Omit<SongCreditCatalogSource, "origin">;

/**
 * Resolves credits only against the catalog identified by the supplied
 * origin. This deliberately does not merge entity IDs from Our Notes and
 * Garupa: identical numeric IDs are not evidence that they are one entity.
 */
export const createSongCreditVisualResolver = (catalogs: SongCreditCatalogs): SongCreditVisualResolver => {
  const sources = new Map(catalogs.sources.map((source) => [contentOriginKey(source.origin), source] as const));
  const catalogFor = (origin: CatalogContentOrigin) => sources.get(contentOriginKey(origin)) || emptyCatalog;
  const sourceBandMap = (origin: CatalogContentOrigin) =>
    new Map(catalogFor(origin).bands.map((band) => [band.bandId, band]));
  const sourceCharacterMap = (origin: CatalogContentOrigin) =>
    new Map(catalogFor(origin).characters.map((character) => [character.characterId, character]));
  const bandKey = (source: Band): string => localizedAliases(source.bandName)[0] || "";
  const characterKey = (source: Character): string => localizedAliases(source.characterName)[0] || "";

  const band = (
    source: Band,
    origin: CatalogContentOrigin,
    variant: SongCreditVisualVariant = "logo",
  ): CompositeEntityVisual => {
    const imageCandidates =
      variant === "icon"
        ? uniqueImages(source.icon, catalogBandLogo(source, origin), source.logo)
        : uniqueImages(catalogBandLogo(source, origin), source.icon, source.logo);
    const label = japaneseDisplayText(source.bandName);
    return {
      image: imageCandidates[0],
      imageCandidates,
      text: variant === "icon" ? fallbackText(textOf(label)) : undefined,
      lang: variant === "icon" ? langOf(label) : undefined,
      icon: variant === "icon" && !imageCandidates.length ? "music_note" : undefined,
      fit: "contain",
      color: source.color,
    };
  };

  const character = (
    source: Character,
    _origin: CatalogContentOrigin,
    variant: SongCreditVisualVariant = "icon",
  ): CompositeEntityVisual => {
    const imageCandidates = uniqueImages(source.faceImage, source.thumbnailImage, source.profileImage);
    const label = japaneseDisplayText(source.characterName);
    return {
      image: imageCandidates[0],
      imageCandidates,
      text: variant === "icon" ? fallbackText(textOf(label)) : undefined,
      lang: variant === "icon" ? langOf(label) : undefined,
      icon: variant === "icon" && !imageCandidates.length ? "person" : undefined,
      fit: "cover",
      color: source.colorCode,
    };
  };

  const identity = (song: Song, origin: CatalogContentOrigin): SongCreditIdentity => {
    const bands = sourceBandMap(origin);
    const characters = sourceCharacterMap(origin);
    const sourceBand = bands.get(song.bandId || 0);
    const bandIds = contributingSongBandIds(song, sourceBand);
    const bandIdSet = new Set(bandIds);
    const sourceBandAliases = new Set(localizedAliases(sourceBand?.bandName));
    const artistAliases = localizedAliases(song.artistName);
    const authoredAsSourceBand =
      artistAliases.length === 0 || artistAliases.some((alias) => sourceBandAliases.has(alias));
    const characterIds =
      sourceBand?.official === false
        ? uniqueSongCreditIds(sourceBand.memberCharacterIds || [])
        : authoredAsSourceBand
          ? []
          : uniqueSongCreditIds(song.vocalCharacterIds || []).filter((characterId) => {
              const characterBandId = characters.get(characterId)?.bandId;
              return !characterBandId || !bandIdSet.has(characterBandId);
            });
    return {
      bandIds,
      characterIds,
      memberNames: sourceBand?.official === false ? [...(sourceBand.memberNames || [])] : [],
      sourceBand,
    };
  };

  const song = (
    value: Song,
    origin: CatalogContentOrigin,
    variant: SongCreditVisualVariant = "logo",
  ): CompositeEntityVisual[] => {
    const bands = sourceBandMap(origin);
    const characters = sourceCharacterMap(origin);
    const resolved = identity(value, origin);
    const seenBands = new Set<string>();
    const seenCharacters = new Set<string>();
    const seenNames = new Set<string>();
    return [
      ...resolved.bandIds.flatMap((id) => {
        const source = bands.get(id);
        if (!source) return [];
        const key = bandKey(source);
        if (seenBands.has(key)) return [];
        seenBands.add(key);
        return [band(source, origin, variant)];
      }),
      ...resolved.characterIds.flatMap((id) => {
        const source = characters.get(id);
        if (!source) return [];
        const key = characterKey(source);
        if (seenCharacters.has(key)) return [];
        seenCharacters.add(key);
        return [character(source, origin, variant)];
      }),
      ...(variant === "icon"
        ? resolved.memberNames.flatMap((name) => {
            const key = localizedAliases(name)[0];
            if (!key || seenNames.has(key)) return [];
            seenNames.add(key);
            return [memberVisual(name)];
          })
        : []),
    ];
  };

  const bandCredit = (
    source: Band,
    origin: CatalogContentOrigin,
    variant: SongCreditVisualVariant = "icon",
  ): CompositeEntityVisual[] => {
    if (source.official !== false) return [band(source, origin, variant)];
    const bands = sourceBandMap(origin);
    const characters = sourceCharacterMap(origin);
    const seenBands = new Set<string>();
    const seenCharacters = new Set<string>();
    const seenNames = new Set<string>();
    return [
      ...uniqueSongCreditIds(source.memberBandIds || []).flatMap((id) => {
        const member = bands.get(id);
        if (!member) return [];
        const key = bandKey(member);
        if (!key || seenBands.has(key)) return [];
        seenBands.add(key);
        return [band(member, origin, variant)];
      }),
      ...uniqueSongCreditIds(source.memberCharacterIds || []).flatMap((id) => {
        const member = characters.get(id);
        if (!member) return [];
        const key = characterKey(member);
        if (!key || seenCharacters.has(key)) return [];
        seenCharacters.add(key);
        return [character(member, origin, variant)];
      }),
      ...(variant === "icon"
        ? (source.memberNames || []).flatMap((name) => {
            const key = localizedAliases(name)[0];
            if (!key || seenNames.has(key)) return [];
            seenNames.add(key);
            return [memberVisual(name)];
          })
        : []),
    ];
  };

  const bandCreditKey = (source: Band, origin: CatalogContentOrigin): string => {
    if (source.official !== false) return `band:${bandKey(source)}`;
    const bands = sourceBandMap(origin);
    const characters = sourceCharacterMap(origin);
    const bandKeys = uniqueSongCreditIds(source.memberBandIds || [])
      .flatMap((id) => {
        const member = bands.get(id);
        return member ? [bandKey(member)] : [];
      })
      .sort();
    const characterKeys = uniqueSongCreditIds(source.memberCharacterIds || [])
      .flatMap((id) => {
        const member = characters.get(id);
        return member ? [characterKey(member)] : [];
      })
      .sort();
    const names = [...new Set((source.memberNames || []).flatMap(localizedAliases))].sort();
    const parts = [bandKeys.join("."), characterKeys.join("."), names.join(".")];
    if (parts.some(Boolean)) return `credit:${parts.join(":")}`;
    return `credit-name:${localizedAliases(source.bandName).sort().join(".")}`;
  };
  const songKey = (value: Song, origin: CatalogContentOrigin): string => {
    const resolved = identity(value, origin);
    const bands = sourceBandMap(origin);
    const characters = sourceCharacterMap(origin);
    const bandKeys = resolved.bandIds
      .flatMap((id) => {
        const source = bands.get(id);
        return source ? [bandKey(source)] : [];
      })
      .filter((value, index, values) => values.indexOf(value) === index)
      .sort();
    const characterKeys = resolved.characterIds
      .flatMap((id) => {
        const source = characters.get(id);
        return source ? [characterKey(source)] : [];
      })
      .filter((entry, index, values) => values.indexOf(entry) === index)
      .sort();
    const names = [...new Set(resolved.memberNames.flatMap(localizedAliases))].sort();
    const parts = [bandKeys.join("."), characterKeys.join("."), names.join(".")];
    if (parts.some(Boolean)) return parts.join(":");
    return localizedAliases(value.artistName).sort().join(".");
  };

  return { identity, songKey, bandCreditKey, song, band, character, bandCredit };
};

export const resolveSongCreditVisuals = (
  song: Song,
  origin: CatalogContentOrigin,
  catalogs: SongCreditCatalogs,
  variant: SongCreditVisualVariant = "logo",
): CompositeEntityVisual[] => createSongCreditVisualResolver(catalogs).song(song, origin, variant);
