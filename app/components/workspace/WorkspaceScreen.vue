<script setup lang="ts">
import { collectFocusableElements, MaterialIcon, UiIconButton, type UiIconButtonHandle } from "@haneoka/ui";

import type { CapabilityDomain } from "~/config/capabilities";

const props = withDefaults(
  defineProps<{
    title: string;
    count?: number | string;
    domain?: CapabilityDomain;
    filterTitle?: string;
    detailTitle?: string;
    detailWidth?: string;
    detailAvailable?: boolean;
    desktopDetailCollapsible?: boolean;
    activeFilterCount?: number;
    backTo?: string;
    backLabel?: string;
    backAction?: () => void;
  }>(),
  {
    detailWidth: "360px",
    detailAvailable: true,
    activeFilterCount: 0,
    backTo: "",
    backLabel: "",
  },
);

const slots = useSlots();
const route = useRoute();
const router = useRouter();
const { t } = useLocale();
const detailOpen = defineModel<boolean>("detailOpen", { default: false });
const emit = defineEmits<{ resetFilters: [] }>();
const topAppBar = provideWorkspaceTopAppBar();
const filtersOpen = ref(false);
const narrowLayout = ref(false);
const filterPanelId = useId();
const detailPanelId = useId();
const filterButton = ref<UiIconButtonHandle>();
const detailButton = ref<UiIconButtonHandle>();
const workspaceRoot = ref<HTMLElement>();
const activePanel = ref<"filters" | "detail" | null>(null);
const hasFilters = computed(() => Boolean(slots.filters));
const hasDetail = computed(() => Boolean(props.detailAvailable && slots.detail));
const modalPanelOpen = computed(() => filtersOpen.value || (narrowLayout.value && detailOpen.value));
const topAppBarOverride = computed(() => topAppBar.current.value?.value ?? null);
const pageActionsSuppressed = computed(() => Boolean(topAppBarOverride.value?.suppressPageActions));
const topAppBarModes = computed(() => {
  const override = topAppBarOverride.value;
  if (!override) return [];
  return override.modes ?? (override.mode ? [override.mode] : []);
});
const hasActions = computed(
  () =>
    topAppBarModes.value.length > 0 ||
    (!pageActionsSuppressed.value &&
      (Boolean(slots["heading-actions"] || slots.actions) || hasFilters.value || hasDetail.value)),
);
const filterLabel = computed(() => props.filterTitle || t("filter"));
const detailLabel = computed(() => props.detailTitle || t("details"));
const filterActionLabel = computed(() =>
  props.activeFilterCount > 0 ? `${filterLabel.value} (${props.activeFilterCount})` : filterLabel.value,
);
const navigateBack = () => {
  if (props.backAction) {
    props.backAction();
    return;
  }
  if (!props.backTo) return;
  const previousLocation = router.options.history.state.back;
  if (typeof previousLocation === "string" && previousLocation) {
    router.back();
    return;
  }
  void navigateTo(props.backTo, { replace: true });
};
const navigateTopAppBar = () => {
  if (topAppBarOverride.value?.navigate) {
    topAppBarOverride.value.navigate();
    return;
  }
  navigateBack();
};
const topAppBarNavigation = computed(() => topAppBarOverride.value?.navigation ?? (props.backTo ? "back" : "none"));

const focusPanel = async (selector: string) => {
  await nextTick();
  const panel = workspaceRoot.value?.querySelector<HTMLElement>(selector);
  const target = panel ? collectFocusableElements(panel)[0] : undefined;
  // A mobile drawer is still translated outside the viewport on its first
  // frame. Letting focus scroll there makes iOS pan the entire app before the
  // drawer settles, which looks like the page has jumped.
  (target || panel)?.focus({ preventScroll: true });
};

const closePanels = async (restoreFocus = false) => {
  const panel = activePanel.value;
  filtersOpen.value = false;
  if (narrowLayout.value || props.desktopDetailCollapsible) detailOpen.value = false;
  activePanel.value = null;
  if (!restoreFocus) return;
  await nextTick();
  if (panel === "filters") filterButton.value?.getElement()?.focus({ preventScroll: true });
  if (panel === "detail") detailButton.value?.getElement()?.focus({ preventScroll: true });
};

const toggleFilters = () => {
  const next = !filtersOpen.value;
  if (narrowLayout.value) detailOpen.value = false;
  filtersOpen.value = next;
  activePanel.value = next ? "filters" : null;
  if (next) void focusPanel(".workspace-screen__filters");
};

const toggleDetail = () => {
  filtersOpen.value = false;
  detailOpen.value = !detailOpen.value;
  activePanel.value = detailOpen.value ? "detail" : null;
  if (detailOpen.value && narrowLayout.value) void focusPanel(".workspace-screen__detail");
};

watch(
  () => route.path,
  () => void closePanels(),
);
watch(detailOpen, (open) => {
  if (open) {
    filtersOpen.value = false;
    activePanel.value = "detail";
    if (narrowLayout.value) void focusPanel(".workspace-screen__detail");
  } else if (activePanel.value === "detail") {
    activePanel.value = null;
  }
});

const onKeydown = (event: KeyboardEvent) => {
  if (event.key === "Escape" && (filtersOpen.value || (narrowLayout.value && detailOpen.value))) {
    event.preventDefault();
    void closePanels(true);
    return;
  }
  if (event.key !== "Tab" || !modalPanelOpen.value) return;
  const panel = workspaceRoot.value?.querySelector<HTMLElement>(
    filtersOpen.value ? ".workspace-screen__filters" : ".workspace-screen__detail",
  );
  if (!panel) return;
  const elements = collectFocusableElements(panel);
  if (!elements.length) {
    event.preventDefault();
    panel.focus({ preventScroll: true });
    return;
  }
  const first = elements[0]!;
  const last = elements.at(-1)!;
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
};

let narrowQuery: MediaQueryList | undefined;
const updateLayout = () => {
  narrowLayout.value = Boolean(narrowQuery?.matches);
  if (!narrowLayout.value) filtersOpen.value = false;
};

onMounted(() => {
  narrowQuery = window.matchMedia("(max-width: 839px)");
  updateLayout();
  narrowQuery.addEventListener("change", updateLayout);
  window.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  narrowQuery?.removeEventListener("change", updateLayout);
  window.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <section
    ref="workspaceRoot"
    class="workspace-screen"
    :class="{
      'workspace-screen--no-detail': !hasDetail,
      'workspace-screen--detail-collapsible': props.desktopDetailCollapsible,
      'is-detail-open': detailOpen,
    }"
    :data-domain="domain"
    :style="{ '--workspace-detail-width': props.detailWidth }"
  >
    <PageTopAppBar
      :inert="modalPanelOpen"
      :title="topAppBarOverride?.title ?? title"
      :subtitle="topAppBarOverride?.subtitle"
      :count="topAppBarOverride ? topAppBarOverride.count : count"
      :variant="topAppBarOverride?.variant || 'page'"
      :navigation="topAppBarNavigation"
      :navigation-label="topAppBarOverride?.navigationLabel || backLabel || t('previous')"
      @navigate="navigateTopAppBar"
    >
      <template v-if="topAppBarOverride?.leadingIcons?.length" #leading>
        <DetailHeaderIconList :items="topAppBarOverride.leadingIcons" />
      </template>
      <template v-if="hasActions" #actions>
        <div class="workspace-screen__actions">
          <ViewModeControl
            v-for="control in topAppBarModes"
            :key="control.label"
            class="workspace-screen__override-mode"
            :model-value="control.value"
            :options="control.options"
            :label="control.label"
            :compact="control.compact"
            :icon-only="control.iconOnly"
            @update:model-value="control.update"
          />
          <div v-if="!pageActionsSuppressed && $slots['heading-actions']" class="workspace-screen__context">
            <slot name="heading-actions" />
          </div>
          <div v-if="!pageActionsSuppressed && $slots.actions" class="workspace-screen__extra-actions">
            <slot name="actions" />
          </div>
          <span v-if="!pageActionsSuppressed && hasFilters" class="workspace-screen__action-wrap">
            <UiIconButton
              ref="filterButton"
              class="workspace-screen__action"
              :label="filterActionLabel"
              :pressed="filtersOpen"
              :emphasis="filtersOpen || props.activeFilterCount > 0"
              touch-target
              :aria-controls="filterPanelId"
              :aria-expanded="filtersOpen"
              @click="toggleFilters"
            >
              <MaterialIcon name="filter_alt" :size="22" />
            </UiIconButton>
            <strong
              v-if="props.activeFilterCount > 0"
              class="workspace-screen__filter-count display-number"
              aria-hidden="true"
            >
              {{ props.activeFilterCount > 99 ? "99+" : props.activeFilterCount }}
            </strong>
          </span>
          <UiIconButton
            v-if="!pageActionsSuppressed && hasDetail && (narrowLayout || props.desktopDetailCollapsible)"
            ref="detailButton"
            class="workspace-screen__action"
            :label="detailLabel"
            :pressed="detailOpen"
            :emphasis="detailOpen"
            touch-target
            :aria-controls="detailPanelId"
            :aria-expanded="detailOpen"
            @click="toggleDetail"
          >
            <MaterialIcon name="info" :size="22" />
          </UiIconButton>
        </div>
      </template>
    </PageTopAppBar>

    <div class="workspace-screen__body" :inert="filtersOpen">
      <div class="workspace-screen__stage" :inert="narrowLayout && detailOpen"><slot /></div>

      <aside
        v-if="hasDetail"
        :id="detailPanelId"
        class="workspace-screen__detail"
        :class="{ 'is-open': detailOpen }"
        :inert="narrowLayout && !detailOpen"
        :aria-hidden="narrowLayout && !detailOpen"
        :role="narrowLayout ? 'dialog' : undefined"
        :aria-modal="narrowLayout ? true : undefined"
        :aria-label="detailLabel"
        :tabindex="narrowLayout ? -1 : undefined"
      >
        <header class="workspace-screen__panel-header">
          <strong>{{ detailLabel }}</strong>
          <UiIconButton :label="t('close')" size="compact" touch-target @click="void closePanels(true)">
            <MaterialIcon name="close" :size="20" />
          </UiIconButton>
        </header>
        <div class="workspace-screen__panel-scroll"><slot name="detail" /></div>
      </aside>
    </div>

    <aside
      v-if="hasFilters"
      :id="filterPanelId"
      class="workspace-screen__filters"
      :class="{ 'is-open': filtersOpen }"
      :inert="!filtersOpen"
      :aria-hidden="!filtersOpen"
      role="dialog"
      :aria-modal="narrowLayout ? true : undefined"
      :aria-label="filterLabel"
      tabindex="-1"
    >
      <header class="workspace-screen__panel-header" :class="{ 'has-reset-action': props.activeFilterCount > 0 }">
        <div class="workspace-screen__panel-title">
          <strong>{{ filterLabel }}</strong>
          <span
            v-if="props.activeFilterCount > 0"
            class="workspace-screen__panel-count display-number"
            :aria-label="`${filterLabel}: ${props.activeFilterCount}`"
          >
            {{ props.activeFilterCount }}
          </span>
        </div>
        <UiIconButton
          v-if="props.activeFilterCount > 0"
          :label="t('reset')"
          size="compact"
          touch-target
          @click="emit('resetFilters')"
        >
          <MaterialIcon name="filter_alt_off" :size="19" />
        </UiIconButton>
        <UiIconButton :label="t('close')" size="compact" touch-target @click="void closePanels(true)">
          <MaterialIcon name="close" :size="20" />
        </UiIconButton>
      </header>
      <div class="workspace-screen__panel-scroll workspace-screen__filter-scroll">
        <div class="workspace-screen__filter-content"><slot name="filters" /></div>
      </div>
    </aside>

    <button
      v-if="filtersOpen || detailOpen"
      class="workspace-screen__backdrop"
      :class="{ 'is-detail-only': detailOpen && !filtersOpen }"
      type="button"
      :aria-label="t('close')"
      @click="void closePanels(true)"
    />
  </section>
</template>

<style scoped>
.workspace-screen {
  --workspace-top-app-bar-offset: var(--md-comp-top-app-bar-safe-height);

  position: relative;
  display: grid;
  width: 100%;
  height: 100%;
  min-height: 0;
  grid-template-rows: var(--workspace-top-app-bar-offset) minmax(0, 1fr);
  overflow: hidden;
  isolation: isolate;
}

.workspace-screen__context {
  display: flex;
  min-width: 0;
  flex: 0 1 auto;
  align-items: center;
  gap: var(--md-sys-spacing-2);
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.workspace-screen__context::-webkit-scrollbar {
  display: none;
}

.workspace-screen__actions,
.workspace-screen__extra-actions {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--md-sys-spacing-2);
}

.workspace-screen__actions {
  flex: 0 1 auto;
  justify-content: flex-end;
  margin-left: auto;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.workspace-screen__actions::-webkit-scrollbar {
  display: none;
}

.workspace-screen__action {
  flex: 0 0 auto;
}

.workspace-screen__action-wrap {
  position: relative;
  display: inline-grid;
  width: var(--md-comp-control-height-touch);
  height: var(--md-comp-control-height-touch);
  flex: 0 0 var(--md-comp-control-height-touch);
  place-items: center;
}

.workspace-screen__override-mode {
  flex: 0 0 auto;
}

.workspace-screen__filter-count {
  position: absolute;
  z-index: 1;
  top: 1px;
  right: -2px;
  display: inline-grid;
  min-width: 18px;
  height: 18px;
  place-items: center;
  padding-inline: var(--md-sys-spacing-1);
  color: var(--md-sys-color-on-primary);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-primary);
  font-size: var(--md-sys-typescale-label-small-size);
  line-height: 1;
  pointer-events: none;
}

.workspace-screen__body {
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-columns: minmax(0, 1fr) minmax(300px, var(--workspace-detail-width));
  overflow: hidden;
}

.workspace-screen--no-detail .workspace-screen__body,
.workspace-screen--detail-collapsible:not(.is-detail-open) .workspace-screen__body {
  grid-template-columns: minmax(0, 1fr);
}

.workspace-screen--detail-collapsible:not(.is-detail-open) .workspace-screen__detail {
  display: none;
}

.workspace-screen__stage,
.workspace-screen__detail {
  min-width: 0;
  min-height: 0;
}

.workspace-screen__stage {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  overflow: hidden;
}

.workspace-screen__detail {
  overflow: hidden;
  border-left: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-low);
}

.workspace-screen--detail-collapsible .workspace-screen__detail {
  display: grid;
  grid-template-rows: 48px minmax(0, 1fr);
}

.workspace-screen__filters {
  position: absolute;
  z-index: var(--md-sys-z-index-local-popover);
  top: calc(var(--workspace-top-app-bar-offset) + var(--md-sys-spacing-2));
  right: var(--md-sys-spacing-3);
  display: grid;
  width: min(var(--md-comp-filter-panel-width), calc(100% - var(--md-sys-spacing-6)));
  max-height: calc(100% - var(--workspace-top-app-bar-offset) - var(--md-sys-spacing-5));
  grid-template-rows: 48px minmax(0, 1fr);
  overflow: hidden;
  overscroll-behavior: contain;
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-high);
  box-shadow: var(--md-sys-elevation-level3);
  opacity: 0;
  pointer-events: none;
  transform: translateY(calc(-1 * var(--md-sys-spacing-2)));
  transition:
    opacity var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard),
    transform var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-emphasized-decelerate);
  will-change: opacity, transform;
}

.workspace-screen__filters.is-open {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}

.workspace-screen__panel-header {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) var(--md-comp-control-height-touch);
  align-items: center;
  padding-left: var(--md-sys-spacing-4);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.workspace-screen__panel-header.has-reset-action {
  grid-template-columns: minmax(0, 1fr) repeat(2, var(--md-comp-control-height-touch));
}

.workspace-screen__detail .workspace-screen__panel-header {
  display: none;
  grid-template-columns: minmax(0, 1fr) var(--md-comp-control-height-touch);
}

.workspace-screen__panel-title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--md-sys-spacing-2);
}

.workspace-screen__panel-header strong {
  min-width: 0;
  overflow: hidden;
  font-family: var(--md-sys-typescale-title-small-font);
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: var(--md-sys-typescale-title-small-weight);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-screen__panel-count {
  display: inline-grid;
  min-width: 24px;
  height: 24px;
  flex: 0 0 auto;
  place-items: center;
  padding-inline: var(--md-sys-spacing-2);
  color: var(--md-sys-color-on-secondary-container);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-secondary-container);
  font-family: var(--md-sys-typescale-label-medium-font);
  font-size: var(--md-sys-typescale-label-medium-size);
  font-weight: var(--md-sys-typescale-label-medium-weight);
  line-height: var(--md-sys-typescale-label-medium-line-height);
}

.workspace-screen__panel-scroll {
  height: 100%;
  padding: var(--md-sys-spacing-3);
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.workspace-screen__filter-content {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--md-sys-spacing-2);
}

.workspace-screen__filter-content :deep(.search-field) {
  width: min(100%, var(--md-comp-search-field-max-width));
  margin-bottom: var(--md-sys-spacing-1);
}

.workspace-screen__filter-content :deep(.facet),
.workspace-screen__filter-content :deep(.catalog-sort),
.workspace-screen__filter-content :deep(fieldset) {
  padding-block: var(--md-sys-spacing-2);
  border-top: 1px solid var(--md-sys-color-outline-variant);
}

.workspace-screen__backdrop {
  position: absolute;
  z-index: var(--md-sys-z-index-local-backdrop);
  inset: var(--workspace-top-app-bar-offset) 0 0;
  padding: 0;
  background: color-mix(in srgb, var(--md-sys-color-scrim) 32%, transparent);
}

.workspace-screen__backdrop.is-detail-only {
  display: none;
}

@media (max-width: 839px), (max-width: 959px) and (max-height: 500px) {
  .workspace-screen__actions {
    gap: var(--md-sys-spacing-1);
  }

  .workspace-screen__body,
  .workspace-screen--no-detail .workspace-screen__body {
    grid-template-columns: minmax(0, 1fr);
    padding-inline: var(--md-sys-safe-area-inset-left) var(--md-sys-safe-area-inset-right);
  }

  .workspace-screen__detail,
  .workspace-screen__filters {
    position: absolute;
    z-index: var(--md-sys-z-index-overlay-sheet);
    top: var(--workspace-top-app-bar-offset);
    right: 0;
    bottom: 0;
    left: auto;
    display: grid;
    width: min(400px, 100%);
    max-height: none;
    grid-template-rows: 48px minmax(0, 1fr);
    border: 0;
    border-left: 1px solid var(--md-sys-color-outline-variant);
    border-radius: 0;
    background: var(--md-sys-color-surface-container-low);
    box-shadow: var(--md-sys-elevation-level3);
    opacity: 1;
    pointer-events: none;
    transform: translateX(100%);
    transition: transform var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-emphasized-decelerate);
    will-change: transform;
  }

  .workspace-screen__detail.is-open,
  .workspace-screen__filters.is-open {
    pointer-events: auto;
    transform: translateX(0);
  }

  .workspace-screen__detail .workspace-screen__panel-header {
    display: grid;
  }

  .workspace-screen__backdrop.is-detail-only {
    display: block;
  }
}

@media (max-width: 599px) {
  .workspace-screen__extra-actions {
    min-width: 0;
  }

  .workspace-screen__action {
    min-width: var(--md-comp-control-height-touch);
  }

  .workspace-screen__filter-count {
    position: absolute;
    top: 0;
    right: 0;
  }

  .workspace-screen__detail,
  .workspace-screen__filters {
    top: auto;
    right: 0;
    bottom: 0;
    left: 0;
    width: auto;
    max-height: min(80%, 640px);
    border-top: 1px solid var(--md-sys-color-outline-variant);
    border-left: 0;
    border-radius: var(--md-sys-shape-corner-extra-large) var(--md-sys-shape-corner-extra-large) 0 0;
    transform: translateY(100%);
  }

  .workspace-screen__detail.is-open,
  .workspace-screen__filters.is-open {
    transform: translateY(0);
  }

  .workspace-screen__panel-scroll {
    padding-bottom: var(--md-sys-spacing-4);
  }
}
</style>
