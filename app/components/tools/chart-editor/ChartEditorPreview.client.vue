<script setup lang="ts">
import type { OurNotesAssetManifest } from "@haneoka/chart/assets";
import { ChartOverview, type ChartCanvasOverviewPresentation } from "@haneoka/chart/overview";
import type { ChartDocument } from "@haneoka/chart/parser";
import { ChartPlayer, type ChartPlayerExpose } from "@haneoka/chart/player";
import ChartPlaybackDock from "~/components/runtime/ChartPlaybackDock.vue";
import ChartPlaybackSettingsPanel from "~/components/runtime/ChartPlaybackSettingsPanel.vue";
import RotatableViewport from "~/components/runtime/RotatableViewport.vue";
import type { ChartStageBackground } from "~/composables/useChartPlayerSettings";

type PreviewMode = "chart" | "watch" | "play";

const props = withDefaults(
  defineProps<{
    chart: ChartDocument;
    assets: OurNotesAssetManifest;
    playheadSeconds: number;
    playing: boolean;
    audioAvailable: boolean;
    durationSeconds: number;
    bgmOffsetMs?: number;
    presentation?: ChartCanvasOverviewPresentation;
  }>(),
  { bgmOffsetMs: 0 },
);

const emit = defineEmits<{
  "toggle-playback": [];
  seek: [seconds: number];
}>();

const { t } = useLocale();
const { assetServer } = useAssetServer();
const mode = defineModel<PreviewMode>("mode", { default: "watch" });
const root = useTemplateRef<HTMLElement>("root");
const player = ref<ChartPlayerExpose>();
const playerReady = ref(false);
const rotation = ref(0);
const settingsOpen = ref(false);
const scrubPreviewSeconds = ref<number>();
let resumeAfterScrub = false;
const { mirror, combo, fever, bpm, noteSize, longAlpha, noteSpeed, effects, quality, background } = toRefs(
  useChartPlayerSettings().value,
);
const { active: fullscreen, fallback: fallbackFullscreen, toggle: toggleFullscreen } = useImmersiveFullscreen(root);

const stageBackgroundUrl = (value: ChartStageBackground) =>
  `/assets/${encodeURIComponent(assetServer.value)}/Assets/AddressableResources/Band/${value === "mygo" ? 1 : 2}/live_stage/lightweight_background.png`;
const backgroundUrl = computed(() => stageBackgroundUrl(background.value));
const externalTimeMs = computed(() => Math.max(0, props.playheadSeconds * 1000));
const displayedPlayheadSeconds = computed(() => scrubPreviewSeconds.value ?? props.playheadSeconds);
const playerSettings = computed(() => ({
  noteSpeed: noteSpeed.value,
  mirror: mirror.value,
  effects: effects.value,
  noteSize: noteSize.value,
  longAlpha: longAlpha.value,
  guideAlpha: longAlpha.value * 0.7,
  graphicsQuality: quality.value,
  guidelineCount: 6,
  guidelineOpacity: 0.4,
  laneOpacity: 0.8,
  backgroundBrightness: 0.7,
}));

const rotate = (delta: -90 | 90) => {
  rotation.value += delta;
};
const startScrub = () => {
  scrubPreviewSeconds.value = props.playheadSeconds;
  resumeAfterScrub = props.playing;
  if (resumeAfterScrub) emit("toggle-playback");
};
const previewSeek = (seconds: number) => {
  scrubPreviewSeconds.value = seconds;
};
const commitSeek = (seconds: number) => {
  scrubPreviewSeconds.value = seconds;
  emit("seek", seconds);
};
const endScrub = () => {
  const shouldResume = resumeAfterScrub;
  resumeAfterScrub = false;
  scrubPreviewSeconds.value = undefined;
  if (shouldResume && props.audioAvailable && playerReady.value) emit("toggle-playback");
};

watch(mode, (value) => {
  // watch <-> play reuses the initialized ChartPlayer. Entering chart mode
  // unmounts it, so only that transition invalidates readiness.
  if (value === "chart") playerReady.value = false;
});
watch(
  () => props.playing,
  (value) => {
    if (value) settingsOpen.value = false;
  },
);
let rotationResizeTimer: ReturnType<typeof setTimeout> | undefined;
let rotationResizeFrame = 0;
watch(rotation, async () => {
  await nextTick();
  cancelAnimationFrame(rotationResizeFrame);
  rotationResizeFrame = requestAnimationFrame(() => player.value?.resize());
  if (rotationResizeTimer) clearTimeout(rotationResizeTimer);
  rotationResizeTimer = setTimeout(() => player.value?.resize(), 300);
});
onBeforeUnmount(() => {
  cancelAnimationFrame(rotationResizeFrame);
  if (rotationResizeTimer) clearTimeout(rotationResizeTimer);
});
</script>

<template>
  <Teleport to="body" :disabled="!fallbackFullscreen">
    <div
      ref="root"
      class="chart-editor-preview-player"
      :class="{ 'is-game-mode': mode !== 'chart' }"
      :role="fullscreen ? 'dialog' : undefined"
      :aria-modal="fullscreen ? 'true' : undefined"
      :aria-label="t('chart')"
      tabindex="-1"
    >
      <RotatableViewport v-model:rotation="rotation" :controls="false">
        <div class="chart-editor-preview-player__orientation">
          <div v-if="mode === 'chart'" class="chart-editor-preview-player__overview">
            <ChartOverview
              :chart="chart"
              :assets="assets"
              :presentation="presentation"
              :show-combo="combo"
              :mirror="mirror"
              :note-size="noteSize"
              :long-alpha="longAlpha"
              :show-fever="fever"
              :show-bpm="bpm"
              :time-marker-seconds="5"
              :beat-subdivision="1"
              :skill-marker-seconds="8"
              :graphics-quality="quality"
            />
          </div>
          <ChartPlayer
            v-else
            ref="player"
            :chart="chart"
            :assets="assets"
            :mode="mode"
            :external-time-ms="externalTimeMs"
            :external-playing="playing"
            :bgm-offset-ms="bgmOffsetMs"
            :background-url="backgroundUrl"
            :settings="playerSettings"
            :note-sound-enabled="false"
            :aria-label="t(mode)"
            :loading-label="t('loading')"
            @ready="playerReady = true"
            @error="playerReady = false"
          >
            <template #loading><LoadingState /></template>
          </ChartPlayer>
          <ChartPlaybackDock
            :mode="mode"
            :playing="playing"
            :ready="audioAvailable && playerReady"
            :current-time="displayedPlayheadSeconds"
            :duration="durationSeconds"
            :settings-open="settingsOpen"
            :compact="!fullscreen"
            :fullscreen-active="fullscreen"
            :show-mode-control="false"
            show-rotate
            show-settings
            show-fullscreen
            @update:mode="mode = $event"
            @toggle-play="emit('toggle-playback')"
            @preview-seek="previewSeek"
            @seek="commitSeek"
            @scrub-start="startScrub"
            @scrub-end="endScrub"
            @rotate="rotate"
            @toggle-settings="settingsOpen = !settingsOpen"
            @fullscreen="toggleFullscreen"
          />
          <ChartPlaybackSettingsPanel v-model="settingsOpen" :mode="mode" :audio-controls="false" />
        </div>
      </RotatableViewport>
    </div>
  </Teleport>
</template>

<style scoped>
.chart-editor-preview-player {
  --chart-runtime-safe-bottom: 0px;
  --chart-runtime-safe-left: 0px;
  --chart-runtime-safe-right: 0px;
  --chart-stage-surface: var(--md-comp-runtime-scene-surface);
  --chart-player-surface: var(--md-comp-runtime-scene-surface-deep);
  --chart-stage-on-surface: var(--md-sys-color-inverse-on-surface);
  --chart-stage-status-scrim: var(--md-comp-runtime-scene-scrim);

  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  overscroll-behavior: none;
  background: var(--chart-stage-surface);
  isolation: isolate;
}

.chart-editor-preview-player__orientation {
  --runtime-dock-reserve: calc(var(--md-comp-runtime-toolbar-height) + var(--chart-runtime-safe-bottom));

  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  overscroll-behavior: none;
  background: var(--chart-stage-surface);
  container-type: inline-size;
  isolation: isolate;
}

.chart-editor-preview-player__overview {
  width: 100%;
  height: calc(100% - var(--runtime-dock-reserve));
  min-height: 0;
  overflow: hidden;
  background: var(--chart-stage-surface);
}

.chart-editor-preview-player__overview :deep(.our-chart-overview) {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  height: 100%;
  overflow-x: scroll;
  overflow-y: hidden;
  contain: inline-size layout paint;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: none;
  background: var(--chart-stage-surface);
  touch-action: pan-x;
  -webkit-touch-callout: none;
  white-space: nowrap;
}

.chart-editor-preview-player__overview :deep(.our-chart-overview__track) {
  position: relative;
  height: 100%;
  background: var(--chart-stage-surface);
}

.chart-editor-preview-player__overview :deep(.our-chart-overview canvas) {
  position: absolute;
  top: 0;
  display: block;
  max-width: none;
}

.chart-editor-preview-player__overview :deep(.our-chart-overview__marker),
.chart-editor-preview-player__overview :deep(.our-chart-overview__hover-time),
.chart-editor-preview-player__overview :deep(.our-chart-overview__hover-combo) {
  position: absolute;
  z-index: 2;
  color: var(--chart-stage-on-surface);
  pointer-events: none;
  -webkit-user-select: none;
  user-select: none;
}

.chart-editor-preview-player__overview :deep(.our-chart-overview__marker) {
  background: var(--chart-stage-on-surface);
  transform: translateY(-50%);
}

.chart-editor-preview-player__overview :deep(.our-chart-overview__hover-time),
.chart-editor-preview-player__overview :deep(.our-chart-overview__hover-combo) {
  font-family: var(--md-ref-typeface-brand);
  font-weight: 400;
  line-height: 1;
  transform: translateY(-50%);
}

.chart-editor-preview-player__overview :deep(.our-chart-overview__hover-time) {
  text-align: right;
  transform: translate(-100%, -50%);
}

.chart-editor-preview-player__overview :deep(.our-chart-overview__hover-combo) {
  text-align: left;
}

.chart-editor-preview-player :deep(.our-notes-player) {
  position: relative;
  width: 100%;
  height: calc(100% - var(--runtime-dock-reserve));
  min-height: 0;
  overflow: hidden;
  overscroll-behavior: none;
  background: var(--chart-player-surface);
  isolation: isolate;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}

.chart-editor-preview-player:fullscreen,
.chart-editor-preview-player.is-app-fullscreen {
  --chart-runtime-safe-bottom: var(--md-sys-safe-area-inset-bottom);
  --chart-runtime-safe-left: var(--md-sys-safe-area-inset-left);
  --chart-runtime-safe-right: var(--md-sys-safe-area-inset-right);

  width: var(--app-viewport-width, 100vw);
  height: var(--app-viewport-height, 100dvh);
  max-width: none;
  max-height: none;
}

.chart-editor-preview-player.is-game-mode:fullscreen,
.chart-editor-preview-player.is-game-mode.is-app-fullscreen {
  touch-action: none;
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}

.chart-editor-preview-player.is-app-fullscreen {
  position: fixed;
  z-index: var(--md-sys-z-index-overlay-dialog);
  top: var(--app-viewport-offset-top, 0);
  left: var(--app-viewport-offset-left, 0);
  margin: 0;
}

.chart-editor-preview-player:fullscreen > :deep(.rotatable-viewport),
.chart-editor-preview-player.is-app-fullscreen > :deep(.rotatable-viewport) {
  position: absolute;
  inset: var(--md-sys-safe-area-inset-top) 0 0;
  width: auto;
  height: auto;
}

.chart-editor-preview-player :deep(.our-notes-player__stage),
.chart-editor-preview-player :deep(.our-notes-player__canvas),
.chart-editor-preview-player :deep(.our-notes-player__hud) {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.chart-editor-preview-player :deep(.our-notes-player__stage) {
  z-index: -2;
  background: var(--chart-player-surface);
}

.chart-editor-preview-player :deep(.our-notes-player__canvas) {
  z-index: 1;
}

.chart-editor-preview-player :deep(.our-notes-player__hud) {
  z-index: 2;
}

.chart-editor-preview-player :deep(.our-notes-player__pause-hit) {
  display: none;
}

.chart-editor-preview-player :deep(.our-notes-player__status) {
  position: absolute;
  z-index: 4;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--md-sys-spacing-3);
  color: var(--chart-stage-on-surface);
  background: var(--chart-stage-status-scrim);
  font: var(--md-sys-typescale-body-medium-weight) var(--md-sys-typescale-body-medium-size) /
    var(--md-sys-typescale-body-medium-line-height) var(--md-sys-typescale-body-medium-font);
}

.chart-editor-preview-player :deep(.our-notes-player__status.is-error) {
  padding: var(--md-sys-spacing-6);
  color: var(--md-comp-runtime-scene-on-error);
  text-align: center;
}

@media (max-width: 560px), (max-width: 959px) and (max-height: 500px), (hover: none) and (pointer: coarse) {
  .chart-editor-preview-player__orientation {
    --runtime-dock-reserve: calc(var(--md-comp-runtime-toolbar-height-touch) + var(--chart-runtime-safe-bottom));
  }
}
</style>
