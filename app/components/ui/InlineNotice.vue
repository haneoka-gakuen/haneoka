<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

const props = withDefaults(
  defineProps<{
    tone?: "error" | "info" | "success";
    icon?: string;
  }>(),
  {
    tone: "info",
    icon: "",
  },
);

const resolvedIcon = computed(() => {
  if (props.icon) return props.icon;
  if (props.tone === "error") return "error";
  if (props.tone === "success") return "check_circle";
  return "info";
});
</script>

<template>
  <div
    class="inline-notice"
    :class="`is-${tone}`"
    :role="tone === 'error' ? 'alert' : 'status'"
    :aria-live="tone === 'error' ? 'assertive' : 'polite'"
  >
    <MaterialIcon :name="resolvedIcon" :size="20" />
    <div class="inline-notice__content"><slot /></div>
    <div v-if="$slots.actions" class="inline-notice__actions"><slot name="actions" /></div>
  </div>
</template>

<style scoped>
.inline-notice {
  display: grid;
  min-width: 0;
  min-height: 48px;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-2) var(--md-sys-spacing-3);
  color: var(--md-sys-color-on-secondary-container);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-secondary-container);
  font: var(--md-sys-typescale-body-medium-weight) var(--md-sys-typescale-body-medium-size) /
    var(--md-sys-typescale-body-medium-line-height) var(--md-sys-typescale-body-medium-font);
  letter-spacing: 0;
}

.inline-notice.is-success {
  color: var(--md-sys-color-on-primary-container);
  background: var(--md-sys-color-primary-container);
}

.inline-notice.is-error {
  color: var(--md-sys-color-on-error-container);
  background: var(--md-sys-color-error-container);
}

.inline-notice__content {
  min-width: 0;
  overflow-wrap: anywhere;
}

.inline-notice__actions {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--md-sys-spacing-1);
}

@media (max-width: 479px) {
  .inline-notice:has(.inline-notice__actions) {
    grid-template-columns: 24px minmax(0, 1fr);
  }

  .inline-notice__actions {
    grid-column: 2;
    justify-content: flex-start;
  }
}
</style>
