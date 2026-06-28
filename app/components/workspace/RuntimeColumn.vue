<script setup lang="ts">
import { MaterialIcon, UiIconButton } from "@haneoka/ui";

import type { DetailHeaderIconItem } from "~/components/detail/types";
import { textOf, type DisplayText } from "~/types/displayText";

const props = withDefaults(
  defineProps<{
    id: string;
    title?: DisplayText;
    subtitle?: DisplayText;
    count?: number | string;
    kind?: "list" | "stage" | "settings";
    closeable?: boolean;
    /** Promote this runtime's heading into the enclosing WorkspaceScreen app bar. */
    workspaceHeader?: boolean;
    workspaceHeaderVariant?: "page" | "detail";
    workspaceHeaderLeadingIcons?: readonly DetailHeaderIconItem[];
  }>(),
  {
    title: "",
    subtitle: "",
    count: undefined,
    kind: "list",
    closeable: false,
    workspaceHeader: false,
    workspaceHeaderVariant: "page",
    workspaceHeaderLeadingIcons: () => [],
  },
);

const emit = defineEmits<{ close: [] }>();
const { locale, t } = useLocale();
const workspaceTopAppBar = useWorkspaceTopAppBar();
const workspaceTopAppBarOwner = Symbol("runtime-column");
const promotedHeader = computed(() => Boolean(props.workspaceHeader && workspaceTopAppBar));

watch(
  [
    () => props.workspaceHeader,
    () => props.title,
    () => props.subtitle,
    () => props.count,
    () => props.closeable,
    () => props.workspaceHeaderVariant,
    () => props.workspaceHeaderLeadingIcons,
    locale,
  ],
  ([enabled, title, subtitle, count, closeable, workspaceHeaderVariant, workspaceHeaderLeadingIcons]) => {
    if (!enabled || !workspaceTopAppBar) {
      workspaceTopAppBar?.clear(workspaceTopAppBarOwner);
      return;
    }
    workspaceTopAppBar.set(workspaceTopAppBarOwner, {
      title,
      subtitle,
      count,
      navigation: closeable ? "back" : "none",
      navigationLabel: closeable ? t("previous") : undefined,
      navigate: closeable ? () => emit("close") : undefined,
      suppressPageActions: true,
      variant: workspaceHeaderVariant,
      leadingIcons: workspaceHeaderLeadingIcons,
    });
  },
  { immediate: true },
);

onBeforeUnmount(() => workspaceTopAppBar?.clear(workspaceTopAppBarOwner));
</script>

<template>
  <section
    :data-runtime-column="id"
    class="runtime-column"
    :class="{ 'is-stage': kind === 'stage', 'is-settings': kind === 'settings' }"
  >
    <header
      v-if="!promotedHeader && (textOf(title) || $slots.header || $slots.actions || closeable)"
      class="runtime-column__header"
    >
      <div class="runtime-column__heading">
        <slot name="header">
          <strong><DisplayText :value="title" /></strong>
          <small v-if="count !== undefined" class="display-number">{{ count }}</small>
        </slot>
      </div>
      <div v-if="$slots.actions" class="runtime-column__actions">
        <slot name="actions" />
      </div>
      <UiIconButton
        v-if="closeable"
        class="runtime-column__close"
        :label="t('close')"
        size="touch"
        @click="emit('close')"
      >
        <MaterialIcon name="close" :size="20" />
      </UiIconButton>
    </header>
    <div class="runtime-column__body"><slot /></div>
  </section>
</template>

<style scoped>
.runtime-column {
  position: relative;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  isolation: isolate;
}

.runtime-column:not(:has(> .runtime-column__header)) {
  grid-template-rows: minmax(0, 1fr);
}

.runtime-column__header {
  position: relative;
  z-index: var(--md-sys-z-index-local-sticky);
  display: flex;
  min-height: var(--md-comp-top-app-bar-height);
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 var(--md-sys-spacing-2) 0 var(--md-sys-spacing-4);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-lowest);
}

.runtime-column__heading {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  gap: var(--md-sys-spacing-2);
  overflow: hidden;
}

.runtime-column__heading > strong,
.runtime-column__heading :deep(strong) {
  min-width: 0;
  overflow: hidden;
  font-family: var(--md-ref-typeface-brand);
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: var(--md-sys-typescale-title-small-weight);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.runtime-column__heading > small,
.runtime-column__heading :deep(small) {
  flex: 0 0 auto;
  color: var(--md-sys-color-outline);
  font-size: 0.55rem;
}

.runtime-column__actions {
  display: flex;
  min-width: 0;
  max-width: 72%;
  flex: 0 1 auto;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.runtime-column__actions::-webkit-scrollbar {
  display: none;
}

.runtime-column__close {
  flex: 0 0 auto;
}

.runtime-column__body {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.runtime-column.is-stage .runtime-column__body {
  overflow: hidden;
}

@media (max-width: 599px) {
  .runtime-column__header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 40px;
    min-height: var(--md-comp-top-app-bar-height);
    gap: 4px 8px;
    padding-right: max(4px, env(safe-area-inset-right));
    padding-left: max(12px, env(safe-area-inset-left));
    padding-block: 4px;
  }

  .runtime-column__heading {
    grid-column: 1;
    grid-row: 1;
  }

  .runtime-column__actions {
    grid-column: 1 / -1;
    grid-row: 2;
    width: 100%;
    max-width: none;
    flex-wrap: wrap;
    margin-left: 0;
    overflow: visible;
  }

  .runtime-column__close {
    grid-column: 2;
    grid-row: 1;
    justify-self: end;
  }
}
</style>
