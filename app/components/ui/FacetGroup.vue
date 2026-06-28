<script setup lang="ts">
import { MaterialIcon, UiFilterChip, UiIconButton } from "@haneoka/ui";

import { langOf, textOf, type DisplayText } from "~/types/displayText";
import type { CompositeEntityVisual } from "~/types/compositeVisual";

export interface FacetOption {
  value: string | number;
  label: DisplayText;
  color?: string;
  image?: string;
  imageFit?: "contain" | "cover";
  avatarText?: string;
  avatarLang?: string;
  icon?: string;
  visuals?: CompositeEntityVisual[];
  textMark?: string;
  tooltip?: DisplayText;
  count?: number;
}

const props = withDefaults(
  defineProps<{
    title: string;
    options: FacetOption[];
    modelValue: Array<string | number>;
    single?: boolean;
    mark?: "attribute" | "rarity";
    attributeVariant?: "card" | "live";
    iconOnly?: boolean;
  }>(),
  { single: false },
);

const emit = defineEmits<{
  "update:modelValue": [value: Array<string | number>];
}>();
const { t } = useLocale();
const accessibleOptionLabel = (option: FacetOption) => {
  const label = textOf(option.tooltip || option.label);
  return option.count === undefined ? label : `${label} (${option.count})`;
};

const toggle = (value: string | number) => {
  if (props.single) {
    emit("update:modelValue", props.modelValue.includes(value) ? [] : [value]);
    return;
  }
  emit(
    "update:modelValue",
    props.modelValue.includes(value) ? props.modelValue.filter((item) => item !== value) : [...props.modelValue, value],
  );
};
const clearSelection = () => emit("update:modelValue", []);
</script>

<template>
  <fieldset class="facet">
    <legend class="meta-label">
      <span>{{ title }}</span>
      <span v-if="modelValue.length" class="facet__legend-actions">
        <span class="facet__selected-count display-number">{{ modelValue.length }}</span>
        <UiIconButton :label="`${t('clear')} ${title}`" size="compact" touch-target @click="clearSelection">
          <MaterialIcon name="filter_alt_off" :size="18" />
        </UiIconButton>
      </span>
    </legend>
    <div class="facet__options" :class="{ 'is-icon-only': iconOnly }">
      <UiFilterChip
        v-for="option in options"
        :key="option.value"
        class="facet__option"
        :class="{
          'is-active': modelValue.includes(option.value),
          'is-icon-only': iconOnly,
          'has-attribute': mark === 'attribute',
          'has-rarity': mark === 'rarity',
        }"
        :aria-label="accessibleOptionLabel(option)"
        :selected="modelValue.includes(option.value)"
        :title="iconOnly ? accessibleOptionLabel(option) : undefined"
        :lang="langOf(option.label)"
        :style="{ '--facet-color': option.color || 'var(--md-sys-color-primary)' }"
        @click="toggle(option.value)"
      >
        <template #icon>
          <AttributeMark
            v-if="mark === 'attribute'"
            class="facet__attribute"
            :attribute="String(option.value)"
            :variant="attributeVariant"
          />
          <RarityMark v-else-if="mark === 'rarity'" class="facet__rarity" :rarity="option.value" />
          <CompositeEntityIcon
            v-else-if="option.visuals?.length"
            class="facet__composite"
            :items="option.visuals"
            transparent-background
          />
          <span v-else-if="option.textMark" class="facet__text-mark display-number">
            {{ option.textMark }}
          </span>
          <EntityAvatar
            v-else-if="option.image || option.avatarText"
            class="facet__image"
            :class="{ 'is-transparent': iconOnly }"
            :image="option.image"
            :text="option.avatarText"
            :lang="option.avatarLang"
            :fit="option.imageFit"
            :color="option.color"
            :icon="option.icon"
          />
          <MaterialIcon v-else-if="option.icon" class="facet__icon" :name="option.icon" :size="21" />
          <span v-else-if="option.color" class="facet__color" :style="{ background: option.color }" />
        </template>
        <span :class="{ 'sr-only': iconOnly }"><DisplayText :value="option.label" /></span>
        <span v-if="option.count !== undefined && !iconOnly" class="facet__count display-number">
          {{ option.count }}
        </span>
      </UiFilterChip>
      <p v-if="!options.length" class="facet__empty" role="status">{{ t("empty") }}</p>
    </div>
  </fieldset>
</template>

<style scoped>
.facet {
  min-width: 0;
  padding: 0;
  margin: 0;
  border: 0;
}

legend {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: var(--md-sys-spacing-2);
  margin-bottom: 8px;
}

.facet__options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--md-sys-spacing-1);
}

.facet__options.is-icon-only {
  grid-template-columns: repeat(auto-fill, var(--md-comp-control-height-touch));
  gap: 8px;
}

.facet__option {
  width: 100%;
  max-width: 100%;
  min-height: var(--md-comp-control-height);
  --md-filter-chip-container-height: var(--md-comp-control-height);
  --md-filter-chip-icon-size: 24px;
  --md-filter-chip-leading-space: 10px;
  --md-filter-chip-trailing-space: 10px;
  --md-filter-chip-with-leading-icon-leading-space: 8px;
}

.facet__option.has-rarity {
  --md-filter-chip-icon-size: 32px;
}

.facet__option.is-icon-only {
  --facet-icon-size: 34px;
  --facet-icon-inline-space: calc((var(--md-comp-control-height-touch) - var(--facet-icon-size)) / 2);

  width: var(--md-comp-control-height-touch);
  min-width: var(--md-comp-control-height-touch);
  min-height: var(--md-comp-control-height-touch);
  flex: 0 0 var(--md-comp-control-height-touch);
  --md-filter-chip-container-height: var(--md-comp-control-height-touch);
  --md-filter-chip-container-shape: var(--md-sys-shape-corner-full);
  --md-filter-chip-icon-size: var(--facet-icon-size);
  --md-filter-chip-icon-label-space: 0px;
  --md-filter-chip-leading-space: var(--facet-icon-inline-space);
  --md-filter-chip-trailing-space: var(--facet-icon-inline-space);
  --md-filter-chip-with-leading-icon-leading-space: var(--facet-icon-inline-space);
}

.facet__option.is-icon-only.is-active {
  --md-filter-chip-outline-color: var(--facet-color);
  --md-filter-chip-selected-container-color: color-mix(in srgb, var(--facet-color) 18%, white);
}

.facet__image {
  width: 24px;
  height: 24px;
  --entity-avatar-font-size: 8px;
}

.facet__image.is-transparent {
  background: transparent;
}

.facet__composite {
  width: 24px;
  height: 24px;
}

.facet__option.is-icon-only .facet__image {
  width: 34px;
  height: 34px;
  --entity-avatar-font-size: 11px;
}

.facet__option.is-icon-only .facet__composite {
  width: 34px;
  height: 34px;
}

.facet__text-mark {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  color: var(--facet-color);
  font-family: var(--md-sys-typescale-label-large-font);
  font-size: var(--md-sys-typescale-label-large-size);
  font-weight: var(--md-sys-typescale-label-large-weight);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.facet__option.is-icon-only .facet__text-mark {
  width: 34px;
  height: 34px;
}

.facet__icon {
  color: var(--facet-color);
}

.facet__color {
  width: 9px;
  height: 9px;
  flex: 0 0 auto;
  border: 1px solid rgb(255 255 255 / 0.8);
  border-radius: 50%;
  box-shadow: 0 0 0 1px rgb(24 34 73 / 0.15);
}

.facet__attribute :deep(img) {
  width: 20px;
  height: 20px;
}

.facet__option.is-icon-only .facet__attribute :deep(img) {
  width: 32px;
  height: 32px;
}

.facet__rarity {
  width: 32px;
  height: 24px;
}

.facet__option.is-icon-only .facet__rarity {
  width: 36px;
  height: 27px;
}

.facet__count {
  margin-left: auto;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.62rem;
}

.facet__legend-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--md-sys-spacing-1);
}

.facet__empty {
  grid-column: 1 / -1;
  margin: 0;
  padding: var(--md-sys-spacing-3);
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: var(--md-sys-typescale-body-small-line-height);
  text-align: center;
}

.facet__selected-count {
  display: inline-grid;
  min-width: 22px;
  height: 22px;
  place-items: center;
  padding-inline: var(--md-sys-spacing-1);
  color: var(--md-sys-color-on-secondary-container);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-secondary-container);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
}

@media (max-width: 359px) {
  .facet__options:not(.is-icon-only) {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
