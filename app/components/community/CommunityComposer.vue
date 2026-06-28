<script setup lang="ts">
import { MaterialIcon, UiIconButton, UiTextField, type UiTextFieldHandle } from "@haneoka/ui";

import type { CommunityAttachment, CommunityAttachmentQueueState } from "~/types/uploads";

interface FormatCommand {
  key: string;
  icon: string;
  labelKey:
    | "communityPage.bold"
    | "communityPage.italic"
    | "communityPage.underline"
    | "communityPage.strike"
    | "communityPage.quote"
    | "communityPage.code"
    | "communityPage.list"
    | "communityPage.link"
    | "communityPage.spoiler";
}

const props = withDefaults(
  defineProps<{
    label: string;
    name: string;
    placeholder: string;
    maxLength: number;
    rows?: number;
    disabled?: boolean;
    allowAttachments?: boolean;
  }>(),
  { rows: 4, disabled: false, allowAttachments: false },
);

const emit = defineEmits<{
  "update:attachmentState": [state: CommunityAttachmentQueueState];
}>();

const content = defineModel<string>({ required: true });
const attachments = defineModel<CommunityAttachment[]>("attachments", { default: () => [] });
const { t } = useLocale();
const textarea = ref<UiTextFieldHandle | null>(null);
const mode = ref<"edit" | "preview">("edit");

const commands: FormatCommand[] = [
  { key: "b", icon: "format_bold", labelKey: "communityPage.bold" },
  { key: "i", icon: "format_italic", labelKey: "communityPage.italic" },
  { key: "u", icon: "format_underlined", labelKey: "communityPage.underline" },
  { key: "s", icon: "format_strikethrough", labelKey: "communityPage.strike" },
  { key: "quote", icon: "format_quote", labelKey: "communityPage.quote" },
  { key: "code", icon: "code", labelKey: "communityPage.code" },
  { key: "list", icon: "format_list_bulleted", labelKey: "communityPage.list" },
  { key: "url", icon: "link", labelKey: "communityPage.link" },
  { key: "spoiler", icon: "visibility", labelKey: "communityPage.spoiler" },
];

const insertRange = async (start: number, end: number, replacement: string, selectStart: number, selectEnd: number) => {
  content.value = `${content.value.slice(0, start)}${replacement}${content.value.slice(end)}`;
  await nextTick();
  textarea.value?.focus();
  textarea.value?.setSelectionRange(selectStart, selectEnd);
};

const applyFormat = async (key: string) => {
  if (props.disabled || mode.value !== "edit") return;
  const field = textarea.value;
  if (!field) return;

  const { start, end } = field.getSelection();
  const selected = content.value.slice(start, end);

  if (key === "list") {
    const entries = selected
      ? selected
          .split("\n")
          .map((line) => `[*]${line}`)
          .join("\n")
      : "[*]";
    const replacement = `[list]\n${entries}\n[/list]`;
    const innerStart = start + "[list]\n[*]".length;
    await insertRange(start, end, replacement, innerStart, innerStart + selected.length);
    return;
  }

  if (key === "url" && !selected) {
    const replacement = "[url]https://[/url]";
    const innerStart = start + "[url]".length;
    await insertRange(start, end, replacement, innerStart, innerStart + "https://".length);
    return;
  }

  const opening = `[${key}]`;
  const closing = `[/${key}]`;
  const replacement = `${opening}${selected}${closing}`;
  const innerStart = start + opening.length;
  await insertRange(start, end, replacement, innerStart, innerStart + selected.length);
};

const handleShortcut = (event: KeyboardEvent) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const command = event.key.toLocaleLowerCase();
  if (!(["b", "i", "u"] as string[]).includes(command)) return;
  event.preventDefault();
  void applyFormat(command);
};
</script>

<template>
  <div class="bbcode-composer" :class="{ 'is-disabled': disabled }">
    <div class="bbcode-composer__toolbar">
      <div class="bbcode-composer__formats" role="toolbar" :aria-label="t('communityPage.formatting')">
        <UiIconButton
          v-for="command in commands"
          :key="command.key"
          class="bbcode-tool"
          size="compact"
          :label="t(command.labelKey)"
          :disabled="disabled || mode === 'preview'"
          @click="applyFormat(command.key)"
        >
          <MaterialIcon :name="command.icon" :size="15" />
        </UiIconButton>
      </div>

      <div class="bbcode-composer__mode" role="group" :aria-label="t('communityPage.editorMode')">
        <UiIconButton
          class="bbcode-mode"
          :pressed="mode === 'edit'"
          size="compact"
          :label="t('communityPage.edit')"
          :disabled="disabled"
          @click="mode = 'edit'"
        >
          <MaterialIcon name="edit" :size="14" />
        </UiIconButton>
        <UiIconButton
          class="bbcode-mode"
          :pressed="mode === 'preview'"
          size="compact"
          :label="t('communityPage.preview')"
          :disabled="disabled"
          @click="mode = 'preview'"
        >
          <MaterialIcon name="visibility" :size="14" />
        </UiIconButton>
      </div>
    </div>

    <UiTextField
      v-if="mode === 'edit'"
      ref="textarea"
      v-model="content"
      class="bbcode-composer__field"
      type="textarea"
      :label="label"
      :placeholder="placeholder"
      :name="name"
      :maxlength="maxLength"
      :rows="rows"
      :disabled="disabled"
      required
      @keydown="handleShortcut"
    />
    <div v-else class="bbcode-composer__preview" :aria-label="t('communityPage.preview')">
      <CommunityBbcode :source="content" />
    </div>

    <CommunityAttachmentUploader
      v-if="allowAttachments"
      v-model="attachments"
      :disabled="disabled"
      @update:state="emit('update:attachmentState', $event)"
    />

    <div class="bbcode-composer__count display-number" aria-live="polite">{{ content.length }} / {{ maxLength }}</div>
  </div>
</template>

<style scoped>
.bbcode-composer {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container-low);
  transition:
    border-color var(--md-sys-motion-duration-short2) ease,
    background-color var(--md-sys-motion-duration-short2) ease;
}

.bbcode-composer:focus-within {
  border-color: var(--md-sys-color-primary);
  background: var(--md-sys-color-surface-container-lowest);
}

.bbcode-composer__toolbar {
  display: flex;
  min-height: 48px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: var(--md-sys-spacing-1) var(--md-sys-spacing-2);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-high);
}

.bbcode-composer__formats,
.bbcode-composer__mode {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 1px;
}

.bbcode-composer__formats {
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.bbcode-composer__formats::-webkit-scrollbar {
  display: none;
}

.bbcode-composer__mode {
  flex: 0 0 auto;
  padding-left: 4px;
  border-left: 1px solid var(--md-sys-color-outline-variant);
}

.bbcode-tool,
.bbcode-mode {
  flex: 0 0 var(--md-comp-control-height-compact);
}

.bbcode-composer__field,
.bbcode-composer__preview {
  display: block;
  width: 100%;
  min-height: 96px;
  padding: 11px 12px;
  border: 0;
  background: transparent;
}

.bbcode-composer__field {
  line-height: 1.65;
  --md-outlined-field-outline-width: 0;
  --md-outlined-field-focus-outline-width: 0;
}

.bbcode-composer__preview {
  overflow: auto;
}

.bbcode-composer__preview :deep(.community-bbcode) {
  font-size: inherit;
}

.bbcode-composer__count {
  padding: var(--md-sys-spacing-1) var(--md-sys-spacing-3) var(--md-sys-spacing-2);
  color: var(--md-sys-color-on-surface-variant);
  border-top: 1px solid var(--md-sys-color-outline-variant);
  font: var(--md-sys-typescale-label-small-weight) var(--md-sys-typescale-label-small-size) /
    var(--md-sys-typescale-label-small-line-height) var(--md-sys-typescale-label-small-font);
  text-align: right;
}

.bbcode-composer.is-disabled {
  opacity: 0.68;
}

@media (max-width: 560px) {
  .bbcode-composer__toolbar {
    align-items: flex-start;
  }

  .bbcode-tool,
  .bbcode-mode {
    flex-basis: var(--md-comp-control-height);
  }
}
</style>
