<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

import type { DisplayText } from "~/types/displayText";

const props = defineProps<{
  title: DisplayText;
  subtitle: string;
  image?: string;
  imageFit?: "contain" | "cover";
  to: string;
  fallbackIcon?: string;
}>();

const imageFailed = ref(false);
watch(
  () => props.image,
  () => {
    imageFailed.value = false;
  },
);
</script>

<template>
  <CollectionTileSurface
    class="playlist-catalog-tile"
    :class="{ 'is-contained': imageFit === 'contain' }"
    :label="title"
    :secondary-label="subtitle"
    aspect-ratio="1"
    :to="to"
  >
    <template #media>
      <span class="playlist-catalog-tile__media">
        <img
          v-if="image && !imageFailed"
          :src="image"
          alt=""
          loading="lazy"
          decoding="async"
          @error="imageFailed = true"
        />
        <span v-else class="playlist-catalog-tile__fallback">
          <DisplayText v-if="fallbackIcon === 'groups'" :value="title" />
          <MaterialIcon v-else :name="fallbackIcon || 'queue_music'" :size="34" />
        </span>
      </span>
    </template>
    <CollectionTileIdentity :title="title" :subtitle="subtitle" />
  </CollectionTileSurface>
</template>

<style scoped>
.playlist-catalog-tile__media,
.playlist-catalog-tile__media > img,
.playlist-catalog-tile__fallback {
  display: grid;
  width: 100%;
  height: 100%;
}

.playlist-catalog-tile__media > img {
  object-fit: cover;
}

.is-contained .playlist-catalog-tile__media {
  padding: var(--md-sys-spacing-3);
}

.is-contained .playlist-catalog-tile__media > img {
  object-fit: contain;
}

.playlist-catalog-tile__fallback {
  place-items: center;
  padding: var(--md-sys-spacing-3);
  color: var(--md-sys-color-on-secondary-container);
  background: var(--md-sys-color-secondary-container);
  font: var(--md-sys-typescale-title-medium-weight) var(--md-sys-typescale-title-medium-size) /
    var(--md-sys-typescale-title-medium-line-height) var(--md-sys-typescale-title-medium-font);
  text-align: center;
}
</style>
