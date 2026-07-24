<script setup lang="ts">
import { defineAsyncComponent } from "vue";

import { MaterialIcon, UiIconButton, UiRange, UiRuntimeSurface, UiSwitch, UiTimeline } from "@haneoka/ui";
import {
  AUTO_PLAY_INTERVAL_SECONDS,
  autoPlayIntervalSeconds,
  useStoryPlayerControls,
} from "@haneoka/story/vue/controls";
import type { AdvStory, StoryUiSprites } from "@haneoka/story";
import { StoryPlayerText } from "@haneoka/story/vue/text";
import LoadingState from "~/components/ui/LoadingState.vue";

type StoryRuntimeMode = "text" | "play";

const StoryPlayer = defineAsyncComponent({
  loader: () => import("@haneoka/story/vue/player").then((module) => module.StoryPlayer),
  loadingComponent: LoadingState,
  delay: 0,
});

const props = withDefaults(
  defineProps<{
    story: AdvStory;
    uiSprites?: StoryUiSprites;
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
const autoAdvanceDisabled = computed(
  () => mode.value === "play" && !progress.value.visible && !progress.value.canStart && !progress.value.canReplay,
);
const autoAdvanceLabel = computed(() => {
  if (autoAdvanceDisabled.value) return t("play");
  if (mode.value === "play" && progress.value.canReplay) return t("replay");
  if (mode.value === "play" && progress.value.canStart) return t("play");
  return autoAdvance.value ? t("pause") : t("play");
});

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
            :release-server="resolvedReleaseServer"
          />
          <StoryPlayer
            v-else-if="uiSprites"
            ref="player"
            :story="story"
            :ui-sprites="uiSprites"
            :release-server="resolvedReleaseServer"
            :controls="controls"
            :show-progress="false"
            :show-start="false"
          />
          <LoadingState v-else />

          <UiRuntimeSurface
            v-if="controlsOpen"
            as="aside"
            variant="panel"
            class="story-runtime__settings"
            :label="t('settings')"
          >
            <header>
              <strong>{{ t("settings") }}</strong>
              <UiIconButton tone="runtime" size="compact" :label="t('close')" @click="controlsOpen = false">
                <MaterialIcon name="close" :size="16" />
              </UiIconButton>
            </header>
            <UiSwitch
              v-if="mode === 'play'"
              class="story-runtime__setting-toggle"
              tone="runtime"
              :label="t('bgm')"
              :model-value="enableBgm === 0"
              @update:model-value="setEnableBgm($event ? 0 : 1)"
            />
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
              v-if="mode === 'play'"
              class="story-runtime__range"
              tone="runtime"
              :label="`${t('bgm')} ${t('volume')}`"
              :model-value="volumeBgm"
              :value-label="String(Math.round(volumeBgm * 100))"
              :step="0.05"
              @update:model-value="setVolumeBgm"
            >
              <template #icon><MaterialIcon name="music_note" :size="17" /></template>
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

          <UiRuntimeSurface class="story-runtime__dock" variant="dock" :label="t('playback')" @click.stop>
            <div
              v-if="showModeControl"
              class="story-runtime__mode md3-runtime-control-group"
              role="group"
              :aria-label="t('view')"
            >
              <UiIconButton tone="runtime" :label="t('storyText')" :pressed="mode === 'text'" @click="mode = 'text'">
                <MaterialIcon name="chat" :size="16" />
              </UiIconButton>
              <UiIconButton tone="runtime" :label="t('play')" :pressed="mode === 'play'" @click="mode = 'play'">
                <MaterialIcon name="movie" :size="16" />
              </UiIconButton>
            </div>

            <UiIconButton
              tone="runtime"
              emphasis
              class="story-runtime__autoplay"
              :disabled="autoAdvanceDisabled"
              :label="autoAdvanceLabel"
              @click="toggleAutoAdvance"
            >
              <MaterialIcon name="refresh" v-if="mode === 'play' && progress.canReplay" :size="17" />
              <MaterialIcon
                name="play_arrow"
                v-else-if="autoAdvanceDisabled || !autoAdvance || (mode === 'play' && progress.canStart)"
                :size="17"
              />
              <MaterialIcon name="pause" v-else :size="17" />
            </UiIconButton>
            <UiIconButton
              v-if="progress.videoVisible"
              tone="runtime"
              :label="t('skip')"
              @click="player?.skipCurrentVideo()"
            >
              <MaterialIcon name="skip_next" :size="17" />
            </UiIconButton>

            <UiTimeline
              class="story-runtime__progress"
              tone="runtime"
              :label="t('seek')"
              :model-value="mode === 'play' ? progress.ratio : 0"
              :max="1"
              :step="0.001"
              :busy="progress.seeking"
              :disabled="mode !== 'play' || !progress.visible"
              :start-label="mode === 'play' ? progress.label : ''"
              @commit="seekProgress($event)"
            />

            <UiIconButton v-if="showRotationControls" tone="runtime" label="-90°" @click="rotateLeft">
              <MaterialIcon name="rotate_left" :size="17" />
            </UiIconButton>
            <UiIconButton v-if="showRotationControls" tone="runtime" label="+90°" @click="rotateRight">
              <MaterialIcon name="rotate_right" :size="17" />
            </UiIconButton>
            <UiIconButton
              tone="runtime"
              :label="t('settings')"
              :pressed="controlsOpen"
              :aria-expanded="controlsOpen"
              @click="controlsOpen = !controlsOpen"
            >
              <MaterialIcon name="tune" :size="17" />
            </UiIconButton>
            <UiIconButton
              tone="runtime"
              :label="fullscreen ? `${t('close')}: ${t('fullscreen')}` : t('fullscreen')"
              :pressed="fullscreen"
              @click="toggleFullscreen"
            >
              <MaterialIcon :name="fullscreen ? 'fullscreen_exit' : 'fullscreen'" :size="17" />
            </UiIconButton>
          </UiRuntimeSurface>
        </div>
      </RotatableViewport>
    </div>
  </Teleport>
</template>

<style scoped>
.story-runtime {
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
  --story-runtime-dock-height: calc(var(--md-comp-runtime-toolbar-height) + var(--story-runtime-safe-bottom));
  --runtime-dock-reserve: var(--story-runtime-dock-height);

  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--md-comp-runtime-scene-surface-deep);
  isolation: isolate;
}

.story-runtime__dock {
  position: absolute;
  z-index: var(--md-sys-z-index-overlay-drawer);
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  width: 100%;
  height: var(--story-runtime-dock-height);
  box-sizing: border-box;
  align-items: flex-start;
  gap: var(--md-comp-runtime-toolbar-gap);
  margin: 0;
  padding: var(--md-comp-runtime-toolbar-padding)
    max(var(--md-comp-runtime-toolbar-padding), var(--story-runtime-safe-right))
    calc(var(--md-comp-runtime-toolbar-padding) + var(--story-runtime-safe-bottom))
    max(var(--md-comp-runtime-toolbar-padding), var(--story-runtime-safe-left));
  border-radius: 0;
  box-shadow: none;
}

.story-runtime__mode {
  min-width: max-content;
}

.story-runtime__progress {
  min-width: 64px;
  flex: 1 1 auto;
  margin-inline: 2px;
}

.story-runtime__settings {
  position: absolute;
  z-index: var(--md-sys-z-index-overlay-raised-backdrop);
  right: max(var(--md-sys-spacing-2), var(--story-runtime-safe-right));
  bottom: calc(var(--story-runtime-dock-height) + var(--md-sys-spacing-2));
  display: grid;
  width: min(300px, calc(100% - 16px));
  max-height: min(440px, calc(100% - 70px));
  gap: var(--md-sys-spacing-1);
  padding: var(--md-sys-spacing-2);
  overflow: auto;
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
  width: min(100%, calc((100dvh - 118px) * var(--adv-landscape-aspect))) !important;
}

.story-runtime :deep(.adv-story-browser),
.story-runtime :deep(.adv-player-progress) {
  width: min(100%, calc(100cqh * var(--adv-landscape-aspect))) !important;
  max-width: none;
  border-radius: 0;
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
  .story-runtime__orientation {
    --story-runtime-dock-height: calc(var(--md-comp-runtime-toolbar-height-touch) + var(--story-runtime-safe-bottom));
  }

  .story-runtime__dock {
    width: 100%;
  }

  .story-runtime__progress-count {
    display: none;
  }

  .story-runtime__progress {
    min-width: 36px;
  }

  .story-runtime__settings {
    right: max(var(--md-sys-spacing-1), var(--story-runtime-safe-right));
    bottom: calc(var(--story-runtime-dock-height) + var(--md-sys-spacing-1));
    width: min(300px, calc(100% - 10px));
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

@media (max-width: 340px) {
  .story-runtime__dock :deep(.md3-icon-button--runtime) {
    --md-comp-icon-button-visual-size: 34px;
  }
}
</style>
