export interface StoryPlayerSettings {
  volume: number;
  volumeBgm: number;
  bgmEnabled: boolean;
  autoPlayDelaySeconds: number;
  instantText: boolean;
  textSize: number;
  subtitlesEnabled: boolean;
}

const STORAGE_KEY = "haneoka:story-player:v1";
const STATE_KEY = "story-player-settings";
const DEFAULT_SETTINGS: Readonly<StoryPlayerSettings> = {
  volume: 1,
  volumeBgm: 1,
  bgmEnabled: true,
  autoPlayDelaySeconds: 0.5,
  instantText: false,
  textSize: 1,
  subtitlesEnabled: true,
};

let hydrated = false;

const clamp = (value: unknown, minimum: number, maximum: number, fallback: number) => {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(minimum, Math.min(maximum, numeric));
};

const booleanValue = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

const normalizeSettings = (value: unknown): StoryPlayerSettings => {
  const source = value && typeof value === "object" ? (value as Partial<StoryPlayerSettings>) : {};
  const autoPlayDelaySeconds = clamp(source.autoPlayDelaySeconds, 0, 5, DEFAULT_SETTINGS.autoPlayDelaySeconds);
  return {
    volume: clamp(source.volume, 0, 1, DEFAULT_SETTINGS.volume),
    volumeBgm: clamp(source.volumeBgm, 0, 1, DEFAULT_SETTINGS.volumeBgm),
    bgmEnabled: booleanValue(source.bgmEnabled, DEFAULT_SETTINGS.bgmEnabled),
    autoPlayDelaySeconds: Math.round(autoPlayDelaySeconds * 2) / 2,
    instantText: booleanValue(source.instantText, DEFAULT_SETTINGS.instantText),
    textSize: clamp(source.textSize, 0.5, 2, DEFAULT_SETTINGS.textSize),
    subtitlesEnabled: booleanValue(source.subtitlesEnabled, DEFAULT_SETTINGS.subtitlesEnabled),
  };
};

export const useStoryPlayerSettings = () => {
  const settings = useState<StoryPlayerSettings>(STATE_KEY, () => ({ ...DEFAULT_SETTINGS }));

  if (import.meta.client && !hydrated) {
    hydrated = true;
    try {
      settings.value = normalizeSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"));
    } catch {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // Storage may be disabled; the in-memory settings still remain usable.
      }
      settings.value = { ...DEFAULT_SETTINGS };
    }
  }

  if (import.meta.client) {
    const persist = () => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeSettings(settings.value)));
      } catch {
        return;
      }
    };
    watch(settings, persist, { deep: true });
    onMounted(() => window.addEventListener("pagehide", persist));
    onBeforeUnmount(() => window.removeEventListener("pagehide", persist));
  }

  return settings;
};
