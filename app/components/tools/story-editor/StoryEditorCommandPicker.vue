<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.

  The command-card layout is adapted from OpenWebGAL/WebGAL_Terre's
  AddSentence component at commit 7b7a2159a5ccead80327437b7305b8fdb47a4e5f.
  See packages/story-editor/NOTICE.webgal.md for complete provenance.
-->
<script setup lang="ts">
import {
  MaterialIcon,
  UiDialog,
  UiIconButton,
  UiSelect,
  UiTextField,
  type UiFieldValue,
  type UiTextFieldHandle,
} from "@haneoka/ui";

import { COMMAND_DESCRIPTORS, type CommandCategory, type CommandDescriptor } from "@haneoka/story-editor";

const props = defineProps<{ modelValue: boolean }>();

const emit = defineEmits<{
  "update:modelValue": [open: boolean];
  pick: [code: number];
}>();

const { t, messages } = useLocale();
const copy = messages("storyEditorPage");
const closeLabel = computed(() => t("close"));
const { commandLabel, fieldLabel } = useStoryEditorLabels();
const query = ref("");
const category = ref<CommandCategory | "all">("all");
const searchInput = ref<UiTextFieldHandle>();
const commandGrid = ref<HTMLElement>();
const categories = computed(
  () => ["all", ...new Set(COMMAND_DESCRIPTORS.map((descriptor) => descriptor.category))] as const,
);
const categoryLabels = computed<Record<CommandCategory | "all", string>>(() => ({
  all: copy.value.allCommands,
  dialogue: copy.value.categoryDialogue,
  character: copy.value.categoryCharacter,
  stage: copy.value.categoryStage,
  camera: copy.value.categoryCamera,
  audio: copy.value.categoryAudio,
  transition: copy.value.categoryTransition,
  chat: copy.value.categoryChat,
  flow: copy.value.categoryFlow,
  timing: copy.value.categoryTiming,
  media: copy.value.categoryMedia,
  system: copy.value.categorySystem,
}));
const categoryIcons: Record<CommandCategory | "all", string> = {
  all: "apps",
  dialogue: "chat_bubble",
  character: "person",
  stage: "landscape",
  camera: "videocam",
  audio: "music_note",
  transition: "auto_awesome",
  chat: "forum",
  flow: "fork_right",
  timing: "schedule",
  media: "movie",
  system: "settings",
};
const categoryOptions = computed(() =>
  categories.value.map((item) => ({
    value: item,
    label: categoryLabels.value[item],
  })),
);
const setCategory = (value: UiFieldValue) => {
  const next = String(value) as CommandCategory | "all";
  if (categories.value.some((item) => item === next)) category.value = next;
};
const descriptionFor = (descriptor: CommandDescriptor) => {
  const fields = descriptor.fields.slice(0, 3).map(fieldLabel);
  return fields.length ? fields.join(" · ") : descriptor.type;
};
const items = computed(() => {
  const needle = query.value.normalize("NFKC").trim().toLocaleLowerCase();
  return COMMAND_DESCRIPTORS.filter((descriptor) => {
    if (category.value !== "all" && descriptor.category !== category.value) return false;
    const localized = commandLabel(descriptor.name, descriptor.label);
    const fields = descriptor.fields.map(fieldLabel).join(" ");
    return (
      !needle ||
      `${localized} ${descriptor.name} ${descriptor.label} ${descriptor.type} ${descriptor.code} ${fields}`
        .toLocaleLowerCase()
        .includes(needle)
    );
  });
});

const close = () => emit("update:modelValue", false);
const choose = (code: number) => {
  emit("pick", code);
  close();
};
const chooseFirst = () => {
  const first = items.value[0];
  if (first) choose(first.code);
};
const commandButtons = () =>
  Array.from(commandGrid.value?.querySelectorAll<HTMLButtonElement>(".story-command-card__action") ?? []);
const focusCommand = (index: number) => {
  const buttons = commandButtons();
  if (!buttons.length) return;
  buttons[Math.max(0, Math.min(index, buttons.length - 1))]?.focus();
};
const focusFirstCommand = () => focusCommand(0);
const resetCommandGridScroll = async () => {
  await nextTick();
  if (commandGrid.value) commandGrid.value.scrollTop = 0;
};
const columnCount = () => {
  if (!commandGrid.value || typeof window === "undefined") return 1;
  return Math.max(1, window.getComputedStyle(commandGrid.value).gridTemplateColumns.split(" ").length);
};
const navigateCommands = (event: KeyboardEvent) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".story-command-card__action");
  if (!button) return;
  const buttons = commandButtons();
  const current = buttons.indexOf(button);
  if (current < 0) return;

  let next = current;
  if (event.key === "ArrowLeft") next -= 1;
  else if (event.key === "ArrowRight") next += 1;
  else if (event.key === "ArrowUp") next -= columnCount();
  else if (event.key === "ArrowDown") next += columnCount();
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = buttons.length - 1;
  else return;

  event.preventDefault();
  focusCommand(next);
};

watch(
  () => props.modelValue,
  async (open) => {
    if (open) {
      query.value = "";
      category.value = "all";
      await nextTick();
      if (commandGrid.value) commandGrid.value.scrollTop = 0;
      searchInput.value?.focus();
    }
  },
);
watch([query, category], () => {
  if (props.modelValue) void resetCommandGridScroll();
});
</script>

<template>
  <UiDialog class="story-command-picker" :open="modelValue" @cancel="close">
    <template #headline>
      <header class="story-command-picker__headline">
        <MaterialIcon name="add_circle" :size="22" />
        <div>
          <strong>{{ copy.allCommands }}</strong>
        </div>
        <UiIconButton size="compact" :label="closeLabel" @click="close">
          <MaterialIcon name="close" :size="20" />
        </UiIconButton>
      </header>
    </template>

    <template #content>
      <div class="story-command-picker__content">
        <UiTextField
          ref="searchInput"
          v-model="query"
          class="story-command-picker__search"
          type="search"
          autofocus
          label=""
          :aria-label="copy.searchCommands"
          :placeholder="copy.searchCommands"
          @keydown.down.prevent="focusFirstCommand"
          @keydown.enter.prevent="chooseFirst"
        >
          <template #leading-icon><MaterialIcon name="search" :size="20" /></template>
        </UiTextField>

        <div class="story-command-picker__workspace">
          <nav class="story-command-picker__categories" :aria-label="copy.commands" aria-orientation="vertical">
            <button
              v-for="item in categories"
              :key="item"
              type="button"
              :class="{ 'is-selected': category === item }"
              :aria-pressed="category === item"
              @click="category = item"
            >
              <md-ripple />
              <MaterialIcon :name="categoryIcons[item]" :size="18" />
              <span>{{ categoryLabels[item] }}</span>
            </button>
          </nav>

          <UiSelect
            class="story-command-picker__category-select"
            :model-value="category"
            :options="categoryOptions"
            :label="copy.type"
            @update:model-value="setCategory"
          />

          <section class="story-command-picker__commands" :aria-label="copy.commands">
            <div v-if="items.length" ref="commandGrid" class="story-command-picker__grid" @keydown="navigateCommands">
              <md-filled-card v-for="item in items" :key="item.code" class="story-command-card">
                <button
                  class="story-command-card__action"
                  type="button"
                  :aria-label="`${commandLabel(item.name, item.label)}, ${descriptionFor(item)}, ${item.code}`"
                  @click="choose(item.code)"
                >
                  <md-ripple />
                  <span class="story-command-card__icon" aria-hidden="true">
                    <MaterialIcon :name="categoryIcons[item.category]" :size="20" />
                  </span>
                  <span class="story-command-card__copy">
                    <strong>{{ commandLabel(item.name, item.label) }}</strong>
                    <small>{{ descriptionFor(item) }}</small>
                    <span>{{ item.name }} · {{ categoryLabels[item.category] }}</span>
                  </span>
                  <span class="story-command-card__code display-number">{{ item.code }}</span>
                </button>
              </md-filled-card>
            </div>
            <div v-else class="story-command-picker__empty">
              <MaterialIcon name="search_off" :size="28" />
              <span>{{ copy.noCommand }}</span>
            </div>
          </section>
        </div>
      </div>
    </template>
  </UiDialog>
</template>

<style scoped>
.story-command-picker {
  width: min(960px, calc(100vw - 32px));
  max-width: min(960px, calc(100vw - 32px));
  max-height: min(720px, calc(100dvh - 32px));
  --md-dialog-container-color: var(--md-sys-color-surface-container-high);
}

.story-command-picker__headline {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: var(--md-sys-spacing-3);
}

.story-command-picker__headline > div {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: baseline;
  gap: var(--md-sys-spacing-2);
}

.story-command-picker__headline strong {
  overflow: hidden;
  color: var(--md-sys-color-on-surface);
  font: var(--md-sys-typescale-headline-small);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.story-command-picker__headline > .md3-material-icon {
  color: var(--md-sys-color-primary);
}

.story-command-picker__content {
  display: grid;
  width: min(912px, calc(100vw - 80px));
  height: min(560px, calc(100dvh - 180px));
  min-height: 320px;
  grid-template-rows: auto minmax(0, 1fr);
  gap: var(--md-sys-spacing-3);
  overflow: hidden;
}

.story-command-picker__search {
  width: 100%;
  min-width: 0;
  align-self: start;
  --md-outlined-text-field-container-shape: var(--md-comp-search-field-shape);
  --md-outlined-text-field-focus-outline-width: 2px;
  --md-outlined-text-field-leading-icon-color: var(--md-sys-color-on-surface-variant);
  --md-outlined-text-field-top-space: var(--md-sys-spacing-3);
  --md-outlined-text-field-bottom-space: var(--md-sys-spacing-3);
}

.story-command-picker__workspace {
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-columns: 156px minmax(0, 1fr);
  align-items: stretch;
  gap: var(--md-sys-spacing-3);
  overflow: hidden;
}

.story-command-picker__categories {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  gap: 2px;
  padding: var(--md-sys-spacing-1) var(--md-sys-spacing-3) var(--md-sys-spacing-1) var(--md-sys-spacing-1);
  overflow-x: hidden;
  overflow-y: auto;
  border-right: 1px solid var(--md-sys-color-outline-variant);
  background: transparent;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  touch-action: pan-y;
}

.story-command-picker__categories button {
  position: relative;
  display: grid;
  width: 100%;
  min-width: 0;
  min-height: 38px;
  grid-template-columns: 20px minmax(0, 1fr);
  align-items: center;
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-1) var(--md-sys-spacing-2);
  color: var(--md-sys-color-on-surface-variant);
  border: 0;
  border-radius: var(--md-sys-shape-corner-full);
  background: transparent;
  font: var(--md-sys-typescale-label-medium);
  text-align: left;
  cursor: pointer;
}

.story-command-picker__categories button:focus-visible,
.story-command-card__action:focus-visible {
  outline: 3px solid var(--md-sys-color-primary);
  outline-offset: 2px;
}

.story-command-picker__categories button.is-selected {
  color: var(--md-sys-color-on-secondary-container);
  background: var(--md-sys-color-secondary-container);
}

.story-command-picker__categories button > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.story-command-picker__category-select {
  display: none;
}

.story-command-picker__commands {
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-rows: minmax(0, 1fr);
  overflow: hidden;
  background: transparent;
}

.story-command-picker__grid {
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-content: start;
  gap: var(--md-sys-spacing-2);
  padding: 0 var(--md-sys-spacing-1) var(--md-sys-spacing-1) 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  touch-action: pan-y;
}

.story-command-card {
  width: 100%;
  min-width: 0;
  --md-filled-card-container-color: var(--md-sys-color-surface-container-high);
  --md-filled-card-container-elevation: 0;
  --md-filled-card-container-shape: var(--md-sys-shape-corner-medium);
}

.story-command-card:hover {
  --md-filled-card-container-elevation: 1;
}

.story-command-card__action {
  position: relative;
  display: grid;
  width: 100%;
  min-width: 0;
  min-height: 92px;
  grid-template-columns: 32px minmax(0, 1fr);
  align-items: start;
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-3);
  color: var(--md-sys-color-on-surface);
  border: 0;
  border-radius: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.story-command-card__icon {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  color: var(--md-sys-color-on-secondary-container);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-secondary-container);
}

.story-command-card__copy {
  display: grid;
  min-width: 0;
  gap: 2px;
  padding-right: 28px;
}

.story-command-card__copy strong,
.story-command-card__copy small,
.story-command-card__copy > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.story-command-card__copy strong {
  color: var(--md-sys-color-on-surface);
  font: var(--md-sys-typescale-title-small);
}

.story-command-card__copy small {
  color: var(--md-sys-color-on-surface);
  font: var(--md-sys-typescale-body-small);
}

.story-command-card__copy > span {
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-label-small);
}

.story-command-card__code {
  position: absolute;
  top: var(--md-sys-spacing-2);
  right: var(--md-sys-spacing-2);
  display: grid;
  min-width: 24px;
  height: 24px;
  place-items: center;
  padding-inline: 4px;
  color: var(--md-sys-color-on-secondary-container);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-secondary-container);
  font: var(--md-sys-typescale-label-small);
}

.story-command-picker__empty {
  display: grid;
  min-height: 180px;
  place-items: center;
  align-content: center;
  gap: var(--md-sys-spacing-2);
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-medium);
}
</style>
