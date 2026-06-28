import type { AdvFrameEntry, AdvFrameNumericRange, AdvFrameParticleLayer } from "../../types/AdvRuntime";

interface ResolvedRainLayer {
  readonly rate: number;
  readonly duration: number;
  readonly lifetime: readonly [number, number];
  readonly sizeX: readonly [number, number];
  readonly sizeY: readonly [number, number];
  readonly alpha: readonly [number, number];
  readonly speed: readonly [number, number];
  readonly velocityX: readonly [number, number];
  readonly velocityY: readonly [number, number];
  readonly shapePosition: Readonly<{ x: number; y: number }>;
  readonly shapeLength: number;
  readonly rotation: readonly [number, number];
  readonly scaleXSign: -1 | 1;
  readonly prewarm: boolean;
  readonly maxParticles: number;
}

interface RainParticle {
  layerIndex: number;
  vx: number;
  vy: number;
  width: number;
  height: number;
  alpha: number;
  lifetime: number;
  rotationCos: number;
  rotationSin: number;
  x: number;
  y: number;
  age: number;
}

interface ReferenceLayerDefaults {
  readonly lifetime: readonly [number, number];
  readonly sizeY: readonly [number, number];
  readonly rotation: readonly [number, number];
}

const REFERENCE_WIDTH = 1920;
const DEFAULT_ROOT_POSITION = { x: -15, y: 167 } as const;
const DEFAULT_ROOT_ROTATION = Math.PI / 180;
const SIMULATION_STEP = 1 / 60;
// Unity TimeManager's maximumDeltaTime.
const MAX_CATCH_UP_SECONDS = 1 / 3;

// The prefab uses UIParticle scale3D=(10,10,10), while both child particle
// RectTransforms use localScale=(10,10,10). UIParticleRenderer bakes the child
// scale and then applies scale3DForCalc, so one ParticleSystem unit is 100
// FrameCanvas units at the authored 1920-wide reference resolution.
const PARTICLE_TO_CANVAS = 100;

const USUALLY_FAST: ReferenceLayerDefaults = {
  lifetime: [0.2, 0.7],
  sizeY: [3, 8],
  rotation: [-0.0872664600610733, -0.0872664600610733],
};
const USUALLY_SLOW: ReferenceLayerDefaults = {
  lifetime: [0.5, 1],
  sizeY: [1, 2],
  rotation: [-0.0872664600610733, -0.0872664600610733],
};
const HEAVY_FAST: ReferenceLayerDefaults = {
  lifetime: [0.2, 0.7],
  sizeY: [4, 9],
  rotation: [-0.0872664600610733, -0.0872664600610733],
};
const LIGHT_MAIN: ReferenceLayerDefaults = {
  lifetime: [2, 3],
  sizeY: [0.5, 1.4],
  rotation: [-0.06981316953897476, -0.06981316953897476],
};
const LIGHT_SECONDARY: ReferenceLayerDefaults = {
  lifetime: [1, 1.2],
  sizeY: [0.5, 0.8],
  rotation: [-0.06981316953897476, -0.06981316953897476],
};

function finite(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function range(
  value: AdvFrameNumericRange | null | undefined,
  fallback: readonly [number, number],
): readonly [number, number] {
  const a = finite(value?.min, fallback[0]);
  const b = finite(value?.max, fallback[1]);
  return a <= b ? [a, b] : [b, a];
}

function referenceDefaults(frame: AdvFrameEntry, layer: AdvFrameParticleLayer): ReferenceLayerDefaults {
  const variant = String(frame.variant || "").toLowerCase();
  const direction = String(frame.direction || "").toLowerCase();
  const rate = Math.max(0, finite(layer.rate));
  const defaults =
    variant === "heavy"
      ? rate >= 500
        ? USUALLY_SLOW
        : HEAVY_FAST
      : variant === "light"
        ? rate >= 100
          ? LIGHT_MAIN
          : LIGHT_SECONDARY
        : rate >= 150
          ? USUALLY_SLOW
          : USUALLY_FAST;
  return direction === "vertical" ? { ...defaults, rotation: [0, 0] } : defaults;
}

function resolveLayer(frame: AdvFrameEntry, layer: AdvFrameParticleLayer): ResolvedRainLayer {
  const defaults = referenceDefaults(frame, layer);
  const scaleXSign = finite(layer.transform?.scale?.x, 10) < 0 ? -1 : 1;
  return {
    rate: Math.max(0, finite(layer.rate)),
    duration: Math.max(0, finite(layer.duration, 5)),
    lifetime: range(layer.lifetime, defaults.lifetime),
    sizeX: range(layer.size, [0.05, 0.05]),
    sizeY: range(layer.sizeY, defaults.sizeY),
    alpha: range(layer.alpha, [0.1, 0.1]),
    speed: range(layer.speed, [0, 0]),
    velocityX: range(layer.velocity?.x, [0, 0]),
    velocityY: range(layer.velocity?.y, [0, 0]),
    shapePosition: {
      x: finite(layer.shape?.position?.x),
      y: finite(layer.shape?.position?.y),
    },
    shapeLength: Math.abs(finite(layer.shape?.scale?.x, 1)),
    rotation: range(layer.rotation, defaults.rotation),
    scaleXSign,
    prewarm: layer.prewarm !== false,
    maxParticles: Math.max(1, Math.trunc(finite(layer.maxParticles, 1000))),
  };
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 1;
}

/** Canvas equivalent of the Coffee.UIExtensions.UIParticle rain prefab. */
export class AdvRainFrameRenderer {
  readonly element: HTMLCanvasElement;
  readonly ready: Promise<void>;

  private readonly context: CanvasRenderingContext2D;
  private readonly texture = new Image();
  private readonly layers: readonly ResolvedRainLayer[];
  private readonly accumulators: number[];
  private readonly liveCounts: number[];
  private readonly particles: RainParticle[] = [];
  private readonly particlePool: RainParticle[] = [];
  private readonly rootPosition: Readonly<{ x: number; y: number }>;
  private readonly rootRotation: number;
  private particleTexture: CanvasImageSource | null = null;
  private seed: number;
  private animationFrame = 0;
  private previousTime = 0;
  private simulationRemainder = 0;
  private width = 0;
  private height = 0;
  private pixelRatio = 1;
  private prewarmed = false;
  private destroyed = false;

  constructor(frame: AdvFrameEntry) {
    this.element = document.createElement("canvas");
    this.element.className = "adv-frame-rain";
    Object.assign(this.element.style, {
      width: "100%",
      height: "100%",
      display: "block",
      pointerEvents: "none",
    });
    const context = this.element.getContext("2d", { alpha: true });
    if (!context) throw new Error("ADV rain frame requires a 2D canvas context");
    this.context = context;
    this.layers = (frame.layers || []).map((layer) => resolveLayer(frame, layer));
    if (!this.layers.length) {
      throw new Error(`ADV rain frame has no particle layers: ${frame.source || frame.name || "unknown"}`);
    }
    this.accumulators = this.layers.map(() => 0);
    this.liveCounts = this.layers.map(() => 0);
    this.rootPosition = {
      x: finite(frame.rootTransform?.position?.x, DEFAULT_ROOT_POSITION.x),
      y: finite(frame.rootTransform?.position?.y, DEFAULT_ROOT_POSITION.y),
    };
    this.rootRotation = finite(frame.rootTransform?.rotation, DEFAULT_ROOT_ROTATION);
    const fallbackSeed = hashSeed(`${frame.source || "rain"}:${frame.variant || ""}:${frame.direction || ""}`);
    const randomSeed = new Uint32Array(1);
    globalThis.crypto?.getRandomValues?.(randomSeed);
    this.seed = randomSeed[0] || fallbackSeed;
    this.texture.decoding = "async";
    const textureSource = String(frame.texture || "");
    if (!textureSource)
      throw new Error(`ADV rain frame has no particle texture: ${frame.source || frame.name || "unknown"}`);
    this.texture.src = textureSource;
    this.ready = this.prepareTexture(textureSource);
    this.animationFrame = requestAnimationFrame(this.update);
  }

  setViewport(width: number, height: number): void {
    const nextWidth = Math.max(0, Math.round(finite(width)));
    const nextHeight = Math.max(0, Math.round(finite(height)));
    const nextPixelRatio = clamp(finite(globalThis.devicePixelRatio, 1), 1, 2);
    if (nextWidth === this.width && nextHeight === this.height && nextPixelRatio === this.pixelRatio) return;
    this.width = nextWidth;
    this.height = nextHeight;
    this.pixelRatio = nextPixelRatio;
    this.element.width = Math.max(1, Math.round(nextWidth * nextPixelRatio));
    this.element.height = Math.max(1, Math.round(nextHeight * nextPixelRatio));
    this.recycleParticles();
    this.accumulators.fill(0);
    this.simulationRemainder = 0;
    this.prewarmed = false;
    this.prewarm();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.particles.length = 0;
    this.particlePool.length = 0;
    this.element.remove();
  }

  private async prepareTexture(source: string): Promise<void> {
    if (!source) return;
    try {
      await this.texture.decode();
    } catch {
      if (!this.texture.complete) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            this.texture.removeEventListener("load", done);
            this.texture.removeEventListener("error", done);
            resolve();
          };
          this.texture.addEventListener("load", done, { once: true });
          this.texture.addEventListener("error", done, { once: true });
        });
      }
    }
    if (this.destroyed || this.texture.naturalWidth <= 0 || this.texture.naturalHeight <= 0) return;
    try {
      // smallglow stores its intensity in opaque RGB (including opaque black).
      // Move magnitude into alpha while preserving premultiplied RGB exactly:
      // normalizedRgb * (sourceAlpha * magnitude) == sourceRgb * sourceAlpha.
      // This makes black a transparent zero contribution even if a browser
      // isolates one of the CSS additive stacking groups during a frame fade.
      const normalized = document.createElement("canvas");
      normalized.width = this.texture.naturalWidth;
      normalized.height = this.texture.naturalHeight;
      const context = normalized.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Cannot normalize ADV rain texture");
      context.drawImage(this.texture, 0, 0);
      const pixels = context.getImageData(0, 0, normalized.width, normalized.height);
      for (let offset = 0; offset < pixels.data.length; offset += 4) {
        const red = pixels.data[offset];
        const green = pixels.data[offset + 1];
        const blue = pixels.data[offset + 2];
        const alpha = pixels.data[offset + 3];
        const magnitude = Math.max(red, green, blue);
        if (magnitude === 0 || alpha === 0) {
          pixels.data[offset] = 0;
          pixels.data[offset + 1] = 0;
          pixels.data[offset + 2] = 0;
          pixels.data[offset + 3] = 0;
          continue;
        }
        pixels.data[offset] = Math.round((red * 255) / magnitude);
        pixels.data[offset + 1] = Math.round((green * 255) / magnitude);
        pixels.data[offset + 2] = Math.round((blue * 255) / magnitude);
        pixels.data[offset + 3] = Math.round((alpha * magnitude) / 255);
      }
      context.putImageData(pixels, 0, 0);
      this.particleTexture = normalized;
    } catch {
      // Cross-origin images can be drawable but unreadable. The final
      // plus-lighter frame group remains the exact additive fallback.
      this.particleTexture = this.texture;
    }
  }

  private readonly update = (time: number): void => {
    if (this.destroyed) return;
    const delta = this.previousTime > 0 ? clamp((time - this.previousTime) / 1000, 0, MAX_CATCH_UP_SECONDS) : 0;
    this.previousTime = time;
    if (!this.prewarmed) this.prewarm();
    if (delta > 0 && this.width > 0 && this.height > 0) {
      this.simulationRemainder = Math.min(MAX_CATCH_UP_SECONDS, this.simulationRemainder + delta);
      while (this.simulationRemainder >= SIMULATION_STEP) {
        this.simulate(SIMULATION_STEP);
        this.simulationRemainder -= SIMULATION_STEP;
      }
    }
    this.render();
    this.animationFrame = requestAnimationFrame(this.update);
  };

  private prewarm(): void {
    if (this.prewarmed || this.width <= 0 || this.height <= 0) return;
    this.prewarmed = true;
    for (let layerIndex = 0; layerIndex < this.layers.length; layerIndex += 1) {
      const layer = this.layers[layerIndex];
      if (!layer.prewarm) continue;
      // UIParticleRenderer.Simulate adds main.duration (5s for every rain
      // prefab) on its first prewarm update. Enumerating the authored
      // constant-rate emission events reproduces the resulting length-biased
      // live-particle population without a guessed average-lifetime count.
      const emissionCount = Math.floor(layer.rate * layer.duration);
      let activeCount = 0;
      for (let index = 1; index <= emissionCount; index += 1) {
        const age = layer.duration - index / Math.max(layer.rate, Number.EPSILON);
        if (activeCount >= layer.maxParticles) break;
        if (this.spawn(layerIndex, Math.max(0, age))) activeCount += 1;
      }
      this.accumulators[layerIndex] = layer.rate * layer.duration - emissionCount;
    }
  }

  private simulate(delta: number): void {
    const liveCounts = this.liveCounts;
    liveCounts.fill(0);
    let alive = 0;
    for (const particle of this.particles) {
      particle.age += delta;
      particle.x += particle.vx * delta;
      particle.y += particle.vy * delta;
      if (particle.age >= particle.lifetime) {
        this.particlePool.push(particle);
        continue;
      }
      this.particles[alive] = particle;
      liveCounts[particle.layerIndex] += 1;
      alive += 1;
    }
    this.particles.length = alive;

    for (let layerIndex = 0; layerIndex < this.layers.length; layerIndex += 1) {
      const layer = this.layers[layerIndex];
      const previousAccumulator = this.accumulators[layerIndex];
      const total = previousAccumulator + layer.rate * delta;
      const emitted = Math.floor(total);
      this.accumulators[layerIndex] = total - emitted;
      let available = Math.max(0, layer.maxParticles - liveCounts[layerIndex]);
      for (let index = 0; index < emitted && available > 0; index += 1) {
        const emissionTime = (1 - previousAccumulator + index) / Math.max(layer.rate, Number.EPSILON);
        if (this.spawn(layerIndex, Math.max(0, delta - emissionTime))) {
          liveCounts[layerIndex] += 1;
          available -= 1;
        }
      }
    }
  }

  private spawn(layerIndex: number, age = 0): boolean {
    const layer = this.layers[layerIndex];
    const canvasScale = this.width / REFERENCE_WIDTH;
    // Every ADV rain system uses ShapeModule type 12
    // (SingleSidedEdge): scale.x is the edge length and scale.y does not widen
    // the emission region. The particle starts on the edge's local Y origin.
    const localX = layer.shapePosition.x + (this.random() - 0.5) * layer.shapeLength;
    const localY = layer.shapePosition.y;
    const cos = Math.cos(this.rootRotation);
    const sin = Math.sin(this.rootRotation);
    // Particle child RectTransforms are rotated 180 degrees around X.
    const particleX = localX * PARTICLE_TO_CANVAS * layer.scaleXSign;
    const particleY = -localY * PARTICLE_TO_CANVAS;
    const worldX = this.rootPosition.x + particleX * cos - particleY * sin;
    const worldY = this.rootPosition.y + particleX * sin + particleY * cos;

    const localVx = this.randomRange(layer.velocityX) * PARTICLE_TO_CANVAS * layer.scaleXSign;
    // Shape type 12 (Edge) emits along local +Y. The child X=180 degree
    // rotation turns both startSpeed and VelocityOverLifetime.y downward.
    const localVy = -(this.randomRange(layer.speed) + this.randomRange(layer.velocityY)) * PARTICLE_TO_CANVAS;
    const worldVx = localVx * cos - localVy * sin;
    const worldVy = localVx * sin + localVy * cos;
    const lifetime = this.randomRange(layer.lifetime);
    if (age >= lifetime) return false;
    const vx = worldVx * canvasScale;
    const vy = -worldVy * canvasScale;
    const rotation = layer.scaleXSign * this.randomRange(layer.rotation) - this.rootRotation;
    const width = Math.max(0.5, this.randomRange(layer.sizeX) * PARTICLE_TO_CANVAS * canvasScale);
    const height = Math.max(1, this.randomRange(layer.sizeY) * PARTICLE_TO_CANVAS * canvasScale);
    const alpha = clamp(this.randomRange(layer.alpha), 0, 1);
    const particle = this.particlePool.pop() ?? ({} as RainParticle);
    particle.layerIndex = layerIndex;
    particle.x = this.width * 0.5 + worldX * canvasScale + vx * age;
    particle.y = this.height * 0.5 - worldY * canvasScale + vy * age;
    particle.vx = vx;
    particle.vy = vy;
    particle.width = width;
    particle.height = height;
    particle.alpha = alpha;
    particle.lifetime = lifetime;
    particle.age = age;
    // Unity rotation is counter-clockwise in a Y-up space; Canvas is Y-down.
    particle.rotationCos = Math.cos(rotation);
    particle.rotationSin = Math.sin(rotation);
    this.particles.push(particle);
    return true;
  }

  private recycleParticles(): void {
    for (const particle of this.particles) this.particlePool.push(particle);
    this.particles.length = 0;
  }

  private render(): void {
    const { context } = this;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.element.width, this.element.height);
    if (!this.particleTexture || this.width <= 0 || this.height <= 0) return;
    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    // Mobile/Particles/Additive: Blend SrcAlpha One. The source PNG has opaque
    // black around the glow, so source-over would recreate the reported black
    // screen even when the particle dimensions are correct.
    context.globalCompositeOperation = "lighter";
    for (const particle of this.particles) {
      context.globalAlpha = particle.alpha;
      context.setTransform(
        particle.rotationCos * this.pixelRatio,
        particle.rotationSin * this.pixelRatio,
        -particle.rotationSin * this.pixelRatio,
        particle.rotationCos * this.pixelRatio,
        particle.x * this.pixelRatio,
        particle.y * this.pixelRatio,
      );
      context.drawImage(
        this.particleTexture,
        -particle.width * 0.5,
        -particle.height * 0.5,
        particle.width,
        particle.height,
      );
    }
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
  }

  private random(): number {
    let value = this.seed;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.seed = value >>> 0 || 1;
    return this.seed / 0x1_0000_0000;
  }

  private randomRange(value: readonly [number, number]): number {
    return value[0] + (value[1] - value[0]) * this.random();
  }
}
