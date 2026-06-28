import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
} from "three";
import type { Texture } from "three";
import type { OurNotesAssetManifest } from "../assets/manifest";
import { OUR_NOTES_LIVE_GEOMETRY } from "../assets/manifest";
import type { RenderPathPoint, RenderStageState } from "./types";

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

export interface StageProjectorOptions {
  laneCount?: number;
  stageWidth?: number;
  judgementZ?: number;
  horizonZ?: number;
  spawnY?: number;
}

/**
 * The Unity scene is left-handed and looks down world +Z. Three.js is
 * right-handed and its camera looks down local -Z, so every world-space Z
 * value (including prefab-local Z) crosses this reflection boundary once.
 */
export function unityWorldZToThree(value: number): number {
  return -value;
}

export class StageProjector {
  readonly laneCount: number;
  readonly stageWidth: number;
  readonly judgementZ: number;
  readonly horizonZ: number;
  readonly spawnY: number;

  constructor(options: StageProjectorOptions = {}) {
    this.laneCount = Math.max(1, options.laneCount ?? OUR_NOTES_LIVE_GEOMETRY.chartLaneCount);
    this.stageWidth = Math.max(1, options.stageWidth ?? OUR_NOTES_LIVE_GEOMETRY.laneWidth);
    this.judgementZ = unityWorldZToThree(options.judgementZ ?? OUR_NOTES_LIVE_GEOMETRY.judgementRootZ);
    this.horizonZ = unityWorldZToThree(options.horizonZ ?? OUR_NOTES_LIVE_GEOMETRY.spawnRootZ);
    this.spawnY = options.spawnY ?? OUR_NOTES_LIVE_GEOMETRY.spawnY;
  }

  laneEdgeToX(lane: number): number {
    return (
      OUR_NOTES_LIVE_GEOMETRY.screenJudgementCenterX +
      (lane / this.laneCount - 0.5) * OUR_NOTES_LIVE_GEOMETRY.screenJudgementWidth
    );
  }

  laneCenterToX(lane: number, width: number): number {
    return this.laneEdgeToX(lane + width / 2);
  }

  /**
   * The camera-plane spawn root and the 2D judgement position are both
   * children of screen_root, so this is a fixed-depth 2D lerp; a second
   * world-Z perspective projection would incorrectly accelerate it.
   */
  laneCenterToXAtApproach(lane: number, width: number, approach: number): number {
    return this.laneCenterToX(lane, width) * this.viewProgress(approach);
  }

  /**
   * Both the center X and the half-width scale by the same progress, so
   * either authored edge is simply the judgement-root edge scaled from
   * spawn x=0.
   */
  laneEdgeToXAtApproach(lane: number, approach: number): number {
    return this.laneEdgeToXAtViewProgress(lane, this.viewProgress(approach));
  }

  laneEdgeToXAtViewProgress(lane: number, viewProgress: number): number {
    return this.laneEdgeToX(lane) * viewProgress;
  }

  widthToWorld(width: number): number {
    return (width / this.laneCount) * OUR_NOTES_LIVE_GEOMETRY.screenJudgementWidth;
  }

  /**
   * Width used by LiveAllNoteEffectView. Unlike note sprites, note effects are
   * positioned through LiveLaneView.noteJudgementRoot3D, whose serialized
   * lane span is the physical 19.12-unit world lane.
   */
  effectWidthToWorld(width: number): number {
    return (width / this.laneCount) * this.stageWidth;
  }

  /**
   * Note-effect positions are averaged from the inclusive from/to lane
   * positions against the serialized judgement root at (0, 0, 9.62); that
   * root is not the camera-child screen_root judgement array.
   */
  effectPoint(lane: number, width: number, target = new Vector3()): Vector3 {
    const x = ((lane + width / 2) / this.laneCount - 0.5) * this.stageWidth;
    return target.set(x, 0, this.judgementZ);
  }

  xToLaneEdge(x: number): number {
    return (
      ((x - OUR_NOTES_LIVE_GEOMETRY.screenJudgementCenterX) / OUR_NOTES_LIVE_GEOMETRY.screenJudgementWidth + 0.5) *
      this.laneCount
    );
  }

  viewProgress(approach: number): number {
    // Pre-spawn raw progress is clamped to zero. With approach=1-rawProgress
    // that means every approach >1 uses 1. Post-judgement progress remains
    // unclamped; -0.16 is our release-window bound and prevents runaway
    // values for external DTOs.
    const f32 = Math.fround;
    const value = f32(clamp(approach, -0.16, 1));
    // View-progress curve: rawProgress=1-approach, then
    // pow(1.06500006, (rawProgress-1)*45), then spawn→judgement lerp.
    const rawProgress = f32(1 - value);
    const exponent = f32(f32(rawProgress - 1) * f32(OUR_NOTES_LIVE_GEOMETRY.viewCurveSteps));
    return f32(Math.pow(f32(OUR_NOTES_LIVE_GEOMETRY.viewCurveBase), exponent));
  }

  approachToZ(approach: number): number {
    void approach;
    // Note/line prefabs are XY meshes below camera child screen_root. The
    // parent itself supplies the fixed 10.6077995 camera distance.
    return 0;
  }

  approachToY(approach: number): number {
    return this.yAtViewProgress(this.viewProgress(approach));
  }

  yAtViewProgress(viewProgress: number): number {
    return this.spawnY + (OUR_NOTES_LIVE_GEOMETRY.screenJudgementY - this.spawnY) * viewProgress;
  }

  /** Reuse a caller-computed native view curve without allocating or repeating pow(). */
  pointAtViewProgress(lane: number, width: number, viewProgress: number, y = 0, target = new Vector3()): Vector3 {
    return target.set(this.laneCenterToX(lane, width) * viewProgress, this.yAtViewProgress(viewProgress) + y, 0);
  }

  point(lane: number, width: number, approach: number, y = 0, target = new Vector3()): Vector3 {
    return this.pointAtViewProgress(lane, width, this.viewProgress(approach), y, target);
  }

  pathEdges(point: RenderPathPoint, y = 0): [Vector3, Vector3] {
    const z = this.approachToZ(point.approach);
    return [
      new Vector3(
        this.laneEdgeToXAtApproach(point.lane - (point.leftLineOffset ?? 0), point.approach),
        this.approachToY(point.approach) + y,
        z,
      ),
      new Vector3(
        this.laneEdgeToXAtApproach(point.lane + point.width + (point.rightLineOffset ?? 0), point.approach),
        this.approachToY(point.approach) + y,
        z,
      ),
    ];
  }
}

/**
 * Note scroll-offset: ease normalized approach [0,1] to a 4..0.35 s view
 * time, then convert to milliseconds.
 */
export function nativeNoteOffset(u: number, curveExponent = OUR_NOTES_LIVE_GEOMETRY.noteSpeedExponent): number {
  const f32 = Math.fround;
  const normalized = f32(clamp(u, 0, 1));
  const eased = f32(1 - Math.pow(f32(1 - normalized), f32(Math.max(0.001, curveExponent))));
  const seconds = f32(f32(4) + f32(f32(0.35 - 4) * eased));
  return Math.ceil(f32(1000 * seconds));
}

export interface BackgroundCoverUv {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly repeatX: number;
  readonly repeatY: number;
}

/**
 * Centered `background-size: cover` crop expressed as a Three.js texture
 * transform. The lightweight stage textures are 1536x1212, so stretching a
 * Scene.background across a 16:9 live view exposes substantially more of the
 * authored top/bottom than the existing simulator and the native RawImage.
 */
export function backgroundCoverUv(
  imageWidth: number,
  imageHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): BackgroundCoverUv {
  const sourceAspect = Math.max(Number.EPSILON, imageWidth) / Math.max(Number.EPSILON, imageHeight);
  const viewportAspect = Math.max(Number.EPSILON, viewportWidth) / Math.max(Number.EPSILON, viewportHeight);
  if (sourceAspect > viewportAspect) {
    const repeatX = viewportAspect / sourceAspect;
    return { offsetX: (1 - repeatX) / 2, offsetY: 0, repeatX, repeatY: 1 };
  }
  const repeatY = sourceAspect / viewportAspect;
  return { offsetX: 0, offsetY: (1 - repeatY) / 2, repeatX: 1, repeatY };
}

/**
 * Background brightness maps to shadow alpha as `1 - brightness`, with the
 * integer percentage first clamped to 0..1.
 */
export function nativeBackgroundShadowAlpha(backgroundBrightness: number): number {
  return 1 - clamp(Number.isFinite(backgroundBrightness) ? backgroundBrightness : 1, 0, 1);
}

function configureTexture(texture: Texture): Texture {
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/**
 * lane_base is already a tight alpha perspective sprite rendered by the
 * ScreenSpace-Camera canvas. It must not pass through LiveGameCamera again.
 */
export class ScreenLaneBackdrop {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1920, 1080, 0, -10, 10);

  private readonly backgroundBaseMaterial: MeshBasicMaterial;
  private readonly backgroundBaseMesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly backgroundMaterial: MeshBasicMaterial;
  private readonly backgroundMesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly backgroundShadowMaterial: MeshBasicMaterial;
  private readonly backgroundShadowMesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly material: MeshBasicMaterial;
  private readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private texture?: Texture;
  private backgroundTexture?: Texture;
  private requestedOpacity = 1;
  private logicalWidth = 1920;
  private logicalHeight = 1080;
  private disposed = false;

  constructor() {
    // The lightweight background image is the lowest visual layer. Keeping it
    // inside the WebGL base framebuffer is essential: the effect layer's
    // ONE/ONE additive composite must add to these pixels, rather than to a
    // transparent canvas that the browser later alpha-composites over DOM.
    this.backgroundBaseMaterial = new MeshBasicMaterial({
      color: 0x03030a,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.backgroundBaseMesh = new Mesh(new PlaneGeometry(1, 1), this.backgroundBaseMaterial);
    this.backgroundBaseMesh.name = "LightWeightBackgroundBase";
    this.backgroundBaseMesh.renderOrder = -3;

    // Both lightweight background PNGs contain transparent pixels. Preserve
    // source-alpha blending over the opaque base rather than writing their
    // alpha into the browser-facing framebuffer.
    this.backgroundMaterial = new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.backgroundMesh = new Mesh(new PlaneGeometry(1, 1), this.backgroundMaterial);
    this.backgroundMesh.name = "LightWeightBackground";
    this.backgroundMesh.renderOrder = -2;
    this.backgroundMesh.visible = false;

    // The original brightness control does not tint the RawImage. It changes
    // this separate black CanvasGroup's alpha, preserving gamma-project UI
    // blending and leaving the lane/game/effect layers unaffected.
    this.backgroundShadowMaterial = new MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: nativeBackgroundShadowAlpha(0.7),
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.backgroundShadowMesh = new Mesh(new PlaneGeometry(1, 1), this.backgroundShadowMaterial);
    this.backgroundShadowMesh.name = "LightWeightBackgroundShadow";
    this.backgroundShadowMesh.renderOrder = -1;

    this.material = new MeshBasicMaterial({
      color: new Color(0.035294119, 0.074509792, 0.180392116),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    });
    // This is a single plane. Three's default transparent DoubleSide path
    // submits separate back/front passes even though only one face can cover a
    // pixel, so a single unculled pass is visually identical.
    this.material.forceSinglePass = true;
    this.mesh = new Mesh(new PlaneGeometry(2048, 1644), this.material);
    this.mesh.name = "LaneBaseScreenSpace";
    this.mesh.renderOrder = 4000;
    this.scene.add(this.backgroundBaseMesh, this.backgroundMesh, this.backgroundShadowMesh, this.mesh);
    this.camera.position.z = 1;
    this.resize(1920, 1080);
  }

  async loadTexture(assets: OurNotesAssetManifest, loader = new TextureLoader()): Promise<void> {
    const texture = configureTexture(await loader.loadAsync(assets.lane.baseTextureUrl));
    if (this.disposed) {
      texture.dispose();
      return;
    }
    this.texture?.dispose();
    this.texture = texture;
    this.material.map = texture;
    this.material.opacity = 0.749019623 * this.requestedOpacity;
    this.mesh.visible = this.material.opacity > 0;
    this.material.needsUpdate = true;
  }

  resize(width: number, height: number): void {
    const scale = Math.max(0.0001, Math.min(width / 1920, height / 1080));
    const logicalWidth = width / scale;
    const logicalHeight = height / scale;
    this.logicalWidth = logicalWidth;
    this.logicalHeight = logicalHeight;
    this.camera.left = 0;
    this.camera.right = logicalWidth;
    this.camera.top = logicalHeight;
    this.camera.bottom = 0;
    this.camera.updateProjectionMatrix();
    // Orthographic world Y is bottom-origin, matching Unity anchoredPosition.
    // Canvas child pos(0,-247) therefore lands directly at 540-247=293.
    this.mesh.position.set(logicalWidth / 2, logicalHeight / 2 - 247, 0);
    this.backgroundBaseMesh.position.set(logicalWidth / 2, logicalHeight / 2, -3);
    this.backgroundBaseMesh.scale.set(logicalWidth, logicalHeight, 1);
    this.backgroundMesh.position.set(logicalWidth / 2, logicalHeight / 2, -2);
    this.backgroundMesh.scale.set(logicalWidth, logicalHeight, 1);
    this.backgroundShadowMesh.position.set(logicalWidth / 2, logicalHeight / 2, -1);
    this.backgroundShadowMesh.scale.set(logicalWidth, logicalHeight, 1);
    this.updateBackgroundCover();
  }

  setOpacity(opacity: number): void {
    this.requestedOpacity = clamp(opacity, 0, 1);
    const nextOpacity = (this.texture ? 0.749019623 : 0) * this.requestedOpacity;
    if (this.material.opacity !== nextOpacity) this.material.opacity = nextOpacity;
    const visible = nextOpacity > 0;
    if (this.mesh.visible !== visible) this.mesh.visible = visible;
  }

  setBackgroundTexture(texture?: Texture): void {
    this.backgroundTexture = texture;
    this.backgroundMaterial.map = texture ?? null;
    this.backgroundMesh.visible = texture !== undefined;
    this.backgroundMaterial.needsUpdate = true;
    this.updateBackgroundCover();
  }

  setBackgroundBrightness(backgroundBrightness: number): void {
    const opacity = nativeBackgroundShadowAlpha(backgroundBrightness);
    if (this.backgroundShadowMaterial.opacity !== opacity) this.backgroundShadowMaterial.opacity = opacity;
    const visible = opacity > 0;
    if (this.backgroundShadowMesh.visible !== visible) this.backgroundShadowMesh.visible = visible;
  }

  private updateBackgroundCover(): void {
    const texture = this.backgroundTexture;
    if (!texture) return;
    const image = texture.image as { width?: number; height?: number } | undefined;
    const imageWidth = Number(image?.width);
    const imageHeight = Number(image?.height);
    if (!(imageWidth > 0) || !(imageHeight > 0)) return;
    const cover = backgroundCoverUv(imageWidth, imageHeight, this.logicalWidth, this.logicalHeight);
    texture.offset.set(cover.offsetX, cover.offsetY);
    texture.repeat.set(cover.repeatX, cover.repeatY);
    texture.updateMatrix();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.texture?.dispose();
    this.backgroundBaseMesh.geometry.dispose();
    this.backgroundBaseMaterial.dispose();
    this.backgroundMesh.geometry.dispose();
    this.backgroundMaterial.dispose();
    this.backgroundShadowMesh.geometry.dispose();
    this.backgroundShadowMaterial.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.scene.clear();
  }
}

interface LaneLineStyle {
  nearWidth: number;
  farWidth: number;
  nearColor: readonly [number, number, number];
  farColor: readonly [number, number, number];
  nearAlpha: number;
  farAlpha: number;
}

const LANE_LINE_STYLES: Readonly<Record<0 | 1 | 2, LaneLineStyle>> = {
  0: {
    nearWidth: 0.15,
    farWidth: 0.3,
    nearColor: [0.6132076, 0.6132076, 0.6132076],
    farColor: [0.6156863, 0.6156863, 0.6156863],
    nearAlpha: 1,
    farAlpha: 0,
  },
  1: {
    // LiveLaneLineView reads the 16 px outside texture width and divides by
    // 100 before assigning both LineRenderer widths.
    nearWidth: 0.16,
    farWidth: 0.16,
    nearColor: [1, 1, 1],
    farColor: [1, 1, 1],
    nearAlpha: 1,
    farAlpha: 0,
  },
  2: {
    nearWidth: 0.15,
    farWidth: 0.15,
    nearColor: [0.6117647, 0.6117647, 0.6117647],
    farColor: [0.6117647, 0.6117647, 0.6117647],
    nearAlpha: 0.5019608,
    farAlpha: 0.5019608,
  },
};

const LANE_LINE_VERTEX_SHADER = `
  varying float vProgress;
  varying vec2 vUv;
  void main() {
    vProgress = uv.y;
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const LANE_LINE_FRAGMENT_SHADER = `
  uniform sampler2D uMap;
  uniform float uUseMap;
  uniform vec3 uNearColor;
  uniform vec3 uFarColor;
  uniform float uNearAlpha;
  uniform float uFarAlpha;
  uniform float uGlobalOpacity;
  varying float vProgress;
  varying vec2 vUv;
  void main() {
    vec4 texel = vec4(1.0);
    if (uUseMap > 0.5) texel = texture2D(uMap, vUv);
    gl_FragColor = vec4(
      mix(uNearColor, uFarColor, vProgress) * texel.rgb,
      mix(uNearAlpha, uFarAlpha, vProgress) * uGlobalOpacity * texel.a
    );
  }
`;

/** One shared material per serialized lane-line style; its opacity is global. */
function createLaneLineMaterial(style: LaneLineStyle): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uMap: { value: null },
      uUseMap: { value: 0 },
      uNearColor: { value: new Color(...style.nearColor) },
      uFarColor: { value: new Color(...style.farColor) },
      uNearAlpha: { value: style.nearAlpha },
      uFarAlpha: { value: style.farAlpha },
      uGlobalOpacity: { value: 1 },
    },
    vertexShader: LANE_LINE_VERTEX_SHADER,
    fragmentShader: LANE_LINE_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
}

interface LaneLineSpec {
  x: number;
  style: LaneLineStyle;
  startZ: number;
  endZ: number;
}

/**
 * Append one longitudinal lane-line quad (near/far trapezoid) to the given
 * vertex/index accumulators. The winding is reversed from Three's default
 * because reflecting Unity +Z into Three -Z flips triangle handedness; without
 * it front-face culling hides every longitudinal guideline.
 */
function appendLineGeometry(spec: LaneLineSpec, positions: number[], uvs: number[], indices: number[]): void {
  const { x, style, startZ, endZ } = spec;
  const base = positions.length / 3;
  positions.push(
    x - style.nearWidth / 2,
    0,
    startZ,
    x + style.nearWidth / 2,
    0,
    startZ,
    x - style.farWidth / 2,
    0,
    endZ,
    x + style.farWidth / 2,
    0,
    endZ,
  );
  uvs.push(0, 0, 1, 0, 0, 1, 1, 1);
  indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
}

/** Merge many same-style lane lines into one BufferGeometry = one draw call. */
function buildLaneLinesGeometry(specs: ReadonlyArray<LaneLineSpec>): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const spec of specs) appendLineGeometry(spec, positions, uvs, indices);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("uv", new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  return geometry;
}

export class OurNotesStage {
  readonly group = new Group();

  private readonly projector: StageProjector;
  private readonly judgementMaterial: MeshBasicMaterial;
  private readonly judgementMesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly tapAreaMaterial: ShaderMaterial;
  private readonly tapAreaMesh: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly guidelineGroup = new Group();
  private readonly outsideGroup = new Group();
  // One shared material + one merged geometry per lane-line style: the entire
  // guideline set (main + space + outside) costs three draw calls instead of
  // one per serialized line.
  private readonly mainLinesMaterial = createLaneLineMaterial(LANE_LINE_STYLES[0]);
  private readonly spaceLinesMaterial = createLaneLineMaterial(LANE_LINE_STYLES[2]);
  private readonly outsideLinesMaterial = createLaneLineMaterial(LANE_LINE_STYLES[1]);
  private readonly lineMaterials: ReadonlyArray<ShaderMaterial> = [
    this.mainLinesMaterial,
    this.spaceLinesMaterial,
    this.outsideLinesMaterial,
  ];
  private mainLinesMesh!: Mesh<BufferGeometry, ShaderMaterial>;
  private spaceLinesMesh!: Mesh<BufferGeometry, ShaderMaterial>;
  private readonly outsideLinesMesh: Mesh<BufferGeometry, ShaderMaterial>;
  private guidelineCount = -1;
  private tapAreaTexture?: Texture;
  private outsideLineTexture?: Texture;
  private laneOpacity = Number.NaN;
  private guidelineOpacity = Number.NaN;
  private judgementOpacity = Number.NaN;
  private disposed = false;

  constructor(projector: StageProjector, assets: OurNotesAssetManifest) {
    this.projector = projector;
    void assets;

    this.group.name = "OurNotesStage";
    this.tapAreaMaterial = new ShaderMaterial({
      uniforms: {
        uMap: { value: null },
        uOpacity: { value: 0 },
        uTargetSize: {
          value: {
            x: OUR_NOTES_LIVE_GEOMETRY.tapAreaSize[0],
            y: OUR_NOTES_LIVE_GEOMETRY.tapAreaSize[1],
          },
        },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;
        uniform float uOpacity;
        uniform vec2 uTargetSize;
        varying vec2 vUv;
        float nineSliceAxis(float uv, float targetSize) {
          const float sourceBorder = 46.0 / 96.0;
          const float worldBorder = 0.46;
          float position = uv * targetSize;
          if (position < worldBorder) return position / worldBorder * sourceBorder;
          if (position > targetSize - worldBorder) {
            return 1.0 - (targetSize - position) / worldBorder * sourceBorder;
          }
          float middle = max(0.0001, targetSize - worldBorder * 2.0);
          return sourceBorder + (position - worldBorder) / middle * (1.0 - sourceBorder * 2.0);
        }
        void main() {
          vec2 slicedUv = vec2(nineSliceAxis(vUv.x, uTargetSize.x), nineSliceAxis(vUv.y, uTargetSize.y));
          vec4 texel = texture2D(uMap, slicedUv);
          gl_FragColor = vec4(texel.rgb, texel.a * uOpacity);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    });
    this.judgementMaterial = new MeshBasicMaterial({
      color: 0xfaf6ff,
      transparent: true,
      // JudgePositionDisplay (OptionItemType 105) is FALSE in all three
      // default presets, so the serialized LineRenderer exists but must
      // start hidden until explicitly enabled.
      opacity: 0,
      depthWrite: false,
      // Three's camera looks down local -Z whereas Unity LineRenderer emits
      // the camera-facing winding for +Z. Preserve the same visible face.
      side: DoubleSide,
      toneMapped: false,
    });
    this.judgementMaterial.forceSinglePass = true;
    // The two anchored outside lines merge into one geometry. Their centers
    // are shifted outward by half the serialized .17 start width.
    const outsideEndZ = unityWorldZToThree(OUR_NOTES_LIVE_GEOMETRY.laneLength);
    const outsideSpecs: LaneLineSpec[] = [-1, 1].map((side) => ({
      x: side * (projector.stageWidth / 2 + LANE_LINE_STYLES[1].nearWidth / 2),
      style: LANE_LINE_STYLES[1],
      startZ: 0,
      endZ: outsideEndZ,
    }));
    this.outsideLinesMesh = new Mesh(buildLaneLinesGeometry(outsideSpecs), this.outsideLinesMaterial);
    this.outsideLinesMesh.name = "LaneOutside";
    this.outsideLinesMesh.renderOrder = OUR_NOTES_LIVE_GEOMETRY.sortingOrders.laneLine;
    this.outsideGroup.add(this.outsideLinesMesh);
    this.group.add(this.outsideGroup);

    const tapArea = (this.tapAreaMesh = new Mesh(
      new PlaneGeometry(OUR_NOTES_LIVE_GEOMETRY.tapAreaSize[0], OUR_NOTES_LIVE_GEOMETRY.tapAreaSize[1]),
      this.tapAreaMaterial,
    ));
    tapArea.name = "LaneTapArea";
    // Transform_144.asset is Unity X=-90 degrees. Reflecting Z converts it
    // to Three X=+90 degrees.
    tapArea.rotation.x = Math.PI / 2;
    tapArea.position.set(0, 0, projector.judgementZ);
    tapArea.renderOrder = OUR_NOTES_LIVE_GEOMETRY.sortingOrders.tapArea;
    this.group.add(tapArea);

    const judgementLine = (this.judgementMesh = new Mesh(
      new PlaneGeometry(OUR_NOTES_LIVE_GEOMETRY.judgementLineSize[0], OUR_NOTES_LIVE_GEOMETRY.judgementLineSize[1]),
      this.judgementMaterial,
    ));
    judgementLine.name = "JudgementLine";
    // LineRenderer_2.asset uses alignment=View. Local Y follows camera-up,
    // rather than lying flat on the XZ lane plane like the tap-area sprite.
    judgementLine.rotation.x = (-OUR_NOTES_LIVE_GEOMETRY.cameraXDegrees * Math.PI) / 180;
    judgementLine.position.set(0, 0, projector.judgementZ);
    judgementLine.renderOrder = OUR_NOTES_LIVE_GEOMETRY.sortingOrders.laneLine;
    judgementLine.visible = false;
    this.group.add(judgementLine);

    this.group.add(this.guidelineGroup);
    this.setGuidelineCount(12);
  }

  async loadTextures(assets: OurNotesAssetManifest, loader = new TextureLoader()): Promise<void> {
    const [tapAreaResult, outsideLineResult] = await Promise.allSettled([
      loader.loadAsync(assets.lane.tapAreaTextureUrl),
      loader.loadAsync(assets.lane.outsideLineTextureUrl),
    ]);
    if (this.disposed) {
      if (tapAreaResult.status === "fulfilled") tapAreaResult.value.dispose();
      if (outsideLineResult.status === "fulfilled") outsideLineResult.value.dispose();
      return;
    }
    if (tapAreaResult.status === "fulfilled") {
      this.tapAreaTexture?.dispose();
      this.tapAreaTexture = configureTexture(tapAreaResult.value);
      this.tapAreaMaterial.uniforms.uMap.value = this.tapAreaTexture;
      this.tapAreaMaterial.uniforms.uOpacity.value = Number.isFinite(this.laneOpacity) ? this.laneOpacity : 1;
      this.tapAreaMesh.visible = this.tapAreaMaterial.uniforms.uOpacity.value > 0;
      this.tapAreaMaterial.needsUpdate = true;
    }
    if (outsideLineResult.status === "fulfilled") {
      this.outsideLineTexture?.dispose();
      this.outsideLineTexture = configureTexture(outsideLineResult.value);
      this.outsideLinesMaterial.uniforms.uMap.value = this.outsideLineTexture;
      this.outsideLinesMaterial.uniforms.uUseMap.value = 1;
      this.outsideLinesMaterial.needsUpdate = true;
    }
    const errors: unknown[] = [];
    if (tapAreaResult.status === "rejected") errors.push(tapAreaResult.reason);
    if (outsideLineResult.status === "rejected") errors.push(outsideLineResult.reason);
    if (errors.length > 0) throw new AggregateError(errors, "One or more native lane textures failed to load");
  }

  update(state: RenderStageState | undefined): void {
    const laneOpacity = clamp(state?.laneOpacity ?? 1, 0, 1);
    const guidelineOpacity = clamp(state?.guidelineOpacity ?? 1, 0, 1);
    const judgementOpacity = clamp(state?.judgementLineOpacity ?? 0, 0, 1);
    void state?.backgroundBrightness;
    if (state?.guidelineCount !== undefined) this.setGuidelineCount(state.guidelineCount);
    if (laneOpacity !== this.laneOpacity) {
      this.laneOpacity = laneOpacity;
      this.tapAreaMaterial.uniforms.uOpacity.value = (this.tapAreaTexture ? 1 : 0) * laneOpacity;
      this.tapAreaMesh.visible = this.tapAreaMaterial.uniforms.uOpacity.value > 0;
    }
    if (guidelineOpacity !== this.guidelineOpacity) {
      this.guidelineOpacity = guidelineOpacity;
      for (const material of this.lineMaterials) material.uniforms.uGlobalOpacity.value = guidelineOpacity;
      const visible = guidelineOpacity > 0;
      this.guidelineGroup.visible = visible;
      this.outsideGroup.visible = visible;
    }
    if (judgementOpacity !== this.judgementOpacity) {
      this.judgementOpacity = judgementOpacity;
      this.judgementMaterial.opacity = 0.4 * judgementOpacity;
      this.judgementMesh.visible = judgementOpacity > 0;
    }
  }

  setGuidelineCount(count: number): void {
    const normalized = [0, 4, 6, 8, 12].includes(Math.round(count)) ? Math.round(count) : 12;
    if (normalized === this.guidelineCount) return;
    this.guidelineCount = normalized;
    this.guidelineOpacity = Number.NaN;
    // The main/sub guideline tables are main=[0,4,6,8,12], sub=[12,12,12,0,0].
    // Runtime laneCount is the chart's 24 half lanes, so Lane12 emits full
    // lines every two indices, while None/Lane4/Lane6 retain short Space
    // ticks at the remaining 12-way boundaries.
    const laneCount = this.projector.laneCount;
    const spaceCount = normalized <= 6 ? 12 : 0;
    const mainDivisor = normalized > 0 ? Math.trunc(laneCount / normalized) : 0;
    const spaceDivisor = spaceCount > 0 ? Math.trunc(laneCount / spaceCount) : 0;
    const fullEndZ = unityWorldZToThree(OUR_NOTES_LIVE_GEOMETRY.laneLength);
    const mainSpecs: LaneLineSpec[] = [];
    const spaceSpecs: LaneLineSpec[] = [];
    for (let index = 1; index < laneCount; index += 1) {
      const isMainLine = mainDivisor > 0 && index % mainDivisor === 0;
      const isSpaceLine = !isMainLine && spaceDivisor > 0 && index % spaceDivisor === 0;
      if (!isMainLine && !isSpaceLine) continue;
      const x = (index / laneCount - 0.5) * this.projector.stageWidth;
      if (isSpaceLine) {
        spaceSpecs.push({
          x,
          style: LANE_LINE_STYLES[2],
          startZ: this.projector.judgementZ + OUR_NOTES_LIVE_GEOMETRY.laneSpaceLineLength / 2,
          endZ: this.projector.judgementZ - OUR_NOTES_LIVE_GEOMETRY.laneSpaceLineLength / 2,
        });
      } else {
        mainSpecs.push({ x, style: LANE_LINE_STYLES[0], startZ: 0, endZ: fullEndZ });
      }
    }
    this.mainLinesMesh = this.applyGuidelineMesh(
      this.mainLinesMesh,
      this.mainLinesMaterial,
      mainSpecs,
      "LaneGuideline",
    );
    this.spaceLinesMesh = this.applyGuidelineMesh(
      this.spaceLinesMesh,
      this.spaceLinesMaterial,
      spaceSpecs,
      "LaneSpace",
    );
  }

  private applyGuidelineMesh(
    mesh: Mesh<BufferGeometry, ShaderMaterial> | undefined,
    material: ShaderMaterial,
    specs: ReadonlyArray<LaneLineSpec>,
    name: string,
  ): Mesh<BufferGeometry, ShaderMaterial> {
    const geometry = buildLaneLinesGeometry(specs);
    if (mesh) {
      mesh.geometry.dispose();
      mesh.geometry = geometry;
    } else {
      mesh = new Mesh(geometry, material);
      mesh.renderOrder = OUR_NOTES_LIVE_GEOMETRY.sortingOrders.laneLine;
      this.guidelineGroup.add(mesh);
    }
    mesh.name = name;
    mesh.visible = specs.length > 0;
    return mesh;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tapAreaTexture?.dispose();
    this.outsideLineTexture?.dispose();
    this.group?.traverse((object) => {
      if (object instanceof Mesh) object.geometry.dispose();
    });
    this.tapAreaMaterial?.dispose();
    for (const material of this.lineMaterials) material.dispose();
    this.judgementMaterial?.dispose();
    this.group?.clear();
  }
}
