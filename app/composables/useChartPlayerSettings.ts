export type ChartStageBackground = "mygo" | "mujica";

export interface ChartPlayerSettings {
  volume: number;
  rate: number;
  loop: boolean;
  mirror: boolean;
  combo: boolean;
  fever: boolean;
  bpm: boolean;
  zoom: number;
  vertical: number;
  noteSize: number;
  longAlpha: number;
  noteSpeed: number;
  effects: boolean;
  noteSound: boolean;
  noteSoundVolume: number;
  quality: number;
  background: ChartStageBackground;
}

const STORAGE_KEY = "haneoka:chart-player:v1";
const STATE_KEY = "chart-player-settings";
export const CHART_PLAYER_SETTING_LIMITS = {
  zoom: { minimum: 0.5, maximum: 3 },
  vertical: { minimum: 0.5, maximum: 2 },
  noteSize: { minimum: 0.5, maximum: 2 },
} as const;
const DEFAULT_SETTINGS: Readonly<ChartPlayerSettings> = {
  volume: 0.8,
  rate: 1,
  loop: false,
  mirror: false,
  combo: true,
  fever: true,
  bpm: true,
  zoom: 1,
  vertical: 1,
  noteSize: 1,
  longAlpha: 1,
  noteSpeed: 5,
  effects: true,
  noteSound: true,
  noteSoundVolume: 0.7,
  quality: 1,
  background: "mygo",
};

let hydrated = false;

const clamp = (value: unknown, minimum: number, maximum: number, fallback: number) => {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(minimum, Math.min(maximum, numeric));
};

const booleanValue = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

const normalizeSettings = (value: unknown): ChartPlayerSettings => {
  const source = value && typeof value === "object" ? (value as Partial<ChartPlayerSettings>) : {};
  return {
    volume: clamp(source.volume, 0, 1, DEFAULT_SETTINGS.volume),
    rate: clamp(source.rate, 0.5, 2, DEFAULT_SETTINGS.rate),
    loop: booleanValue(source.loop, DEFAULT_SETTINGS.loop),
    mirror: booleanValue(source.mirror, DEFAULT_SETTINGS.mirror),
    combo: booleanValue(source.combo, DEFAULT_SETTINGS.combo),
    fever: booleanValue(source.fever, DEFAULT_SETTINGS.fever),
    bpm: booleanValue(source.bpm, DEFAULT_SETTINGS.bpm),
    zoom: clamp(
      source.zoom,
      CHART_PLAYER_SETTING_LIMITS.zoom.minimum,
      CHART_PLAYER_SETTING_LIMITS.zoom.maximum,
      DEFAULT_SETTINGS.zoom,
    ),
    vertical: clamp(
      source.vertical,
      CHART_PLAYER_SETTING_LIMITS.vertical.minimum,
      CHART_PLAYER_SETTING_LIMITS.vertical.maximum,
      DEFAULT_SETTINGS.vertical,
    ),
    noteSize: clamp(
      source.noteSize,
      CHART_PLAYER_SETTING_LIMITS.noteSize.minimum,
      CHART_PLAYER_SETTING_LIMITS.noteSize.maximum,
      DEFAULT_SETTINGS.noteSize,
    ),
    longAlpha: clamp(source.longAlpha, 0.1, 1, DEFAULT_SETTINGS.longAlpha),
    noteSpeed: clamp(source.noteSpeed, 1, 14, DEFAULT_SETTINGS.noteSpeed),
    effects: booleanValue(source.effects, DEFAULT_SETTINGS.effects),
    noteSound: booleanValue(source.noteSound, DEFAULT_SETTINGS.noteSound),
    noteSoundVolume: clamp(source.noteSoundVolume, 0, 1, DEFAULT_SETTINGS.noteSoundVolume),
    quality: clamp(source.quality, 0.5, 2, DEFAULT_SETTINGS.quality),
    background: source.background === "mygo" || source.background === "mujica" ? source.background : "mygo",
  };
};

export const useChartPlayerSettings = () => {
  const settings = useState<ChartPlayerSettings>(STATE_KEY, () => ({ ...DEFAULT_SETTINGS }));

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
