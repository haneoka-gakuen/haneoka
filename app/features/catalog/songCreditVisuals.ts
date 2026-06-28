import type { Band, Character, Song } from "~/types/archive";
import type { CompositeEntityVisual } from "~/types/compositeVisual";
import { localizeArchiveValue } from "~/i18n/locales";
import { contributingSongBandIds, uniqueSongCreditIds } from "~/features/catalog/songCredits";
import { langOf } from "~/types/displayText";
import { entityAvatarText } from "~/utils/entityAvatar";

export type SongCreditVisualVariant = "logo" | "icon";

export interface SongCreditCatalogs {
  catalogBands: readonly Band[];
  catalogCharacters: readonly Character[];
  bestdoriBands: readonly Band[];
  bestdoriCharacters: readonly Character[];
}

export interface SongCreditIdentity {
  bandIds: number[];
  characterIds: number[];
  memberNames: string[];
  sourceBand?: Band;
}

export interface SongCreditVisualResolver {
  identity: (song: Song, sourceServer: string) => SongCreditIdentity;
  songKey: (song: Song, sourceServer: string) => string;
  bandCreditKey: (band: Band, sourceServer: string) => string;
  song: (song: Song, sourceServer: string, variant?: SongCreditVisualVariant) => CompositeEntityVisual[];
  band: (band: Band, sourceServer: string, variant?: SongCreditVisualVariant) => CompositeEntityVisual;
  character: (character: Character, sourceServer: string, variant?: SongCreditVisualVariant) => CompositeEntityVisual;
  bandCredit: (band: Band, sourceServer: string, variant?: SongCreditVisualVariant) => CompositeEntityVisual[];
}

const identityKey = (value: unknown): string =>
  String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ja")
    .replace(/[\p{P}\p{S}\s]+/gu, "");

const japaneseText = (value: Parameters<typeof localizeArchiveValue>[0]): string => localizeArchiveValue(value, "ja");
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

export const catalogBandLogo = (band: Band | undefined): string | undefined => {
  if (!band) return undefined;
  if (band.logo) return band.logo;
  if (band.bandId === 3 && identityKey(japaneseText(band.bandName)) === identityKey("夢限大みゅーたいぷ")) {
    return "/runtime/jp-cbt/unity/Assets/AddressableResources/UI/Atlas/FixUiSpriteAtlas.spriteatlasv2/band_logo_mugendai--Sprite-1531089103092969011.png";
  }
  return band.icon;
};

const uniqueImages = (...values: Array<string | null | undefined>): string[] => [
  ...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))),
];
const fallbackText = (value: string) => entityAvatarText(value, { cjkLength: 4 });
const memberVisual = (name: string): CompositeEntityVisual => ({
  text: fallbackText(name),
  lang: langOf(name),
  icon: "person",
  fit: "cover",
});

export const createSongCreditVisualResolver = (catalogs: SongCreditCatalogs): SongCreditVisualResolver => {
  const catalogBandMap = new Map(catalogs.catalogBands.map((band) => [band.bandId, band]));
  const bestdoriBandMap = new Map(catalogs.bestdoriBands.map((band) => [band.bandId, band]));
  const catalogCharacterMap = new Map(
    catalogs.catalogCharacters.map((character) => [character.characterId, character]),
  );
  const bestdoriCharacterMap = new Map(
    catalogs.bestdoriCharacters.map((character) => [character.characterId, character]),
  );
  const aliasMap = <T>(values: readonly T[], aliases: (value: T) => string[]): Map<string, T> => {
    const output = new Map<string, T>();
    for (const value of values) {
      for (const alias of aliases(value)) if (!output.has(alias)) output.set(alias, value);
    }
    return output;
  };
  const catalogBandsByName = aliasMap(catalogs.catalogBands, (band) => localizedAliases(band.bandName));
  const bestdoriBandsByName = aliasMap(
    catalogs.bestdoriBands.filter((band) => band.official !== false),
    (band) => localizedAliases(band.bandName),
  );
  const catalogCharactersByName = aliasMap(catalogs.catalogCharacters, (character) =>
    localizedAliases([character.characterName, character.englishName]),
  );
  const bestdoriCharactersByName = aliasMap(catalogs.bestdoriCharacters, (character) =>
    localizedAliases([character.characterName, character.englishName]),
  );
  const sourceBandMap = (sourceServer: string) => (sourceServer === "bestdori" ? bestdoriBandMap : catalogBandMap);
  const sourceCharacterMap = (sourceServer: string) =>
    sourceServer === "bestdori" ? bestdoriCharacterMap : catalogCharacterMap;
  const firstAliasMatch = <T>(aliases: readonly string[], index: ReadonlyMap<string, T>): T | undefined =>
    aliases.flatMap((alias) => {
      const match = index.get(alias);
      return match ? [match] : [];
    })[0];
  const matchedBand = (source: Band) => {
    const aliases = localizedAliases(source.bandName);
    return {
      catalog: firstAliasMatch(aliases, catalogBandsByName),
      bestdori: firstAliasMatch(aliases, bestdoriBandsByName),
    };
  };
  const matchedCharacter = (source: Character) => {
    const aliases = localizedAliases([source.characterName, source.englishName]);
    return {
      catalog: firstAliasMatch(aliases, catalogCharactersByName),
      bestdori: firstAliasMatch(aliases, bestdoriCharactersByName),
    };
  };
  const bandKey = (source: Band): string => {
    const matched = matchedBand(source);
    return localizedAliases(matched.catalog?.bandName || matched.bestdori?.bandName || source.bandName)[0] || "";
  };
  const characterKey = (source: Character): string => {
    const matched = matchedCharacter(source);
    return (
      localizedAliases(matched.catalog?.characterName || matched.bestdori?.characterName || source.characterName)[0] ||
      ""
    );
  };

  const band = (
    source: Band,
    _sourceServer: string,
    variant: SongCreditVisualVariant = "logo",
  ): CompositeEntityVisual => {
    const { catalog, bestdori } = matchedBand(source);
    const imageCandidates =
      variant === "icon"
        ? uniqueImages(
            catalog?.icon,
            catalogBandLogo(catalog),
            bestdori?.icon,
            bestdori?.logo,
            source.icon,
            source.logo,
          )
        : uniqueImages(
            catalogBandLogo(catalog),
            catalog?.icon,
            bestdori?.logo,
            bestdori?.icon,
            source.logo,
            source.icon,
          );
    const label = japaneseText(source.bandName || catalog?.bandName || bestdori?.bandName);
    return {
      image: imageCandidates[0],
      imageCandidates,
      text: variant === "icon" ? fallbackText(label) : undefined,
      lang: variant === "icon" ? langOf(label) : undefined,
      icon: variant === "icon" && !imageCandidates.length ? "music_note" : undefined,
      fit: "contain",
      color: catalog?.color || bestdori?.color || source.color,
    };
  };

  const character = (
    source: Character,
    _sourceServer: string,
    variant: SongCreditVisualVariant = "icon",
  ): CompositeEntityVisual => {
    const { catalog, bestdori } = matchedCharacter(source);
    const imageCandidates = uniqueImages(
      catalog?.faceImage,
      catalog?.thumbnailImage,
      catalog?.profileImage,
      bestdori?.faceImage,
      bestdori?.thumbnailImage,
      bestdori?.profileImage,
      source.faceImage,
      source.thumbnailImage,
      source.profileImage,
    );
    const label = japaneseText(source.characterName || catalog?.characterName || bestdori?.characterName);
    return {
      image: imageCandidates[0],
      imageCandidates,
      text: variant === "icon" ? fallbackText(label) : undefined,
      lang: variant === "icon" ? langOf(label) : undefined,
      icon: variant === "icon" && !imageCandidates.length ? "person" : undefined,
      fit: "cover",
      color: catalog?.colorCode || bestdori?.colorCode || source.colorCode,
    };
  };

  const identity = (song: Song, sourceServer: string): SongCreditIdentity => {
    const bands = sourceBandMap(sourceServer);
    const characters = sourceCharacterMap(sourceServer);
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
    sourceServer: string,
    variant: SongCreditVisualVariant = "logo",
  ): CompositeEntityVisual[] => {
    const bands = sourceBandMap(sourceServer);
    const characters = sourceCharacterMap(sourceServer);
    const resolved = identity(value, sourceServer);
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
        return [band(source, sourceServer, variant)];
      }),
      ...resolved.characterIds.flatMap((id) => {
        const source = characters.get(id);
        if (!source) return [];
        const key = characterKey(source);
        if (seenCharacters.has(key)) return [];
        seenCharacters.add(key);
        return [character(source, sourceServer, variant)];
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
    sourceServer: string,
    variant: SongCreditVisualVariant = "icon",
  ): CompositeEntityVisual[] => {
    if (source.official !== false) return [band(source, sourceServer, variant)];
    const bands = sourceBandMap(sourceServer);
    const characters = sourceCharacterMap(sourceServer);
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
        return [band(member, sourceServer, variant)];
      }),
      ...uniqueSongCreditIds(source.memberCharacterIds || []).flatMap((id) => {
        const member = characters.get(id);
        if (!member) return [];
        const key = characterKey(member);
        if (!key || seenCharacters.has(key)) return [];
        seenCharacters.add(key);
        return [character(member, sourceServer, variant)];
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

  const bandCreditKey = (source: Band, sourceServer: string): string => {
    if (source.official !== false) return `band:${bandKey(source)}`;
    const bands = sourceBandMap(sourceServer);
    const characters = sourceCharacterMap(sourceServer);
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
  const songKey = (value: Song, sourceServer: string): string => {
    const resolved = identity(value, sourceServer);
    const bands = sourceBandMap(sourceServer);
    const characters = sourceCharacterMap(sourceServer);
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
  sourceServer: string,
  catalogs: SongCreditCatalogs,
  variant: SongCreditVisualVariant = "logo",
): CompositeEntityVisual[] => createSongCreditVisualResolver(catalogs).song(song, sourceServer, variant);
