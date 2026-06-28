<script setup lang="ts">
import {
  MaterialIcon,
  UiButton,
  UiDialog,
  UiIconButton,
  UiTextField,
  type UiButtonHandle,
  type UiFieldValue,
  type UiTextFieldHandle,
} from "@haneoka/ui";

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    confirmLabel: string;
    cancelLabel: string;
    description?: string;
    icon?: string;
    destructive?: boolean;
    inputLabel?: string;
    initialValue?: string;
  }>(),
  {
    description: "",
    icon: "help",
    destructive: false,
    inputLabel: "",
    initialValue: "",
  },
);

const emit = defineEmits<{
  cancel: [];
  closed: [];
  confirm: [value: string];
}>();

const draft = ref("");
const input = ref<UiTextFieldHandle>();
const cancelButton = ref<UiButtonHandle>();
const prompt = computed(() => Boolean(props.inputLabel));
const confirmDisabled = computed(() => prompt.value && !draft.value.trim());

watch(
  () => [props.open, props.initialValue] as const,
  ([open, initialValue]) => {
    if (open) draft.value = initialValue;
  },
  { immediate: true },
);

const setDraft = (value: UiFieldValue) => {
  draft.value = String(value);
};

const focusInitialControl = async () => {
  await nextTick();
  if (!prompt.value) {
    cancelButton.value?.focus();
    return;
  }
  input.value?.focus();
  input.value?.setSelectionRange(0, draft.value.length);
};

const confirm = () => {
  if (confirmDisabled.value) return;
  emit("confirm", draft.value);
};

const onInputKeydown = (event: KeyboardEvent) => {
  if (event.key !== "Enter" || event.isComposing) return;
  event.preventDefault();
  confirm();
};
</script>

<template>
  <UiDialog
    class="editor-action-dialog"
    :open="open"
    @cancel="emit('cancel')"
    @closed="emit('closed')"
    @opened="focusInitialControl"
  >
    <template #headline>
      <header class="editor-action-dialog__headline">
        <MaterialIcon :name="icon" :size="22" aria-hidden="true" />
        <strong>{{ title }}</strong>
        <UiIconButton size="compact" :label="cancelLabel" @click="emit('cancel')">
          <MaterialIcon name="close" :size="20" />
        </UiIconButton>
      </header>
    </template>

    <template #content>
      <div class="editor-action-dialog__content">
        <p v-if="description">{{ description }}</p>
        <UiTextField
          v-if="prompt"
          ref="input"
          :model-value="draft"
          :label="inputLabel"
          required
          @update:model-value="setDraft"
          @keydown="onInputKeydown"
        />
      </div>
    </template>

    <template #actions>
      <UiButton ref="cancelButton" tone="text" @click="emit('cancel')">{{ cancelLabel }}</UiButton>
      <UiButton :tone="destructive ? 'danger' : 'primary'" :disabled="confirmDisabled" @click="confirm">
        {{ confirmLabel }}
      </UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.editor-action-dialog {
  width: min(480px, calc(100vw - var(--md-sys-spacing-6)));
  max-width: 480px;
  --md-dialog-container-color: var(--md-sys-color-surface-container-high);
  --md-dialog-container-shape: var(--md-sys-shape-corner-extra-large);
}

.editor-action-dialog__headline {
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--md-sys-spacing-3);
}

.editor-action-dialog__headline strong {
  min-width: 0;
  overflow: hidden;
  color: var(--md-sys-color-on-surface);
  font-family: var(--md-sys-typescale-headline-small-font);
  font-size: var(--md-sys-typescale-headline-small-size);
  font-weight: var(--md-sys-typescale-headline-small-weight);
  line-height: var(--md-sys-typescale-headline-small-line-height);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor-action-dialog__content {
  display: grid;
  min-width: 0;
  gap: var(--md-sys-spacing-4);
}

.editor-action-dialog__content p {
  margin: 0;
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-body-medium-font);
  font-size: var(--md-sys-typescale-body-medium-size);
  line-height: var(--md-sys-typescale-body-medium-line-height);
  overflow-wrap: anywhere;
}

.editor-action-dialog__content > * {
  width: 100%;
}

@media (max-width: 599px) {
  .editor-action-dialog {
    width: 100vw;
    max-width: 100vw;
    --md3-dialog-max-height: 100dvh;
    --md3-dialog-viewport-inset: 0px;
    --md-dialog-container-shape: var(--md-sys-shape-corner-none);
  }
}
</style>
