import { ref, type Ref } from "vue";
import { normalizeAutoPlayInterval, type AdvAutoPlayInterval } from "../core/AdvAutoPlayInterval";

export type StoryPlayerToggleValue = 0 | 1;

export interface StoryPlayerControlValues {
  readonly volume: number;
  readonly volumeBgm: number;
  readonly enableBgm: StoryPlayerToggleValue;
  readonly autoPlay: StoryPlayerToggleValue;
  readonly autoPlayInterval: AdvAutoPlayInterval;
  readonly instantText: StoryPlayerToggleValue;
  readonly textSize: number;
  readonly subtitlesEnabled: boolean;
}

export interface StoryPlayerControlsSlotProps extends StoryPlayerControlValues {
  setVolume(value: number): void;
  setVolumeBgm(value: number): void;
  setEnableBgm(value: number): void;
  setAutoPlay(value: number): void;
  setAutoPlayInterval(value: number): void;
  setInstantText(value: number): void;
  setTextSize(value: number): void;
  setSubtitlesEnabled(value: boolean): void;
  toggleFullscreen(): Promise<void>;
}

export interface StoryPlayerControls {
  readonly volume: Ref<number>;
  readonly volumeBgm: Ref<number>;
  readonly enableBgm: Ref<StoryPlayerToggleValue>;
  readonly autoPlay: Ref<StoryPlayerToggleValue>;
  readonly autoPlayInterval: Ref<AdvAutoPlayInterval>;
  readonly instantText: Ref<StoryPlayerToggleValue>;
  readonly textSize: Ref<number>;
  readonly subtitlesEnabled: Ref<boolean>;
  readonly setVolume: (value: number) => void;
  readonly setVolumeBgm: (value: number) => void;
  readonly setEnableBgm: (value: number) => void;
  readonly setAutoPlay: (value: number) => void;
  readonly setAutoPlayInterval: (value: number) => void;
  readonly setInstantText: (value: number) => void;
  readonly setTextSize: (value: number) => void;
  readonly setSubtitlesEnabled: (value: boolean) => void;
}

function clamp(value: number, minimum: number, maximum: number, fallback: number): number {
  const numeric = Number(value);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(numeric) ? numeric : fallback));
}

function toggleValue(value: number): StoryPlayerToggleValue {
  return Number(value) === 0 ? 0 : 1;
}

function autoPlayIntervalValue(value: number, fallback: AdvAutoPlayInterval): AdvAutoPlayInterval {
  return normalizeAutoPlayInterval(value, fallback);
}

/**
 * Host-independent control state for the full Three/Cubism player.
 */
export function useStoryPlayerControls(): StoryPlayerControls {
  const volume = ref(1);
  const volumeBgm = ref(1);
  const enableBgm = ref<StoryPlayerToggleValue>(0);
  const autoPlay = ref<StoryPlayerToggleValue>(0);
  const autoPlayInterval = ref<AdvAutoPlayInterval>(1);
  const instantText = ref<StoryPlayerToggleValue>(1);
  const textSize = ref(1);
  const subtitlesEnabled = ref(true);

  return {
    volume,
    volumeBgm,
    enableBgm,
    autoPlay,
    autoPlayInterval,
    instantText,
    textSize,
    subtitlesEnabled,
    setVolume: (value) => {
      volume.value = clamp(value, 0, 1, volume.value);
    },
    setVolumeBgm: (value) => {
      volumeBgm.value = clamp(value, 0, 1, volumeBgm.value);
    },
    setEnableBgm: (value) => {
      enableBgm.value = toggleValue(value);
    },
    setAutoPlay: (value) => {
      autoPlay.value = toggleValue(value);
    },
    setAutoPlayInterval: (value) => {
      autoPlayInterval.value = autoPlayIntervalValue(value, autoPlayInterval.value);
    },
    setInstantText: (value) => {
      instantText.value = toggleValue(value);
    },
    setTextSize: (value) => {
      textSize.value = clamp(value, 0.5, 2, textSize.value);
    },
    setSubtitlesEnabled: (value) => {
      subtitlesEnabled.value = Boolean(value);
    },
  };
}
