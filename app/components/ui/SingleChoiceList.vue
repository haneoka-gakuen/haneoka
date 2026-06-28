<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

export interface SingleChoiceOption {
  value: string;
  label: string;
  icon?: string;
  image?: string;
  imageAlt?: string;
  lang?: string;
}

const props = defineProps<{
  label: string;
  modelValue: string;
  name: string;
  options: readonly SingleChoiceOption[];
}>();

const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const select = (value: string) => {
  if (value !== props.modelValue) emit("update:modelValue", value);
};
</script>

<template>
  <div class="single-choice-list" role="radiogroup" :aria-label="label">
    <label
      v-for="option in options"
      :key="option.value"
      class="single-choice-list__option"
      :class="{ 'is-selected': option.value === modelValue }"
      :for="`${name}-${option.value}`"
    >
      <md-ripple />
      <span class="single-choice-list__leading" aria-hidden="true">
        <slot name="leading" :option="option">
          <img
            v-if="option.image"
            :src="option.image"
            :alt="option.imageAlt || ''"
            :aria-hidden="option.imageAlt ? undefined : 'true'"
            loading="lazy"
            decoding="async"
          />
          <MaterialIcon v-else-if="option.icon" :name="option.icon" :size="24" />
        </slot>
      </span>
      <span class="single-choice-list__label" :lang="option.lang">{{ option.label }}</span>
      <md-radio
        :id="`${name}-${option.value}`"
        :name="name"
        :value="option.value"
        :checked="option.value === modelValue"
        touch-target="wrapper"
        @change="select(option.value)"
      />
    </label>
  </div>
</template>

<style scoped>
.single-choice-list {
  display: grid;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-lowest);
}

.single-choice-list__option {
  position: relative;
  display: grid;
  min-width: 0;
  min-height: 56px;
  grid-template-columns: 40px minmax(0, 1fr) 48px;
  align-items: center;
  gap: var(--md-sys-spacing-3);
  padding-left: var(--md-sys-spacing-3);
  color: var(--md-sys-color-on-surface);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  cursor: pointer;
}

.single-choice-list__option:last-child {
  border-bottom: 0;
}

.single-choice-list__option.is-selected {
  color: var(--md-sys-color-on-secondary-container);
  background: var(--md-sys-color-secondary-container);
}

.single-choice-list__leading {
  position: relative;
  z-index: 1;
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  overflow: hidden;
  color: var(--md-sys-color-primary);
  border-radius: var(--md-sys-shape-corner-full);
}

.single-choice-list__leading :deep(img),
.single-choice-list__leading > img {
  width: 40px;
  height: 40px;
  object-fit: cover;
}

.single-choice-list__label {
  position: relative;
  z-index: 1;
  min-width: 0;
  overflow: hidden;
  font-size: var(--md-sys-typescale-body-large-size);
  font-weight: var(--md-sys-typescale-body-large-weight);
  line-height: var(--md-sys-typescale-body-large-line-height);
  letter-spacing: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.single-choice-list md-radio {
  position: relative;
  z-index: 1;
}
</style>
