<script setup lang="ts">
import type { SingleChoiceOption } from "~/components/ui/SingleChoiceList.vue";

defineProps<{
  label: string;
  modelValue: string;
  name: string;
  options: readonly SingleChoiceOption[];
}>();

defineEmits<{ "update:modelValue": [value: string] }>();
</script>

<template>
  <div class="icon-row" role="radiogroup" :aria-label="label">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      role="radio"
      :aria-checked="modelValue === option.value"
      :aria-label="option.label"
      :name="name"
      class="icon-row__item"
      :class="{ 'is-selected': modelValue === option.value }"
      @click="$emit('update:modelValue', option.value)"
    >
      <slot name="leading" :option="option">
        <img
          v-if="option.image"
          :src="option.image"
          :alt="option.imageAlt || ''"
          class="icon-row__image"
          :loading="'lazy'"
        />
        <span v-else class="material-symbols-rounded icon-row__icon">{{ option.icon }}</span>
      </slot>
    </button>
  </div>
</template>

<style scoped>
.icon-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--md-sys-spacing-3);
}

.icon-row__item {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  padding: 0;
  border: 2px solid var(--md-sys-color-outline-variant);
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
  transition:
    border-color var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard),
    background-color var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
}

.icon-row__item:hover {
  background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent);
}

.icon-row__item:focus-visible {
  border-color: var(--md-sys-color-primary);
}

.icon-row__item.is-selected {
  border-color: var(--md-sys-color-primary);
  border-width: 3px;
  background: color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent);
}

.icon-row__item.is-selected::after {
  content: "";
  position: absolute;
  inset: -6px;
  border: 2px solid var(--md-sys-color-primary);
  border-radius: 50%;
  opacity: 0.3;
  pointer-events: none;
}

.icon-row__image,
.icon-row__icon {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
}

.icon-row__icon {
  display: grid;
  place-items: center;
  font-size: 24px;
  color: var(--md-sys-color-on-surface);
}

@media (prefers-reduced-motion: reduce) {
  .icon-row__item {
    transition: none;
  }
}
</style>
