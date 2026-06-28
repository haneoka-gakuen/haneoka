<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

import { songTypeDefinition } from "~/config/songTypes";

const props = withDefaults(
  defineProps<{
    type?: unknown;
    compact?: boolean;
    iconOnly?: boolean;
  }>(),
  { compact: false, iconOnly: false },
);

const { locale } = useLocale();
const definition = computed(() => songTypeDefinition(props.type, locale.value));
</script>

<template>
  <span
    class="song-type-mark"
    :class="[`song-type-mark--${definition.key}`, { 'is-compact': compact, 'is-icon-only': iconOnly }]"
    :style="{ '--song-type-color': definition.color }"
    :title="iconOnly ? definition.label : undefined"
    :aria-label="iconOnly ? definition.label : undefined"
  >
    <MaterialIcon :name="definition.icon" :size="compact ? 11 : 13" />
    <span :class="{ 'sr-only': iconOnly }">{{ definition.label }}</span>
  </span>
</template>

<style scoped>
.song-type-mark {
  display: inline-flex;
  min-width: 0;
  min-height: 25px;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0 8px;
  color: color-mix(in srgb, var(--song-type-color) 82%, #17213d);
  border: 1px solid color-mix(in srgb, var(--song-type-color) 48%, white);
  border-radius: var(--md-sys-shape-corner-full);
  background: color-mix(in srgb, var(--song-type-color) 10%, rgb(255 255 255 / 0.92));
  font-family: var(--md-ref-typeface-brand);
  font-size: 0.59rem;
  font-weight: 680;
  letter-spacing: 0;
  line-height: 1;
  vertical-align: middle;
  white-space: nowrap;
}

.song-type-mark.is-compact {
  min-height: 20px;
  gap: 3px;
  padding-inline: 6px;
  font-size: 0.52rem;
}

.song-type-mark.is-icon-only {
  width: 25px;
  min-width: 25px;
  height: 25px;
  justify-content: center;
  padding: 0;
}

.song-type-mark.is-compact.is-icon-only {
  width: 21px;
  min-width: 21px;
  height: 21px;
}
</style>
