<script setup lang="ts">
import { defineAsyncComponent } from "vue";
import { ChartOverview } from "@haneoka/chart/overview";
import type { ChartDocument } from "@haneoka/chart/parser";
import type { ChartPlayerExpose } from "@haneoka/chart/player";
import ChartPlaybackDock from "~/components/runtime/ChartPlaybackDock.vue";
import ChartPlaybackSettingsPanel from "~/components/runtime/ChartPlaybackSettingsPanel.vue";
import LoadingState from "~/components/ui/LoadingState.vue";
import RotatableViewport from "~/components/runtime/RotatableViewport.vue";
import type { ChartStageBackground } from "~/composables/useChartPlayerSettings";

type RuntimeMode = "chart" | "watch" | "play";

const ChartPlayer = defineAsyncComponent({
  loader: () => import("@haneoka/chart/player").then((module) => module.ChartPlayer),
  loadingComponent: LoadingState,
  delay: 0,
});

const props = withDefaults(
  defineProps<{
    chart: ChartDocument;
    audioUrl?: string;
    bgmOffsetMs?: number;
    scoreRanks?: number[];
    rotation?: number;
  }>(),
  { audioUrl: "", bgmOffsetMs: 0, scoreRanks: () => [], rotation: 0 },
);
const mode = defineModel<RuntimeMode>("mode", { default: "chart" });

const emit = defineEmits<{
  "update:rotation": [rotation: number];
}>();

const { assetServer } = useAssetServer();
const { t } = useLocale();
const { assets, error: assetsError, refresh: refreshAssets } = useOurNotesRuntimeAssets();

const viewport = useTemplateRef<HTMLElement>("viewport");
const player = ref<ChartPlayerExpose>();
const settingsOpen = ref(false);
const ready = ref(false);
const playing = ref(false);
const currentTime = ref(0);
const duration = ref(Math.max(0, props.chart.durationMs + props.bgmOffsetMs) / 1000);
const {
  volume,
  rate,
  loop,
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
const { active: fullscreen, fallback: fallbackFullscreen, toggle: toggleFullscreen } = useImmersiveFullscreen(viewport);

const { pause: pauseGlobalAudio } = useAudioPlayer();
onMounted(pauseGlobalAudio);

const stageBackgroundUrl = (value: ChartStageBackground) =>
  `/assets/${encodeURIComponent(assetServer.value)}/Assets/AddressableResources/Band/${value === "mygo" ? 1 : 2}/live_stage/lightweight_background.png`;
const backgroundUrl = computed(() => stageBackgroundUrl(background.value));
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
  scoreRankScores: props.scoreRanks,
}));

const togglePlay = async () => {
  if (!ready.value) return;
  if (playing.value) player.value?.pause();
  else await player.value?.play();
};

const seek = (value: number) => {
  currentTime.value = value;
  player.value?.seek(value);
};

let resumeAfterScrub = false;
const startScrub = () => {
  resumeAfterScrub = playing.value;
  if (resumeAfterScrub) player.value?.pause();
};
const previewSeek = (value: number) => {
  currentTime.value = value;
};
const endScrub = async () => {
  const shouldResume = resumeAfterScrub;
  resumeAfterScrub = false;
  if (shouldResume && ready.value) await player.value?.play();
};

const rotate = (delta: -90 | 90) => emit("update:rotation", props.rotation + delta);

watch(mode, (next, previous) => {
  if (next === "chart" || previous === "chart") ready.value = false;
  playing.value = false;
  currentTime.value = 0;
});

watch(playing, (value) => {
  if (value) settingsOpen.value = false;
});

watch(
  [() => props.chart, () => props.audioUrl, () => props.bgmOffsetMs],
  () => {
    playing.value = false;
    currentTime.value = 0;
    duration.value = Math.max(0, props.chart.durationMs + props.bgmOffsetMs) / 1000;
  },
  { deep: false },
);

let rotationResizeTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => props.rotation,
  async () => {
    await nextTick();
    requestAnimationFrame(() => player.value?.resize());
    if (rotationResizeTimer) clearTimeout(rotationResizeTimer);
    rotationResizeTimer = setTimeout(() => player.value?.resize(), 300);
  },
);
onBeforeUnmount(() => {
  if (rotationResizeTimer) clearTimeout(rotationResizeTimer);
});
</script>

<template>
  <Teleport to="body" :disabled="!fallbackFullscreen">
    <div
      ref="viewport"
      class="chart-workbench"
      :class="{ 'is-game-mode': mode !== 'chart' }"
      :role="fullscreen ? 'dialog' : undefined"
      :aria-modal="fullscreen ? 'true' : undefined"
      :aria-label="t('chart')"
      tabindex="-1"
    >
      <RotatableViewport :rotation="fullscreen ? rotation : 0" :controls="false">
        <section class="chart-stage" :class="`chart-stage--${mode}`">
          <ErrorState v-if="assetsError" @retry="refreshAssets()" />
          <LoadingState v-else-if="!assets" />
          <template v-else>
            <div v-if="mode === 'chart'" class="chart-stage__overview">
              <ChartOverview
                :chart="chart"
                :assets="assets"
                :scale="zoom"
                :vertical-scale="vertical"
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

            <div v-else class="chart-stage__player">
              <ChartPlayer
                ref="player"
                :chart="chart"
                :assets="assets"
                :audio-url="audioUrl"
                :bgm-offset-ms="bgmOffsetMs"
                :background-url="backgroundUrl"
                :mode="mode"
                :settings="playerSettings"
                :volume="volume"
                :rate="rate"
                :loop="loop"
                :note-sound-enabled="noteSound"
                :note-sound-volume="noteSoundVolume"
                :aria-label="t('chart')"
                :pause-label="t('pause')"
                :loading-label="t('loading')"
                @playing="playing = $event"
                @ready="ready = true"
                @timeupdate="currentTime = $event"
                @duration="duration = $event || Math.max(0, chart.durationMs + bgmOffsetMs) / 1000"
                @error="ready = false"
              >
                <template #loading><LoadingState /></template>
              </ChartPlayer>
            </div>

            <ChartPlaybackDock
              :mode="mode"
              :playing="playing"
              :ready="ready"
              :current-time="currentTime"
              :duration="duration"
              :loop="loop"
              :settings-open="settingsOpen"
              :fullscreen-active="fullscreen"
              :show-mode-control="false"
              show-loop
              show-rotate
              show-settings
              show-fullscreen
              @update:mode="mode = $event"
              @toggle-play="togglePlay"
              @preview-seek="previewSeek"
              @seek="seek"
              @scrub-start="startScrub"
              @scrub-end="endScrub"
              @update:loop="loop = $event"
              @rotate="rotate"
              @toggle-settings="settingsOpen = !settingsOpen"
              @fullscreen="toggleFullscreen"
            />
            <ChartPlaybackSettingsPanel v-model="settingsOpen" :mode="mode" />
          </template>
        </section>
      </RotatableViewport>
    </div>
  </Teleport>
</template>

<style scoped>
.chart-workbench {
  --chart-runtime-safe-bottom: 0px;
  --chart-runtime-safe-left: 0px;
  --chart-runtime-safe-right: 0px;
  --chart-stage-surface: var(--md-comp-runtime-scene-surface);
  --chart-player-surface: var(--md-comp-runtime-scene-surface-deep);
  --chart-stage-on-surface: var(--md-sys-color-inverse-on-surface);
  --chart-stage-status-scrim: var(--md-comp-runtime-scene-scrim);

  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  overscroll-behavior: none;
  background: var(--chart-stage-surface);
  isolation: isolate;
}

.chart-stage {
  --runtime-dock-reserve: calc(var(--md-comp-runtime-toolbar-height) + var(--chart-runtime-safe-bottom));

  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  overscroll-behavior: none;
  background: var(--chart-stage-surface);
  isolation: isolate;
}

.chart-stage__overview,
.chart-stage__player {
  width: 100%;
  height: calc(100% - var(--runtime-dock-reserve));
  min-height: 0;
  overflow: hidden;
  background: var(--chart-player-surface);
}

.chart-stage__overview :deep(.our-chart-overview) {
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
  background: var(--chart-player-surface);
  white-space: nowrap;
}

.chart-stage__overview :deep(.our-chart-overview__track) {
  position: relative;
  height: 100%;
  background: var(--chart-stage-surface);
}

.chart-stage__overview :deep(.our-chart-overview canvas) {
  position: absolute;
  top: 0;
  display: block;
  max-width: none;
}

.chart-stage__overview :deep(.our-chart-overview__marker),
.chart-stage__overview :deep(.our-chart-overview__hover-time),
.chart-stage__overview :deep(.our-chart-overview__hover-combo) {
  position: absolute;
  z-index: 2;
  color: var(--chart-stage-on-surface);
  pointer-events: none;
  user-select: none;
}

.chart-stage__overview :deep(.our-chart-overview__marker) {
  background: var(--chart-stage-on-surface);
  transform: translateY(-50%);
}

.chart-stage__overview :deep(.our-chart-overview__hover-time),
.chart-stage__overview :deep(.our-chart-overview__hover-combo) {
  font-family: var(--md-ref-typeface-brand);
  font-weight: 400;
  line-height: 1;
  transform: translateY(-50%);
}

.chart-stage__overview :deep(.our-chart-overview__hover-time) {
  text-align: right;
  transform: translate(-100%, -50%);
}

.chart-stage__overview :deep(.our-chart-overview__hover-combo) {
  text-align: left;
}

.chart-stage__player {
  min-height: 0;
  overflow: hidden;
  overscroll-behavior: none;
  background: var(--chart-stage-surface);
  touch-action: none;
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}

.chart-stage__player :deep(.our-notes-player) {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  overscroll-behavior: none;
  background: var(--chart-stage-surface);
  isolation: isolate;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}

.chart-stage__player :deep(.our-notes-player__stage),
.chart-stage__player :deep(.our-notes-player__canvas),
.chart-stage__player :deep(.our-notes-player__hud) {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.chart-stage__player :deep(.our-notes-player__stage) {
  z-index: -2;
  background: var(--chart-player-surface);
}

.chart-stage__player :deep(.our-notes-player__canvas) {
  z-index: 1;
}

.chart-stage__player :deep(.our-notes-player__hud) {
  z-index: 2;
}

.chart-stage__player :deep(.our-notes-player__pause-hit) {
  position: absolute;
  z-index: 3;
  top: 1.75%;
  right: 1%;
  width: 4.2%;
  min-width: var(--md-comp-control-height-touch);
  aspect-ratio: 1;
  padding: 0;
  border: 0;
  border-radius: 50%;
  opacity: 0;
  cursor: pointer;
}

.chart-stage__player :deep(.our-notes-player__status) {
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

.chart-stage__player :deep(.our-notes-player__status.is-error) {
  padding: var(--md-sys-spacing-6);
  color: var(--md-comp-runtime-scene-on-error);
  text-align: center;
}

.chart-workbench:fullscreen,
.chart-workbench.is-app-fullscreen {
  --chart-runtime-safe-bottom: var(--md-sys-safe-area-inset-bottom);
  --chart-runtime-safe-left: var(--md-sys-safe-area-inset-left);
  --chart-runtime-safe-right: var(--md-sys-safe-area-inset-right);

  width: var(--app-viewport-width, 100vw);
  height: var(--app-viewport-height, 100dvh);
  max-width: none;
  max-height: none;
  border-radius: 0;
  background: var(--chart-stage-surface);
}

.chart-workbench.is-game-mode:fullscreen,
.chart-workbench.is-game-mode.is-app-fullscreen {
  touch-action: none;
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}

.chart-workbench.is-app-fullscreen {
  position: fixed;
  z-index: var(--md-sys-z-index-overlay-dialog);
  top: var(--app-viewport-offset-top, 0);
  left: var(--app-viewport-offset-left, 0);
  margin: 0;
}

.chart-workbench:fullscreen > :deep(.rotatable-viewport),
.chart-workbench.is-app-fullscreen > :deep(.rotatable-viewport) {
  position: absolute;
  inset: var(--md-sys-safe-area-inset-top) 0 0;
  width: auto;
  height: auto;
}

.chart-workbench:fullscreen .chart-stage__overview,
.chart-workbench:fullscreen .chart-stage__player,
.chart-workbench.is-app-fullscreen .chart-stage__overview,
.chart-workbench.is-app-fullscreen .chart-stage__player {
  box-sizing: border-box;
  height: calc(100% - var(--runtime-dock-reserve));
  padding-inline: var(--chart-runtime-safe-left) var(--chart-runtime-safe-right);
}

.chart-workbench:fullscreen .chart-stage__player,
.chart-workbench.is-app-fullscreen .chart-stage__player {
  display: grid;
  overflow: hidden;
  place-items: center;
}

.chart-workbench:fullscreen .chart-stage__player :deep(.our-notes-player),
.chart-workbench.is-app-fullscreen .chart-stage__player :deep(.our-notes-player) {
  width: 100%;
  height: 100%;
}

@media (max-width: 560px), (max-width: 959px) and (max-height: 500px), (hover: none) and (pointer: coarse) {
  .chart-stage {
    --runtime-dock-reserve: calc(var(--md-comp-runtime-toolbar-height-touch) + var(--chart-runtime-safe-bottom));
  }
}
</style>
