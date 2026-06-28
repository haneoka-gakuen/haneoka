<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

import { langOf, textOf, type DisplayText } from "~/types/displayText";

const props = withDefaults(
  defineProps<{
    label: DisplayText;
    secondaryLabel?: DisplayText;
    icon?: string;
    color?: string;
    aspectRatio?: string;
  }>(),
  {
    secondaryLabel: "",
    icon: "image_not_supported",
    color: "var(--md-sys-color-primary)",
    aspectRatio: "1 / 1",
  },
);
</script>

<template>
  <span
    class="text-media-fallback"
    :style="{
      '--text-media-accent': color,
      aspectRatio: props.aspectRatio,
    }"
    aria-hidden="true"
  >
    <MaterialIcon class="text-media-fallback__icon" :name="icon" :size="18" />
    <span class="text-media-fallback__copy">
      <strong class="localized-text" :lang="langOf(label)"><DisplayText :value="label" /></strong>
      <small v-if="textOf(secondaryLabel)" class="localized-text" :lang="langOf(secondaryLabel)">
        <DisplayText :value="secondaryLabel" />
      </small>
    </span>
  </span>
</template>

<style scoped>
.text-media-fallback {
  position: relative;
  display: grid;
  width: 100%;
  min-width: 0;
  min-height: 72px;
  align-content: space-between;
  gap: var(--md-sys-spacing-3);
  padding: clamp(10px, 9%, 18px);
  overflow: hidden;
  color: var(--md-sys-color-on-surface);
  background:
    radial-gradient(
      circle at 100% 0%,
      color-mix(in srgb, var(--text-media-accent) 24%, transparent) 0 28%,
      transparent 29%
    ),
    linear-gradient(
      145deg,
      color-mix(in srgb, var(--text-media-accent) 16%, var(--md-sys-color-surface-container-lowest)),
      var(--md-sys-color-surface-container-high)
    );
}

.text-media-fallback::after {
  position: absolute;
  right: -12%;
  bottom: -24%;
  width: 62%;
  aspect-ratio: 1;
  border: 1px solid color-mix(in srgb, var(--text-media-accent) 28%, transparent);
  border-radius: var(--md-sys-shape-corner-full);
  content: "";
}

.text-media-fallback__icon {
  position: relative;
  z-index: 1;
  color: color-mix(in srgb, var(--text-media-accent) 72%, var(--md-sys-color-on-surface));
}

.text-media-fallback__copy {
  position: relative;
  z-index: 1;
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--md-sys-spacing-1);
}

.text-media-fallback__copy strong,
.text-media-fallback__copy small {
  display: -webkit-box;
  overflow: hidden;
  overflow-wrap: anywhere;
  text-overflow: ellipsis;
  white-space: normal;
  -webkit-box-orient: vertical;
}

.text-media-fallback__copy strong {
  color: var(--md-sys-color-on-surface);
  font-family: var(--md-sys-typescale-title-small-font);
  font-size: clamp(var(--md-sys-typescale-label-medium-size), 8.5cqi, var(--md-sys-typescale-title-small-size));
  font-weight: var(--md-sys-typescale-title-small-weight);
  line-height: 1.22;
  -webkit-line-clamp: 3;
}

.text-media-fallback__copy small {
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
  -webkit-line-clamp: 2;
}
</style>
