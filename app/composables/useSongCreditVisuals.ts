import { toValue, type MaybeRefOrGetter } from "vue";

import type { Band, Character, Song } from "~/types/archive";
import { createSongCreditVisualResolver, type SongCreditVisualVariant } from "~/features/catalog/songCreditVisuals";

export const useSongCreditVisualResolver = () => {
  const catalogBands = useCatalogCollection<Band>("bands", "jp-cbt");
  const catalogCharacters = useCatalogCollection<Character>("characters", "jp-cbt");
  const bestdoriBands = useCatalogCollection<Band>("bands", "bestdori");
  const bestdoriCharacters = useCatalogCollection<Character>("characters", "bestdori");

  return computed(() =>
    createSongCreditVisualResolver({
      catalogBands: recordValues(catalogBands.data.value),
      catalogCharacters: recordValues(catalogCharacters.data.value),
      bestdoriBands: recordValues(bestdoriBands.data.value),
      bestdoriCharacters: recordValues(bestdoriCharacters.data.value),
    }),
  );
};

export const useSongCreditVisuals = (
  song: MaybeRefOrGetter<Song | undefined>,
  sourceServer: MaybeRefOrGetter<string>,
  variant: MaybeRefOrGetter<SongCreditVisualVariant> = "logo",
) => {
  const resolver = useSongCreditVisualResolver();

  return computed(() => {
    const current = toValue(song);
    if (!current) return [];
    return resolver.value.song(current, toValue(sourceServer), toValue(variant));
  });
};
