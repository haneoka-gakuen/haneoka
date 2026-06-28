<script setup lang="ts">
import { UiIconButton, UiRuntimeSurface, UiTimeline, MaterialIcon } from "@haneoka/ui";

type PlaybackMode = "chart" | "watch" | "play";

const props = withDefaults(
  defineProps<{
    mode: PlaybackMode;
    playing: boolean;
    ready: boolean;
    currentTime: number;
    duration: number;
    loop?: boolean;
    settingsOpen?: boolean;
    showLoop?: boolean;
    showRotate?: boolean;
    showSettings?: boolean;
    showFullscreen?: boolean;
    fullscreenActive?: boolean;
    showModeControl?: boolean;
    compact?: boolean;
  }>(),
  {
    loop: false,
    settingsOpen: false,
    showLoop: false,
    showRotate: false,
    showSettings: false,
    showFullscreen: false,
    fullscreenActive: false,
    showModeControl: true,
    compact: false,
  },
);

const emit = defineEmits<{
  "update:mode": [mode: PlaybackMode];
  "toggle-play": [];
  "preview-seek": [seconds: number];
  seek: [seconds: number];
  "scrub-start": [];
  "scrub-end": [];
  "update:loop": [loop: boolean];
  rotate: [delta: -90 | 90];
  "toggle-settings": [];
  fullscreen: [];
}>();

const { t } = useLocale();
const modes = computed(() => [
  { value: "chart" as const, label: t("chart"), icon: "bar_chart" },
  { value: "watch" as const, label: t("watch"), icon: "visibility" },
  { value: "play" as const, label: t("play"), icon: "sports_esports" },
]);
const duration = computed(() => Math.max(0, Number.isFinite(props.duration) ? props.duration : 0));
const currentTime = computed(() =>
  Math.min(duration.value, Math.max(0, Number.isFinite(props.currentTime) ? props.currentTime : 0)),
);
const format = (value: number) => formatDuration(value);
const fullscreenLabel = computed(() =>
  props.fullscreenActive ? `${t("close")}: ${t("fullscreen")}` : t("fullscreen"),
);
</script>

<template>
  <UiRuntimeSurface class="chart-playback-dock" variant="dock" :compact="compact" :label="t('playback')" @click.stop>
    <div
      v-if="showModeControl"
      class="chart-playback-dock__mode md3-runtime-control-group"
      role="group"
      :aria-label="t('section')"
    >
      <UiIconButton
        v-for="option in modes"
        :key="option.value"
        tone="runtime"
        :label="option.label"
        :pressed="mode === option.value"
        @click="emit('update:mode', option.value)"
      >
        <MaterialIcon :name="option.icon" :size="16" :filled="mode === option.value" />
      </UiIconButton>
    </div>

    <UiIconButton
      tone="runtime"
      emphasis
      :disabled="mode === 'chart' || !ready"
      :label="playing ? t('pause') : t('play')"
      @click="emit('toggle-play')"
    >
      <MaterialIcon name="pause" v-if="playing" :size="17" />
      <MaterialIcon name="play_arrow" v-else :size="17" />
    </UiIconButton>
    <UiTimeline
      class="chart-playback-dock__progress"
      tone="runtime"
      :label="t('seek')"
      :model-value="mode === 'chart' ? 0 : currentTime"
      :max="duration"
      :step="0.01"
      :disabled="mode === 'chart' || !ready"
      :start-label="mode === 'chart' ? '' : format(currentTime)"
      :end-label="mode === 'chart' ? '' : format(duration)"
      @preview="emit('preview-seek', $event)"
      @commit="emit('seek', $event)"
      @scrub-start="emit('scrub-start')"
      @scrub-end="emit('scrub-end')"
    />

    <UiIconButton
      v-if="showLoop"
      tone="runtime"
      :disabled="mode === 'chart'"
      :label="t('loop')"
      :pressed="loop"
      @click="emit('update:loop', !loop)"
    >
      <MaterialIcon name="refresh" :size="17" />
    </UiIconButton>
    <template v-if="showRotate">
      <UiIconButton tone="runtime" label="-90°" @click="emit('rotate', -90)">
        <MaterialIcon name="rotate_left" :size="17" />
      </UiIconButton>
      <UiIconButton tone="runtime" label="+90°" @click="emit('rotate', 90)">
        <MaterialIcon name="rotate_right" :size="17" />
      </UiIconButton>
    </template>
    <UiIconButton
      v-if="showSettings"
      tone="runtime"
      :label="t('settings')"
      :pressed="settingsOpen"
      :aria-expanded="settingsOpen"
      @click="emit('toggle-settings')"
    >
      <MaterialIcon name="tune" :size="17" />
    </UiIconButton>
    <UiIconButton
      v-if="showFullscreen"
      tone="runtime"
      :label="fullscreenLabel"
      :pressed="fullscreenActive"
      @click="emit('fullscreen')"
    >
      <MaterialIcon :name="fullscreenActive ? 'fullscreen_exit' : 'fullscreen'" :size="17" />
    </UiIconButton>
  </UiRuntimeSurface>
</template>

<style scoped>
.chart-playback-dock {
  position: absolute;
  z-index: var(--md-sys-z-index-overlay-drawer);
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  box-sizing: border-box;
  width: 100%;
  min-height: calc(var(--md-comp-runtime-toolbar-height) + var(--chart-runtime-safe-bottom, 0px));
  align-items: center;
  gap: var(--md-comp-runtime-toolbar-gap);
  padding: var(--md-comp-runtime-toolbar-padding) max(var(--md-sys-spacing-2), var(--chart-runtime-safe-right, 0px))
    calc(var(--md-comp-runtime-toolbar-padding) + var(--chart-runtime-safe-bottom, 0px))
    max(var(--md-sys-spacing-2), var(--chart-runtime-safe-left, 0px));
}

.chart-playback-dock__mode {
  min-width: max-content;
}

.chart-playback-dock__progress {
  min-width: 64px;
  flex: 1 1 auto;
  margin-inline: 2px;
}

.chart-playback-dock.is-compact {
  min-height: calc(var(--md-comp-runtime-toolbar-height) + var(--chart-runtime-safe-bottom, 0px));
}

.chart-playback-dock.is-compact .chart-playback-dock__progress {
  min-width: 36px;
}

.chart-playback-dock.is-compact .chart-playback-dock__progress :deep(.md3-timeline__label) {
  display: none;
}

@container (max-width: 280px) {
  .chart-playback-dock.is-compact {
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }

  .chart-playback-dock.is-compact::-webkit-scrollbar {
    display: none;
  }

  .chart-playback-dock.is-compact :deep(.md3-icon-button--runtime) {
    width: 22px;
    height: 30px;
    min-height: 30px;
  }

  .chart-playback-dock.is-compact .chart-playback-dock__mode {
    padding-right: 1px;
  }

  .chart-playback-dock.is-compact .chart-playback-dock__progress {
    min-width: 14px;
    padding-inline: 2px;
  }
}

@media (max-width: 560px), (max-width: 959px) and (max-height: 500px), (hover: none) and (pointer: coarse) {
  .chart-playback-dock {
    min-height: calc(var(--md-comp-runtime-toolbar-height-touch) + var(--chart-runtime-safe-bottom, 0px));
  }

  .chart-playback-dock:not(.is-compact) :deep(.md3-icon-button--runtime) {
    --md-comp-icon-button-hit-size: var(--md-comp-control-height-touch);
    --md-comp-icon-button-visual-size: var(--md-comp-runtime-control-size-touch);
  }

  .chart-playback-dock__progress :deep(.md3-timeline__label) {
    display: none;
  }

  .chart-playback-dock__progress {
    min-width: 36px;
  }
}
</style>
