export interface RenderQuality {
  readonly factor: 1 | 1.3 | 1.5;
  readonly sharpness: number;
}

export interface SpatialUpscalingTarget {
  setSpatialUpscaling(settings: RenderQuality): void;
}

export const DEFAULT_RENDER_QUALITY: RenderQuality = Object.freeze({ factor: 1, sharpness: 0.8705505633 });
const STORAGE_KEY = "haneoka:render-quality:v1";
const CHANGE_EVENT = "haneoka:render-quality";
let current: RenderQuality | undefined;

function normalize(value: Partial<RenderQuality> | null): RenderQuality {
  return {
    factor: value?.factor === 1.3 || value?.factor === 1.5 ? value.factor : 1,
    sharpness:
      typeof value?.sharpness === "number" && Number.isFinite(value.sharpness)
        ? Math.max(0, Math.min(1, value.sharpness))
        : DEFAULT_RENDER_QUALITY.sharpness,
  };
}

export function readRenderQuality(): RenderQuality {
  if (!current) {
    try {
      current = normalize(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"));
    } catch {
      current = DEFAULT_RENDER_QUALITY;
    }
  }
  return current;
}

export function writeRenderQuality(settings: RenderQuality): void {
  current = normalize(settings);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {}
  dispatchEvent(new CustomEvent<RenderQuality>(CHANGE_EVENT, { detail: current }));
}

export function observeRenderQuality(listener: (settings: RenderQuality) => void): () => void {
  const changed = () => listener(readRenderQuality());
  const stored = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    current = undefined;
    changed();
  };
  addEventListener(CHANGE_EVENT, changed);
  addEventListener("storage", stored);
  listener(readRenderQuality());
  return () => {
    removeEventListener(CHANGE_EVENT, changed);
    removeEventListener("storage", stored);
  };
}

export function applyRenderQuality(target: unknown, settings = readRenderQuality()): void {
  if (target && typeof (target as SpatialUpscalingTarget).setSpatialUpscaling === "function")
    (target as SpatialUpscalingTarget).setSpatialUpscaling(settings);
}
