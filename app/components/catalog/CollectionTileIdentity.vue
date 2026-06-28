<script setup lang="ts">
import { textOf, type DisplayText } from "~/types/displayText";

const props = withDefaults(
  defineProps<{
    title: DisplayText;
    subtitle?: DisplayText;
  }>(),
  { subtitle: "" },
);

const slots = useSlots();
const hasSubtitle = () => Boolean(slots.subtitle) || Boolean(textOf(props.subtitle));
</script>

<template>
  <span class="collection-tile-identity">
    <strong class="collection-tile-identity__title">
      <slot name="title"><DisplayText :value="title" /></slot>
    </strong>
    <small v-if="hasSubtitle()" class="collection-tile-identity__subtitle">
      <slot name="subtitle"><DisplayText :value="subtitle" /></slot>
    </small>
  </span>
</template>

<style scoped>
.collection-tile-identity {
  display: flex;
  width: 100%;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
  color: var(--md-sys-color-on-surface);
  text-align: start;
}

.collection-tile-identity__title {
  display: -webkit-box;
  min-width: 0;
  min-block-size: calc(
    var(--md-sys-typescale-label-medium-line-height) + var(--md-sys-typescale-label-medium-line-height)
  );
  overflow: hidden;
  overflow-wrap: anywhere;
  font-family: var(--md-sys-typescale-label-medium-font);
  font-size: var(--md-sys-typescale-label-medium-size);
  font-weight: var(--md-sys-typescale-label-medium-weight);
  line-height: var(--md-sys-typescale-label-medium-line-height);
  text-overflow: ellipsis;
  white-space: normal;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.collection-tile-identity__subtitle {
  display: flex;
  min-width: 0;
  overflow: hidden;
  align-items: center;
  gap: var(--md-sys-spacing-2);
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.collection-tile-identity__subtitle > :slotted(*) {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
}
</style>
