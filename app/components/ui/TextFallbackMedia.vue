<script setup lang="ts">
import { type DisplayText } from "~/types/displayText";

type ImageExpander = (url: string | null | undefined) => readonly string[];

const props = withDefaults(
  defineProps<{
    image?: string;
    label: DisplayText;
    secondaryLabel?: DisplayText;
    icon?: string;
    color?: string;
    fallbackAspectRatio?: string;
    fit?: "contain" | "cover";
    eager?: boolean;
    /** Expand `image` into a locale/variant fallback chain; each is tried in order on error. */
    expandImage?: ImageExpander;
  }>(),
  {
    image: "",
    secondaryLabel: "",
    icon: "image_not_supported",
    color: "var(--md-sys-color-primary)",
    fallbackAspectRatio: "1 / 1",
    fit: "contain",
    eager: false,
  },
);

const emit = defineEmits<{ imageError: [] }>();
// `image` is the base of a locale-fallback candidate chain. By default we use
// the gated Our Notes expander (locale-tagged variant first, then the ja base;
// language-neutral paths collapse to a single base), so every TextFallbackMedia
// renders the right language wherever a localized variant exists without any
// caller wiring. An explicit `expandImage` override (e.g. a provider with its
// own URL scheme) takes precedence. We walk the chain the way StoryMediaRail
// does: try the current candidate, advance on error, and surface the text
// fallback only once every candidate is exhausted.
const defaultExpand = useLocalizedAssetSources();
const sources = computed<readonly string[]>(() => {
  if (!props.image) return [];
  return props.expandImage ? props.expandImage(props.image) : defaultExpand(props.image);
});
const candidateIndex = ref(0);
// Restart from the first candidate whenever the set changes — a new image, or a
// new locale (the expander reads the active locale, so its output shifts with it).
watch(sources, () => {
  candidateIndex.value = 0;
});
const imageFailed = computed(() => candidateIndex.value >= sources.value.length);
const showImage = computed(() => sources.value.length > 0 && !imageFailed.value);
const currentSrc = computed(() => sources.value[candidateIndex.value] ?? "");
const onImageError = () => {
  candidateIndex.value += 1;
  if (candidateIndex.value >= sources.value.length) emit("imageError");
};
</script>

<template>
  <span class="text-fallback-media" :class="{ 'is-fallback': !showImage }" aria-hidden="true">
    <img
      v-if="showImage"
      :src="currentSrc"
      alt=""
      :class="`is-${fit}`"
      :loading="eager ? 'eager' : 'lazy'"
      decoding="async"
      :fetchpriority="eager ? 'high' : 'low'"
      @error="onImageError"
    />
    <TextMediaFallback
      v-else
      :label="label"
      :secondary-label="secondaryLabel"
      :icon="icon"
      :color="color"
      :aspect-ratio="fallbackAspectRatio"
    />
  </span>
</template>

<style scoped>
.text-fallback-media {
  display: block;
  width: 100%;
  min-width: 0;
  overflow: hidden;
}

.text-fallback-media > img {
  display: block;
  width: 100%;
  height: auto;
}

.text-fallback-media > img.is-cover {
  object-fit: cover;
}

.text-fallback-media.is-fallback {
  display: grid;
}
</style>
