<script setup lang="ts">
import { MaterialIcon, UiIconButton, UiTextField } from "@haneoka/ui";

withDefaults(
  defineProps<{
    modelValue: string;
    label?: string;
    placeholder?: string;
    fullWidth?: boolean;
    compact?: boolean;
    clearLabel?: string;
  }>(),
  {
    label: "",
    placeholder: "",
    fullWidth: false,
    compact: false,
    clearLabel: "",
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  clear: [];
}>();
const { t } = useLocale();

const clear = () => {
  emit("update:modelValue", "");
  emit("clear");
};
</script>

<template>
  <UiTextField
    class="search-field"
    :class="{ 'is-full-width': fullWidth, 'is-compact': compact }"
    type="search"
    :label="compact ? '' : label || t('search')"
    :aria-label="compact ? label || t('search') : undefined"
    :placeholder="placeholder || (compact ? label || t('search') : '')"
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', String($event))"
  >
    <template #leading-icon><MaterialIcon name="search" :size="20" /></template>
    <template v-if="modelValue" #trailing-icon>
      <UiIconButton :label="clearLabel || t('clear')" size="compact" touch-target @click="clear">
        <MaterialIcon name="close" :size="18" />
      </UiIconButton>
    </template>
  </UiTextField>
</template>

<style scoped>
.search-field {
  width: min(100%, var(--md-comp-search-field-max-width));
  max-width: 100%;
  align-self: flex-start;
  --md-outlined-text-field-container-shape: var(--md-comp-search-field-shape);
}

.search-field.is-full-width {
  width: 100%;
}

.search-field.is-compact {
  height: var(--md-comp-control-height-compact);
  min-height: var(--md-comp-control-height-compact);
  align-self: center;
  --md-outlined-text-field-top-space: var(--md-sys-spacing-1);
  --md-outlined-text-field-bottom-space: var(--md-sys-spacing-1);
  --md-outlined-text-field-leading-space: var(--md-sys-spacing-2);
  --md-outlined-text-field-trailing-space: var(--md-sys-spacing-1);
  --md-outlined-text-field-with-leading-icon-leading-space: var(--md-sys-spacing-2);
  --md-outlined-text-field-with-trailing-icon-trailing-space: var(--md-sys-spacing-1);
  --md-outlined-text-field-icon-input-space: var(--md-sys-spacing-2);
  --md-outlined-text-field-input-text-font: var(--md-sys-typescale-body-small-font);
  --md-outlined-text-field-input-text-size: var(--md-sys-typescale-body-small-size);
  --md-outlined-text-field-input-text-line-height: var(--md-sys-typescale-body-small-line-height);
}

@media (max-width: 599px) {
  .search-field {
    width: 100%;
  }
}
</style>
