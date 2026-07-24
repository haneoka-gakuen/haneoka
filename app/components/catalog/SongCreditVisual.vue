<script setup lang="ts">
import type { CompositeEntityVisual } from "~/types/compositeVisual";
import type { Song } from "~/types/archive";
import type { SongCreditVisualVariant } from "~/features/catalog/songCreditVisuals";
import { ourNotesReleaseOrigin, type CatalogContentOrigin } from "~/features/catalog/contentSource";

const props = defineProps<{
  items?: readonly CompositeEntityVisual[];
  label?: string;
  song?: Song;
  origin?: CatalogContentOrigin;
  variant?: SongCreditVisualVariant;
}>();

const failedImages = reactive(new Set<string>());
const { releaseServer } = useReleaseServer();
const inferredOrigin = computed(() => props.origin || ourNotesReleaseOrigin(releaseServer.value));
const inferredItems = useSongCreditVisuals(
  () => props.song,
  inferredOrigin,
  () => props.variant || "logo",
);
const sourceItems = computed(() => (props.items?.length ? props.items : inferredItems.value));
const visibleItems = computed(() =>
  sourceItems.value.flatMap((item) => {
    const candidates = item.imageCandidates?.length ? item.imageCandidates : [item.image];
    const image = candidates.find((candidate) => candidate?.trim() && !failedImages.has(candidate));
    return image || item.text || item.icon ? [{ ...item, image }] : [];
  }),
);

watch([() => props.items, () => props.song, () => props.origin, () => props.variant], () => failedImages.clear());
</script>

<template>
  <span
    v-if="visibleItems.length"
    class="song-credit-visual"
    role="img"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
  >
    <template v-for="(item, index) in visibleItems" :key="`${item.image || item.text || item.icon}:${index}`">
      <img
        v-if="item.image"
        class="song-credit-visual__item"
        :class="item.fit === 'cover' ? 'is-character' : 'is-band'"
        :src="item.image"
        alt=""
        loading="lazy"
        decoding="async"
        @error="failedImages.add(item.image)"
      />
      <EntityAvatar
        v-else
        class="song-credit-visual__item is-character"
        :text="item.text"
        :lang="item.lang"
        :icon="item.icon"
        :color="item.color"
      />
    </template>
  </span>
</template>

<style scoped>
.song-credit-visual {
  display: inline-flex;
  min-width: 0;
  height: var(--song-credit-logo-height, 24px);
  flex: 0 0 auto;
  align-items: center;
  gap: var(--song-credit-gap, 2px);
}

.song-credit-visual__item {
  display: block;
  flex: 0 0 auto;
}

.song-credit-visual__item.is-band {
  width: var(--song-credit-logo-width, 34px);
  height: var(--song-credit-logo-height, 24px);
  object-fit: contain;
}

.song-credit-visual__item.is-character {
  width: var(--song-credit-avatar-size, var(--song-credit-logo-height, 24px));
  height: var(--song-credit-avatar-size, var(--song-credit-logo-height, 24px));
  object-fit: cover;
  border-radius: var(--md-sys-shape-corner-full);
}

.song-credit-visual__item.is-character + .song-credit-visual__item.is-character {
  margin-left: var(--song-credit-avatar-overlap, -5px);
}
</style>
