<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

import type { AnonTokyoEntity } from "~/types/anonTokyo";
import { anonTokyoEntities } from "~/types/anonTokyo";
import { anonTokyoRawLabel, parseAnonTokyoReward, useAnonTokyoCatalogData } from "~/composables/useAnonTokyoData";

const { t, messages } = useLocale();
const copy = messages("anonTokyoPage");
const { document, pending, error, refresh, text, section: recordsOf, currencyLabel } = useAnonTokyoCatalogData();

const taskTypes = computed(() => recordsOf(document.value?.tasks?.types));
const taskTabs = computed(() => recordsOf(document.value?.tasks?.tabs));

const typeName = (entry: AnonTokyoEntity): string => {
  const typeId = anonTokyoRawLabel(anonTokyoFieldOf(entry, "taskTypeId"));
  const type = taskTypes.value.find((candidate) => String(candidate.rawId) === typeId);
  const template = text(type?.description as never);
  if (!template) return "";
  const params = (entry.parameters as Array<string | number> | undefined) || [];
  return template.replace(/\{([12])\}/g, (_, index) => String(params[Number(index) - 1] ?? ""));
};
const tabName = (entry: AnonTokyoEntity): string => {
  const tabId = anonTokyoRawLabel(anonTokyoFieldOf(entry, "taskTabId"));
  const tab = taskTabs.value.find((candidate) => String(candidate.rawId) === tabId);
  return text(tab?.name as never) || "";
};
const rewardText = (raw: unknown): string => {
  const source = raw && typeof raw === "object" ? (raw as { raw?: unknown }).raw : raw;
  return parseAnonTokyoReward(source)
    .map((part) => (part.type === 1 ? `${currencyLabel(1)} ×${part.count ?? "?"}` : `#${part.id ?? "?"} ×${part.count ?? "?"}`))
    .join("、");
};
function anonTokyoFieldOf(entry: AnonTokyoEntity, key: string) {
  const value = entry[key];
  if (typeof value === "string" || typeof value === "number") return value;
  if (value && typeof value === "object" && "raw" in (value as Record<string, unknown>)) {
    return (value as { raw: unknown }).raw;
  }
  return undefined;
}

const mainTabs = computed(() => {
  const groups = new Map<string, { name: string; entries: AnonTokyoEntity[] }>();
  for (const entry of anonTokyoEntities(document.value?.tasks?.main)) {
    const key = anonTokyoRawLabel(anonTokyoFieldOf(entry, "taskTabId")) || "0";
    if (!groups.has(key)) groups.set(key, { name: tabName(entry) || `#${key}`, entries: [] });
    groups.get(key)!.entries.push(entry);
  }
  return [...groups.entries()].map(([key, group]) => ({ key, ...group }));
});

useSeoMeta({ title: () => `${copy.value.tasks} · ${t("anonTokyo")} · haneoka` });
</script>

<template>
  <WorkspaceScreen :title="copy.tasks" domain="catalog" :detail-available="false">
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" @retry="refresh()" />
    <EmptyState v-else-if="!document?.available" />
    <PageContentSurface v-else class="tasks-stack">
      <section
        v-for="tab in mainTabs"
        :key="tab.key"
        class="tasks-group"
        :aria-label="tab.name"
      >
        <header class="tasks-group__header">
          <MaterialIcon name="fact_check" :size="20" aria-hidden="true" />
          <h2>{{ tab.name }}</h2>
          <span class="tasks-group__count display-number">{{ tab.entries.length }}</span>
        </header>
        <div class="tasks-entries">
          <details v-for="entry in tab.entries" :key="entry.id" class="tasks-entry">
            <summary>
              <md-ripple />
              <span class="tasks-entry__title">
                {{ text(entry.title as never) || text(entry.description as never) || `#${entry.rawId}` }}
              </span>
              <span v-if="rewardText(anonTokyoFieldOf(entry, 'reward'))" class="tasks-entry__reward">
                {{ rewardText(anonTokyoFieldOf(entry, 'reward')) }}
              </span>
              <MaterialIcon class="tasks-entry__expand" name="expand_more" :size="20" aria-hidden="true" />
            </summary>
            <div class="tasks-entry__body">
              <p v-if="typeName(entry)">{{ copy.taskType }}: {{ typeName(entry) }}</p>
              <p v-if="text(entry.description as never)">
                {{ text(entry.description as never) }}
              </p>
            </div>
          </details>
        </div>
      </section>

      <section class="tasks-group" :aria-label="copy.dailyTasks">
        <header class="tasks-group__header">
          <MaterialIcon name="today" :size="20" aria-hidden="true" />
          <h2>{{ copy.dailyTasks }}</h2>
          <span class="tasks-group__count display-number">{{ recordsOf(document.tasks?.daily).length }}</span>
        </header>
        <div class="tasks-entries">
          <details v-for="entry in recordsOf(document.tasks?.daily)" :key="entry.id" class="tasks-entry">
            <summary>
              <md-ripple />
              <span class="tasks-entry__title">
                {{ text(entry.title as never) || text(entry.description as never) || `#${entry.rawId}` }}
              </span>
              <span v-if="rewardText(anonTokyoFieldOf(entry, 'reward'))" class="tasks-entry__reward">
                {{ rewardText(anonTokyoFieldOf(entry, 'reward')) }}
              </span>
              <MaterialIcon class="tasks-entry__expand" name="expand_more" :size="20" aria-hidden="true" />
            </summary>
            <div class="tasks-entry__body">
              <p v-if="anonTokyoRawLabel(entry.levelLimited)">{{ copy.levelLimit }}: {{ anonTokyoRawLabel(entry.levelLimited) }}</p>
              <p v-if="anonTokyoRawLabel(entry.weight)">{{ copy.weight }}: {{ anonTokyoRawLabel(entry.weight) }}</p>
            </div>
          </details>
        </div>
      </section>

      <section class="tasks-group" :aria-label="copy.achievements">
        <header class="tasks-group__header">
          <MaterialIcon name="emoji_events" :size="20" aria-hidden="true" />
          <h2>{{ copy.achievements }}</h2>
          <span class="tasks-group__count display-number">{{ recordsOf(document.tasks?.achievements).length }}</span>
        </header>
        <div class="tasks-entries">
          <details v-for="entry in recordsOf(document.tasks?.achievements)" :key="entry.id" class="tasks-entry">
            <summary>
              <md-ripple />
              <span class="tasks-entry__title">{{ text(entry.name as never) || `#${entry.rawId}` }}</span>
              <MaterialIcon class="tasks-entry__expand" name="expand_more" :size="20" aria-hidden="true" />
            </summary>
            <div class="tasks-entry__body">
              <p>{{ text(entry.description as never) }}</p>
              <p v-if="anonTokyoRawLabel(entry.rewardCount)">
                {{ copy.reward }}: {{ anonTokyoRawLabel(entry.rewardCount) }} {{ anonTokyoRawLabel(entry.rewardType) }}
              </p>
            </div>
          </details>
        </div>
      </section>

      <section class="tasks-group" :aria-label="copy.chapterTasks">
        <header class="tasks-group__header">
          <MaterialIcon name="checklist" :size="20" aria-hidden="true" />
          <h2>{{ copy.chapterTasks }}</h2>
          <span class="tasks-group__count display-number">{{ recordsOf(document.tasks?.chapter).length }}</span>
        </header>
        <div class="tasks-entries">
          <details v-for="entry in recordsOf(document.tasks?.chapter)" :key="entry.id" class="tasks-entry">
            <summary>
              <md-ripple />
              <span class="tasks-entry__title">{{ text(entry.chapterName as never) || `#${entry.rawId}` }}</span>
              <MaterialIcon class="tasks-entry__expand" name="expand_more" :size="20" aria-hidden="true" />
            </summary>
            <div class="tasks-entry__body">
              <p>{{ copy.taskTabs }}: {{ ((entry.taskIDList as number[] | undefined) || []).join("、") }}</p>
              <p v-if="rewardText(anonTokyoFieldOf(entry, 'reward'))">{{ copy.reward }}: {{ rewardText(anonTokyoFieldOf(entry, 'reward')) }}</p>
            </div>
          </details>
        </div>
      </section>
    </PageContentSurface>
  </WorkspaceScreen>
</template>

<style scoped>
.tasks-stack {
  display: grid;
  gap: var(--md-sys-spacing-5);
}

.tasks-group__header {
  display: flex;
  align-items: center;
  gap: var(--md-sys-spacing-2);
  margin-bottom: var(--md-sys-spacing-2);
  color: var(--md-sys-color-on-surface);
}

.tasks-group__header h2 {
  margin: 0;
  font: var(--md-sys-typescale-title-large-weight) var(--md-sys-typescale-title-large-size) /
    var(--md-sys-typescale-title-large-line-height) var(--md-sys-typescale-title-large-font);
}

.tasks-group__count {
  color: var(--md-sys-color-on-surface-variant);
}

.tasks-entries {
  overflow: hidden;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-lowest);
}

.tasks-entry {
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.tasks-entry:last-child {
  border-bottom: 0;
}

.tasks-entry summary {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-3) var(--md-sys-spacing-4);
  color: var(--md-sys-color-on-surface);
  list-style: none;
  cursor: pointer;
}

.tasks-entry summary::-webkit-details-marker {
  display: none;
}

.tasks-entry__title {
  position: relative;
  z-index: 1;
  flex: 1;
  min-width: 0;
  font: var(--md-sys-typescale-body-large-weight) var(--md-sys-typescale-body-large-size) /
    var(--md-sys-typescale-body-large-line-height) var(--md-sys-typescale-body-large-font);
}

.tasks-entry__reward {
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-label-medium-weight) var(--md-sys-typescale-label-medium-size) /
    var(--md-sys-typescale-label-medium-line-height) var(--md-sys-typescale-label-medium-font);
}

.tasks-entry__expand {
  color: var(--md-sys-color-on-surface-variant);
  transition: rotate var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
}

.tasks-entry[open] .tasks-entry__expand {
  rotate: 180deg;
}

.tasks-entry__body {
  padding: var(--md-sys-spacing-1) var(--md-sys-spacing-4) var(--md-sys-spacing-4);
  border-top: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-low);
}

.tasks-entry__body p {
  margin: 0;
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-medium-weight) var(--md-sys-typescale-body-medium-size) /
    var(--md-sys-typescale-body-medium-line-height) var(--md-sys-typescale-body-medium-font);
}
</style>
