<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

defineProps<{ label?: string }>();
const { t } = useLocale();
</script>

<template>
  <div class="empty-state" role="status">
    <span class="empty-state__icon" aria-hidden="true"><MaterialIcon name="inbox" :size="24" /></span>
    <span class="empty-state__label">{{ label || t("empty") }}</span>
  </div>
</template>

<style scoped>
.empty-state {
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

.empty-state__icon {
  display: grid;
  width: 48px;
  height: 48px;
  place-items: center;
  color: var(--md-sys-color-on-secondary-container);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-secondary-container);
}

.empty-state__label {
  max-width: min(100%, 32rem);
  overflow-wrap: anywhere;
}
</style>
