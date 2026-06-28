export interface AdaptiveRenderQualityOptions {
  initialScale?: number;
  minScale?: number;
  maxScale?: number;
  targetFps?: number;
  enabled?: boolean;
}

function finite(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/**
 * A deliberately slow render-scale governor. Short transition/filter spikes
 * leave fidelity untouched; only sustained missed frames lower resolution.
 */
export class AdaptiveRenderQuality {
  readonly enabled: boolean;
  readonly minScale: number;
  readonly maxScale: number;
  readonly targetFrameMs: number;
  scale: number;
  private slowSamples = 0;
  private fastSamples = 0;

  constructor(options: AdaptiveRenderQualityOptions = {}) {
    this.enabled = options.enabled !== false;
    this.minScale = clamp(finite(options.minScale, 0.72), 0.5, 1);
    this.maxScale = Math.max(this.minScale, clamp(finite(options.maxScale, 1), this.minScale, 1.5));
    this.scale = clamp(finite(options.initialScale, this.maxScale), this.minScale, this.maxScale);
    this.targetFrameMs = 1000 / clamp(finite(options.targetFps, 60), 30, 120);
  }

  sample(deltaMs: number) {
    if (!this.enabled || !Number.isFinite(deltaMs) || deltaMs <= 0 || deltaMs > 250) return false;
    if (deltaMs > this.targetFrameMs * 1.28) {
      this.slowSamples += 1;
      this.fastSamples = Math.max(0, this.fastSamples - 4);
    } else if (deltaMs < this.targetFrameMs * 0.9) {
      this.fastSamples += 1;
      this.slowSamples = Math.max(0, this.slowSamples - 2);
    } else {
      this.slowSamples = Math.max(0, this.slowSamples - 1);
      this.fastSamples = Math.max(0, this.fastSamples - 1);
    }

    if (this.slowSamples >= 90 && this.scale > this.minScale) {
      this.scale = clamp(Math.round((this.scale - 0.1) * 100) / 100, this.minScale, this.maxScale);
      this.slowSamples = 0;
      this.fastSamples = 0;
      return true;
    }
    if (this.fastSamples >= 480 && this.scale < this.maxScale) {
      this.scale = clamp(Math.round((this.scale + 0.05) * 100) / 100, this.minScale, this.maxScale);
      this.slowSamples = 0;
      this.fastSamples = 0;
      return true;
    }
    return false;
  }
}
