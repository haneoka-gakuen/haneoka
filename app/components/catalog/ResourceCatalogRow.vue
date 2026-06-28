<script setup lang="ts">
import { MaterialIcon, UiIconButton } from "@haneoka/ui";
import type { RouteLocationRaw } from "vue-router";

import { langOf, textOf, type DisplayText } from "~/types/displayText";

export interface ResourceRowField {
  key: string;
  value?: DisplayText | number | null;
  align?: "start" | "center" | "end";
  code?: boolean;
}

withDefaults(
  defineProps<{
    identifier: string | number;
    title: DisplayText;
    subtitle?: DisplayText;
    image?: string;
    imageFit?: "contain" | "cover";
    mediaText?: DisplayText;
    mediaColor?: string;
    mediaShape?: "circle" | "rounded";
    fields?: ResourceRowField[];
    selected?: boolean;
    playable?: boolean;
    playing?: boolean;
    mediaIcon?: string;
    actionCell?: boolean;
    rowIndex?: number;
    to?: RouteLocationRaw;
  }>(),
  {
    subtitle: "",
    image: "",
    imageFit: "contain",
    mediaText: "",
    mediaColor: undefined,
    mediaShape: "rounded",
    fields: () => [],
    selected: false,
    playable: false,
    playing: false,
    mediaIcon: undefined,
    actionCell: true,
    rowIndex: undefined,
    to: undefined,
  },
);

const emit = defineEmits<{
  select: [];
  play: [];
}>();

const { t } = useLocale();
const hasFieldValue = (value: ResourceRowField["value"]) =>
  value != null && (typeof value === "number" || Boolean(textOf(value)));
</script>

<template>
  <CollectionTableRow
    :label="textOf(title)"
    :language="langOf(title)"
    :selected="selected"
    :row-index="rowIndex"
    :to="to"
    @select="emit('select')"
  >
    <code class="resource-row__id display-number" role="gridcell">{{ identifier }}</code>

    <CollectionPrimaryCell
      :title="title"
      :subtitle="subtitle"
      :image="image"
      :image-fit="imageFit"
      :media-icon="mediaIcon"
      :media-text="mediaText"
      :media-color="mediaColor"
      :media-shape="mediaShape"
    />

    <span
      v-for="field in fields"
      :key="field.key"
      class="resource-row__field"
      :class="[`is-${field.align || 'center'}`, { 'is-code': field.code }]"
      role="gridcell"
    >
      <slot :name="`field-${field.key}`" :field="field">
        <code
          v-if="field.code && hasFieldValue(field.value)"
          class="display-number"
          :lang="typeof field.value === 'number' ? undefined : langOf(field.value)"
        >
          <DisplayText v-if="typeof field.value !== 'number'" :value="field.value" />
          <template v-else>{{ field.value }}</template>
        </code>
        <template v-else-if="typeof field.value === 'number'">{{ field.value }}</template>
        <DisplayText v-else-if="hasFieldValue(field.value)" :value="field.value" />
        <template v-else>—</template>
      </slot>
    </span>

    <span v-if="actionCell" class="resource-row__action" role="gridcell">
      <UiIconButton
        v-if="playable"
        class="resource-row__play"
        emphasis
        :pressed="playing"
        :label="playing ? t('pause') : t('play')"
        @click.stop="emit('play')"
      >
        <MaterialIcon name="pause" v-if="playing" :size="15" aria-hidden="true" />
        <MaterialIcon name="play_arrow" v-else :size="15" aria-hidden="true" />
      </UiIconButton>
    </span>
  </CollectionTableRow>
</template>

<style scoped>
.resource-row__id,
.resource-row__field {
  min-width: 0;
  padding-inline: 4px;
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
  overflow-wrap: anywhere;
}

.resource-row__id {
  color: var(--md-sys-color-on-surface-variant);
  text-align: center;
}

.resource-row__field {
  text-align: center;
}

.resource-row__field.is-start {
  text-align: start;
}

.resource-row__field.is-end {
  text-align: end;
}

.resource-row__field.is-code code {
  color: var(--md-sys-color-on-surface-variant);
  font: inherit;
}

.resource-row__action {
  display: grid;
  place-items: center;
}

.resource-row__play {
  --md-comp-icon-button-visual-size: 32px;
}
</style>
