<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

import type { StoryEpisode } from "~/types/archive";
import type { DisplayText } from "~/types/displayText";

type ImageExpander = (url: string | null | undefined) => readonly string[];

const props = withDefaults(
  defineProps<{
    episode: StoryEpisode;
    title: DisplayText;
    duration?: string;
    selected?: boolean;
    imageMode?: "natural" | "cover" | "stretch-4x3" | "stretch-16x9";
    /** When provided, expand the episode image into language-fallback candidates. */
    expandImage?: ImageExpander;
  }>(),
  { imageMode: "natural" },
);

const emit = defineEmits<{ select: [] }>();

const sources = computed<readonly string[]>(() => {
  const base = [props.episode.banner, props.episode.image].filter(
    (entry): entry is string => typeof entry === "string" && Boolean(entry),
  );
  return props.expandImage && base.length ? props.expandImage(base[0]) : base;
});
const { src, onError } = useFallbackImage(sources);
const episodeNumber = computed(() =>
  String(props.episode.episodeNumber || props.episode.storySort || 0).padStart(2, "0"),
);
const secondaryLabel = computed(() => [episodeNumber.value, props.duration].filter(Boolean).join(" · "));
const fallbackAspectRatio = computed(() =>
  props.imageMode === "stretch-16x9" ? "16 / 9" : "var(--md-comp-story-media-aspect-ratio)",
);
</script>

<template>
  <CollectionTileSurface
    class="episode-row"
    :class="`is-${imageMode}`"
    :data-story-id="episode.storyId"
    :label="title"
    :secondary-label="secondaryLabel"
    :selected="selected"
    @select="emit('select')"
  >
    <template #media>
      <span class="episode-row__media">
        <img v-if="src" :src="src" alt="" loading="lazy" decoding="async" @error="onError" />
        <TextMediaFallback
          v-else
          :label="title"
          :secondary-label="secondaryLabel"
          icon="auto_stories"
          :aspect-ratio="fallbackAspectRatio"
        />
      </span>
    </template>

    <CollectionTileIdentity class="episode-row__copy" :title="title">
      <template #subtitle>
        <span class="episode-row__number display-number">{{ episodeNumber }}</span>
        <span v-if="duration" class="episode-row__duration display-number">
          <MaterialIcon name="schedule" :size="12" />
          {{ duration }}
        </span>
      </template>
    </CollectionTileIdentity>
  </CollectionTileSurface>
</template>

<style scoped>
.episode-row {
  width: clamp(112px, 12vw, 156px);
  flex: 0 0 clamp(112px, 12vw, 156px);
  /* Off-screen horizontal cards must use their real height. The base tile's
     320px content-visibility placeholder otherwise inflates long filmstrips. */
  content-visibility: visible;
  contain-intrinsic-size: none;
}

.episode-row :deep(.collection-tile-surface__media) {
  background: transparent;
}

.episode-row :deep(.collection-tile-surface__metadata) {
  align-items: stretch;
}

.episode-row__media {
  display: block;
  width: 100%;
  overflow: hidden;
  background: var(--md-sys-color-surface-container-high);
}

.episode-row__media img {
  display: block;
  width: 100%;
  height: auto;
}

.episode-row.is-cover .episode-row__media,
.episode-row.is-stretch-4x3 .episode-row__media,
.episode-row.is-stretch-16x9 .episode-row__media {
  aspect-ratio: var(--md-comp-story-media-aspect-ratio);
}

.episode-row.is-stretch-16x9 .episode-row__media {
  aspect-ratio: 16 / 9;
}

.episode-row.is-cover .episode-row__media img,
.episode-row.is-stretch-4x3 .episode-row__media img,
.episode-row.is-stretch-16x9 .episode-row__media img {
  height: 100%;
}

.episode-row.is-cover .episode-row__media img {
  object-fit: cover;
}

.episode-row.is-stretch-4x3 .episode-row__media img,
.episode-row.is-stretch-16x9 .episode-row__media img {
  object-fit: fill;
}

.episode-row__number {
  color: var(--md-sys-color-on-surface-variant);
}

.episode-row__duration {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--md-sys-color-on-surface-variant);
}
</style>
