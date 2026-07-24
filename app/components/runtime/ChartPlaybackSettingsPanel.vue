<script setup lang="ts">
import { MaterialIcon, UiIconButton, UiRange, UiRuntimeSurface, UiSwitch } from "@haneoka/ui";

import type { ChartStageBackground } from "~/composables/useChartPlayerSettings";
import { liveStageBackgroundForRelease } from "~/composables/useReleaseServer";
import type { OurNotesReleaseOrigin } from "~/features/catalog/contentSource";

type PlaybackMode = "chart" | "watch" | "play";

const props = withDefaults(
  defineProps<{
    mode: PlaybackMode;
    /** Exact release that owns the stage-preview artwork. */
    runtimeRelease: OurNotesReleaseOrigin;
    audioControls?: boolean;
  }>(),
  { audioControls: true },
);

const open = defineModel<boolean>({ default: false });
const { t } = useLocale();
const {
  volume,
  rate,
  mirror,
  combo,
  fever,
  bpm,
  zoom,
  vertical,
  noteSize,
  longAlpha,
  noteSpeed,
  effects,
  noteSound,
  noteSoundVolume,
  quality,
  background,
} = toRefs(useChartPlayerSettings().value);

const stageBackgroundUrl = (value: ChartStageBackground) =>
  liveStageBackgroundForRelease(props.runtimeRelease.releaseId, value);
const backgrounds = computed(() => [
  { value: "mygo" as const, label: "MyGO!!!!!", image: stageBackgroundUrl("mygo"), imageFit: "cover" as const },
  {
    value: "mujica" as const,
    label: "Ave Mujica",
    image: stageBackgroundUrl("mujica"),
    imageFit: "cover" as const,
  },
]);
</script>

<template>
  <Transition name="chart-settings">
    <UiRuntimeSurface
      v-if="open"
      class="chart-settings"
      as="aside"
      variant="panel"
      :label="t('settings')"
      @keydown.esc.stop.prevent="open = false"
    >
      <header>
        <strong>{{ t("settings") }}</strong>
        <UiIconButton :label="t('close')" size="compact" tone="runtime" @click="open = false">
          <MaterialIcon name="close" :size="18" />
        </UiIconButton>
      </header>
      <div class="chart-inspector">
        <template v-if="mode === 'chart'">
          <div class="chart-inspector__toggles">
            <UiSwitch v-model="mirror" tone="runtime" :label="t('mirror')" />
            <UiSwitch v-model="combo" tone="runtime" :label="t('combo')" />
            <UiSwitch v-model="fever" tone="runtime" :label="t('fever')" />
            <UiSwitch v-model="bpm" tone="runtime" :label="t('metaBpm')" />
          </div>
          <div class="chart-control-row">
            <span>{{ t("zoom") }}</span>
            <UiRange v-model="zoom" :label="t('zoom')" tone="runtime" :min="0.5" :max="3" :step="0.1" />
            <output class="display-number">{{ zoom.toFixed(1) }}</output>
          </div>
          <div class="chart-control-row">
            <span>{{ t("vertical") }}</span>
            <UiRange v-model="vertical" :label="t('vertical')" tone="runtime" :min="0.5" :max="2" :step="0.1" />
            <output class="display-number">{{ vertical.toFixed(1) }}</output>
          </div>
        </template>

        <template v-else>
          <SegmentedControl v-model="background" :options="backgrounds" :label="t('stage')" icon-only />
          <div class="chart-inspector__toggles">
            <UiSwitch v-model="mirror" tone="runtime" :label="t('mirror')" />
            <UiSwitch v-model="effects" tone="runtime" :label="audioControls ? t('soundEffects') : t('effects')" />
            <UiSwitch v-if="audioControls" v-model="noteSound" tone="runtime" :label="t('noteSound')" />
          </div>
          <div class="chart-control-row">
            <span>{{ t("speed") }}</span>
            <UiRange v-model="noteSpeed" :label="t('speed')" tone="runtime" :min="1" :max="14" :step="0.1" />
            <output class="display-number">{{ noteSpeed.toFixed(1) }}</output>
          </div>
          <template v-if="audioControls">
            <div class="chart-control-row">
              <span>{{ t("rate") }}</span>
              <UiRange v-model="rate" :label="t('rate')" tone="runtime" :min="0.5" :max="2" :step="0.25" />
              <output class="display-number">{{ rate.toFixed(2) }}</output>
            </div>
            <div class="chart-control-row">
              <span>
                <MaterialIcon name="volume_up" :size="15" />
                {{ t("volume") }}
              </span>
              <UiRange v-model="volume" :label="t('volume')" tone="runtime" :min="0" :max="1" :step="0.05" />
              <output class="display-number">{{ Math.round(volume * 100) }}</output>
            </div>
            <div class="chart-control-row">
              <span>{{ t("noteSound") }}</span>
              <UiRange
                v-model="noteSoundVolume"
                :label="t('noteSound')"
                tone="runtime"
                :min="0"
                :max="1"
                :step="0.05"
              />
              <output class="display-number">{{ Math.round(noteSoundVolume * 100) }}</output>
            </div>
          </template>
        </template>

        <div class="chart-control-row">
          <span>{{ t("size") }}</span>
          <UiRange v-model="noteSize" :label="t('size')" tone="runtime" :min="0.5" :max="2" :step="0.05" />
          <output class="display-number">{{ noteSize.toFixed(2) }}</output>
        </div>
        <div class="chart-control-row">
          <span>{{ t("longNotes") }}</span>
          <UiRange v-model="longAlpha" :label="t('longNotes')" tone="runtime" :min="0.1" :max="1" :step="0.05" />
          <output class="display-number">{{ Math.round(longAlpha * 100) }}</output>
        </div>
        <div class="chart-control-row">
          <span>
            <MaterialIcon name="speed" :size="15" />
            {{ t("quality") }}
          </span>
          <UiRange v-model="quality" :label="t('quality')" tone="runtime" :min="0.5" :max="2" :step="0.25" />
          <output class="display-number">{{ quality.toFixed(2) }}</output>
        </div>
      </div>
    </UiRuntimeSurface>
  </Transition>
</template>

<style scoped>
.chart-settings {
  position: absolute;
  z-index: var(--md-sys-z-index-overlay-sheet);
  right: max(var(--md-sys-spacing-2), var(--chart-runtime-safe-right, 0px));
  bottom: calc(
    max(var(--md-sys-spacing-2), var(--chart-runtime-safe-bottom, 0px)) + var(--md-comp-runtime-toolbar-height)
  );
  display: grid;
  width: min(330px, calc(100% - 16px));
  max-height: min(480px, calc(100% - 70px));
  grid-template-rows: auto minmax(0, 1fr);
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-2);
  overflow: hidden;
  color: var(--md-comp-runtime-on-surface-variant);
  border-radius: var(--md-sys-shape-corner-small);
}

.chart-settings header {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--md-sys-spacing-2);
}

.chart-settings header strong {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  font-family: var(--md-sys-typescale-title-small-font);
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: var(--md-sys-typescale-title-small-weight);
  line-height: var(--md-sys-typescale-title-small-line-height);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chart-settings-enter-active,
.chart-settings-leave-active {
  transition:
    opacity var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-emphasized-decelerate),
    transform var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-emphasized-decelerate);
}

.chart-settings-enter-from,
.chart-settings-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}

.chart-inspector {
  display: flex;
  width: 100%;
  min-height: 0;
  flex-direction: column;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-1);
  overflow: auto;
  overscroll-behavior: contain;
}

.chart-inspector > :deep(.md3-segments:not(.is-icon-only)) {
  width: 100%;
}

.chart-inspector > :deep(.md3-segments:not(.is-icon-only) .md3-segments__option) {
  --md-outlined-segmented-button-container-height: var(--md-comp-control-height);
}

.chart-inspector > :deep(.md3-segments.is-icon-only .md3-segments__option) {
  --md-outlined-segmented-button-outline-color: var(--md-comp-runtime-outline);
  --md-outlined-segmented-button-selected-container-color: var(--md-comp-runtime-primary-container);
  --md-outlined-segmented-button-selected-icon-color: var(--md-sys-color-on-primary-container);
  --md-outlined-segmented-button-unselected-icon-color: var(--md-sys-color-on-surface-variant);
}

.chart-inspector__toggles {
  display: grid;
  gap: var(--md-sys-spacing-1);
}

.chart-inspector__toggles :deep(.md3-switch-field) {
  min-height: var(--md-comp-control-height);
  padding-inline: var(--md-sys-spacing-2);
  border-radius: var(--md-sys-shape-corner-extra-small);
  background: var(--md-comp-runtime-surface);
}

.chart-control-row {
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr) 42px;
  align-items: center;
  gap: var(--md-sys-spacing-2);
  color: var(--md-comp-runtime-on-surface-variant);
  font-size: var(--md-sys-typescale-label-medium-size);
}

.chart-control-row > span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.chart-control-row :deep(.md3-range) {
  min-width: 0;
}

.chart-control-row output {
  color: var(--md-comp-runtime-on-surface-variant);
  font-size: var(--md-sys-typescale-label-small-size);
  text-align: right;
}

@media (max-width: 560px), (max-width: 959px) and (max-height: 500px), (hover: none) and (pointer: coarse) {
  .chart-settings {
    right: max(var(--md-sys-spacing-1), var(--chart-runtime-safe-right, 0px));
    bottom: calc(
      max(var(--md-sys-spacing-1), var(--chart-runtime-safe-bottom, 0px)) + var(--md-comp-runtime-toolbar-height-touch)
    );
    width: min(320px, calc(100% - var(--md-sys-spacing-2)));
  }
}
</style>
