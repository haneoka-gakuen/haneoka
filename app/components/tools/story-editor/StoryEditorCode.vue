<script setup lang="ts">
import { MaterialIcon, UiButton, UiIconButton } from "@haneoka/ui";

withDefaults(
  defineProps<{
    modelValue: string;
    label?: string;
    language?: string;
    error?: string;
    dirty?: boolean;
    canFormat?: boolean;
  }>(),
  { label: "", language: "Code", canFormat: true },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  apply: [];
  discard: [];
  format: [];
}>();

const copy = useLocale().messages("storyEditorPage");
</script>

<template>
  <section class="story-code-editor">
    <header>
      <MaterialIcon name="data_object" :size="15" />
      <strong>{{ label || copy.formatProject }}</strong>
      <span v-if="dirty" aria-hidden="true">●</span>
      <UiIconButton v-if="canFormat" size="compact" :label="label" @click="emit('format')">
        <MaterialIcon name="auto_fix_high" :size="18" />
      </UiIconButton>
      <UiButton v-if="dirty" class="story-code-editor__action" tone="text" @click="emit('discard')">
        <template #icon><MaterialIcon name="close" :size="18" /></template>
        {{ copy.discardDraft }}
      </UiButton>
      <UiButton class="story-code-editor__action" tone="accent" :disabled="!dirty" @click="emit('apply')">
        <template #icon><MaterialIcon name="check" :size="18" /></template>
        {{ copy.applyCode }}
      </UiButton>
    </header>
    <textarea
      :value="modelValue"
      spellcheck="false"
      :aria-label="language"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      @keydown.meta.s.prevent="emit('apply')"
      @keydown.ctrl.s.prevent="emit('apply')"
    />
    <footer :class="{ 'is-error': error }" role="status">
      {{ error || copy.ready }}
    </footer>
  </section>
</template>

<style scoped>
.story-code-editor {
  display: grid;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-template-rows: 40px minmax(0, 1fr) 28px;
  overflow: hidden;
  background: var(--md-comp-runtime-surface);
}

.story-code-editor > header {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
  padding: 0 9px;
  color: var(--md-sys-color-on-surface-variant);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-low);
}

.story-code-editor > header strong {
  flex: 1;
  font-size: 0.65rem;
  letter-spacing: 0;
  text-transform: uppercase;
}

.story-code-editor > header > span {
  color: var(--md-sys-color-primary);
  font-size: 0.6rem;
}

.story-code-editor__action {
  --md-comp-control-height: var(--md-comp-control-height-compact);
  --md-filled-tonal-button-container-height: var(--md-comp-control-height-compact);
  --md-text-button-container-height: var(--md-comp-control-height-compact);
}

.story-code-editor textarea {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding: 18px 20px;
  resize: none;
  color: var(--md-comp-runtime-on-surface);
  border: 0;
  outline: 0;
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--md-comp-runtime-outline) 50%, transparent) 1px, transparent 1px)
      55px 0 / 1px 100%,
    var(--md-comp-runtime-surface);
  font-family: var(--md-ref-typeface-code);
  font-size: 0.73rem;
  line-height: 1.65;
  tab-size: 2;
  white-space: pre;
}

.story-code-editor > footer {
  display: flex;
  min-width: 0;
  align-items: center;
  padding: 0 10px;
  overflow: hidden;
  color: var(--md-comp-runtime-on-surface-variant);
  border-top: 1px solid var(--md-comp-runtime-outline);
  background: var(--md-comp-runtime-surface-high);
  font-size: 0.56rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.story-code-editor > footer.is-error {
  color: var(--md-comp-runtime-error);
}
</style>
