<script setup lang="ts">
import type { RouteLocationRaw } from "vue-router";
import { NuxtLink } from "#components";

withDefaults(
  defineProps<{
    label?: string;
    language?: string;
    selected?: boolean;
    rowIndex?: number;
    /** Read-only rows keep shared geometry without becoming faux buttons. */
    interactive?: boolean;
    /** Use the shared row as a real router link when a collection entry opens a page. */
    to?: RouteLocationRaw;
  }>(),
  { label: undefined, language: undefined, selected: false, rowIndex: undefined, interactive: true, to: undefined },
);

const emit = defineEmits<{ select: [] }>();

const onKeydown = (event: KeyboardEvent) => {
  if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
  event.preventDefault();
  emit("select");
};
</script>

<template>
  <component
    :is="to ? NuxtLink : 'article'"
    :to="to"
    class="catalog-selectable-row collection-table-row"
    :class="{ 'is-interactive': interactive || Boolean(to), 'is-selected': selected }"
    role="row"
    :aria-rowindex="rowIndex === undefined ? undefined : rowIndex + 2"
    :aria-label="label"
    :lang="language"
    :aria-selected="interactive || to ? selected : undefined"
    :aria-current="to && selected ? 'true' : undefined"
    :tabindex="to ? undefined : interactive ? 0 : undefined"
    @click="interactive && emit('select')"
    @keydown="to || !interactive ? undefined : onKeydown"
  >
    <md-ripple />
    <slot />
  </component>
</template>

<style scoped>
.collection-table-row md-ripple {
  z-index: 5;
  --md-ripple-hover-color: var(--md-sys-color-on-surface);
  --md-ripple-pressed-color: var(--md-sys-color-primary);
}
</style>
