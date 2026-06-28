<script setup lang="ts">
import { MaterialIcon, UiIconButton } from "@haneoka/ui";

import type { DetailMediaItem } from "~/components/detail/types";
import { langOf, textOf } from "~/types/displayText";

const props = defineProps<{
  modelValue: string;
  items: DetailMediaItem[];
  compact?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const { t } = useLocale();
const activeItem = computed(() => props.items.find((item) => item.id === props.modelValue) || props.items[0]);
const activeIndex = computed(() => {
  const index = props.items.findIndex((item) => item.id === activeItem.value?.id);
  return Math.max(0, index);
});

const selectRelative = (offset: number) => {
  if (props.items.length < 2) return;
  const index = (activeIndex.value + offset + props.items.length) % props.items.length;
  const item = props.items[index];
  if (item) emit("update:modelValue", item.id);
};

watchEffect(() => {
  if (props.items.length && !props.items.some((item) => item.id === props.modelValue)) {
    emit("update:modelValue", props.items[0]!.id);
  }
});
</script>

<template>
  <div class="detail-media-stage" :class="{ 'is-compact': compact }">
    <MediaFrame
      v-if="activeItem"
      :key="activeItem.id"
      class="detail-media-stage__art"
      :src="activeItem.src"
      :alt="textOf(activeItem.label)"
      :lang="langOf(activeItem.label)"
      :ratio="activeItem.ratio || 'square'"
      :fit="activeItem.fit || 'contain'"
      loading="eager"
    />

    <slot name="overlay" />

    <div v-if="items.length > 1" class="detail-media-stage__navigation" role="group" :aria-label="t('view')">
      <UiIconButton
        class="detail-media-stage__arrow is-previous"
        emphasis
        touch-target
        :label="t('previous')"
        @click="selectRelative(-1)"
      >
        <MaterialIcon name="chevron_left" :size="24" aria-hidden="true" />
      </UiIconButton>
      <UiIconButton
        class="detail-media-stage__arrow is-next"
        emphasis
        touch-target
        :label="t('next')"
        @click="selectRelative(1)"
      >
        <MaterialIcon name="chevron_right" :size="24" aria-hidden="true" />
      </UiIconButton>
    </div>
  </div>
</template>

<style scoped>
.detail-media-stage {
  position: relative;
  display: grid;
  width: 100%;
  height: 100%;
  min-height: 0;
  place-items: center;
}

.detail-media-stage__art {
  max-width: min(100%, 520px);
  max-height: 100%;
  animation: detail-media-enter var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard-decelerate);
}

.detail-media-stage__art.media-frame--support,
.detail-media-stage__art.media-frame--comic,
.detail-media-stage__art.media-frame--square {
  max-width: min(100%, 860px);
}

.detail-media-stage.is-compact .detail-media-stage__art {
  max-width: 100%;
  max-height: calc(100% - 4px);
}

.detail-media-stage__navigation {
  position: absolute;
  z-index: 4;
  inset: 50% 0 auto;
  display: flex;
  justify-content: space-between;
  padding-inline: var(--md-sys-spacing-2);
  pointer-events: none;
  transform: translateY(-50%);
}

.detail-media-stage__arrow {
  pointer-events: auto;
  --md-filled-tonal-icon-button-container-color: color-mix(
    in srgb,
    var(--md-sys-color-surface-container-high) 92%,
    transparent
  );
  --md-filled-tonal-icon-button-icon-color: var(--md-sys-color-on-surface);
  --md-filled-tonal-icon-button-hover-icon-color: var(--md-comp-detail-accent);
  --md-filled-tonal-icon-button-focus-icon-color: var(--md-comp-detail-accent);
}

@keyframes detail-media-enter {
  from {
    opacity: 0.55;
    transform: translateY(4px) scale(0.992);
  }
}

@media (max-width: 860px) {
  .detail-media-stage__art {
    max-width: min(94vw, 480px);
    max-height: 100%;
  }

  .detail-media-stage__art.media-frame--support,
  .detail-media-stage__art.media-frame--comic,
  .detail-media-stage__art.media-frame--square {
    max-width: min(94vw, 760px);
  }

  .detail-media-stage__navigation {
    top: 50%;
    padding-inline: var(--md-sys-spacing-1);
  }

  .detail-media-stage.is-compact .detail-media-stage__art,
  .detail-media-stage.is-compact .detail-media-stage__art.media-frame--support,
  .detail-media-stage.is-compact .detail-media-stage__art.media-frame--comic,
  .detail-media-stage.is-compact .detail-media-stage__art.media-frame--square {
    max-width: 100%;
    max-height: calc(100% - 4px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .detail-media-stage__art {
    animation: none;
  }
}
</style>
