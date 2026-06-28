<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

defineProps<{
  navigationLabel: string;
  items: ReadonlyArray<{
    id: string;
    icon?: string;
    label: string;
    route: string;
  }>;
}>();

const { rememberedRoute } = useWorkspaceMemory();
</script>

<template>
  <nav class="workspace-index" :aria-label="navigationLabel">
    <md-filled-card v-for="item in items" :key="item.id" class="workspace-index__card">
      <NuxtLink class="workspace-index__card-action" :to="rememberedRoute(item.route)">
        <md-ripple />
        <MaterialIcon v-if="item.icon" class="workspace-index__icon" :name="item.icon" :size="22" />
        <span class="workspace-index__label">{{ item.label }}</span>
        <MaterialIcon class="workspace-index__arrow" name="arrow_forward" :size="18" />
      </NuxtLink>
    </md-filled-card>
  </nav>
</template>

<style scoped>
.workspace-index {
  display: grid;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-template-columns: repeat(auto-fill, minmax(192px, 1fr));
  align-content: start;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-4) var(--md-comp-page-inline-space);
  overflow: auto;
  background: var(--md-sys-color-surface);
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.workspace-index__card {
  width: 100%;
  --md-filled-card-container-color: var(--md-sys-color-surface-container-low);
  --md-filled-card-container-elevation: 0;
}

.workspace-index__card-action {
  position: relative;
  display: grid;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 76px;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-3) var(--md-sys-spacing-4);
  overflow: hidden;
  color: var(--md-sys-color-on-surface);
  text-decoration: none;
}

.workspace-index__icon {
  color: var(--md-sys-color-primary);
}

.workspace-index__label {
  min-width: 0;
  font-family: var(--md-ref-typeface-plain);
  font-size: var(--md-sys-typescale-label-large-size);
  font-weight: var(--md-sys-typescale-label-large-weight);
  line-height: var(--md-sys-typescale-label-large-line-height);
  overflow-wrap: anywhere;
}

.workspace-index__arrow {
  color: var(--md-sys-color-on-surface-variant);
}

@media (max-width: 599px) {
  .workspace-index {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--md-sys-spacing-2);
    padding: var(--md-sys-spacing-2) var(--md-sys-spacing-3);
  }

  .workspace-index__card-action {
    min-height: 96px;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-rows: auto 1fr;
    align-items: start;
    gap: var(--md-sys-spacing-2);
    padding: var(--md-sys-spacing-3);
  }

  .workspace-index__icon {
    grid-column: 1;
    grid-row: 1;
  }

  .workspace-index__label {
    grid-column: 1 / -1;
    grid-row: 2;
    align-self: end;
  }

  .workspace-index__arrow {
    grid-column: 2;
    grid-row: 1;
  }
}
</style>
