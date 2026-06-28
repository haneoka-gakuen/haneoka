<script setup lang="ts">
import { MaterialIcon, UiButton } from "@haneoka/ui";

defineProps<{ label?: string; actionLabel?: string }>();

defineEmits<{ retry: [] }>();
const { t } = useLocale();
</script>

<template>
  <div class="error-state" role="alert">
    <span class="error-state__icon" aria-hidden="true"><MaterialIcon name="error" :size="24" /></span>
    <p class="error-state__label">{{ label || t("unavailable") }}</p>
    <UiButton tone="neutral" @click="$emit('retry')">
      <template #icon><MaterialIcon name="refresh" :size="18" /></template>
      {{ actionLabel || t("retry") }}
    </UiButton>
  </div>
</template>

<style scoped>
.error-state {
  display: flex;
  min-height: 180px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-5);
  color: var(--md-sys-color-on-surface-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-low);
  font-family: var(--md-sys-typescale-body-medium-font);
  font-size: var(--md-sys-typescale-body-medium-size);
  font-weight: var(--md-sys-typescale-body-medium-weight);
  line-height: var(--md-sys-typescale-body-medium-line-height);
  text-align: center;
}

.error-state__icon {
  display: grid;
  width: 48px;
  height: 48px;
  place-items: center;
  color: var(--md-sys-color-on-error-container);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-error-container);
}

.error-state__label {
  max-width: min(100%, 32rem);
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
