export interface SongDisplaySettings {
  forceJapaneseTitles: boolean;
}

const STORAGE_KEY = "haneoka:song-display:v1";
const STATE_KEY = "song-display-settings";
const DEFAULT_SETTINGS: Readonly<SongDisplaySettings> = {
  forceJapaneseTitles: false,
};

let hydrated = false;

const booleanValue = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

const normalizeSettings = (value: unknown): SongDisplaySettings => {
  const source = value && typeof value === "object" ? (value as Partial<SongDisplaySettings>) : {};
  return {
    forceJapaneseTitles: booleanValue(source.forceJapaneseTitles, DEFAULT_SETTINGS.forceJapaneseTitles),
  };
};

export const useSongDisplaySettings = () => {
  const settings = useState<SongDisplaySettings>(STATE_KEY, () => ({ ...DEFAULT_SETTINGS }));

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
