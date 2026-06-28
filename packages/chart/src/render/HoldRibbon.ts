import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  DataTexture,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  LinearFilter,
  Mesh,
  NormalBlending,
  RGBAFormat,
  ShaderMaterial,
  SRGBColorSpace,
  TextureLoader,
  UnsignedByteType,
} from "three";
import type { Texture } from "three";
import { OUR_NOTES_LIVE_GEOMETRY, type OurNotesAssetManifest } from "../assets/manifest";
import type { RenderEasing, RenderHold, RenderPathPoint } from "./types";
import { StageProjector } from "./stageGeometry";

interface HoldVisual {
  mesh: Mesh<BufferGeometry, ShaderMaterial>;
  geometry: BufferGeometry;
  material: ShaderMaterial;
  capacity: number;
  positions: Float32Array;
  uvs: Float32Array;
  approaches: Float32Array;
  positionAttribute?: BufferAttribute;
  approachAttribute?: BufferAttribute;
  positionUpdateRange: { start: number; count: number };
  approachUpdateRange: { start: number; count: number };
  lastSeen: number;
  lastOpacity: number;
  lastPressed: number;
  lastGuide: number;
}

const EMPTY_FLOATS = new Float32Array(0);
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
// LiveNoteLineViewBase._offsetValue from class init. One mesh unit is three
// trapezia / eight vertices, with the two cap strips occupying the authored
// 0..1/8 and 7/8..1 texture ranges.
const RIBBON_U = [0, 0.125, 0.875, 1] as const;
const RIBBON_COLUMNS = RIBBON_U.length;
// SetStatusValue selects the slide texture row at 1/2. The compiled
// Live/Unlit/SlideLine fragment shader treats this as a sprite-sheet row; it
// is not longitudinal path progress.
const NORMAL_FRAGMENT_V = 0.5;

function easing(value: number, mode: RenderEasing | undefined): number {
  const t = clamp01(value);
  if (typeof mode === "number") {
    const exponent = Math.max(0.05, Math.abs(mode));
    return mode < 0 ? 1 - (1 - t) ** exponent : t ** exponent;
  }
  switch (mode) {
    case "in":
      return t * t;
    case "out":
      return 1 - (1 - t) * (1 - t);
    case "in-out":
      return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    default:
      return t;
  }
}

function leftEdge(point: RenderPathPoint): number {
  return point.lane - (point.leftLineOffset ?? 0);
}

function rightEdge(point: RenderPathPoint): number {
  return point.lane + point.width + (point.rightLineOffset ?? 0);
}

function isLinear(mode: RenderEasing | undefined): boolean {
  return mode === undefined || mode === "linear";
}

function segmentSteps(from: RenderPathPoint, to: RenderPathPoint): number {
  if (isLinear(to.leftEasing ?? from.leftEasing) && isLinear(to.rightEasing ?? from.rightEasing)) return 1;
  return Math.max(2, Math.min(24, Math.ceil(Math.abs(to.approach - from.approach) * 28)));
}

function sampleCount(points: ReadonlyArray<RenderPathPoint>): number {
  if (points.length < 2) return 0;
  let count = 1;
  for (let index = 0; index < points.length - 1; index += 1) count += segmentSteps(points[index]!, points[index + 1]!);
  return count;
}

function makeTransparentTexture(): DataTexture {
  // A missing native slide_line texture must fail closed. A white strip is
  // not visually equivalent to the original material.
  const texture = new DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, RGBAFormat, UnsignedByteType);
  texture.needsUpdate = true;
  return texture;
}

/**
 * Live/Unlit/SlideLine from the decoded skin001 shader/material:
 * Transparent queue, SrcAlpha/OneMinusSrcAlpha, ZWrite Off, LEqual and Cull
 * Back. The texture is sampled once in its authored UV space; there is no
 * scrolling, repeat, edge pulse or critical recolor in the native shader.
 */
function makeMaterial(texture: Texture): ShaderMaterial {
  const material = new ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uOpacity: { value: 1 },
      uPressed: { value: 0 },
      uGuide: { value: 0 },
      uZMin: { value: 0 },
      uZMax: { value: 217.60000610351562 },
      uFadeInProgressRange: { value: 0.01 },
    },
    vertexShader: `
      attribute float aApproach;
      varying vec2 vUv;
      varying float vStageZ;
      varying float vApproach;
      void main() {
        vUv = uv;
        vStageZ = position.z;
        vApproach = aApproach;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform float uOpacity;
      uniform float uPressed;
      uniform float uGuide;
      uniform float uZMin;
      uniform float uZMax;
      uniform float uFadeInProgressRange;
      varying vec2 vUv;
      varying float vStageZ;
      varying float vApproach;

      vec3 threeKeyGradient(float t, vec3 c0, vec3 c1, vec3 c2) {
        const float middle = 0.5499961852445259;
        if (t <= middle) return mix(c0, c1, clamp(t / middle, 0.0, 1.0));
        return mix(c1, c2, clamp((t - middle) / (1.0 - middle), 0.0, 1.0));
      }

      void main() {
        vec4 texel = texture2D(uMap, vUv);
        float zProgress = clamp((vStageZ - uZMin) / max(0.0001, uZMax - uZMin), 0.0, 1.0);
        vec3 normalRgb = threeKeyGradient(
          zProgress,
          vec3(0.4796607196, 0.2862745523, 1.0),
          vec3(0.2666666508, 0.3255745471, 0.8509804010),
          vec3(0.3656105399, 0.5172215700, 0.9811320900)
        );
        vec3 pressedRgb = threeKeyGradient(
          zProgress,
          vec3(0.6041513681, 0.3349056840, 1.0),
          vec3(0.5283370614, 0.4386792183, 1.0),
          vec3(0.25, 0.6136242151, 1.0)
        );
        // Unity Gradient stores color RGB and alpha keys independently in
        // the same key slots. m_NumAlphaKeys=2, atime=[0,65535], and both
        // alpha values are 0.8627451062; key2.a is not a third alpha key.
        vec4 normalColor = vec4(normalRgb, 0.8627451062);
        vec4 pressedColor = vec4(pressedRgb, 0.8627451062);
        vec4 guideColor = vec4(0.4705882370, 0.3843137320, 1.0, 0.5098039510);
        vec4 lineColor = mix(normalColor, pressedColor, uPressed);
        lineColor = mix(lineColor, guideColor, uGuide);
        // CalculateFadeInAlpha leaves progress <= 1 untouched, then fades
        // 1 -> 0 only across the over-spawn interval 1..1.01.
        float fadeIn = 1.0 - clamp(
          (vApproach - 1.0) / max(0.0001, uFadeInProgressRange),
          0.0,
          1.0
        );
        vec4 outputColor = texel * lineColor;
        outputColor.a *= uOpacity * fadeIn;
        if (outputColor.a < 0.001) discard;
        gl_FragColor = outputColor;
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: DoubleSide,
    blending: NormalBlending,
    toneMapped: false,
  });
  // This is a flat ribbon. Three's default two-pass path for transparent
  // DoubleSide materials only splits its front/back triangles across two draw
  // calls; a single unculled pass produces the same coverage.
  material.forceSinglePass = true;
  return material;
}

/** Slide/guide ribbon mesh rendered with the original skin001 material. */
export class HoldRibbonLayer {
  readonly group = new Group();

  private readonly projector: StageProjector;
  private readonly assets: OurNotesAssetManifest;
  private readonly visuals = new Map<RenderHold["id"], HoldVisual>();
  private readonly pool: HoldVisual[] = [];
  private readonly maximumSamplesById = new Map<RenderHold["id"], number>();
  private readonly fallbackTexture = makeTransparentTexture();
  private slideTexture?: Texture;
  private disposed = false;
  private updateEpoch = 0;
  private visualAllocations = 0;
  private visualReuses = 0;
  private visualReleases = 0;
  private capacityGrowths = 0;

  constructor(projector: StageProjector, assets: OurNotesAssetManifest) {
    this.projector = projector;
    this.assets = assets;
    this.group.name = "OurNotesHoldRibbons";
  }

  async loadTexture(loader = new TextureLoader()): Promise<void> {
    const texture = await loader.loadAsync(this.assets.particles.slideLineTextureUrl);
    texture.colorSpace = SRGBColorSpace;
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    if (this.disposed) {
      texture.dispose();
      return;
    }
    this.slideTexture?.dispose();
    this.slideTexture = texture;
    for (const visual of this.visuals.values()) visual.material.uniforms.uMap.value = texture;
    for (const visual of this.pool) visual.material.uniforms.uMap.value = texture;
  }

  update(holds: ReadonlyArray<RenderHold> | undefined, _time: number): void {
    const epoch = ++this.updateEpoch;
    for (const hold of holds ?? []) {
      if (hold.visible === false || hold.points.length < 2) continue;
      const requiredSamples = sampleCount(hold.points);
      const knownMaximum = this.maximumSamplesById.get(hold.id) ?? 0;
      if (requiredSamples > knownMaximum) this.maximumSamplesById.set(hold.id, requiredSamples);
      let visual = this.visuals.get(hold.id);
      if (!visual) {
        visual = this.acquireVisual(hold, Math.max(requiredSamples, knownMaximum));
        this.visuals.set(hold.id, visual);
        this.group.add(visual.mesh);
      }
      visual.lastSeen = epoch;
      this.updateGeometry(visual, hold.points, requiredSamples);
      const opacity = clamp01(hold.alpha ?? 1);
      if (visual.lastOpacity !== opacity) {
        visual.material.uniforms.uOpacity.value = opacity;
        visual.lastOpacity = opacity;
      }
      const pressed = hold.active ? 1 : 0;
      if (visual.lastPressed !== pressed) {
        visual.material.uniforms.uPressed.value = pressed;
        visual.lastPressed = pressed;
      }
      const guide = hold.kind === "guide" ? 1 : 0;
      if (visual.lastGuide !== guide) {
        visual.material.uniforms.uGuide.value = guide;
        visual.lastGuide = guide;
      }
      visual.mesh.visible = true;
    }

    for (const [id, visual] of this.visuals) {
      if (visual.lastSeen !== epoch) this.releaseVisual(id, visual);
    }
  }

  private acquireVisual(hold: RenderHold, requiredSamples: number): HoldVisual {
    let selected = -1;
    let selectedCapacity = Number.POSITIVE_INFINITY;
    let largest = -1;
    for (let index = 0; index < this.pool.length; index += 1) {
      const capacity = this.pool[index]!.capacity;
      if (largest < 0 || capacity > this.pool[largest]!.capacity) largest = index;
      if (capacity >= requiredSamples && capacity < selectedCapacity) {
        selected = index;
        selectedCapacity = capacity;
      }
    }
    if (selected < 0) selected = largest;
    const pooled = selected < 0 ? undefined : this.pool[selected];
    if (pooled) {
      const last = this.pool.pop()!;
      if (selected < this.pool.length) this.pool[selected] = last;
      this.visualReuses += 1;
      pooled.mesh.name = `HoldRibbon:${String(hold.id)}`;
      pooled.mesh.visible = true;
      return pooled;
    }
    this.visualAllocations += 1;
    return this.createVisual(hold);
  }

  private createVisual(hold: RenderHold): HoldVisual {
    const geometry = new BufferGeometry();
    const material = makeMaterial(this.slideTexture ?? this.fallbackTexture);
    const mesh = new Mesh(geometry, material);
    mesh.name = `HoldRibbon:${String(hold.id)}`;
    mesh.frustumCulled = false;
    // Slide line view MeshRenderer: m_SortingOrder=4999.
    mesh.renderOrder = OUR_NOTES_LIVE_GEOMETRY.sortingOrders.holdLine;
    return {
      mesh,
      geometry,
      material,
      capacity: 0,
      positions: EMPTY_FLOATS,
      uvs: EMPTY_FLOATS,
      approaches: EMPTY_FLOATS,
      positionUpdateRange: { start: 0, count: 0 },
      approachUpdateRange: { start: 0, count: 0 },
      lastSeen: 0,
      lastOpacity: Number.NaN,
      lastPressed: Number.NaN,
      lastGuide: Number.NaN,
    };
  }

  private ensureCapacity(visual: HoldVisual, requiredSamples: number): void {
    if (requiredSamples <= visual.capacity) return;
    const previousGeometry = visual.geometry;
    const geometry = new BufferGeometry();
    let capacity = Math.max(16, visual.capacity || 16);
    while (capacity < requiredSamples) capacity *= 2;
    visual.capacity = capacity;
    this.capacityGrowths += 1;
    visual.positions = new Float32Array(capacity * RIBBON_COLUMNS * 3);
    visual.uvs = new Float32Array(capacity * RIBBON_COLUMNS * 2);
    visual.approaches = new Float32Array(capacity * RIBBON_COLUMNS);
    for (let sample = 0; sample < capacity; sample += 1) {
      for (let column = 0; column < RIBBON_COLUMNS; column += 1) {
        const uvOffset = (sample * RIBBON_COLUMNS + column) * 2;
        visual.uvs[uvOffset] = RIBBON_U[column]!;
        visual.uvs[uvOffset + 1] = NORMAL_FRAGMENT_V;
      }
    }
    const indices = new Uint32Array(Math.max(0, capacity - 1) * 18);
    for (let index = 0; index < capacity - 1; index += 1) {
      const near = index * RIBBON_COLUMNS;
      const far = near + RIBBON_COLUMNS;
      for (let strip = 0; strip < 3; strip += 1) {
        const offset = index * 18 + strip * 6;
        indices[offset] = near + strip;
        indices[offset + 1] = far + strip;
        indices[offset + 2] = near + strip + 1;
        indices[offset + 3] = far + strip;
        indices[offset + 4] = far + strip + 1;
        indices[offset + 5] = near + strip + 1;
      }
    }
    const position = new BufferAttribute(visual.positions, 3).setUsage(DynamicDrawUsage);
    const uv = new BufferAttribute(visual.uvs, 2);
    const approach = new BufferAttribute(visual.approaches, 1).setUsage(DynamicDrawUsage);
    visual.positionAttribute = position;
    visual.approachAttribute = approach;
    geometry.setAttribute("position", position);
    geometry.setAttribute("uv", uv);
    geometry.setAttribute("aApproach", approach);
    geometry.setIndex(new BufferAttribute(indices, 1));
    visual.geometry = geometry;
    visual.mesh.geometry = geometry;
    // BufferAttribute has no public dispose event. Disposing the complete old
    // geometry is what lets WebGLGeometries release every superseded GPU
    // buffer after a capacity growth.
    previousGeometry.dispose();
  }

  private updateGeometry(visual: HoldVisual, points: ReadonlyArray<RenderPathPoint>, count: number): void {
    if (count < 2) {
      visual.geometry.setDrawRange(0, 0);
      return;
    }
    this.ensureCapacity(visual, count);
    let sampleIndex = 0;

    for (let index = 0; index < points.length - 1; index += 1) {
      const from = points[index]!;
      const to = points[index + 1]!;
      const steps = segmentSteps(from, to);
      const fromLeft = leftEdge(from);
      const fromRight = rightEdge(from);
      const toLeft = leftEdge(to);
      const toRight = rightEdge(to);
      for (let step = index === 0 ? 0 : 1; step <= steps; step += 1) {
        const t = step / steps;
        const leftT = easing(t, to.leftEasing ?? from.leftEasing);
        const rightT = easing(t, to.rightEasing ?? from.rightEasing);
        this.writeSample(
          visual,
          sampleIndex,
          fromLeft + (toLeft - fromLeft) * leftT,
          fromRight + (toRight - fromRight) * rightT,
          from.approach + (to.approach - from.approach) * t,
        );
        sampleIndex += 1;
      }
    }

    visual.geometry.setDrawRange(0, Math.max(0, sampleIndex - 1) * 18);
    const position = visual.positionAttribute!;
    const approach = visual.approachAttribute!;
    visual.positionUpdateRange.count = sampleIndex * RIBBON_COLUMNS * 3;
    position.updateRanges.length = 1;
    position.updateRanges[0] = visual.positionUpdateRange;
    visual.approachUpdateRange.count = sampleIndex * RIBBON_COLUMNS;
    approach.updateRanges.length = 1;
    approach.updateRanges[0] = visual.approachUpdateRange;
    position.needsUpdate = true;
    approach.needsUpdate = true;
  }

  private writeSample(
    visual: HoldVisual,
    sampleIndex: number,
    leftLane: number,
    rightLane: number,
    approach: number,
  ): void {
    // InsertMeshUnitAtProgress first lerps the center from spawn x=0, then
    // multiplies converted width by the same progress.
    const viewProgress = this.projector.viewProgress(approach);
    const left = this.projector.laneEdgeToXAtViewProgress(leftLane, viewProgress);
    const right = this.projector.laneEdgeToXAtViewProgress(rightLane, viewProgress);
    const z = this.projector.approachToZ(approach);
    const y = this.projector.yAtViewProgress(viewProgress) + 0.002;
    const width = right - left;
    for (let column = 0; column < RIBBON_COLUMNS; column += 1) {
      const u = RIBBON_U[column]!;
      const vertex = sampleIndex * RIBBON_COLUMNS + column;
      const positionOffset = vertex * 3;
      visual.positions[positionOffset] = left + width * u;
      visual.positions[positionOffset + 1] = y;
      visual.positions[positionOffset + 2] = z;
      visual.approaches[vertex] = approach;
    }
  }

  private releaseVisual(id: RenderHold["id"], visual: HoldVisual): void {
    this.group.remove(visual.mesh);
    visual.mesh.visible = false;
    this.visuals.delete(id);
    this.pool.push(visual);
    this.visualReleases += 1;
  }

  private disposeVisual(visual: HoldVisual): void {
    visual.geometry.dispose();
    visual.material.dispose();
  }

  get stats(): {
    activeVisuals: number;
    pooledVisuals: number;
    visualAllocations: number;
    visualReuses: number;
    visualReleases: number;
    capacityGrowths: number;
    sampleCapacity: number;
  } {
    let sampleCapacity = 0;
    for (const visual of this.visuals.values()) sampleCapacity += visual.capacity;
    for (const visual of this.pool) sampleCapacity += visual.capacity;
    return {
      activeVisuals: this.visuals.size,
      pooledVisuals: this.pool.length,
      visualAllocations: this.visualAllocations,
      visualReuses: this.visualReuses,
      visualReleases: this.visualReleases,
      capacityGrowths: this.capacityGrowths,
      sampleCapacity,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const visual of this.visuals.values()) this.disposeVisual(visual);
    this.visuals.clear();
    for (const visual of this.pool) this.disposeVisual(visual);
    this.pool.length = 0;
    this.maximumSamplesById.clear();
    this.slideTexture?.dispose();
    this.fallbackTexture.dispose();
    this.group.clear();
  }
}
