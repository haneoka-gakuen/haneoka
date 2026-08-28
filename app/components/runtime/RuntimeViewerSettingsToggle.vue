<script setup lang="ts">
import { MaterialIcon, UiIconButton } from "@haneoka/ui";

defineProps<{ label: string }>();

const open = defineModel<boolean>({ default: false });
</script>

<template>
  <UiIconButton
    class="runtime-viewer-settings-toggle"
    :label="label"
    :pressed="open"
    :aria-expanded="open"
    tone="runtime"
    touch-target
    @click="open = !open"
  >
    <MaterialIcon name="tune" :size="20" />
  </UiIconButton>
</template>

<style scoped>
.runtime-viewer-settings-toggle {
  position: absolute;
  z-index: var(--md-sys-z-index-local-sticky);
  top: var(--md-sys-spacing-2);
  right: var(--md-sys-spacing-2);
}

@media (max-width: 560px) {
  .runtime-viewer-settings-toggle {
    top: var(--md-sys-spacing-1);
    right: var(--md-sys-spacing-1);
  }
}
</style>
