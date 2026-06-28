<script setup lang="ts">
import { UiCircularProgress, UiLinearProgress } from "@haneoka/ui";

type LoadingVariant = "block" | "fill" | "overlay" | "inline";
type LoadingSize = "xs" | "sm" | "md";

const props = withDefaults(
  defineProps<{
    label?: string;
    variant?: LoadingVariant;
    size?: LoadingSize;
    progress?: number | null;
    max?: number;
    showLabel?: boolean;
    showProgress?: boolean;
    showMark?: boolean;
  }>(),
  {
    label: undefined,
    variant: "block",
    size: "md",
    progress: null,
    max: 100,
    showLabel: true,
    showProgress: true,
    showMark: true,
  },
);

const { t } = useLocale();
const displayLabel = computed(() => props.label?.trim() || t("loading"));
const progressMax = computed(() => (Number.isFinite(props.max) && props.max > 0 ? props.max : 100));
const determinate = computed(() => typeof props.progress === "number" && Number.isFinite(props.progress));
const progressValue = computed(() =>
  determinate.value ? Math.min(progressMax.value, Math.max(0, props.progress as number)) : undefined,
);
</script>

<template>
  <component
    :is="variant === 'inline' ? 'span' : 'div'"
    class="loading-state"
    :class="[`loading-state--${variant}`, `loading-state--${size}`]"
    role="status"
    aria-live="polite"
    aria-busy="true"
  >
    <span class="loading-state__announcement">{{ displayLabel }}</span>

    <UiCircularProgress
      v-if="showMark"
      class="loading-state__mark"
      :label="displayLabel"
      :indeterminate="!determinate"
      :value="progressValue || 0"
      :max="progressMax"
    />

    <span v-if="showLabel" class="loading-state__label" aria-hidden="true">{{ displayLabel }}</span>

    <UiLinearProgress
      v-if="showProgress"
      class="loading-state__progress"
      :label="displayLabel"
      :indeterminate="!determinate"
      :value="progressValue || 0"
      :max="progressMax"
    />
  </component>
</template>

<style scoped>
.loading-state {
  --loading-mark-size: 40px;
  --loading-track-width: min(168px, 54vw);
  --loading-label-size: var(--md-sys-typescale-label-medium-size);
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: var(--md-sys-spacing-2);
  color: var(--md-sys-color-on-surface-variant);
  isolation: isolate;
}

.loading-state--block {
  min-height: 160px;
}

.loading-state--fill {
  width: 100%;
  height: 100%;
  min-height: 88px;
}

.loading-state--overlay {
  position: absolute;
  z-index: 5;
  inset: 0;
  min-height: 72px;
  background: color-mix(in srgb, var(--md-sys-color-surface-container-low) 80%, transparent);
}

.loading-state--inline {
  --loading-track-width: 64px;
  display: inline-flex;
  min-height: 0;
  flex-direction: row;
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-1);
  vertical-align: middle;
}

.loading-state--xs {
  --loading-mark-size: 16px;
  --loading-label-size: var(--md-sys-typescale-label-small-size);
  --loading-track-width: 54px;
}

.loading-state--sm {
  --loading-mark-size: 28px;
  --loading-label-size: var(--md-sys-typescale-label-small-size);
  --loading-track-width: min(122px, 45vw);
}

.loading-state__announcement {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.loading-state__mark {
  --md-comp-progress-size: var(--loading-mark-size);

  display: inline-flex;
  width: var(--loading-mark-size);
  height: var(--loading-mark-size);
  flex: 0 0 var(--loading-mark-size);
}

.loading-state__label {
  max-width: min(260px, 72vw);
  overflow: hidden;
  font-family: var(--md-sys-typescale-label-medium-font);
  font-size: var(--loading-label-size);
  font-weight: var(--md-sys-typescale-label-medium-weight);
  line-height: var(--md-sys-typescale-label-medium-line-height);
  letter-spacing: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.loading-state__progress {
  width: var(--loading-track-width);
  flex: 0 0 auto;
}
</style>
