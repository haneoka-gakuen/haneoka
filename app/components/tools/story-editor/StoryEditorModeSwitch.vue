<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.

  Portions are adapted from OpenWebGAL/WebGAL_Terre's EditorToolbar
  component at commit 7b7a2159a5ccead80327437b7305b8fdb47a4e5f.
  See packages/story-editor/NOTICE.webgal.md for complete provenance.
-->
<script setup lang="ts">
import { MaterialIcon, UiButton, UiList, UiListItem, type UiButtonHandle } from "@haneoka/ui";
import type { ComponentPublicInstance } from "vue";

export type StoryEditorMode = "visual" | "graph" | "webgal" | "project";

const props = defineProps<{ modelValue: StoryEditorMode }>();

const emit = defineEmits<{
  "update:modelValue": [mode: StoryEditorMode];
}>();

const { messages } = useLocale();
const copy = messages("storyEditorPage");
const root = ref<HTMLElement>();
const menuTrigger = ref<UiButtonHandle>();
const menu = ref<HTMLElement>();
const menuOpen = ref(false);
const modeButtons = new Map<StoryEditorMode, HTMLButtonElement>();
const options = computed(() => [
  { value: "visual" as const, label: copy.value.visual, icon: "playlist_add" },
  { value: "graph" as const, label: copy.value.graph, icon: "account_tree" },
  { value: "webgal" as const, label: copy.value.webgalCode, icon: "data_object" },
  { value: "project" as const, label: copy.value.projectCode, icon: "code_blocks" },
]);
const currentOption = computed(
  () => options.value.find((option) => option.value === props.modelValue) ?? options.value[0]!,
);

const setModeButton = (mode: StoryEditorMode, element: Element | ComponentPublicInstance | null) => {
  if (element instanceof HTMLButtonElement) modeButtons.set(mode, element);
  else modeButtons.delete(mode);
};

const updateMode = (mode: StoryEditorMode) => {
  emit("update:modelValue", mode);
  menuOpen.value = false;
};

const moveFocus = (from: StoryEditorMode, delta: number) => {
  const index = options.value.findIndex((option) => option.value === from);
  const next = options.value[(index + delta + options.value.length) % options.value.length];
  if (!next) return;
  updateMode(next.value);
  void nextTick(() => modeButtons.get(next.value)?.focus());
};

const onModeKeydown = (event: KeyboardEvent, mode: StoryEditorMode) => {
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    event.preventDefault();
    moveFocus(mode, -1);
  } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    event.preventDefault();
    moveFocus(mode, 1);
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    const next = event.key === "Home" ? options.value[0] : options.value.at(-1);
    if (!next) return;
    updateMode(next.value);
    void nextTick(() => modeButtons.get(next.value)?.focus());
  }
};

const focusFirstMenuItem = async () => {
  await nextTick();
  menu.value?.querySelector<HTMLElement>("[role='menuitemradio']")?.focus();
};

const toggleMenu = () => {
  menuOpen.value = !menuOpen.value;
  if (menuOpen.value) void focusFirstMenuItem();
};

const openMenu = () => {
  menuOpen.value = true;
  void focusFirstMenuItem();
};

const closeMenu = (restoreFocus = false) => {
  if (!menuOpen.value) return;
  menuOpen.value = false;
  if (restoreFocus) void nextTick(() => menuTrigger.value?.focus());
};

const onDocumentPointerdown = (event: PointerEvent) => {
  const target = event.target as Node | null;
  if (target && !root.value?.contains(target)) closeMenu();
};

const onDocumentKeydown = (event: KeyboardEvent) => {
  if (event.key !== "Escape" || !menuOpen.value) return;
  event.preventDefault();
  closeMenu(true);
};

const menuItems = () => [...(menu.value?.querySelectorAll<HTMLElement>("[role='menuitemradio']") ?? [])];

const onMenuKeydown = (event: KeyboardEvent) => {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = menuItems();
  if (!items.length) return;
  event.preventDefault();
  const currentIndex = items.findIndex((item) => item === document.activeElement);
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (currentIndex + 1 + items.length) % items.length
          : (currentIndex - 1 + items.length) % items.length;
  items[nextIndex]?.focus();
};

const onFocusout = (event: FocusEvent) => {
  const nextTarget = event.relatedTarget as Node | null;
  if (nextTarget && root.value?.contains(nextTarget)) return;
  closeMenu();
};

onMounted(() => {
  document.addEventListener("pointerdown", onDocumentPointerdown);
  document.addEventListener("keydown", onDocumentKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocumentPointerdown);
  document.removeEventListener("keydown", onDocumentKeydown);
});
</script>

<template>
  <div ref="root" class="story-editor-mode-switch" @focusout="onFocusout">
    <div class="story-editor-mode-switch__group" role="radiogroup" :aria-label="copy.type">
      <button
        v-for="option in options"
        :key="option.value"
        :ref="(element) => setModeButton(option.value, element)"
        type="button"
        class="story-editor-mode-switch__mode"
        :class="{ 'is-selected': modelValue === option.value }"
        role="radio"
        :aria-checked="modelValue === option.value"
        :tabindex="modelValue === option.value ? 0 : -1"
        @click="updateMode(option.value)"
        @keydown="onModeKeydown($event, option.value)"
      >
        <MaterialIcon :name="option.icon" :size="17" />
        <span>{{ option.label }}</span>
        <MaterialIcon
          class="story-editor-mode-switch__check"
          :class="{ 'is-visible': modelValue === option.value }"
          name="check"
          :size="14"
        />
      </button>
    </div>

    <UiButton
      ref="menuTrigger"
      class="story-editor-mode-switch__trigger"
      tone="text"
      aria-haspopup="menu"
      :aria-expanded="menuOpen"
      :title="copy.type"
      @click="toggleMenu"
      @keydown.down.prevent="openMenu"
    >
      <template #icon><MaterialIcon :name="currentOption.icon" :size="18" /></template>
      <span>{{ currentOption.label }}</span>
      <MaterialIcon name="arrow_drop_up" :size="18" />
    </UiButton>

    <div
      v-if="menuOpen"
      ref="menu"
      class="story-editor-mode-switch__menu"
      role="menu"
      :aria-label="copy.type"
      @keydown="onMenuKeydown"
    >
      <UiList>
        <UiListItem
          v-for="option in options"
          :key="option.value"
          type="button"
          role="menuitemradio"
          :aria-checked="modelValue === option.value"
          @click="updateMode(option.value)"
        >
          <template #start><MaterialIcon :name="option.icon" :size="19" /></template>
          <template #headline>{{ option.label }}</template>
          <template v-if="modelValue === option.value" #end><MaterialIcon name="check" :size="18" /></template>
        </UiListItem>
      </UiList>
    </div>
  </div>
</template>

<style scoped>
.story-editor-mode-switch {
  position: relative;
  display: flex;
  min-width: 0;
  height: 28px;
  flex: 0 0 auto;
  align-items: stretch;
  color: var(--md-sys-color-on-surface-variant);
}

.story-editor-mode-switch__group {
  display: flex;
  min-width: 0;
  align-items: stretch;
  gap: var(--md-sys-spacing-2);
}

.story-editor-mode-switch__mode {
  position: relative;
  display: inline-flex;
  min-width: 0;
  height: 28px;
  align-items: center;
  gap: 5px;
  padding: 0 6px;
  color: var(--md-sys-color-on-surface-variant);
  border: 0;
  border-radius: var(--md-sys-shape-corner-extra-small);
  outline: 0;
  background: transparent;
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
  white-space: nowrap;
  cursor: pointer;
}

.story-editor-mode-switch__mode:hover,
.story-editor-mode-switch__mode:focus-visible {
  background: var(--md-sys-color-surface-container-highest);
}

.story-editor-mode-switch__mode.is-selected {
  color: var(--md-sys-color-primary);
  background: var(--md-sys-color-secondary-container);
  font-weight: var(--md-sys-typescale-label-small-weight);
}

.story-editor-mode-switch__mode > :deep(.md3-material-icon:first-child) {
  color: currentcolor;
}

.story-editor-mode-switch__check {
  color: currentcolor;
  opacity: 0;
}

.story-editor-mode-switch__check.is-visible {
  opacity: 1;
}

.story-editor-mode-switch__trigger {
  display: none;
  min-height: 28px;
  --md-comp-control-height: 28px;
  --md-text-button-container-height: 28px;
  --md-text-button-container-shape: var(--md-sys-shape-corner-extra-small);
  --md-text-button-label-text-size: var(--md-sys-typescale-label-small-size);
  --md-text-button-label-text-color: var(--md-sys-color-primary);
}

.story-editor-mode-switch__menu {
  position: absolute;
  z-index: var(--md-sys-z-index-overlay-popover);
  right: 0;
  bottom: calc(100% + 4px);
  width: max-content;
  min-width: 196px;
  padding-block: var(--md-sys-spacing-1);
  overflow: hidden;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-small);
  box-shadow: var(--md-sys-elevation-level2);
  --md-list-container-color: var(--md-sys-color-surface-container);
}

.story-editor-mode-switch__menu :deep(.md3-list-item) {
  --md-list-item-one-line-container-height: 42px;
  --md-list-item-label-text-size: var(--md-sys-typescale-label-medium-size);
}
</style>
