<script setup lang="ts">
import { computed, ref } from "vue";
import type { AdvStory, StoryUiSprites } from "../types/AdvRuntime";
import { useStoryPlayerControls, type StoryPlayerControls } from "./StoryPlayerControls";
import StoryPlayerFull from "./StoryPlayerFull.vue";

defineOptions({ name: "StoryPlayer" });

const props = withDefaults(
  defineProps<{
    story: AdvStory;
    uiSprites: StoryUiSprites;
    server?: string;
    controls?: StoryPlayerControls;
    showProgress?: boolean;
    showStart?: boolean;
  }>(),
  { server: undefined, controls: undefined, showProgress: true, showStart: true },
);

const storyRoot = ref<HTMLElement | null>(null);
const fullPlayer = ref<{
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
} | null>(null);
const controls = props.controls || useStoryPlayerControls();
const { volume, volumeBgm, enableBgm, autoPlay, autoPlayInterval, instantText, textSize, subtitlesEnabled } = controls;

async function toggleFullscreen(): Promise<void> {
  if (document.fullscreenElement) await document.exitFullscreen?.();
  else await storyRoot.value?.requestFullscreen?.();
}

const progress = computed(() =>
  fullPlayer.value?.progress
    ? fullPlayer.value.progress
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
const resize = () => fullPlayer.value?.resize();
const startOrAdvance = () => fullPlayer.value?.startOrAdvance();
const seekProgress = (ratio: number, delay = 0) => fullPlayer.value?.seekProgress(ratio, delay);
const skipCurrentVideo = () => fullPlayer.value?.skipCurrentVideo();

defineExpose({ controls, progress, resize, startOrAdvance, seekProgress, skipCurrentVideo, toggleFullscreen });
</script>

<template>
  <div ref="storyRoot" class="adv-story-player-root">
    <StoryPlayerFull
      ref="fullPlayer"
      :story="props.story"
      :ui-sprites="props.uiSprites"
      :server="props.server"
      :volume="volume"
      :volume-bgm="volumeBgm"
      :enable-bgm="enableBgm"
      :auto-play="autoPlay"
      :auto-play-interval="autoPlayInterval"
      :instant-text="instantText"
      :text-size="textSize"
      :subtitles-enabled="subtitlesEnabled"
      :show-progress="props.showProgress"
      :show-start="props.showStart"
    />
  </div>
</template>
