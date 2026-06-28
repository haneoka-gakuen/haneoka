<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

import type { DetailPeerItem } from "~/components/detail/types";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    items: readonly DetailPeerItem[];
    label: string;
    controlsId?: string;
    idPrefix?: string;
  }>(),
  {
    controlsId: "",
    idPrefix: "detail-tab",
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const itemId = (id: string) => `${props.idPrefix}-${id}`;
const onChange = (event: Event) => {
  const index = (event.currentTarget as HTMLElement & { activeTabIndex?: number }).activeTabIndex;
  const item = typeof index === "number" ? props.items[index] : undefined;
  if (item) emit("update:modelValue", item.id);
};
</script>

<template>
  <md-tabs class="detail-peer-tabs" :aria-label="label" @change="onChange">
    <md-primary-tab
      v-for="item in items"
      :id="itemId(item.id)"
      :key="item.id"
      class="detail-peer-tabs__item"
      inline-icon
      :active="item.id === modelValue"
      :aria-controls="controlsId || undefined"
    >
      <!-- Material Web tabs expose a native named slot; this is not a legacy Vue slot. -->
      <!-- eslint-disable-next-line vue/no-deprecated-slot-attribute -->
      <MaterialIcon v-if="item.icon" slot="icon" :name="item.icon" :size="18" aria-hidden="true" />
      <span class="detail-peer-tabs__label">
        {{ item.label }}
        <small v-if="item.count !== undefined" class="display-number">{{ item.count }}</small>
      </span>
    </md-primary-tab>
  </md-tabs>
</template>

<style scoped>
.detail-peer-tabs {
  display: block;
  width: 100%;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  --md-primary-tab-active-indicator-color: var(--md-sys-color-primary);
  --md-primary-tab-active-label-text-color: var(--md-sys-color-primary);
  --md-primary-tab-active-icon-color: var(--md-sys-color-primary);
  --md-primary-tab-container-height: 48px;
}

.detail-peer-tabs__item {
  --md-primary-tab-label-text-font: var(--md-sys-typescale-label-large-font);
  --md-primary-tab-label-text-size: var(--md-sys-typescale-label-large-size);
  --md-primary-tab-label-text-weight: var(--md-sys-typescale-label-large-weight);
}

.detail-peer-tabs__label small {
  margin-inline-start: 4px;
  color: inherit;
  font-size: 0.6rem;
}

@media (max-width: 900px) {
  .detail-peer-tabs__label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
  }
}
</style>
