<script setup lang="ts">
import { MaterialIcon, UiList, UiListItem } from "@haneoka/ui";

import { stripUnityMarkup } from "~/composables/useArchiveText";
import {
  isToolRecord,
  toolArray,
  toolField,
  toolId,
  toolLocaleDisplayText,
  toolNumber,
  toolRecordValues,
  toolSearchText,
  type ToolRecord,
} from "~/components/catalog/ToolCatalogData";
import { replaceDisplayText, textOf, type DisplayText } from "~/types/displayText";

interface HelpDocument {
  categories?: Record<string, ToolRecord>;
  loadingTips?: Record<string, ToolRecord>;
}

interface HelpEntry {
  category: ToolRecord;
  entry: ToolRecord;
}

const { resolveLocalized, t, messages } = useLocale();
const mode = useRouteQueryEnum("mode", ["manual", "tips"] as const, "manual");
const query = useRouteQueryText("q");
const selectedCategories = useRouteQueryList("category", true);
const helpFilterFacets = computed(() => (mode.value === "manual" ? [selectedCategories] : []));
const { activeFilterCount, resetFilters } = useCatalogFilterState({ texts: [query], facets: helpFilterFacets });
const { data, pending, error, refresh } = useCatalogDocument<HelpDocument>("help");
const copy = messages("helpPage");

const categories = computed(() =>
  toolRecordValues(data.value?.categories).sort(
    (left, right) => toolNumber(toolField(left, "order", "_order")) - toolNumber(toolField(right, "order", "_order")),
  ),
);
const categoryId = (category: ToolRecord) => toolNumber(toolField(category, "categoryId", "id", "_id"));
const localizedToolText = (value: unknown, fallback = ""): DisplayText => {
  const resolved = toolLocaleDisplayText(value, resolveLocalized, { sourceHint: "ja", fallback });
  const text = stripUnityMarkup(textOf(resolved));
  return text ? replaceDisplayText(resolved, text) : "";
};
const displayTitleOf = (value: ToolRecord) => localizedToolText(toolField(value, "title"), `#${toolId(value)}`);
const titleOf = (value: ToolRecord) => textOf(displayTitleOf(value));
const displayDescriptionOf = (value: ToolRecord) => localizedToolText(toolField(value, "description"));
const descriptionOf = (value: ToolRecord) => textOf(displayDescriptionOf(value));
const categoryOptions = computed(() =>
  categories.value.map((category) => ({
    value: categoryId(category),
    label: displayTitleOf(category),
    count: toolArray(category, "subcategories").length,
  })),
);
const manualEntries = computed<HelpEntry[]>(() =>
  categories.value.flatMap((category) =>
    toolArray(category, "subcategories")
      .filter(isToolRecord)
      .map((entry) => ({ category, entry })),
  ),
);
const visibleManual = computed(() => {
  const needle = toolSearchText(query.value);
  return manualEntries.value.filter(
    ({ category, entry }) =>
      (!selectedCategories.value.length || selectedCategories.value.includes(categoryId(category))) &&
      (!needle ||
        toolSearchText(titleOf(category), titleOf(entry), descriptionOf(entry), toolId(entry)).includes(needle)),
  );
});
const tips = computed(() => {
  const needle = toolSearchText(query.value);
  return toolRecordValues(data.value?.loadingTips)
    .filter((tip) => !needle || toolSearchText(titleOf(tip), descriptionOf(tip), toolId(tip)).includes(needle))
    .sort((left, right) => toolNumber(toolId(left)) - toolNumber(toolId(right)));
});
const groupedManual = computed(() =>
  categories.value.flatMap((category) => {
    const entries = visibleManual.value.filter((item) => categoryId(item.category) === categoryId(category));
    return entries.length ? [{ category, entries }] : [];
  }),
);

useSeoMeta({ title: () => `${copy.value.title} · haneoka` });
</script>

<template>
  <WorkspaceScreen
    domain="catalog"
    :title="copy.title"
    :count="mode === 'manual' ? visibleManual.length : tips.length"
    :active-filter-count="activeFilterCount"
    @reset-filters="resetFilters"
  >
    <template #actions>
      <SegmentedControl
        v-model="mode"
        :options="[
          { value: 'manual', label: copy.manual, icon: 'menu_book' },
          { value: 'tips', label: copy.tips, icon: 'lightbulb' },
        ]"
        :label="t('view')"
      />
    </template>
    <template #filters>
      <SearchField v-model="query" :label="t('search')" />
      <FacetGroup
        v-if="mode === 'manual'"
        v-model="selectedCategories"
        :title="copy.category"
        :options="categoryOptions"
      />
    </template>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" @retry="refresh()" />
    <EmptyState v-else-if="!manualEntries.length && !tips.length" />
    <PageContentSurface v-else>
      <div class="help-stack">
        <template v-if="mode === 'manual'">
          <section
            v-for="group in groupedManual"
            :key="categoryId(group.category)"
            class="help-category"
            :aria-labelledby="`help-category-${categoryId(group.category)}`"
          >
            <header class="help-category__header">
              <MaterialIcon name="menu_book" :size="20" aria-hidden="true" />
              <h2 :id="`help-category-${categoryId(group.category)}`">
                <DisplayText :value="displayTitleOf(group.category)" />
              </h2>
              <span class="help-category__count display-number">{{ group.entries.length }}</span>
            </header>
            <div class="help-entries">
              <details
                v-for="{ entry } in group.entries"
                :key="toolId(entry)"
                class="help-entry"
                :open="Boolean(query)"
              >
                <summary>
                  <md-ripple />
                  <span class="help-entry__title"><DisplayText :value="displayTitleOf(entry)" /></span>
                  <MaterialIcon class="help-entry__expand" name="expand_more" :size="20" aria-hidden="true" />
                </summary>
                <div class="help-entry__body">
                  <p><DisplayText :value="displayDescriptionOf(entry)" /></p>
                </div>
              </details>
            </div>
          </section>
        </template>

        <section v-else class="tips-surface" :aria-label="copy.tips">
          <UiList class="tips-list">
            <UiListItem v-for="tip in tips" :key="toolId(tip)" type="text" class="tip-row">
              <template #start><MaterialIcon name="lightbulb" :size="20" aria-hidden="true" /></template>
              <template #headline><DisplayText :value="displayTitleOf(tip)" /></template>
              <template #supporting><DisplayText :value="displayDescriptionOf(tip)" /></template>
            </UiListItem>
          </UiList>
        </section>
      </div>
    </PageContentSurface>
  </WorkspaceScreen>
</template>

<style scoped>
.help-stack {
  display: grid;
  align-content: start;
  gap: var(--md-sys-spacing-4);
}

.help-entries {
  display: grid;
  overflow: hidden;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-lowest);
}

.help-category {
  display: grid;
  gap: var(--md-sys-spacing-2);
}

.help-category__header {
  display: grid;
  min-height: var(--md-comp-control-height-touch);
  grid-template-columns: 24px minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--md-sys-spacing-2);
  padding-inline: var(--md-sys-spacing-2);
  color: var(--md-sys-color-on-surface);
}

.help-category__header > .md3-material-icon {
  color: var(--md-sys-color-primary);
}

.help-category__header h2 {
  margin: 0;
  font: var(--md-sys-typescale-title-medium-weight) var(--md-sys-typescale-title-medium-size) /
    var(--md-sys-typescale-title-medium-line-height) var(--md-sys-typescale-title-medium-font);
  letter-spacing: 0;
}

.help-category__count {
  display: inline-grid;
  min-width: 28px;
  height: 24px;
  place-items: center;
  padding-inline: var(--md-sys-spacing-2);
  color: var(--md-sys-color-on-secondary-container);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-secondary-container);
  font-size: var(--md-sys-typescale-label-small-size);
  line-height: var(--md-sys-typescale-label-small-line-height);
}

.help-entry {
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.help-entry:last-child {
  border-bottom: 0;
}

.help-entry summary {
  position: relative;
  display: grid;
  min-height: 48px;
  grid-template-columns: minmax(0, 1fr) 40px;
  align-items: center;
  gap: var(--md-sys-spacing-2);
  padding-left: var(--md-sys-spacing-4);
  color: var(--md-sys-color-on-surface);
  list-style: none;
  cursor: pointer;
}

.help-entry summary::-webkit-details-marker {
  display: none;
}

.help-entry summary md-ripple {
  --md-ripple-hover-color: var(--md-sys-color-on-surface);
  --md-ripple-pressed-color: var(--md-sys-color-primary);
}

.help-entry__title {
  position: relative;
  z-index: 1;
  font: var(--md-sys-typescale-body-large-weight) var(--md-sys-typescale-body-large-size) /
    var(--md-sys-typescale-body-large-line-height) var(--md-sys-typescale-body-large-font);
  letter-spacing: 0;
}

.help-entry__expand {
  position: relative;
  z-index: 1;
  color: var(--md-sys-color-on-surface-variant);
  transition: rotate var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
}

.help-entry[open] .help-entry__expand {
  rotate: 180deg;
}

.help-entry__body {
  padding: var(--md-sys-spacing-1) var(--md-sys-spacing-4) var(--md-sys-spacing-4);
  border-top: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-low);
}

.help-entry__body p {
  margin: 0;
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-medium-weight) var(--md-sys-typescale-body-medium-size) /
    var(--md-sys-typescale-body-medium-line-height) var(--md-sys-typescale-body-medium-font);
  letter-spacing: 0;
  white-space: pre-line;
}

.tips-surface {
  overflow: hidden;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-lowest);
}

.tips-list {
  padding: var(--md-sys-spacing-1);
}

.tip-row {
  --md-list-item-supporting-text-line-height: var(--md-sys-typescale-body-small-line-height);
}

.tip-row + .tip-row {
  border-top: 1px solid var(--md-sys-color-outline-variant);
}

.tip-row > :deep([slot="supporting-text"]) {
  white-space: pre-line;
}

@media (prefers-reduced-motion: reduce) {
  .help-entry__expand {
    transition: none;
  }
}
</style>
