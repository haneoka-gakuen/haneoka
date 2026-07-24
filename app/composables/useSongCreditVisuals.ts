import { toValue, type MaybeRefOrGetter } from "vue";

import type { Band, Character, Song } from "~/types/archive";
import { createSongCreditVisualResolver, type SongCreditVisualVariant } from "~/features/catalog/songCreditVisuals";
import { ourNotesReleaseOrigin, type CatalogContentOrigin } from "~/features/catalog/contentSource";

/**
 * Credit entities are loaded from one exact origin. Passing the origin is
 * mandatory for cross-game catalog consumers; omitting it means the selected
 * Our Notes release, never a fictional `bestdori` server.
 */
export const useSongCreditVisualResolver = (origin?: MaybeRefOrGetter<CatalogContentOrigin | undefined>) => {
  const { releaseServer } = useReleaseServer();
  const resolvedOrigin = computed<CatalogContentOrigin>(() => {
    const requested = origin === undefined ? undefined : toValue(origin);
    return requested || ourNotesReleaseOrigin(releaseServer.value);
  });
  const bands = useCatalogCollection<Band>("bands", resolvedOrigin);
  const characters = useCatalogCollection<Character>("characters", resolvedOrigin);

  return computed(() =>
    createSongCreditVisualResolver({
      sources: [
        {
          origin: resolvedOrigin.value,
          bands: recordValues(bands.data.value),
          characters: recordValues(characters.data.value),
        },
      ],
    }),
  );
};

export const useSongCreditVisuals = (
  song: MaybeRefOrGetter<Song | undefined>,
  origin: MaybeRefOrGetter<CatalogContentOrigin>,
  variant: MaybeRefOrGetter<SongCreditVisualVariant> = "logo",
) => {
  const resolver = useSongCreditVisualResolver(origin);

  return computed(() => {
    const current = toValue(song);
    if (!current) return [];
    return resolver.value.song(current, toValue(origin), toValue(variant));
  });
};
