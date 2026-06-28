<script setup lang="ts">
import { MaterialIcon, UiDialog, UiIconButton } from "@haneoka/ui";

import type { DisplayText } from "~/types/displayText";

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: DisplayText;
    closeOnEscape?: boolean;
  }>(),
  { closeOnEscape: true },
);

const emit = defineEmits<{ close: [] }>();
const { t } = useLocale();

const cancel = (event: Event) => {
  if (!props.closeOnEscape) {
    event.preventDefault();
    return;
  }
  emit("close");
};
</script>

<template>
  <UiDialog class="modal-surface" :open="open" @cancel="cancel">
    <template #headline>
      <div class="modal-surface__headline">
        <h2><DisplayText :value="title" /></h2>
        <UiIconButton :label="t('close')" size="touch" @click="emit('close')">
          <MaterialIcon name="close" :size="20" />
        </UiIconButton>
      </div>
    </template>
    <template #content>
      <div class="modal-surface__content"><slot /></div>
    </template>
    <template v-if="$slots.actions" #actions>
      <div class="modal-surface__actions"><slot name="actions" /></div>
    </template>
  </UiDialog>
</template>

<style scoped>
.modal-surface {
  --md3-dialog-max-height: 720px;
  --md3-dialog-max-width: 560px;
  --md3-dialog-width: 560px;
  --md-dialog-container-color: var(--md-sys-color-surface-container-high);
  --md-dialog-container-shape: var(--md-sys-shape-corner-extra-large);
  --md-dialog-headline-color: var(--md-sys-color-on-surface);
  --md-dialog-supporting-text-color: var(--md-sys-color-on-surface-variant);
}

.modal-surface__headline {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) var(--md-comp-control-height-touch);
  align-items: center;
  gap: var(--md-sys-spacing-3);
}

.modal-surface__headline h2 {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  font-family: var(--md-sys-typescale-headline-small-font);
  font-size: var(--md-sys-typescale-headline-small-size);
  font-weight: var(--md-sys-typescale-headline-small-weight);
  line-height: var(--md-sys-typescale-headline-small-line-height);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.modal-surface__content {
  min-width: 0;
}

.modal-surface__actions {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--md-sys-spacing-2);
}

@media (max-width: 599px) {
  .modal-surface {
    --md3-dialog-max-height: calc(100dvh - var(--shell-bottom-navigation-height));
    --md3-dialog-max-width: 100vw;
    --md3-dialog-viewport-inset: 0px;
    --md3-dialog-width: 100vw;
    --md-dialog-container-shape: var(--md-sys-shape-corner-none);
  }
}
</style>
