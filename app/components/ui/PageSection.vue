<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

withDefaults(
  defineProps<{
    title: string;
    description?: string;
    icon?: string;
    divided?: boolean;
  }>(),
  {
    description: "",
    icon: "",
    divided: false,
  },
);

const headingId = useId();
</script>

<template>
  <section class="page-section" :class="{ 'is-divided': divided }" :aria-labelledby="headingId">
    <header class="page-section__header">
      <span v-if="icon" class="page-section__icon" aria-hidden="true">
        <MaterialIcon :name="icon" :size="20" />
      </span>
      <div class="page-section__copy">
        <h2 :id="headingId">{{ title }}</h2>
        <p v-if="description">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="page-section__actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="page-section__body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.page-section {
  min-width: 0;
}

.page-section.is-divided {
  padding-top: var(--md-sys-spacing-5);
  border-top: 1px solid var(--md-sys-color-outline-variant);
}

.page-section__header {
  display: flex;
  min-width: 0;
  min-height: 48px;
  align-items: center;
  gap: var(--md-sys-spacing-3);
  padding: 0 var(--md-sys-spacing-2) var(--md-sys-spacing-2);
}

.page-section__icon {
  display: grid;
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  place-items: center;
  color: var(--md-sys-color-on-secondary-container);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-secondary-container);
}

.page-section__copy {
  display: grid;
  min-width: 0;
  gap: var(--md-sys-spacing-1);
}

.page-section h2,
.page-section p {
  margin: 0;
}

.page-section h2 {
  color: var(--md-sys-color-on-surface);
  font: var(--md-sys-typescale-title-medium-weight) var(--md-sys-typescale-title-medium-size) /
    var(--md-sys-typescale-title-medium-line-height) var(--md-sys-typescale-title-medium-font);
  letter-spacing: 0;
}

.page-section p {
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-small-weight) var(--md-sys-typescale-body-small-size) /
    var(--md-sys-typescale-body-small-line-height) var(--md-sys-typescale-body-small-font);
  letter-spacing: 0;
}

.page-section__actions {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--md-sys-spacing-2);
  margin-left: auto;
}

.page-section__body {
  min-width: 0;
}
</style>
