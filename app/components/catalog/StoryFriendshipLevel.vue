<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

defineProps<{
  level: number;
}>();

const { t } = useLocale();
</script>

<template>
  <span class="story-friendship-level display-number">
    <MaterialIcon name="handshake" :size="12" aria-hidden="true" />
    {{ t("friendshipLevel") }} {{ level }}
  </span>
</template>

<style scoped>
.story-friendship-level {
  display: inline-flex;
  align-items: center;
  gap: var(--md-sys-spacing-1);
  color: var(--md-sys-color-primary);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
}
</style>
