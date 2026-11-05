// L3 — GEB
// Input: 本地画面偏好与渲染器设置端口。
// Output: 跨页面同步的空间重建与故事帧率上限。
// Pos: [Map](L2-2.md)；浏览器画面设置持久化与即时应用。
// Effects/Dependencies: 读写 localStorage，广播设置事件并更新活动渲染器。
export interface RenderQuality {
  readonly factor: 1 | 1.3 | 1.5;
  readonly sharpness: number;
  readonly storyFrameRateLimit: number;
}

export interface SpatialUpscalingTarget {
  setSpatialUpscaling(settings: RenderQuality): void;
  setFrameRateLimit?(limit: number): void;
}

export const STORY_FRAME_RATE_LIMITS: readonly number[] = [30, 60, 90, 120, 144, 165, 240, 360, 0];
export const DEFAULT_RENDER_QUALITY: RenderQuality = Object.freeze({ factor: 1, sharpness: 0.8705505633, storyFrameRateLimit: 30 });
const STORAGE_KEY = "haneoka:render-quality:v1";
const CHANGE_EVENT = "haneoka:render-quality";
let current: RenderQuality | undefined;

function normalize(value: Partial<RenderQuality> | null): RenderQuality {
  const storyFrameRateLimit = value?.storyFrameRateLimit ?? DEFAULT_RENDER_QUALITY.storyFrameRateLimit;
  return {
    factor: value?.factor === 1.3 || value?.factor === 1.5 ? value.factor : 1,
    sharpness:
      typeof value?.sharpness === "number" && Number.isFinite(value.sharpness)
        ? Math.max(0, Math.min(1, value.sharpness))
        : DEFAULT_RENDER_QUALITY.sharpness,
    storyFrameRateLimit: STORY_FRAME_RATE_LIMITS.includes(storyFrameRateLimit)
      ? storyFrameRateLimit
      : DEFAULT_RENDER_QUALITY.storyFrameRateLimit,
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
  if (!target) return;
  const renderer = target as SpatialUpscalingTarget;
  if (typeof renderer.setSpatialUpscaling === "function") renderer.setSpatialUpscaling(settings);
  renderer.setFrameRateLimit?.(settings.storyFrameRateLimit);
}
