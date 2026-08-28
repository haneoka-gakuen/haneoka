<script setup lang="ts">
import { liveMusicTypeLabel } from "~/config/liveMusic";
import { runtimeReleaseForCatalogOrigin, type CatalogContentOrigin } from "~/features/catalog/contentSource";
import type { Song } from "~/types/archive";
import { langOf, textOf, type DisplayText } from "~/types/displayText";

const props = defineProps<{
  song: Song;
  title: DisplayText;
  band: DisplayText;
  /** Full-resolution jacket used by high-density displays. */
  image?: string;
  /** Lightweight jacket used by standard-density displays and as a fallback. */
  thumbnailImage?: string;
  musicType?: string | number;
  categories?: unknown;
  creditOrigin?: CatalogContentOrigin;
  selected?: boolean;
}>();

const emit = defineEmits<{ select: [] }>();
const { locale } = useLocale();
const { releaseServer } = useReleaseServer();
const runtimeRelease = computed(() => runtimeReleaseForCatalogOrigin(props.creditOrigin, releaseServer.value));

const imageFailed = ref(false);
const usingThumbnailFallback = ref(false);
const imageSource = computed(() => props.thumbnailImage || props.image || "");
const imageSourceSet = computed(() => {
  if (usingThumbnailFallback.value) return undefined;
  const thumbnail = props.thumbnailImage?.trim();
  const full = props.image?.trim();
  return thumbnail && full && thumbnail !== full ? `${thumbnail} 1x, ${full} 2x` : undefined;
});
const imageCandidates = computed(() => [props.thumbnailImage?.trim() || "", props.image?.trim() || ""]);
watch(imageCandidates, () => {
  imageFailed.value = false;
  usingThumbnailFallback.value = false;
});

const fallbackToThumbnail = () => {
  const thumbnail = props.thumbnailImage?.trim();
  const full = props.image?.trim();
  // A 2x full jacket can fail independently of the thumbnail selected for
  // `src`. Switch declaratively so LoadingImage resets its state and Vue owns
  // the retry rather than mutating a native element behind the renderer.
  if (!usingThumbnailFallback.value && thumbnail && full && thumbnail !== full) {
    usingThumbnailFallback.value = true;
    return;
  }
  imageFailed.value = true;
};
</script>

<template>
  <CollectionTileSurface
    class="song-catalog-tile"
    :label="title"
    :secondary-label="band"
    :lang="langOf(title)"
    :selected="selected"
    @select="emit('select')"
  >
    <template #media>
      <span class="song-catalog-tile__media">
        <LoadingImage
          v-if="imageSource && !imageFailed"
          :src="imageSource"
          :srcset="imageSourceSet"
          alt=""
          :loading="selected ? 'eager' : 'lazy'"
          :fetchpriority="selected ? 'high' : 'low'"
          placeholder-aspect-ratio="1 / 1"
          @error="fallbackToThumbnail"
        />
        <TextMediaFallback v-else :label="title" :secondary-label="band" icon="music_note" />
        <AttributeMark
          v-if="musicType"
          class="song-catalog-tile__attribute"
          :attribute="musicType"
          :runtime-release="runtimeRelease"
          variant="live"
          :aria-label="liveMusicTypeLabel(musicType, locale)"
        />
        <SongTypeMark class="song-catalog-tile__type" :type="categories" compact />
      </span>
    </template>
    <CollectionTileIdentity :title="title" :subtitle="band">
      <template v-if="textOf(band)" #subtitle>
        <span class="song-catalog-tile__band-credit">
          <SongCreditVisual
            class="song-catalog-tile__band-visual"
            :song="song"
            :origin="creditOrigin"
            :label="textOf(band)"
          />
          <span class="song-catalog-tile__band-label"><DisplayText :value="band" /></span>
        </span>
      </template>
    </CollectionTileIdentity>
  </CollectionTileSurface>
</template>

<style scoped>
.song-catalog-tile__media {
  position: relative;
  display: block;
  width: 100%;
  overflow: hidden;
}

.song-catalog-tile__media > :deep(.loading-image) {
  display: block;
  width: 100%;
  height: auto;
}

.song-catalog-tile__type {
  position: absolute;
  top: 5px;
  right: 5px;
  max-width: calc(100% - 10px);
}

.song-catalog-tile__attribute {
  position: absolute;
  top: 5px;
  left: 5px;
}

.song-catalog-tile__attribute :deep(img) {
  width: 24px;
  height: 24px;
}

.song-catalog-tile__band-credit {
  display: inline-flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 5px;
}

.song-catalog-tile__band-visual {
  --song-credit-logo-width: 24px;
  --song-credit-logo-height: 20px;
  --song-credit-avatar-size: 20px;
  --song-credit-gap: 1px;
}

.song-catalog-tile__band-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
