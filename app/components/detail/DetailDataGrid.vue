<script setup lang="ts">
import { textOf, type DisplayText } from "~/types/displayText";

interface DetailDataGridItem {
  key: string;
  label: string;
  labelImage?: string;
  labelImageAlt?: DisplayText;
  value: DisplayText | number;
  numeric?: boolean;
  accent?: boolean;
  image?: string;
  imageAlt?: DisplayText;
  imageKind?: "avatar" | "logo" | "attribute";
}

const props = withDefaults(
  defineProps<{
    items: DetailDataGridItem[];
    compact?: boolean;
  }>(),
  { compact: false },
);

// Detail data is intentionally rendered as one continuous record table.  It
// must not turn every value into an unrelated card: that hides the relation
// between a field and the neighbouring values, and is especially noisy on
// song/detail pages.
const columns = computed(() => Math.max(1, props.items.length));
</script>

<template>
  <dl class="detail-data-grid" :class="{ 'is-compact': compact }" :style="{ '--detail-data-columns': columns }">
    <div v-for="item in items" :key="item.key" class="detail-data-grid__item" :class="{ 'is-accent': item.accent }">
      <dt :title="item.label">
        <img v-if="item.labelImage" :src="item.labelImage" :alt="textOf(item.labelImageAlt || item.label)" />
        <template v-else>{{ item.label }}</template>
      </dt>
      <dd
        :class="{
          'display-number': item.numeric,
          'has-image': item.image,
        }"
        :title="typeof item.value === 'number' ? String(item.value) : textOf(item.value)"
      >
        <img
          v-if="item.image"
          :class="item.imageKind ? `is-${item.imageKind}` : undefined"
          :src="item.image"
          :alt="textOf(item.imageAlt)"
        />
        <DisplayText v-if="typeof item.value !== 'number'" :value="item.value" />
        <template v-else>{{ item.value }}</template>
      </dd>
    </div>
  </dl>
</template>

<style scoped>
.detail-data-grid {
  display: grid;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  flex: 0 0 auto;
  grid-template-columns: repeat(var(--detail-data-columns), minmax(max-content, 1fr));
  box-sizing: border-box;
  padding: 0;
  margin: 0;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-inline: contain;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-lowest);
  scrollbar-width: thin;
}

.detail-data-grid__item {
  min-width: max-content;
  padding: var(--md-sys-spacing-2);
  border-right: 1px solid var(--md-sys-color-outline-variant);
  text-align: center;
}

.detail-data-grid__item:last-child {
  border-right: 0;
}

.detail-data-grid dt {
  display: flex;
  min-height: 2.3em;
  align-items: center;
  justify-content: center;
  color: var(--md-sys-color-outline);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
  letter-spacing: 0;
}

.detail-data-grid dt img {
  width: 48px;
  height: 30px;
  object-fit: contain;
}

.detail-data-grid dd {
  margin: 3px 0 0;
  overflow: visible;
  color: var(--md-sys-color-on-surface);
  font-family: var(--md-sys-typescale-body-small-font);
  font-size: var(--md-sys-typescale-body-small-size);
  font-weight: var(--md-sys-typescale-body-small-weight);
  line-height: var(--md-sys-typescale-body-small-line-height);
  text-overflow: clip;
  white-space: nowrap;
}

.detail-data-grid dd.has-image {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: center;
  gap: var(--md-sys-spacing-2);
}

.detail-data-grid dd img {
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  object-fit: contain;
}

.detail-data-grid dd img.is-avatar,
.detail-data-grid dd img.is-attribute {
  border-radius: var(--md-sys-shape-corner-full);
}

.detail-data-grid dd img.is-logo {
  width: 48px;
  height: 24px;
}

.detail-data-grid__item.is-accent dd {
  color: var(--md-comp-detail-accent);
}

.detail-data-grid.is-compact {
  border: 0;
  border-radius: 0;
  background: transparent;
}

.detail-data-grid.is-compact .detail-data-grid__item {
  padding: 3px 5px;
}

.detail-data-grid.is-compact dt {
  min-height: 0;
}

.detail-data-grid.is-compact dd {
  margin-top: 1px;
}
</style>
