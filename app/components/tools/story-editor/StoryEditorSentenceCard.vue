<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.

  Portions are adapted from OpenWebGAL/WebGAL_Terre's GraphicalEditor
  and SentenceEditor components at commit 7b7a2159a5ccead80327437b7305b8fdb47a4e5f.
  See packages/story-editor/NOTICE.webgal.md for complete provenance.
-->
<script setup lang="ts">
import {
  MaterialIcon,
  UiFilterChip,
  UiIconButton,
  UiSelect,
  UiSwitch,
  UiTextField,
  type UiFieldValue,
  type UiSelectOption,
} from "@haneoka/ui";

import {
  commandFieldDescriptors,
  commandDescriptor,
  replaceStoryLocalizedTextForEditor,
  storyCommandFieldValue,
  storyLocalizedTextForEditor,
  storyNumberFromInput,
  storyNumberInputValue,
  storyTargetNameForEditor,
  storyTargetNameFromEditor,
  type CommandFieldDescriptor,
  type CommandResourceKind,
  type JsonObject,
  type JsonValue,
  type StoryProjectCommand,
  type StoryValidationIssue,
} from "@haneoka/story-editor";
import type { ArchiveLocale } from "~/i18n/locales";
import { createStoryEditorCommitQueue } from "~/utils/storyEditorCommitQueue";
import type { StoryEditorAudioUsage } from "./StoryEditorResourceLibrary.vue";

export interface StoryEditorResourceTarget {
  commandId: string;
  fieldKey: string;
  resource: CommandResourceKind;
  audioUsage?: StoryEditorAudioUsage;
}

const props = defineProps<{
  command: StoryProjectCommand;
  index: number;
  selected?: boolean;
  first?: boolean;
  last?: boolean;
  issues?: readonly StoryValidationIssue[];
  canExecute?: boolean;
}>();

const emit = defineEmits<{
  select: [id: string];
  patch: [payload: { id: string; key: string; value?: JsonValue }];
  replace: [payload: { id: string; fields: JsonObject }];
  duplicate: [id: string];
  remove: [id: string];
  move: [payload: { id: string; index: number }];
  "pick-resource": [target: StoryEditorResourceTarget];
  "drag-start": [payload: { id: string; event: DragEvent }];
  "execute-to": [id: string];
}>();

const { locale, messages } = useLocale();
const copy = messages("storyEditorPage");
const { commandLabel, fieldLabel, choiceLabel: localizeChoiceLabel } = useStoryEditorLabels();
const visibleFields = computed(() =>
  commandFieldDescriptors(props.command).map((field) => ({
    field,
    value: storyCommandFieldValue(props.command, field),
  })),
);
const title = computed(() => {
  const descriptor = commandDescriptor(props.command.command);
  return descriptor
    ? commandLabel(descriptor.name, descriptor.label)
    : props.command.source?.command || `#${props.command.command ?? "?"}`;
});
const localeIndexes: Record<ArchiveLocale, number> = { ja: 0, en: 1, "zh-TW": 2, "zh-CN": 3, ko: 4 };
type DraftFieldKind = "localized-list" | "localized-text" | "number" | "resource" | "resource-list" | "text";
interface FieldDraft {
  field: CommandFieldDescriptor;
  kind: DraftFieldKind;
  localeIndex: number;
  source: string;
}
const fieldDrafts = shallowReactive(new Map<string, FieldDraft>());
const committedDrafts = new Map<string, string>();
const commitQueue = createStoryEditorCommitQueue(300);

const localizedText = (value: JsonValue | undefined): string =>
  storyLocalizedTextForEditor(value, localeIndexes[locale.value]);

const localizedListText = (value: JsonValue | undefined): string => {
  if (!Array.isArray(value)) return localizedText(value);
  return value
    .map((item) => localizedText(item))
    .filter(Boolean)
    .join(", ");
};

const localizedValue = (original: JsonValue | undefined, localeIndex: number, text: string): JsonValue =>
  replaceStoryLocalizedTextForEditor(original, localeIndex, text);

const replaceField = (field: CommandFieldDescriptor, value?: JsonValue) => {
  const sourceKey = field.sourceKey || field.key;
  if (field.parameterIndex === undefined) {
    emit("patch", { id: props.command.id, key: sourceKey, value });
    return;
  }

  const currentParams = Array.isArray(props.command.fields[sourceKey])
    ? [...(props.command.fields[sourceKey] as JsonValue[])]
    : [];
  while (currentParams.length <= field.parameterIndex) currentParams.push("");
  currentParams[field.parameterIndex] =
    field.parameterEncoding === "string" && (typeof value === "number" || typeof value === "boolean")
      ? Object.is(value, -0)
        ? "-0"
        : String(value)
      : (value ?? "");
  while (currentParams.length && currentParams.at(-1) === "") currentParams.pop();
  emit("patch", {
    id: props.command.id,
    key: sourceKey,
    value: currentParams.length ? currentParams : undefined,
  });
};

const numericInputValue = (value: JsonValue | undefined): string => {
  if (typeof value === "number") return storyNumberInputValue(value);
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Number(value))) return "";
  return value;
};

const choiceValue = (field: CommandFieldDescriptor, source: string): JsonValue =>
  field.choices?.find((choice) => String(choice.value) === source)?.value ?? source;
const selectOptions = (field: CommandFieldDescriptor, value: JsonValue | undefined): UiSelectOption[] => {
  const options =
    field.choices?.map((choice) => ({ label: localizeChoiceLabel(choice.label), value: String(choice.value) })) ?? [];
  if (value !== undefined && !options.some((option) => option.value === String(value))) {
    options.unshift({ label: String(value), value: String(value) });
  }
  return options;
};

const resourceListText = (value: JsonValue | undefined): string =>
  Array.isArray(value) ? value.map(String).filter(Boolean).join(", ") : String(value || "");

const choiceListEntries = (value: JsonValue | undefined): JsonObject[] =>
  Array.isArray(value)
    ? value.map((entry) =>
        entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as JsonObject) : ({} as JsonObject),
      )
    : [];

const replaceChoiceEntry = (
  field: CommandFieldDescriptor,
  value: JsonValue | undefined,
  index: number,
  key: "choiceValue" | "text" | "nextKey",
  nextValue: JsonValue | undefined,
) => {
  const choices = choiceListEntries(value).map((entry) => ({ ...entry }));
  const choice = choices[index];
  if (!choice) return;
  if (nextValue === undefined) delete choice[key];
  else choice[key] = nextValue;
  replaceField(field, choices);
};

const replaceChoiceText = (
  field: CommandFieldDescriptor,
  value: JsonValue | undefined,
  index: number,
  source: string,
) => {
  const choice = choiceListEntries(value)[index];
  if (!choice) return;
  replaceChoiceEntry(field, value, index, "text", localizedValue(choice.text, localeIndexes[locale.value], source));
};

const addChoiceEntry = (field: CommandFieldDescriptor, value: JsonValue | undefined) => {
  const choices = choiceListEntries(value).map((entry) => ({ ...entry }));
  const used = new Set(
    choices.map((choice) => choice.choiceValue).filter((item): item is number => Number.isInteger(item)),
  );
  let choiceValue = 0;
  while (used.has(choiceValue)) choiceValue += 1;
  choices.push({ choiceValue, text: "", nextKey: "" });
  replaceField(field, choices);
};

const removeChoiceEntry = (field: CommandFieldDescriptor, value: JsonValue | undefined, index: number) => {
  const choices = choiceListEntries(value).map((entry) => ({ ...entry }));
  choices.splice(index, 1);
  replaceField(field, choices);
};

type VectorAxis = "x" | "y" | "z";
const vectorComponent = (value: JsonValue | undefined, axis: VectorAxis): string => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return numericInputValue(value[axis]);
};
const replaceVectorComponent = (
  field: CommandFieldDescriptor,
  value: JsonValue | undefined,
  axis: VectorAxis,
  source: string,
) => {
  const current = value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  const component = storyNumberFromInput(source);
  if (component === undefined) delete current[axis];
  else current[axis] = component;
  replaceField(field, Object.keys(current).length ? current : undefined);
};

const isTargetNameField = (field: CommandFieldDescriptor): boolean => (field.sourceKey || field.key) === "targetName";

const editorText = (field: CommandFieldDescriptor, value: JsonValue | undefined): string =>
  isTargetNameField(field) ? storyTargetNameForEditor(value) : String(value ?? "");

const draftText = (field: CommandFieldDescriptor, fallback: string): string =>
  fieldDrafts.get(field.key)?.source ?? fallback;

const draftValue = (draft: FieldDraft): JsonValue | undefined => {
  const original = storyCommandFieldValue(props.command, draft.field);
  if (draft.kind === "number") return storyNumberFromInput(draft.source);
  if (draft.kind === "resource-list") {
    return draft.source
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (draft.kind === "localized-text") return localizedValue(original, draft.localeIndex, draft.source);
  if (draft.kind === "localized-list") {
    const names = draft.source
      .split(/[・·,，、]/)
      .map((item) => item.trim())
      .filter(Boolean);
    const existing = Array.isArray(original) ? original : [];
    return names.map((name, index) => localizedValue(existing[index], draft.localeIndex, name));
  }
  if (draft.kind === "text" && isTargetNameField(draft.field)) return storyTargetNameFromEditor(draft.source);
  return draft.source;
};

const commitFieldDraft = (key: string) => {
  const draft = fieldDrafts.get(key);
  if (!draft || committedDrafts.get(key) === draft.source) return;
  committedDrafts.set(key, draft.source);
  replaceField(draft.field, draftValue(draft));
};

const queueFieldDraft = (field: CommandFieldDescriptor, kind: DraftFieldKind, source: string) => {
  const key = field.key;
  fieldDrafts.set(key, { field, kind, source, localeIndex: localeIndexes[locale.value] });
  commitQueue.schedule(key, () => commitFieldDraft(key));
};

const flushFieldDraft = (key: string, clear = true) => {
  commitQueue.flush(key);
  const draft = fieldDrafts.get(key);
  if (!clear || !draft) return;
  void nextTick().then(() => {
    if (fieldDrafts.get(key) !== draft) return;
    fieldDrafts.delete(key);
    committedDrafts.delete(key);
  });
};

const updateMultiSelect = (
  field: CommandFieldDescriptor,
  value: JsonValue | undefined,
  choice: JsonValue,
  checked: boolean,
) => {
  const current = Array.isArray(value) ? [...value] : [];
  const key = String(choice);
  const next = current.filter((item) => String(item) !== key);
  if (checked) next.push(choice);
  replaceField(field, next);
};

const hasMultiChoice = (value: JsonValue | undefined, choice: JsonValue): boolean =>
  Array.isArray(value) && value.some((item) => String(item) === String(choice));

const fieldControlId = (key: string) => `story-field-${props.command.id}-${key}`;
const pickResource = (field: CommandFieldDescriptor) => {
  if (!field.resource) return;
  emit("pick-resource", {
    commandId: props.command.id,
    fieldKey: field.sourceKey || field.key,
    resource: field.resource,
    ...(field.audioUsage ? { audioUsage: field.audioUsage } : {}),
  });
};
const moveBy = (delta: number) => emit("move", { id: props.command.id, index: props.index + delta });
const fieldSource = (value: UiFieldValue): string => String(value);

onBeforeUnmount(() => commitQueue.flushAll());
</script>

<template>
  <article
    class="story-sentence"
    :class="{ 'is-selected': selected, 'has-issues': issues?.length }"
    :data-command-id="command.id"
    :data-command-code="command.command"
    @click="emit('select', command.id)"
    @focusin="emit('select', command.id)"
  >
    <div class="story-sentence__rail">
      <span class="display-number">{{ index + 1 }}</span>
      <UiIconButton size="compact" :disabled="first" :label="copy.moveUp" @click.stop="moveBy(-1)">
        <MaterialIcon name="expand_less" :size="18" />
      </UiIconButton>
      <UiIconButton size="compact" :disabled="last" :label="copy.moveDown" @click.stop="moveBy(1)">
        <MaterialIcon name="expand_more" :size="18" />
      </UiIconButton>
      <UiIconButton
        class="story-sentence__drag"
        size="compact"
        draggable="true"
        :label="copy.dragToReorder"
        @dragstart.stop="emit('drag-start', { id: command.id, event: $event })"
      >
        <MaterialIcon name="drag_indicator" :size="18" />
      </UiIconButton>
    </div>

    <div class="story-sentence__content">
      <header>
        <div class="story-sentence__title">
          <strong>{{ title }}</strong>
        </div>
        <span v-if="issues?.length" class="story-sentence__issue-count" :title="issues[0]?.message">
          <MaterialIcon name="warning" :size="13" />
          {{ issues.length }}
        </span>
        <div class="story-sentence__actions">
          <UiIconButton
            size="compact"
            :disabled="!canExecute"
            :label="canExecute ? copy.executeToCommand : copy.previewUnavailable"
            @click.stop="emit('execute-to', command.id)"
          >
            <MaterialIcon name="play_arrow" :size="18" />
          </UiIconButton>
          <UiIconButton size="compact" :label="copy.duplicateCommand" @click.stop="emit('duplicate', command.id)">
            <MaterialIcon name="content_copy" :size="18" />
          </UiIconButton>
          <UiIconButton size="compact" :label="copy.deleteCommand" @click.stop="emit('remove', command.id)">
            <MaterialIcon name="delete" :size="18" />
          </UiIconButton>
        </div>
      </header>

      <div v-if="visibleFields.length" class="story-sentence__fields">
        <div
          v-for="entry in visibleFields"
          :key="entry.field.key"
          class="story-sentence-field"
          :data-kind="entry.field.kind"
          :data-key="entry.field.key"
        >
          <label
            v-if="['choice-list', 'multi-select', 'vector3'].includes(entry.field.kind)"
            :for="fieldControlId(entry.field.key)"
          >
            {{ fieldLabel(entry.field) }}
          </label>

          <div
            v-if="entry.field.kind === 'resource' || entry.field.kind === 'resource-list'"
            class="story-sentence-field__resource"
          >
            <UiTextField
              :id="fieldControlId(entry.field.key)"
              class="story-sentence-field__control"
              :label="fieldLabel(entry.field)"
              :model-value="
                draftText(
                  entry.field,
                  entry.field.kind === 'resource-list' ? resourceListText(entry.value) : String(entry.value ?? ''),
                )
              "
              :required="entry.field.required"
              @update:model-value="queueFieldDraft(entry.field, entry.field.kind, fieldSource($event))"
              @change="flushFieldDraft(entry.field.key)"
              @blur="flushFieldDraft(entry.field.key)"
            />
            <UiIconButton
              class="story-sentence-field__resource-picker"
              size="touch"
              :label="copy.selectResource"
              @click.stop="pickResource(entry.field)"
            >
              <MaterialIcon name="folder_open" :size="20" />
            </UiIconButton>
          </div>
          <UiTextField
            v-else-if="entry.field.kind === 'text'"
            :id="fieldControlId(entry.field.key)"
            class="story-sentence-field__control"
            :label="fieldLabel(entry.field)"
            :model-value="draftText(entry.field, editorText(entry.field, entry.value))"
            :required="entry.field.required"
            @update:model-value="queueFieldDraft(entry.field, 'text', fieldSource($event))"
            @change="flushFieldDraft(entry.field.key)"
            @blur="flushFieldDraft(entry.field.key)"
          />
          <UiTextField
            v-else-if="entry.field.kind === 'number'"
            :id="fieldControlId(entry.field.key)"
            class="story-sentence-field__control"
            type="number"
            step="any"
            :label="fieldLabel(entry.field)"
            :model-value="draftText(entry.field, numericInputValue(entry.value))"
            @update:model-value="queueFieldDraft(entry.field, 'number', fieldSource($event))"
            @change="flushFieldDraft(entry.field.key)"
            @blur="flushFieldDraft(entry.field.key)"
          />
          <div v-else-if="entry.field.kind === 'vector3'" class="story-sentence-field__vector">
            <UiTextField
              v-for="axis in ['x', 'y', 'z'] as const"
              :id="axis === 'x' ? fieldControlId(entry.field.key) : undefined"
              :key="axis"
              class="story-sentence-field__control"
              type="number"
              step="any"
              :label="axis.toUpperCase()"
              :model-value="vectorComponent(entry.value, axis)"
              @update:model-value="replaceVectorComponent(entry.field, entry.value, axis, fieldSource($event))"
            />
          </div>
          <div v-else-if="entry.field.kind === 'choice-list'" class="story-sentence-field__choice-list">
            <div
              v-for="(choice, choiceIndex) in choiceListEntries(entry.value)"
              :key="choiceIndex"
              class="story-sentence-field__choice-row"
            >
              <UiTextField
                :id="choiceIndex === 0 ? fieldControlId(entry.field.key) : undefined"
                class="story-sentence-field__control"
                :model-value="localizedText(choice.text)"
                :lang="locale"
                :label="fieldLabel(entry.field)"
                @update:model-value="replaceChoiceText(entry.field, entry.value, choiceIndex, fieldSource($event))"
              />
              <UiTextField
                class="story-sentence-field__control"
                type="number"
                step="1"
                :model-value="numericInputValue(choice.choiceValue)"
                label="#"
                @update:model-value="
                  replaceChoiceEntry(
                    entry.field,
                    entry.value,
                    choiceIndex,
                    'choiceValue',
                    storyNumberFromInput(fieldSource($event)),
                  )
                "
              />
              <UiTextField
                class="story-sentence-field__control"
                :model-value="String(choice.nextKey ?? '')"
                :label="copy.scenes"
                @update:model-value="
                  replaceChoiceEntry(entry.field, entry.value, choiceIndex, 'nextKey', fieldSource($event))
                "
              />
              <UiIconButton
                size="touch"
                :label="copy.removeArrayItem"
                @click="removeChoiceEntry(entry.field, entry.value, choiceIndex)"
              >
                <MaterialIcon name="remove_circle_outline" :size="20" />
              </UiIconButton>
            </div>
            <UiIconButton
              class="story-sentence-field__choice-add"
              size="touch"
              :label="copy.addArrayItem"
              @click="addChoiceEntry(entry.field, entry.value)"
            >
              <MaterialIcon name="add" :size="20" />
            </UiIconButton>
          </div>
          <UiSwitch
            v-else-if="entry.field.kind === 'boolean'"
            :id="fieldControlId(entry.field.key)"
            class="story-sentence-field__toggle"
            :model-value="entry.value === true"
            :label="fieldLabel(entry.field)"
            @update:model-value="replaceField(entry.field, $event)"
          />
          <UiTextField
            v-else-if="entry.field.kind === 'localized-text'"
            :id="fieldControlId(entry.field.key)"
            class="story-sentence-field__control story-sentence-field__control--textarea"
            type="textarea"
            rows="2"
            :model-value="draftText(entry.field, localizedText(entry.value))"
            :label="fieldLabel(entry.field)"
            :lang="locale"
            @update:model-value="queueFieldDraft(entry.field, 'localized-text', fieldSource($event))"
            @change="flushFieldDraft(entry.field.key)"
            @blur="flushFieldDraft(entry.field.key)"
          />
          <UiTextField
            v-else-if="entry.field.kind === 'localized-list'"
            :id="fieldControlId(entry.field.key)"
            class="story-sentence-field__control"
            :model-value="draftText(entry.field, localizedListText(entry.value))"
            :label="fieldLabel(entry.field)"
            :lang="locale"
            @update:model-value="queueFieldDraft(entry.field, 'localized-list', fieldSource($event))"
            @change="flushFieldDraft(entry.field.key)"
            @blur="flushFieldDraft(entry.field.key)"
          />
          <UiSelect
            v-else-if="entry.field.kind === 'select'"
            :id="fieldControlId(entry.field.key)"
            class="story-sentence-field__control"
            :model-value="String(entry.value ?? '')"
            :options="selectOptions(entry.field, entry.value)"
            :label="fieldLabel(entry.field)"
            @update:model-value="replaceField(entry.field, choiceValue(entry.field, fieldSource($event)))"
          />
          <div v-else-if="entry.field.kind === 'multi-select'" class="story-sentence-field__choices">
            <UiFilterChip
              v-for="choice in entry.field.choices"
              :key="String(choice.value)"
              :selected="hasMultiChoice(entry.value, choice.value)"
              @click="
                updateMultiSelect(entry.field, entry.value, choice.value, !hasMultiChoice(entry.value, choice.value))
              "
            >
              {{ localizeChoiceLabel(choice.label) }}
            </UiFilterChip>
          </div>
        </div>
      </div>
    </div>
  </article>
</template>

<style scoped>
.story-sentence {
  contain: layout paint style;
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: 34px minmax(0, 1fr);
  color: var(--md-sys-color-on-surface-variant);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container-lowest);
  font-family: var(--md-sys-typescale-body-small-font);
  transition: border-color var(--md-sys-motion-duration-short2) ease;
}

.story-sentence:hover,
.story-sentence:focus-within,
.story-sentence.is-selected {
  border-color: color-mix(in srgb, var(--md-sys-color-secondary) 45%, transparent);
}

.story-sentence.is-selected {
  box-shadow: inset 2px 0 var(--md-sys-color-primary);
}

.story-sentence.has-issues {
  border-left-color: var(--md-sys-color-error);
}

.story-sentence__rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 9px;
  color: var(--md-sys-color-outline);
  border-right: 1px solid var(--md-sys-color-outline-variant);
}

.story-sentence__rail > span {
  height: 22px;
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
}

.story-sentence__rail :deep(.md3-icon-button),
.story-sentence__actions :deep(.md3-icon-button) {
  --md-icon-button-icon-color: var(--md-sys-color-on-surface-variant);
}

.story-sentence__drag {
  margin-top: 2px;
  cursor: grab !important;
}

.story-sentence__content {
  min-width: 0;
  padding: 5px 7px 8px;
}

.story-sentence__content > header {
  display: flex;
  min-width: 0;
  min-height: 26px;
  align-items: center;
  gap: 6px;
}

.story-sentence__title {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  color: var(--md-sys-color-primary);
}

.story-sentence__title strong {
  overflow: hidden;
  font-family: var(--md-sys-typescale-label-medium-font);
  font-size: var(--md-sys-typescale-label-medium-size);
  font-weight: var(--md-sys-typescale-label-medium-weight);
  line-height: var(--md-sys-typescale-label-medium-line-height);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.story-sentence__issue-count {
  color: var(--md-sys-color-error);
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: var(--md-sys-typescale-label-small-size);
}

.story-sentence__actions {
  display: flex;
  margin-left: auto;
  opacity: 0;
}

.story-sentence:hover .story-sentence__actions,
.story-sentence:focus-within .story-sentence__actions,
.story-sentence.is-selected .story-sentence__actions {
  opacity: 1;
}

.story-sentence__fields {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: end;
  gap: 6px;
  padding-top: 4px;
}

.story-sentence-field {
  display: grid;
  min-width: 120px;
  max-width: 300px;
  flex: 0 1 190px;
  gap: 3px;
  padding: 3px;
  border-radius: var(--md-sys-shape-corner-extra-small);
}

.story-sentence-field:hover {
  background: var(--md-sys-color-surface-container-high);
}

.story-sentence-field[data-kind="localized-text"] {
  min-width: min(360px, 100%);
  max-width: none;
  flex: 1 1 460px;
}

.story-sentence-field[data-kind="resource"],
.story-sentence-field[data-kind="resource-list"] {
  min-width: min(270px, 100%);
  max-width: 430px;
  flex-basis: 310px;
}

.story-sentence-field[data-kind="multi-select"] {
  min-width: min(300px, 100%);
  max-width: 540px;
  flex-basis: 400px;
}

.story-sentence-field[data-kind="vector3"] {
  min-width: min(270px, 100%);
  max-width: 360px;
  flex-basis: 300px;
}

.story-sentence-field[data-kind="choice-list"] {
  min-width: min(520px, 100%);
  max-width: none;
  flex: 1 1 620px;
}

.story-sentence-field > label {
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
}

.story-sentence-field__control {
  width: 100%;
  min-width: 0;
  --md-outlined-text-field-top-space: var(--md-sys-spacing-2);
  --md-outlined-text-field-bottom-space: var(--md-sys-spacing-2);
  --md-outlined-text-field-with-label-top-space: var(--md-sys-spacing-1);
  --md-outlined-text-field-with-label-bottom-space: var(--md-sys-spacing-1);
  --md-outlined-text-field-input-text-size: var(--md-sys-typescale-body-small-size);
  --md-outlined-select-text-field-input-text-size: var(--md-sys-typescale-body-small-size);
}

.story-sentence-field__control--textarea {
  min-height: 72px;
}

.story-sentence-field__resource {
  display: flex;
  min-width: 0;
  gap: 4px;
}

.story-sentence-field__vector {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
}

.story-sentence-field__choice-list {
  display: grid;
  gap: 4px;
}

.story-sentence-field__choice-row {
  display: grid;
  grid-template-columns: minmax(150px, 1fr) 74px minmax(120px, 0.8fr) 30px;
  gap: 4px;
}

.story-sentence-field__choice-add {
  width: 100%;
}

.story-sentence-field__resource .story-sentence-field__control {
  flex: 1;
}

.story-sentence-field__resource-picker {
  flex: 0 0 auto;
}

.story-sentence-field__toggle {
  min-height: var(--md-comp-control-height);
  font-size: var(--md-sys-typescale-body-medium-size);
  font-weight: var(--md-sys-typescale-body-medium-weight);
}

.story-sentence-field__choices {
  display: flex;
  min-height: 32px;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px;
}

.story-sentence-field__choices :deep(.md3-filter-chip) {
  --md-filter-chip-container-height: 32px;
  --md-filter-chip-label-text-size: var(--md-sys-typescale-label-small-size);
}
</style>
