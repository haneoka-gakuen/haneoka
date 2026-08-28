<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

import type { AnonTokyoEntity } from "~/types/anonTokyo";
import { anonTokyoEntities } from "~/types/anonTokyo";
import { useAnonTokyoCatalogData } from "~/composables/useAnonTokyoData";

const { t, messages } = useLocale();
const copy = messages("anonTokyoPage");
const { document, pending, error, refresh, text } = useAnonTokyoCatalogData();

interface GuideStep {
  entry: AnonTokyoEntity;
  title: string;
  detail: string;
  page: string;
}

const steps = computed<GuideStep[]>(() =>
  anonTokyoEntities(document.value?.guides?.steps)
    .filter((entry) => entry.isShow !== false)
    .map((entry) => {
      const title = text(entry.title as never) || text(entry.text as never) || `#${entry.rawId}`;
      const hint = text(entry.hint as never);
      return {
        entry,
        title,
        detail: hint,
        page: String(entry.page || ""),
      };
    }),
);

const groups = computed(() => {
  const byPage = new Map<string, GuideStep[]>();
  for (const step of steps.value) {
    const key = step.page || "—";
    byPage.set(key, [...(byPage.get(key) || []), step]);
  }
  return [...byPage.entries()].map(([page, entries]) => ({ page, entries }));
});

useSeoMeta({ title: () => `${copy.value.guide} · ${t("anonTokyo")} · haneoka` });
</script>

<template>
  <WorkspaceScreen :title="copy.guide" domain="catalog" :detail-available="false">
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" @retry="refresh()" />
    <EmptyState v-else-if="!steps.length" />
    <PageContentSurface v-else>
      <div class="guide-stack">
        <section
          v-for="group in groups"
          :key="group.page"
          class="guide-category"
          :aria-label="group.page"
        >
          <header class="guide-category__header">
            <MaterialIcon name="menu_book" :size="20" aria-hidden="true" />
            <h2>{{ group.page }}</h2>
            <span class="guide-category__count display-number">{{ group.entries.length }}</span>
          </header>
          <div class="guide-entries">
            <details v-for="{ entry, title, detail } in group.entries" :key="entry.id" class="guide-entry">
              <summary>
                <md-ripple />
                <span class="guide-entry__step display-number">#{{ entry.rawId }}</span>
                <span class="guide-entry__title">{{ title }}</span>
                <MaterialIcon class="guide-entry__expand" name="expand_more" :size="20" aria-hidden="true" />
              </summary>
              <div class="guide-entry__body">
                <p v-if="detail">{{ detail }}</p>
                <p class="guide-entry__meta">
                  <span>page: {{ entry.page }}</span>
                  <span v-if="entry.group !== undefined">group: {{ entry.group }}</span>
                </p>
              </div>
            </details>
          </div>
        </section>
      </div>
    </PageContentSurface>
  </WorkspaceScreen>
</template>

<style scoped>
.guide-stack {
  display: grid;
  gap: var(--md-sys-spacing-5);
}

.guide-category__header {
  display: flex;
  align-items: center;
  gap: var(--md-sys-spacing-2);
  margin-bottom: var(--md-sys-spacing-2);
  color: var(--md-sys-color-on-surface);
}

.guide-category__header h2 {
  margin: 0;
  font: var(--md-sys-typescale-title-large-weight) var(--md-sys-typescale-title-large-size) /
    var(--md-sys-typescale-title-large-line-height) var(--md-sys-typescale-title-large-font);
}

.guide-category__count {
  color: var(--md-sys-color-on-surface-variant);
}

.guide-entries {
  overflow: hidden;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-lowest);
}

.guide-entry {
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.guide-entry:last-child {
  border-bottom: 0;
}

.guide-entry summary {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-3) var(--md-sys-spacing-4);
  color: var(--md-sys-color-on-surface);
  list-style: none;
  cursor: pointer;
}

.guide-entry summary::-webkit-details-marker {
  display: none;
}

.guide-entry__step {
  color: var(--md-sys-color-on-surface-variant);
}

.guide-entry__title {
  position: relative;
  z-index: 1;
  flex: 1;
  font: var(--md-sys-typescale-body-large-weight) var(--md-sys-typescale-body-large-size) /
    var(--md-sys-typescale-body-large-line-height) var(--md-sys-typescale-body-large-font);
}

.guide-entry__expand {
  color: var(--md-sys-color-on-surface-variant);
  transition: rotate var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
}

.guide-entry[open] .guide-entry__expand {
  rotate: 180deg;
}

.guide-entry__body {
  padding: var(--md-sys-spacing-1) var(--md-sys-spacing-4) var(--md-sys-spacing-4);
  border-top: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-low);
}

.guide-entry__body p {
  margin: 0;
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-medium-weight) var(--md-sys-typescale-body-medium-size) /
    var(--md-sys-typescale-body-medium-line-height) var(--md-sys-typescale-body-medium-font);
  white-space: pre-line;
}

.guide-entry__meta {
  display: flex;
  gap: var(--md-sys-spacing-4);
}
</style>
