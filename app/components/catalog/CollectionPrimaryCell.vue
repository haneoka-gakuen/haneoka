<script setup lang="ts">
import { langOf, textOf, type DisplayText } from "~/types/displayText";
import { entityAvatarText } from "~/utils/entityAvatar";

const props = withDefaults(
  defineProps<{
    title: DisplayText;
    subtitle?: DisplayText;
    image?: string;
    mediaIcon?: string;
    mediaText?: DisplayText;
    mediaColor?: string;
    mediaShape?: "circle" | "rounded";
    imageFit?: "contain" | "cover";
  }>(),
  {
    subtitle: "",
    image: "",
    mediaIcon: undefined,
    mediaText: "",
    mediaColor: undefined,
    mediaShape: "rounded",
    imageFit: "contain",
  },
);

const imageFailed = ref(false);
watch(
  () => props.image,
  () => {
    imageFailed.value = false;
  },
);
const fallbackText = computed(() => entityAvatarText(textOf(props.mediaText) ? props.mediaText : props.title));
</script>

<template>
  <span class="collection-primary-cell" role="gridcell">
    <span
      class="collection-primary-cell__media"
      :class="{ 'is-fallback': !image || imageFailed, 'is-circle': mediaShape === 'circle' }"
      aria-hidden="true"
    >
      <img
        v-if="image && !imageFailed"
        :src="image"
        :alt="textOf(title)"
        :lang="langOf(title)"
        loading="lazy"
        decoding="async"
        :class="{ 'is-cover': imageFit === 'cover' }"
        @error="imageFailed = true"
      />
      <EntityAvatar
        v-else
        class="collection-primary-cell__fallback"
        :text="fallbackText"
        :lang="langOf(mediaText || title)"
        :icon="mediaIcon"
        :color="mediaColor"
        :shape="mediaShape"
      />
    </span>

    <span class="collection-primary-cell__copy">
      <strong><DisplayText :value="title" /></strong>
      <small v-if="textOf(subtitle)"><DisplayText :value="subtitle" /></small>
    </span>
  </span>
</template>

<style scoped>
.collection-primary-cell {
  display: flex;
  min-width: 0;
  align-self: stretch;
  align-items: center;
  justify-content: flex-start;
  gap: var(--md-sys-spacing-2);
  padding-inline-end: var(--md-sys-spacing-2);
  text-align: start;
}

.collection-primary-cell__media {
  display: grid;
  width: max-content;
  height: 44px;
  flex: 0 0 auto;
  place-items: center;
  overflow: hidden;
  color: var(--md-sys-color-on-surface-variant);
  border-radius: var(--md-sys-shape-corner-extra-small);
  background: var(--md-sys-color-surface-container-high);
}

.collection-primary-cell__media.is-fallback {
  width: 44px;
}

.collection-primary-cell__media.is-circle {
  width: 44px;
  border-radius: var(--md-sys-shape-corner-full);
  background: transparent;
}

.collection-primary-cell__fallback {
  width: 44px;
  height: 44px;
  --entity-avatar-font-size: 12px;
}

.collection-primary-cell__media img {
  display: block;
  width: auto;
  max-width: none;
  height: 44px;
  max-height: 44px;
  object-fit: contain;
}

.collection-primary-cell__media img.is-cover {
  width: 44px;
  object-fit: cover;
}

.collection-primary-cell__copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--md-sys-spacing-1);
}

.collection-primary-cell__copy strong,
.collection-primary-cell__copy small {
  min-width: 0;
  text-align: start;
  white-space: nowrap;
}

.collection-primary-cell__copy strong {
  color: var(--md-sys-color-on-surface);
  font-family: var(--md-sys-typescale-label-large-font);
  font-size: var(--md-sys-typescale-label-large-size);
  font-weight: var(--md-sys-typescale-label-large-weight);
  line-height: var(--md-sys-typescale-label-large-line-height);
}

.collection-primary-cell__copy small {
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
}
</style>
