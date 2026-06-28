<script setup lang="ts">
import { MaterialIcon, UiIconButton } from "@haneoka/ui";

import { textOf, type DisplayText } from "~/types/displayText";

const props = withDefaults(
  defineProps<{
    title: DisplayText;
    subtitle?: DisplayText;
    count?: number | string;
    navigation?: "back" | "close" | "none";
    navigationLabel?: string;
    headingLevel?: 1 | 2;
    headingId?: string;
    accent?: string;
    variant?: "page" | "detail";
  }>(),
  {
    subtitle: "",
    count: undefined,
    navigation: "none",
    navigationLabel: "",
    headingLevel: 1,
    headingId: undefined,
    accent: "var(--md-sys-color-primary)",
    variant: "page",
  },
);

const emit = defineEmits<{ navigate: [] }>();
const { t } = useLocale();
const shellNavigation = useShellNavigation();
const headingTag = computed<"h1" | "h2">(() => (props.headingLevel === 1 ? "h1" : "h2"));
const shellNavigationOpen = computed(() => shellNavigation?.opened.value ?? false);
const resolvedNavigationLabel = computed(
  () => props.navigationLabel || (props.navigation === "close" ? t("close") : t("previous")),
);
</script>

<template>
  <header
    class="page-top-app-bar"
    :class="[`has-${navigation}-navigation`, `is-${variant}`, { 'has-subtitle': textOf(subtitle) }]"
    :style="{ '--md-comp-top-app-bar-accent': accent }"
  >
    <UiIconButton
      v-if="navigation === 'none' && shellNavigation"
      class="page-top-app-bar__menu"
      size="touch"
      :label="t('menu')"
      aria-controls="global-navigation-panel"
      :aria-expanded="shellNavigationOpen"
      @click="shellNavigation.open($event)"
    >
      <MaterialIcon name="menu" :size="24" />
    </UiIconButton>

    <UiIconButton
      v-if="navigation !== 'none'"
      class="page-top-app-bar__navigation"
      size="touch"
      :label="resolvedNavigationLabel"
      @click="emit('navigate')"
    >
      <MaterialIcon :name="navigation === 'close' ? 'close' : 'arrow_back'" :size="24" />
    </UiIconButton>

    <div v-if="$slots.leading" class="page-top-app-bar__leading">
      <slot name="leading" />
    </div>

    <div class="page-top-app-bar__copy">
      <component :is="headingTag" :id="headingId" class="page-top-app-bar__title">
        <DisplayText :value="title" />
      </component>
      <small v-if="textOf(subtitle)" class="page-top-app-bar__subtitle">
        <DisplayText :value="subtitle" />
      </small>
    </div>

    <span v-if="count !== undefined" class="page-top-app-bar__count display-number">{{ count }}</span>

    <div v-if="$slots.context" class="page-top-app-bar__context">
      <slot name="context" />
    </div>

    <div v-if="$slots.actions" class="page-top-app-bar__actions" role="toolbar" :aria-label="textOf(title)">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.page-top-app-bar {
  position: relative;
  z-index: var(--md-sys-z-index-local-sticky);
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: var(--md-comp-top-app-bar-safe-height);
  align-items: center;
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-safe-area-inset-top) max(var(--md-comp-page-inline-space), var(--md-sys-safe-area-inset-right))
    0 max(var(--md-comp-page-inline-space), var(--md-sys-safe-area-inset-left));
  color: var(--md-sys-color-on-surface);
  background: var(--md-sys-color-surface-container-low);
  box-shadow: var(--md-sys-elevation-level0);
}

.page-top-app-bar.has-back-navigation,
.page-top-app-bar.has-close-navigation {
  padding-left: max(var(--md-sys-spacing-2), var(--md-sys-safe-area-inset-left));
}

.page-top-app-bar__navigation {
  flex: 0 0 auto;
  --md-icon-button-icon-color: var(--md-comp-top-app-bar-accent);
  --md-icon-button-hover-icon-color: var(--md-comp-top-app-bar-accent);
  --md-icon-button-focus-icon-color: var(--md-comp-top-app-bar-accent);
  --md-icon-button-pressed-icon-color: var(--md-comp-top-app-bar-accent);
}

.page-top-app-bar__menu {
  display: none;
  flex: 0 0 auto;
  --md-icon-button-icon-color: var(--md-comp-top-app-bar-accent);
  --md-icon-button-hover-icon-color: var(--md-comp-top-app-bar-accent);
  --md-icon-button-focus-icon-color: var(--md-comp-top-app-bar-accent);
  --md-icon-button-pressed-icon-color: var(--md-comp-top-app-bar-accent);
}

.page-top-app-bar__leading,
.page-top-app-bar__context,
.page-top-app-bar__actions {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--md-sys-spacing-2);
}

.page-top-app-bar__leading {
  width: fit-content;
  max-width: min(30vw, 320px);
  flex: 0 1 auto;
  overflow: hidden;
}

.page-top-app-bar__leading > :deep(*) {
  min-width: 0;
  max-width: 100%;
}

.page-top-app-bar__copy {
  display: grid;
  min-width: 0;
  flex: 1 1 0;
  overflow: hidden;
}

.page-top-app-bar__title,
.page-top-app-bar__subtitle {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.page-top-app-bar__title {
  font-family: var(--md-sys-typescale-title-large-font);
  font-size: var(--md-sys-typescale-title-large-size);
  font-weight: var(--md-sys-typescale-title-large-weight);
  line-height: var(--md-sys-typescale-title-large-line-height);
}

.page-top-app-bar.has-subtitle .page-top-app-bar__title,
.page-top-app-bar.is-detail .page-top-app-bar__title {
  font-family: var(--md-sys-typescale-title-medium-font);
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: var(--md-sys-typescale-title-medium-weight);
  line-height: var(--md-sys-typescale-title-medium-line-height);
}

.page-top-app-bar__subtitle {
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-body-small-font);
  font-size: var(--md-sys-typescale-body-small-size);
  font-weight: var(--md-sys-typescale-body-small-weight);
  line-height: var(--md-sys-typescale-body-small-line-height);
}

.page-top-app-bar__count {
  display: inline-grid;
  min-width: 24px;
  min-height: 24px;
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

.page-top-app-bar__context {
  flex: 0 1 auto;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.page-top-app-bar__context::-webkit-scrollbar,
.page-top-app-bar__actions::-webkit-scrollbar {
  display: none;
}

.page-top-app-bar__actions {
  max-width: 60%;
  flex: 0 1 auto;
  margin-left: auto;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

@media (max-width: 839px), (max-width: 959px) and (max-height: 500px) {
  .page-top-app-bar__menu {
    display: inline-flex;
  }
}

@media (max-width: 599px) {
  .page-top-app-bar {
    gap: var(--md-sys-spacing-1);
    padding-right: max(var(--md-sys-spacing-2), var(--md-sys-safe-area-inset-right));
    padding-left: max(var(--md-sys-spacing-2), var(--md-sys-safe-area-inset-left));
  }

  .page-top-app-bar__title {
    font-family: var(--md-sys-typescale-title-medium-font);
    font-size: var(--md-sys-typescale-title-medium-size);
    font-weight: var(--md-sys-typescale-title-medium-weight);
    line-height: var(--md-sys-typescale-title-medium-line-height);
  }

  /* Detail identity marks and controls outrank copy on narrow screens. The
   * title owns only the remaining middle space and may collapse completely. */
  .page-top-app-bar.is-detail .page-top-app-bar__leading {
    max-width: none;
    flex: 0 0 auto;
    overflow: visible;
  }

  .page-top-app-bar.is-detail .page-top-app-bar__copy {
    min-width: 0;
    flex: 1 1 0;
  }

  .page-top-app-bar__context {
    display: none;
  }

  .page-top-app-bar__actions {
    max-width: 70%;
    flex: 0 1 auto;
  }

  .page-top-app-bar.is-detail .page-top-app-bar__actions {
    max-width: none;
    flex: 0 0 auto;
    overflow: visible;
  }
}
</style>
