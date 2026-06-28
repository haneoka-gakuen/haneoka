<script setup lang="ts">
import { langOf, textOf, type DisplayText } from "~/types/displayText";
import { entityAvatarText } from "~/utils/entityAvatar";

export interface ArchiveEntityItem {
  id: string | number;
  label: DisplayText;
  shortLabel?: DisplayText;
  image?: string;
  color?: string;
}

const props = withDefaults(
  defineProps<{
    items?: ArchiveEntityItem[];
    shape?: "avatar" | "logo";
    showLabel?: boolean;
  }>(),
  {
    items: () => [],
    shape: "avatar",
    showLabel: true,
  },
);

const combinedLabel = computed(() =>
  props.items
    .map((item) => textOf(item.label))
    .filter(Boolean)
    .join(" · "),
);
const labelId = useId();
</script>

<template>
  <span
    class="archive-entities"
    :class="`is-${shape}`"
    :aria-labelledby="items.length && combinedLabel ? labelId : undefined"
  >
    <span v-if="items.length && combinedLabel" :id="labelId" class="sr-only">
      <template v-for="(item, index) in items" :key="item.id">
        <span v-if="index" aria-hidden="true">·</span>
        <DisplayText :value="item.label" />
      </template>
    </span>
    <span
      v-for="item in items"
      :key="item.id"
      class="archive-entities__item"
      :title="textOf(item.label)"
      :lang="langOf(item.label)"
    >
      <span class="archive-entities__visual">
        <EntityAvatar
          :image="item.image"
          :text="entityAvatarText(item.shortLabel || item.label)"
          :lang="langOf(item.shortLabel || item.label)"
          :color="item.color"
          :fit="shape === 'logo' ? 'contain' : 'cover'"
          :shape="shape === 'logo' ? 'rounded' : 'circle'"
          :icon="shape === 'logo' ? 'music_note' : 'person'"
        />
      </span>
    </span>
    <span v-if="items.length && showLabel" class="archive-entities__label" :title="combinedLabel">
      <template v-for="(item, index) in items" :key="item.id">
        <span v-if="index" aria-hidden="true">·</span>
        <DisplayText :value="item.label" />
      </template>
    </span>
    <span v-if="!items.length" class="archive-entities__empty">—</span>
  </span>
</template>

<style scoped>
.archive-entities {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: center;
  gap: 7px;
  overflow: hidden;
  text-align: center;
}

.archive-entities.is-avatar {
  gap: 0;
}

.archive-entities.is-avatar .archive-entities__item + .archive-entities__item {
  margin-left: -7px;
}

.archive-entities.is-avatar .archive-entities__label {
  margin-left: 7px;
}

.archive-entities__item {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
}

.archive-entities__visual {
  display: grid;
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  place-items: center;
  overflow: hidden;
  border-radius: 50%;
  background: rgb(226 233 247 / 0.82);
  --entity-avatar-font-size: 8px;
}

.archive-entities.is-logo .archive-entities__visual {
  width: 34px;
  height: 24px;
  flex-basis: 34px;
  border-radius: 0;
  background: transparent;
  --entity-avatar-font-size: 8px;
}

.archive-entities__label,
.archive-entities__empty {
  overflow: hidden;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.64rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
