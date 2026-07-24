<script setup lang="ts">
import { liveMusicTypeLabel } from "~/config/liveMusic";
import { bestdoriOrigin, runtimeReleaseForCatalogOrigin } from "~/features/catalog/contentSource";
import { useBestdoriImageSources } from "~/features/community/bestdori/imageSources";
import { langOf, textOf, type DisplayText } from "~/types/displayText";

const props = defineProps<{
  title: DisplayText;
  normalImage?: string;
  trainedImage?: string;
  attribute?: string | number;
  rarity?: string | number;
}>();

const { locale } = useLocale();
const { releaseServer } = useReleaseServer();
// Bestdori card metadata remains Garupa content. Only the shared UI sprite
// atlas uses this explicit Our Notes renderer fallback release.
const runtimeRelease = computed(() => runtimeReleaseForCatalogOrigin(bestdoriOrigin("jp"), releaseServer.value));
const expandImage = useBestdoriImageSources();
const normalSources = computed(() => expandImage(props.normalImage));
const trainedSources = computed(() => expandImage(props.trainedImage));
const { src: normalSrc, onError: onNormalError } = useFallbackImage(normalSources);
const { src: trainedSrc, onError: onTrainedError } = useFallbackImage(trainedSources);

const attributeLabel = computed(() => liveMusicTypeLabel(props.attribute, locale.value));
const imageCount = computed(() => Number(Boolean(normalSrc.value)) + Number(Boolean(trainedSrc.value)));
const imageAlt = computed(() => textOf(props.title));
</script>

<template>
  <span
    class="bestdori-card-artwork"
    :class="{
      'is-single': imageCount === 1,
      'is-double': imageCount === 2,
      'is-empty': imageCount === 0,
    }"
    role="img"
    :aria-label="imageAlt"
    :lang="langOf(title)"
  >
    <span v-if="normalSrc" class="bestdori-card-artwork__panel">
      <img :src="normalSrc" alt="" loading="lazy" decoding="async" @error="onNormalError" />
    </span>

    <span v-if="trainedSrc" class="bestdori-card-artwork__panel">
      <img :src="trainedSrc" alt="" loading="lazy" decoding="async" @error="onTrainedError" />
    </span>

    <TextMediaFallback
      v-if="imageCount === 0"
      class="bestdori-card-artwork__unsupported"
      :label="title"
      icon="style"
      aspect-ratio="16 / 9"
    />

    <AttributeMark
      v-if="attribute !== undefined && attribute !== null && attribute !== ''"
      class="bestdori-card-artwork__attribute"
      :attribute="attribute"
      :label="attributeLabel"
      :runtime-release="runtimeRelease"
      icon-only
    />
    <BestdoriRarityMark class="bestdori-card-artwork__rarity" :rarity="rarity" />
  </span>
</template>

<style scoped>
.bestdori-card-artwork {
  position: relative;
  display: grid;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
  padding: 5px;
  overflow: hidden;
  background:
    radial-gradient(
      circle at 50% 45%,
      color-mix(in srgb, var(--md-sys-color-primary) 9%, transparent),
      transparent 62%
    ),
    var(--md-sys-color-surface-container-low);
}

.bestdori-card-artwork.is-single,
.bestdori-card-artwork.is-empty {
  grid-template-columns: minmax(0, 1fr);
}

.bestdori-card-artwork__panel {
  position: relative;
  display: grid;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  place-items: center;
  border-radius: 6px;
  background: color-mix(in srgb, var(--md-sys-color-surface) 68%, transparent);
}

.bestdori-card-artwork__panel img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.bestdori-card-artwork__unsupported {
  width: 100%;
  height: 100%;
}

.bestdori-card-artwork__attribute,
.bestdori-card-artwork__rarity {
  position: absolute;
  z-index: 4;
  pointer-events: none;
}

.bestdori-card-artwork__attribute {
  top: 8px;
  left: 8px;
}

.bestdori-card-artwork__attribute :deep(img) {
  width: 28px;
  height: 28px;
}

.bestdori-card-artwork__rarity {
  right: 6px;
  bottom: 5px;
}
</style>
