<script setup lang="ts">
import { defineAsyncComponent } from "vue";

import { MaterialIcon, UiIconButton, UiRange, UiRuntimeSurface, UiSwitch } from "@haneoka/ui";
import {
  AUTO_PLAY_INTERVAL_SECONDS,
  autoPlayIntervalSeconds,
  useStoryPlayerControls,
} from "@haneoka/vega/vue/controls";
import type { StoryProjectPlugin } from "@haneoka/altair";
import type { AdvStory, StoryUiSprites } from "@haneoka/vega";
import { StoryPlayerText } from "@haneoka/vega/vue/text";
import { createHaneokaReleaseResourceScope, resolveHaneokaChatIconSprites } from "@haneoka/vega-plugin-haneoka";
import type { HaneokaThemeHost, HaneokaThemeHostSnapshot } from "@haneoka/vega-theme-haneoka";
import LoadingState from "~/components/ui/LoadingState.vue";
import { createHaneokaStoryPlugins, createHaneokaStoryTextRichTextBridge } from "~/features/story/haneokaStoryRenderer";
import { isAcceptedExternalResourceUrl } from "~/features/resources/sourcePolicies";

type StoryRuntimeMode = "text" | "play";

const StoryPlayer = defineAsyncComponent({
  loader: () => import("@haneoka/vega/vue/player").then((module) => module.StoryPlayer),
  loadingComponent: LoadingState,
  delay: 0,
});

const props = withDefaults(
  defineProps<{
    story: AdvStory;
    uiSprites?: StoryUiSprites;
    plugins?: readonly StoryProjectPlugin[];
    releaseServer?: string;
    showModeControl?: boolean;
    showRotationControls?: boolean;
  }>(),
  { releaseServer: undefined, showModeControl: true, showRotationControls: true },
);
const mode = defineModel<StoryRuntimeMode>("mode", { default: "play" });
const rotation = defineModel<number>("rotation", { default: 0 });

const { pause } = useAudioPlayer();
const { releaseServer: selectedReleaseServer } = useReleaseServer();
const { t } = useLocale();
const root = useTemplateRef<HTMLElement>("root");
const textPlayer = ref<{ pause(): void; play(): void }>();
const player = ref<{
  progress: {
    visible: boolean;
    label: string;
    ratio: number;
    seeking: boolean;
    videoVisible: boolean;
    canStart: boolean;
    canReplay: boolean;
    playing: boolean;
  };
  resize(): void;
  startOrAdvance(): void;
  seekProgress(ratio: number, delay?: number): void;
  skipCurrentVideo(): void;
}>();
const controlsOpen = ref(false);
const loop = ref(false);
const controls = useStoryPlayerControls();
const {
  volume,
  volumeBgm,
  enableBgm,
  autoPlay,
  autoPlayInterval,
  instantText,
  textSize,
  subtitlesEnabled,
  setVolume,
  setVolumeBgm,
  setEnableBgm,
  setAutoPlay,
  setAutoPlayInterval,
  setInstantText,
  setTextSize,
  setSubtitlesEnabled,
} = controls;
const playerSettings = useStoryPlayerSettings();
const { active: fullscreen, fallback: fallbackFullscreen, toggle: toggleFullscreen } = useImmersiveFullscreen(root);
setVolume(playerSettings.value.volume);
setVolumeBgm(playerSettings.value.volumeBgm);
setEnableBgm(playerSettings.value.bgmEnabled ? 0 : 1);
setAutoPlayInterval(Math.round(playerSettings.value.autoPlayDelaySeconds * 2));
setInstantText(playerSettings.value.instantText ? 0 : 1);
setTextSize(playerSettings.value.textSize);
setSubtitlesEnabled(playerSettings.value.subtitlesEnabled);
setAutoPlay(1);
const resolvedReleaseServer = computed(() =>
  normalizeReleaseServer(props.releaseServer || selectedReleaseServer.value),
);
const storyResourceScope = computed(() =>
  createHaneokaReleaseResourceScope({
    releaseId: resolvedReleaseServer.value,
    acceptsExternal: isAcceptedExternalResourceUrl,
  }),
);
const resolveStorySourceAsset = (path: string): string => {
  const canonicalPath = String(path || "").replace(/^\/+/u, "");
  const segments = canonicalPath.split("/");
  if (
    !/^(?:Assets|Packages)\//u.test(canonicalPath) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new TypeError(`Invalid Haneoka story source-asset path: ${path}`);
  }
  const encodedPath = segments.map(encodeURIComponent).join("/");
  return releaseResourceUrl(
    `${assetRootForRelease(resolvedReleaseServer.value)}/${encodedPath}`,
    resolvedReleaseServer.value,
  );
};
const haneokaThemeAssets = computed(() => ({
  chatIcons: resolveHaneokaChatIconSprites(resolveStorySourceAsset),
}));
const autoAdvance = computed(() => autoPlay.value === 0);
const autoPlayDelaySeconds = computed(() => autoPlayIntervalSeconds(autoPlayInterval.value));
const maximumAutoPlayDelaySeconds = AUTO_PLAY_INTERVAL_SECONDS[AUTO_PLAY_INTERVAL_SECONDS.length - 1];
const progress = computed(() =>
  player.value?.progress
    ? player.value.progress
    : {
        visible: false,
        label: "",
        ratio: 0,
        seeking: false,
        videoVisible: false,
        canStart: false,
        canReplay: false,
        playing: false,
      },
);
const progressLabels = computed(() => {
  const match = /^\s*(.*?)\s*\/\s*(.*?)\s*$/.exec(progress.value.label);
  return match
    ? { current: match[1]?.trim() || "", duration: match[2]?.trim() || "" }
    : { current: "", duration: progress.value.label.trim() };
});
const autoAdvanceDisabled = computed(
  () => mode.value === "play" && !progress.value.visible && !progress.value.canStart && !progress.value.canReplay,
);
let resizeFrame = 0;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
const resizePlayer = () => {
  cancelAnimationFrame(resizeFrame);
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeFrame = requestAnimationFrame(() => player.value?.resize());
  resizeTimer = setTimeout(() => player.value?.resize(), 300);
};

watch(mode, async () => {
  setAutoPlay(1);
  textPlayer.value?.pause();
  controlsOpen.value = false;
  await nextTick();
  if (mode.value === "play") resizePlayer();
});
watch(rotation, async () => {
  await nextTick();
  resizePlayer();
});
watch(
  () => [loop.value, progress.value.canReplay] as const,
  ([shouldLoop, canReplay]) => {
    if (mode.value === "play" && shouldLoop && canReplay) player.value?.startOrAdvance();
  },
);
watch(
  [volume, volumeBgm, enableBgm, autoPlayInterval, instantText, textSize, subtitlesEnabled],
  () => {
    playerSettings.value = {
      volume: volume.value,
      volumeBgm: volumeBgm.value,
      bgmEnabled: enableBgm.value === 0,
      autoPlayDelaySeconds: autoPlayDelaySeconds.value,
      instantText: instantText.value === 0,
      textSize: textSize.value,
      subtitlesEnabled: subtitlesEnabled.value,
    };
  },
  { immediate: true },
);

onMounted(pause);
onBeforeUnmount(() => {
  cancelAnimationFrame(resizeFrame);
  if (resizeTimer) clearTimeout(resizeTimer);
});

const setAutoPlayDelaySeconds = (value: number) => setAutoPlayInterval(Math.round(value * 2));
const toggleAutoAdvance = () => {
  if (autoAdvanceDisabled.value) return;
  if (mode.value === "text") {
    if (autoAdvance.value) {
      setAutoPlay(1);
      textPlayer.value?.pause();
    } else {
      setAutoPlay(0);
      textPlayer.value?.play();
    }
    return;
  }
  if (mode.value === "play" && (progress.value.canStart || progress.value.canReplay)) {
    setAutoPlay(0);
    player.value?.startOrAdvance();
    return;
  }
  setAutoPlay(autoAdvance.value ? 1 : 0);
};
const rotateLeft = () => {
  rotation.value -= 90;
};
const rotateRight = () => {
  rotation.value += 90;
};
const seekProgress = (value: number, delay = 0): boolean => {
  if (mode.value !== "play" || !progress.value.visible || !player.value) return false;
  player.value.seekProgress(value, delay);
  return true;
};

const haneokaThemeSnapshot = (): HaneokaThemeHostSnapshot => ({
  autoAdvance: autoAdvance.value,
  autoAdvanceDisabled: autoAdvanceDisabled.value,
  instantText: instantText.value === 0,
  subtitlesEnabled: subtitlesEnabled.value,
  videoVisible: progress.value.videoVisible,
  fullscreen: fullscreen.value,
  bgmEnabled: enableBgm.value === 0,
  volume: volume.value,
  bgmVolume: volumeBgm.value,
  autoPlayDelaySeconds: autoPlayDelaySeconds.value,
  maximumAutoPlayDelaySeconds,
  textSize: textSize.value,
  progress: progress.value.ratio,
  progressEnabled: progress.value.visible,
  progressLabel: progress.value.label,
});

const haneokaThemeHost: HaneokaThemeHost = {
  externalPlaybackControls: true,
  labels: {
    playback: t("playback"),
    play: t("play"),
    pause: t("pause"),
    settings: t("settings"),
    close: t("close"),
    seek: t("seek"),
    bgm: t("bgm"),
    instantText: t("instantText"),
    subtitles: t("subtitles"),
    volume: t("volume"),
    bgmVolume: `${t("bgm")} ${t("volume")}`,
    autoplay: t("autoplay"),
    textSize: t("textSize"),
    storyText: t("storyText"),
    fullscreen: t("fullscreen"),
  },
  assets: () => haneokaThemeAssets.value,
  resolveSourceAsset: resolveStorySourceAsset,
  snapshot: haneokaThemeSnapshot,
  subscribe(listener) {
    listener(haneokaThemeSnapshot());
    return watch(
      [
        autoAdvance,
        autoAdvanceDisabled,
        instantText,
        subtitlesEnabled,
        progress,
        fullscreen,
        enableBgm,
        volume,
        volumeBgm,
        autoPlayDelaySeconds,
        textSize,
      ],
      () => listener(haneokaThemeSnapshot()),
    );
  },
  toggleAutoAdvance,
  setInstantText: (value) => setInstantText(value ? 0 : 1),
  setSubtitlesEnabled,
  setBgmEnabled: (value) => setEnableBgm(value ? 0 : 1),
  setVolume,
  setBgmVolume: setVolumeBgm,
  setAutoPlayDelaySeconds,
  setTextSize,
  seekProgress: (value) => {
    seekProgress(value);
  },
  skipCurrentVideo: () => player.value?.skipCurrentVideo(),
  toggleFullscreen,
  ...(props.showRotationControls ? { rotateLeft, rotateRight } : {}),
  ...(props.showModeControl
    ? {
        openTextView: () => {
          mode.value = "text";
        },
      }
    : {}),
};
const storyPlugins = createHaneokaStoryPlugins(props.plugins, {
  inputScope: () => root.value ?? undefined,
  themeHost: haneokaThemeHost,
});
const textRichTextBridge = createHaneokaStoryTextRichTextBridge(props.plugins);
onBeforeUnmount(() => textRichTextBridge?.dispose());

defineExpose({ seekProgress });
</script>

<template>
  <Teleport to="body" :disabled="!fallbackFullscreen">
    <div
      ref="root"
      class="story-runtime"
      :class="`is-${mode}`"
      :role="fullscreen ? 'dialog' : undefined"
      :aria-modal="fullscreen ? 'true' : undefined"
      :aria-label="t('story')"
      tabindex="-1"
    >
      <RotatableViewport v-model:rotation="rotation" :controls="false">
        <div class="story-runtime__orientation">
          <StoryPlayerText
            v-if="mode === 'text'"
            ref="textPlayer"
            class="story-runtime__text"
            :story="story"
            :volume="volume"
            :auto-play="autoPlay"
            :auto-play-interval="autoPlayInterval"
            :text-size="textSize"
            :resource-scope="storyResourceScope"
            :rich-text-renderer="textRichTextBridge?.renderer"
          />
          <StoryPlayer
            v-else
            ref="player"
            :story="story"
            :ui-sprites="uiSprites"
            :resource-scope="storyResourceScope"
            :controls="controls"
            :show-progress="false"
            :show-start="false"
            :official-plugins="storyPlugins"
            render-backend="vega-three-webgl2"
          />
          <ChartPlaybackDock
            v-if="mode === 'play'"
            mode="watch"
            :playing="autoAdvance"
            :ready="!autoAdvanceDisabled"
            :current-time="progress.ratio"
            :duration="1"
            :start-label="progressLabels.current"
            :end-label="progressLabels.duration"
            :loop="loop"
            :settings-open="controlsOpen"
            :fullscreen-active="fullscreen"
            :show-mode-control="false"
            show-loop
            :show-rotate="showRotationControls"
            show-settings
            show-fullscreen
            @toggle-play="toggleAutoAdvance"
            @preview-seek="seekProgress"
            @seek="seekProgress"
            @update:loop="loop = $event"
            @rotate="rotation += $event"
            @toggle-settings="controlsOpen = !controlsOpen"
            @fullscreen="toggleFullscreen"
          />

          <UiRuntimeSurface
            v-if="mode === 'text' && showModeControl"
            class="story-runtime__text-utility"
            variant="dock"
            :label="t('view')"
            @click.stop
          >
            <UiIconButton tone="runtime" :label="t('play')" @click="mode = 'play'">
              <MaterialIcon name="movie" :size="16" />
            </UiIconButton>
            <UiIconButton tone="runtime" :label="t('settings')" @click="controlsOpen = true">
              <MaterialIcon name="tune" :size="16" />
            </UiIconButton>
          </UiRuntimeSurface>

          <UiRuntimeSurface
            v-if="controlsOpen"
            as="aside"
            variant="panel"
            class="story-runtime__settings"
            :label="t('settings')"
            @keydown.esc.stop.prevent="controlsOpen = false"
          >
            <header>
              <strong>{{ t("settings") }}</strong>
              <UiIconButton tone="runtime" size="compact" :label="t('close')" @click="controlsOpen = false">
                <MaterialIcon name="close" :size="16" />
              </UiIconButton>
            </header>
            <div
              v-if="showModeControl"
              class="story-runtime__mode md3-runtime-control-group"
              role="group"
              :aria-label="t('view')"
            >
              <UiIconButton tone="runtime" :label="t('storyText')" :pressed="mode === 'text'" @click="mode = 'text'">
                <MaterialIcon name="chat" :size="16" />
              </UiIconButton>
              <UiIconButton tone="runtime" :label="t('play')" :pressed="false" @click="mode = 'play'">
                <MaterialIcon name="movie" :size="16" />
              </UiIconButton>
            </div>
            <UiSwitch
              class="story-runtime__setting-toggle"
              tone="runtime"
              :label="t('instantText')"
              :model-value="instantText === 0"
              @update:model-value="setInstantText($event ? 0 : 1)"
            />
            <UiSwitch
              class="story-runtime__setting-toggle"
              tone="runtime"
              :label="t('subtitles')"
              :model-value="subtitlesEnabled"
              @update:model-value="setSubtitlesEnabled"
            />
            <UiSwitch
              class="story-runtime__setting-toggle"
              tone="runtime"
              :label="t('bgm')"
              :model-value="enableBgm === 0"
              @update:model-value="setEnableBgm($event ? 0 : 1)"
            />
            <UiRange
              class="story-runtime__range"
              tone="runtime"
              :label="t('volume')"
              :model-value="volume"
              :value-label="String(Math.round(volume * 100))"
              :step="0.05"
              @update:model-value="setVolume"
            >
              <template #icon>
                <MaterialIcon name="volume_off" v-if="volume === 0" :size="17" />
                <MaterialIcon name="volume_up" v-else :size="17" />
              </template>
            </UiRange>
            <UiRange
              class="story-runtime__range"
              tone="runtime"
              :label="`${t('bgm')} ${t('volume')}`"
              :model-value="volumeBgm"
              :value-label="String(Math.round(volumeBgm * 100))"
              :step="0.05"
              :disabled="enableBgm !== 0"
              @update:model-value="setVolumeBgm"
            >
              <template #icon>
                <MaterialIcon name="music_off" v-if="enableBgm !== 0 || volumeBgm === 0" :size="17" />
                <MaterialIcon name="music_note" v-else :size="17" />
              </template>
            </UiRange>
            <UiRange
              class="story-runtime__range"
              tone="runtime"
              :label="t('autoplay')"
              :model-value="autoPlayDelaySeconds"
              :max="maximumAutoPlayDelaySeconds"
              :step="0.5"
              :value-label="`${autoPlayDelaySeconds.toFixed(1)}s`"
              @update:model-value="setAutoPlayDelaySeconds"
            >
              <template #icon><MaterialIcon name="timer" :size="17" /></template>
            </UiRange>
            <UiRange
              class="story-runtime__range"
              tone="runtime"
              :label="t('textSize')"
              :model-value="textSize"
              :min="0.5"
              :max="2"
              :step="0.1"
              :value-label="textSize.toFixed(1)"
              @update:model-value="setTextSize"
            >
              <template #icon><MaterialIcon name="text_fields" :size="17" /></template>
            </UiRange>
          </UiRuntimeSurface>
        </div>
      </RotatableViewport>
    </div>
  </Teleport>
</template>

<style scoped>
.story-runtime {
  color-scheme: light;

  --md-sys-color-primary: #31356e;
  --md-sys-color-on-primary: #ffffff;
  --md-sys-color-primary-container: #e5e6f3;
  --md-sys-color-on-primary-container: #242750;
  --md-sys-color-secondary: #2e6974;
  --md-sys-color-on-secondary: #ffffff;
  --md-sys-color-secondary-container: #d9eff2;
  --md-sys-color-on-secondary-container: #173f46;
  --md-sys-color-surface: #f6f8f9;
  --md-sys-color-on-surface: #202428;
  --md-sys-color-on-surface-variant: #555d63;
  --md-sys-color-surface-container-lowest: #ffffff;
  --md-sys-color-surface-container-low: #f1f4f5;
  --md-sys-color-surface-container: #eceff1;
  --md-sys-color-surface-container-high: #e6eaec;
  --md-sys-color-surface-container-highest: #dce2e5;
  --md-sys-color-outline: #687177;
  --md-sys-color-outline-variant: #c7ced2;
  --md-comp-runtime-surface: #e6eaec;
  --md-comp-runtime-surface-high: #dce2e5;
  --md-comp-runtime-outline: #c7ced2;
  --md-comp-runtime-primary: #31356e;
  --md-comp-runtime-primary-strong: #31356e;
  --md-comp-runtime-primary-container: #e5e6f3;
  --md-comp-runtime-on-surface: #202428;
  --md-comp-runtime-on-surface-variant: #555d63;
  --md-comp-runtime-slider-track: #dce2e5;
  --md-comp-runtime-slider-fill: #31356e;
  --md-comp-runtime-slider-thumb: #31356e;
  --story-runtime-safe-bottom: 0px;
  --story-runtime-safe-left: 0px;
  --story-runtime-safe-right: 0px;

  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--md-comp-runtime-scene-surface-deep);
  container-type: size;
  isolation: isolate;
}

.story-runtime:fullscreen,
.story-runtime.is-app-fullscreen {
  width: var(--app-viewport-width, 100vw);
  height: var(--app-viewport-height, 100dvh);
  max-width: none;
  max-height: none;
  background: var(--md-comp-runtime-scene-surface-deep);
}

.story-runtime:fullscreen > :deep(.rotatable-viewport),
.story-runtime.is-app-fullscreen > :deep(.rotatable-viewport) {
  position: absolute;
  inset: var(--md-sys-safe-area-inset-top) var(--md-sys-safe-area-inset-right) var(--md-sys-safe-area-inset-bottom)
    var(--md-sys-safe-area-inset-left);
  width: auto;
  height: auto;
}

.story-runtime__orientation {
  --runtime-dock-reserve: 0px;

  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--md-comp-runtime-scene-surface-deep);
  isolation: isolate;
}

.story-runtime.is-play .story-runtime__orientation {
  --runtime-dock-reserve: calc(var(--md-comp-runtime-toolbar-height) + var(--story-runtime-safe-bottom));
}

.story-runtime__text-utility {
  position: absolute;
  z-index: var(--md-sys-z-index-overlay-drawer);
  top: var(--md-sys-spacing-2);
  right: var(--md-sys-spacing-2);
  display: flex;
  gap: var(--md-sys-spacing-1);
  padding: var(--md-sys-spacing-1);
}

.story-runtime__mode {
  min-width: max-content;
}

.story-runtime__progress {
  width: 100%;
  min-width: 0;
}

.story-runtime__settings {
  position: absolute;
  z-index: var(--md-sys-z-index-overlay-raised-backdrop);
  top: max(var(--md-sys-spacing-2), var(--md-sys-safe-area-inset-top));
  right: max(var(--md-sys-spacing-2), var(--story-runtime-safe-right));
  display: grid;
  width: min(300px, calc(100% - 16px));
  max-height: calc(100% - 16px);
  gap: var(--md-sys-spacing-1);
  padding: var(--md-sys-spacing-2);
  overflow: auto;
}

.story-runtime.is-play .story-runtime__settings {
  top: auto;
  bottom: calc(max(var(--md-sys-spacing-2), var(--story-runtime-safe-bottom)) + var(--md-comp-runtime-toolbar-height));
  max-height: min(480px, calc(100% - var(--md-comp-runtime-toolbar-height) - 24px));
}

.story-runtime__settings header {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px 3px 7px;
}

.story-runtime__settings header strong {
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

.story-runtime__setting-toggle {
  width: 100%;
  padding-inline: 12px;
  border-radius: var(--md-sys-shape-corner-full);
  background: color-mix(in srgb, var(--md-comp-runtime-on-surface) 5%, transparent);
}

.story-runtime__range {
  padding: 4px 8px;
  border-radius: var(--md-sys-shape-corner-small);
  background: color-mix(in srgb, var(--md-comp-runtime-on-surface) 5%, transparent);
}

.story-runtime :deep(.adv-story-player-root) {
  position: relative;
  display: grid;
  width: 100%;
  height: calc(100% - var(--runtime-dock-reserve));
  min-height: 0;
  place-items: center;
  gap: 0;
  overflow: hidden;
  container-type: size;
}

.story-runtime :deep(.adv-story-player-root:fullscreen) {
  width: 100vw;
  height: 100dvh;
  padding: 8px;
  overflow: auto;
  background: var(--md-comp-runtime-scene-surface);
}

.story-runtime :deep(.adv-story-player-root:fullscreen .adv-story-browser),
.story-runtime :deep(.adv-story-player-root:fullscreen .adv-player-progress) {
  width: 100% !important;
}

.story-runtime :deep(.adv-story-browser),
.story-runtime :deep(.adv-player-progress) {
  width: 100% !important;
  max-width: none;
  border-radius: 0;
}

.story-runtime :deep(.adv-story-browser) {
  height: 100%;
  aspect-ratio: auto;
}

.story-runtime :deep(.adv-text-player) {
  width: 100%;
  height: calc(100% - var(--runtime-dock-reserve));
  min-height: 0;
  padding: clamp(16px, 3vw, 36px);
  overflow: auto;
  color: var(--md-sys-color-on-surface);
  background: var(--md-sys-color-surface);
  scrollbar-color: var(--md-sys-color-outline-variant) transparent;
}

.story-runtime :deep(.adv-text-player__stream) {
  position: relative;
  display: block;
  width: min(760px, 100%);
  margin-inline: auto;
}

.story-runtime :deep(.adv-text-player__window) {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  display: grid;
  min-width: 0;
  gap: var(--md-sys-spacing-1);
  will-change: transform;
}

.story-runtime :deep(.adv-text-player__snippet) {
  min-width: 0;
}

.story-runtime :deep(.adv-text-player__entry) {
  display: block;
  min-width: 0;
  padding: 12px 14px 13px;
  color: inherit;
  border: 1px solid transparent;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-low);
  transition:
    border-color var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-emphasized-decelerate),
    background var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-emphasized-decelerate),
    transform var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-emphasized-decelerate);
}

.story-runtime :deep(.adv-text-player__entry.is-interactive) {
  cursor: pointer;
}

.story-runtime :deep(.adv-text-player__entry.is-interactive:hover),
.story-runtime :deep(.adv-text-player__entry.is-interactive:focus-visible),
.story-runtime :deep(.adv-text-player__entry.is-playing) {
  border-color: var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-secondary-container);
}

.story-runtime :deep(.adv-text-player__entry.is-interactive:active) {
  transform: translateY(1px);
}

.story-runtime :deep(.adv-text-player__speaker) {
  display: flex;
  min-height: 28px;
  align-items: center;
  gap: 8px;
  margin-bottom: 7px;
}

.story-runtime :deep(.adv-text-player__avatars) {
  display: inline-flex;
  flex: none;
  align-items: center;
  isolation: isolate;
}

.story-runtime :deep(.adv-text-player__avatar) {
  position: relative;
  display: grid;
  width: 28px;
  height: 28px;
  box-sizing: border-box;
  flex: 0 0 28px;
  place-items: center;
  overflow: hidden;
  color: var(--md-sys-color-on-surface-variant);
  border: 2px solid var(--md-sys-color-surface-container-low);
  border-radius: 50%;
  background: var(--md-sys-color-surface-container-highest);
}

.story-runtime :deep(.adv-text-player__avatar + .adv-text-player__avatar) {
  margin-left: -8px;
}

.story-runtime :deep(.adv-text-player__avatar img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.story-runtime :deep(.adv-text-player__speaker-name) {
  min-width: 0;
  overflow: hidden;
  color: var(--md-sys-color-primary);
  font-family: var(--md-sys-typescale-label-medium-font);
  font-size: var(--md-sys-typescale-label-medium-size);
  font-weight: var(--md-sys-typescale-label-medium-weight);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.story-runtime :deep(.adv-text-player__dialogue) {
  display: grid;
  min-width: 0;
  grid-template-columns: 22px minmax(0, 1fr);
  align-items: start;
  gap: 8px;
}

.story-runtime :deep(.adv-text-player__playback) {
  display: grid;
  height: 1.5em;
  place-items: center;
  color: var(--md-sys-color-primary);
  font-size: 0.78rem;
}

.story-runtime :deep(.adv-text-player__body) {
  min-width: 0;
  margin: 0;
  font-size: clamp(0.78em, 1.6cqw, 0.92em);
  line-height: 1.72;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.story-runtime :deep(.adv-text-player__body ruby) {
  ruby-position: over;
}

.story-runtime :deep(.adv-text-player__body rt) {
  font-size: 0.46em;
  font-weight: 700;
  line-height: 1;
}

.story-runtime :deep(.adv-text-player__location) {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-block: 8px 2px;
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  letter-spacing: 0;
}

.story-runtime :deep(.adv-text-player__location::before),
.story-runtime :deep(.adv-text-player__location::after) {
  height: 1px;
  flex: 1;
  content: "";
  background: var(--md-sys-color-outline-variant);
}

.story-runtime :deep(.adv-text-player__empty) {
  display: grid;
  min-height: 100%;
  place-items: center;
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-body-small-size);
}

@media (max-width: 560px), (max-width: 959px) and (max-height: 500px), (hover: none) and (pointer: coarse) {
  .story-runtime.is-play .story-runtime__orientation {
    --runtime-dock-reserve: calc(var(--md-comp-runtime-toolbar-height-touch) + var(--story-runtime-safe-bottom));
  }

  .story-runtime__progress {
    min-width: 36px;
  }

  .story-runtime__settings {
    right: max(var(--md-sys-spacing-1), var(--story-runtime-safe-right));
    top: max(var(--md-sys-spacing-1), var(--md-sys-safe-area-inset-top));
    width: min(300px, calc(100% - 10px));
  }

  .story-runtime.is-play .story-runtime__settings {
    top: auto;
    bottom: calc(
      max(var(--md-sys-spacing-1), var(--story-runtime-safe-bottom)) + var(--md-comp-runtime-toolbar-height-touch)
    );
    max-height: calc(100% - var(--md-comp-runtime-toolbar-height-touch) - 10px);
  }

  .story-runtime :deep(.adv-text-player) {
    padding: 10px;
  }

  .story-runtime :deep(.adv-text-player__entry) {
    padding: 10px;
  }

  .story-runtime :deep(.adv-text-player__speaker) {
    gap: 6px;
  }

  .story-runtime :deep(.adv-text-player__avatar) {
    width: 24px;
    height: 24px;
    flex-basis: 24px;
  }

  .story-runtime :deep(.adv-text-player__avatar + .adv-text-player__avatar) {
    margin-left: -7px;
  }

  .story-runtime :deep(.adv-text-player__dialogue) {
    grid-template-columns: 18px minmax(0, 1fr) auto;
    gap: 6px;
  }
}
</style>
