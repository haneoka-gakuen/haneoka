<script setup lang="ts">
import type { DisplayText } from "~/types/displayText";

/**
 * Pure presentational shell for a "skill"-style block: an icon + label + name
 * header, an optional description, and an open slot for trailing detail (effect
 * rows, a cost breakdown, target chips, …). It owns no data fetching so it can be
 * reused by anything that renders a skill-like surface — card skills (whose text
 * resolution lives in `CardSkillBlock`) and band-item level effects alike.
 */
defineProps<{
  icon?: string;
  label?: string;
  name?: DisplayText;
  description?: DisplayText | null;
}>();
</script>

<template>
  <section class="skill-block">
    <header v-if="icon || label || name" class="skill-block__header">
      <span v-if="icon" class="skill-block__icon" aria-hidden="true">
        <img :src="icon" alt="" loading="lazy" decoding="async" />
      </span>
      <span class="skill-block__heading">
        <span v-if="label" class="skill-block__label meta-label">{{ label }}</span>
        <strong v-if="name"><DisplayText :value="name" /></strong>
      </span>
    </header>
    <p v-if="description"><DisplayText :value="description" /></p>
    <slot />
  </section>
</template>

<style scoped>
.skill-block {
  position: relative;
  padding: var(--md-sys-spacing-3) var(--md-sys-spacing-4);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container-lowest);
}

.skill-block__label {
  display: block;
  margin-bottom: var(--md-sys-spacing-1);
}

.skill-block__header {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--md-sys-spacing-3);
}

.skill-block__icon {
  display: grid;
  width: 42px;
  height: 42px;
  flex: 0 0 auto;
  place-items: center;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--md-sys-color-primary) 16%, var(--md-sys-color-outline-variant));
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container-high);
}

.skill-block__icon img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.skill-block__heading {
  min-width: 0;
}

strong {
  display: block;
  overflow: hidden;
  font-family: var(--md-sys-typescale-title-small-font);
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: var(--md-sys-typescale-title-small-weight);
  line-height: var(--md-sys-typescale-title-small-line-height);
  text-overflow: ellipsis;
  white-space: nowrap;
}

p {
  margin: var(--md-sys-spacing-2) 0 0;
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-body-small-font);
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: var(--md-sys-typescale-body-small-line-height);
  white-space: pre-line;
}
</style>
