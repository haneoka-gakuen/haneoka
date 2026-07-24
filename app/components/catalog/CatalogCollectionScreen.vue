<script setup lang="ts">
import type { CapabilityDomain } from "~/config/capabilities";

withDefaults(
  defineProps<{
    title: string;
    count?: number | string;
    domain?: CapabilityDomain;
    pending?: boolean;
    error?: unknown;
    empty?: boolean;
    filterTitle?: string;
    showViewControl?: boolean;
    viewportMode?: "scroll" | "stage";
    detailTitle?: string;
    detailWidth?: string;
    detailAvailable?: boolean;
    desktopDetailCollapsible?: boolean;
    activeFilterCount?: number;
  }>(),
  {
    domain: "catalog",
    pending: false,
    error: undefined,
    empty: false,
    filterTitle: undefined,
    showViewControl: true,
    viewportMode: "scroll",
    detailTitle: undefined,
    detailWidth: "340px",
    detailAvailable: true,
    desktopDetailCollapsible: false,
    activeFilterCount: 0,
  },
);

const view = defineModel<"grid" | "list">("view", { required: true });
const detailOpen = defineModel<boolean>("detailOpen", { default: false });
const emit = defineEmits<{ retry: []; resetFilters: [] }>();
</script>

<template>
  <WorkspaceScreen
    v-model:detail-open="detailOpen"
    :domain="domain"
    :title="title"
    :count="count"
    :filter-title="filterTitle"
    :detail-title="detailTitle"
    :detail-width="detailWidth"
    :detail-available="detailAvailable"
    :desktop-detail-collapsible="desktopDetailCollapsible"
    :active-filter-count="activeFilterCount"
    @reset-filters="emit('resetFilters')"
  >
    <template v-if="$slots['heading-actions']" #heading-actions>
      <slot name="heading-actions" />
    </template>

    <template v-if="showViewControl || $slots['before-view-actions'] || $slots.actions" #actions>
      <slot name="before-view-actions" />
      <CollectionViewControl v-if="showViewControl" v-model="view" />
      <slot name="actions" />
    </template>

    <template v-if="$slots.filters" #filters>
      <slot name="filters" />
    </template>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" @retry="emit('retry')" />
    <EmptyState v-else-if="empty" />
    <section v-else class="catalog-collection-screen" :class="[`is-${view}`, `is-viewport-${viewportMode}`]">
      <div class="catalog-collection-screen__viewport" :class="`is-${viewportMode}`">
        <slot v-if="$slots.content" name="content" :view="view" />
        <slot v-else :name="view" />
      </div>
      <slot name="overlay" />
    </section>

    <template v-if="$slots.detail" #detail>
      <slot name="detail" />
    </template>
  </WorkspaceScreen>
</template>

<style scoped>
.catalog-collection-screen {
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--md-sys-color-surface);
}

.catalog-collection-screen__viewport {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  background: var(--md-sys-color-surface);
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.catalog-collection-screen__viewport.is-stage {
  overflow: hidden;
}
</style>
