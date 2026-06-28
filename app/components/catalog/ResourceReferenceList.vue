<script setup lang="ts">
import { MaterialIcon, UiIconButton, UiList, UiListItem } from "@haneoka/ui";

import { langOf, textOf, type DisplayText } from "~/types/displayText";

export interface ResourceReferenceItem {
  key: string;
  title: DisplayText;
  subtitle?: DisplayText;
  image?: string;
  quantity?: string | number;
  href?: string;
}

withDefaults(
  defineProps<{
    title?: DisplayText;
    items?: ResourceReferenceItem[];
    compact?: boolean;
  }>(),
  { title: "", items: () => [], compact: false },
);
</script>

<template>
  <section v-if="items.length" class="resource-references" :class="{ 'is-compact': compact }">
    <h3 v-if="textOf(title)" class="meta-label"><DisplayText :value="title" /></h3>
    <UiList>
      <UiListItem v-for="item in items" :key="item.key" type="text">
        <template #start>
          <span class="resource-references__visual">
            <img
              v-if="item.image"
              :src="item.image"
              :alt="textOf(item.title)"
              :lang="langOf(item.title)"
              loading="lazy"
              decoding="async"
            />
          </span>
        </template>
        <template #headline>
          <strong><DisplayText :value="item.title" /></strong>
        </template>
        <template v-if="textOf(item.subtitle)" #supporting>
          <small v-if="textOf(item.subtitle)"><DisplayText :value="item.subtitle" /></small>
        </template>
        <template #end>
          <span class="resource-references__end">
            <code v-if="item.quantity !== '' && item.quantity != null" class="display-number">{{ item.quantity }}</code>
            <UiIconButton
              v-if="item.href"
              :href="item.href"
              target="_blank"
              rel="noopener"
              size="compact"
              :label="textOf(item.title)"
              :lang="langOf(item.title)"
              @click.stop
            >
              <MaterialIcon name="north_east" :size="14" aria-hidden="true" />
            </UiIconButton>
          </span>
        </template>
      </UiListItem>
    </UiList>
  </section>
</template>

<style scoped>
.resource-references {
  min-width: 0;
}

.resource-references h3 {
  margin: 0 0 7px;
}

.resource-references .md3-list {
  padding: 0;
}

.resource-references__visual {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
}

.resource-references__visual img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.resource-references strong,
.resource-references small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.resource-references code {
  color: var(--md-sys-color-outline);
  font: var(--md-sys-typescale-label-small-weight) var(--md-sys-typescale-label-small-size) /
    var(--md-sys-typescale-label-small-line-height) var(--md-sys-typescale-label-small-font);
}

.resource-references__end {
  display: inline-flex;
  align-items: center;
  gap: var(--md-sys-spacing-2);
}

.resource-references.is-compact .md3-list-item {
  --md-list-item-one-line-container-height: 40px;
  --md-list-item-two-line-container-height: 48px;
  --md-list-item-leading-space: 0;
  --md-list-item-trailing-space: 0;
}

.resource-references.is-compact .resource-references__visual {
  width: 28px;
  height: 28px;
}
</style>
