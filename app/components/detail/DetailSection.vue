<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

import type { DisplayText } from "~/types/displayText";

withDefaults(
  defineProps<{
    title: DisplayText;
    icon?: string;
    count?: number;
  }>(),
  {
    icon: "",
    count: undefined,
  },
);

const headingId = useId();
</script>

<template>
  <section class="detail-section" :aria-labelledby="headingId">
    <header class="detail-section__header">
      <span v-if="icon" class="detail-section__icon" aria-hidden="true">
        <MaterialIcon :name="icon" :size="19" />
      </span>
      <h2 :id="headingId"><DisplayText :value="title" /></h2>
      <span v-if="count !== undefined" class="detail-section__count display-number">{{ count }}</span>
      <div v-if="$slots.actions" class="detail-section__actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="detail-section__body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.detail-section {
  --md-comp-detail-block-gap: var(--md-sys-spacing-3);

  min-width: 0;
  padding-block: var(--md-sys-spacing-4);
  border-top: 1px solid var(--md-sys-color-outline-variant);
}

.detail-section:first-child {
  padding-top: var(--md-sys-spacing-1);
  border-top: 0;
}

.detail-section__header {
  display: flex;
  min-height: 32px;
  align-items: center;
  gap: var(--md-sys-spacing-2);
  margin-bottom: var(--md-sys-spacing-3);
}

.detail-section__icon {
  display: grid;
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  place-items: center;
  color: var(--md-sys-color-primary);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-secondary-container);
}

.detail-section h2 {
  min-width: 0;
  margin: 0;
  color: var(--md-sys-color-on-surface);
  font-family: var(--md-sys-typescale-title-medium-font);
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: var(--md-sys-typescale-title-medium-weight);
  line-height: var(--md-sys-typescale-title-medium-line-height);
  overflow-wrap: anywhere;
}

.detail-section__count {
  min-width: 24px;
  padding: var(--md-sys-spacing-1) var(--md-sys-spacing-2);
  color: var(--md-sys-color-on-secondary-container);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-secondary-container);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
  text-align: center;
}

.detail-section__actions {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--md-sys-spacing-2);
  margin-left: auto;
}

.detail-section__body {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: var(--md-comp-detail-block-gap);
}

@media (max-width: 599px) {
  .detail-section {
    --md-comp-detail-block-gap: var(--md-sys-spacing-2);

    padding-block: var(--md-sys-spacing-3);
  }

  .detail-section__header {
    margin-bottom: var(--md-sys-spacing-2);
  }
}
</style>
