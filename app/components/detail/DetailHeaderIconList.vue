<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

import type { DetailHeaderIconItem } from "~/components/detail/types";
import { textOf } from "~/types/displayText";

const props = defineProps<{
  items: readonly DetailHeaderIconItem[];
}>();
const failedImages = reactive(new Set<string>());
const visibleItems = computed(() =>
  props.items.flatMap((item) => {
    const candidates = item.imageCandidates?.length ? item.imageCandidates : [item.image];
    const image = candidates.find((candidate) => candidate?.trim() && !failedImages.has(candidate));
    return image || item.text || item.icon ? [{ ...item, image, imageCandidates: undefined }] : [];
  }),
);
watch(
  () => props.items,
  () => failedImages.clear(),
);
</script>

<template>
  <span class="detail-header-icons">
    <span
      v-for="item in visibleItems"
      :key="item.id"
      class="detail-header-icons__item"
      :class="`is-${item.shape || (item.image ? 'avatar' : 'icon')}`"
      :style="{ color: item.color }"
      :aria-label="textOf(item.label)"
      :title="textOf(item.label)"
      role="img"
    >
      <EntityAvatar
        v-if="item.shape === 'avatar'"
        :image="item.image"
        :text="item.text"
        :lang="item.lang"
        :color="item.color"
        fit="cover"
        :icon="item.icon || 'person'"
        @image-error="item.image && failedImages.add(item.image)"
      />
      <img
        v-else-if="item.image"
        :src="item.image"
        alt=""
        aria-hidden="true"
        decoding="async"
        @error="failedImages.add(item.image)"
      />
      <MaterialIcon v-else-if="item.icon" :name="item.icon" :size="20" aria-hidden="true" />
    </span>
  </span>
</template>

<style scoped>
.detail-header-icons {
  display: flex;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  gap: var(--md-sys-spacing-1);
  overflow: hidden;
}

.detail-header-icons__item {
  display: inline-grid;
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  place-items: center;
  overflow: hidden;
  color: var(--md-sys-color-on-surface-variant);
}

.detail-header-icons__item.is-avatar {
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container-high);
}

.detail-header-icons__item.is-avatar + .detail-header-icons__item.is-avatar {
  margin-left: calc(-1 * var(--md-sys-spacing-2));
  box-shadow: 0 0 0 2px var(--md-sys-color-surface-container-low);
}

.detail-header-icons__item.is-logo {
  width: 36px;
  flex-basis: 36px;
}

.detail-header-icons__item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.detail-header-icons__item.is-logo img {
  object-fit: contain;
}
</style>
