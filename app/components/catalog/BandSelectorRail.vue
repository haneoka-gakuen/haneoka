<script setup lang="ts">
import { UiIconButton } from "@haneoka/ui";

import type { Band } from "~/types/archive";
import { langOf, textOf } from "~/types/displayText";
import { entityAvatarText } from "~/utils/entityAvatar";

withDefaults(
  defineProps<{
    bands: readonly Band[];
    selectedId?: number;
    label?: string;
  }>(),
  { selectedId: undefined, label: "" },
);

const emit = defineEmits<{
  select: [bandId: number];
}>();

const { resolveLocalized } = useLocale();
const optionLabelId = useId();
const bandName = (band: Band) =>
  resolveLocalized(band.bandName, { sourceHint: "ja", fallback: String(band.bandId) }) || String(band.bandId);
const bandLabelId = (bandId: number) => `${optionLabelId}-${bandId}`;
</script>

<template>
  <nav class="band-selector-rail" :aria-label="label">
    <UiIconButton
      v-for="band in bands"
      :key="band.bandId"
      class="band-selector-rail__option"
      :class="{ 'is-selected': band.bandId === selectedId }"
      :style="{ '--option-color': band.color || 'var(--md-sys-color-primary)' }"
      :label="textOf(bandName(band))"
      :aria-labelledby="bandLabelId(band.bandId)"
      :pressed="band.bandId === selectedId"
      :emphasis="band.bandId === selectedId"
      size="touch"
      @click="emit('select', band.bandId)"
    >
      <span :id="bandLabelId(band.bandId)" class="sr-only"><DisplayText :value="bandName(band)" /></span>
      <EntityAvatar
        class="band-selector-rail__image"
        :image="band.icon"
        :text="entityAvatarText(bandName(band))"
        :lang="langOf(bandName(band))"
        :color="band.color"
        icon="music_note"
      />
    </UiIconButton>
  </nav>
</template>

<style scoped>
.band-selector-rail {
  position: relative;
  display: flex;
  min-height: 0;
  flex-direction: column;
  align-items: center;
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-3) var(--md-sys-spacing-2);
  overflow-y: auto;
  border-right: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container);
  overscroll-behavior: contain;
  scrollbar-width: none;
}

.band-selector-rail::-webkit-scrollbar {
  display: none;
}

.band-selector-rail__option {
  /* The native icon-button host owns the 48dp touch target.  Match the
   * artwork slot to its actual 30px icon so image and fallback glyph share
   * the same geometric center instead of inheriting a 24px baseline slot. */
  --md-icon-button-icon-size: 30px;
  --md-filled-tonal-icon-button-icon-size: 30px;
  --md-icon-button-icon-color: var(--md-sys-color-on-surface-variant);
  --md-icon-button-hover-icon-color: var(--md-sys-color-on-surface);
  --md-icon-button-focus-icon-color: var(--md-sys-color-on-surface);
  --md-icon-button-pressed-icon-color: var(--md-sys-color-on-surface);
  --md-filled-tonal-icon-button-container-color: color-mix(
    in srgb,
    var(--option-color) 18%,
    var(--md-sys-color-secondary-container)
  );
  --md-filled-tonal-icon-button-icon-color: var(--md-sys-color-on-secondary-container);
}

.band-selector-rail__option :deep(.md3-icon-button__icon) {
  width: 30px;
  height: 30px;
  align-self: center;
  justify-self: center;
  place-items: center;
}

.band-selector-rail__image {
  display: block;
  width: 30px;
  height: 30px;
  --entity-avatar-font-size: 10px;
}

@media (max-width: 760px) {
  .band-selector-rail {
    flex-direction: row;
    justify-content: flex-start;
    overflow-x: auto;
    overflow-y: hidden;
    padding: var(--md-sys-spacing-2) var(--md-sys-spacing-3);
    border-right: 0;
    border-bottom: 1px solid var(--md-sys-color-outline-variant);
    overscroll-behavior-x: contain;
  }
}
</style>
