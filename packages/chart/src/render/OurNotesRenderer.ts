import {
  Color,
  Group,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import type { Texture } from "three";
import { OUR_NOTES_LIVE_GEOMETRY } from "../assets/manifest";
import { SpriteAtlas } from "../assets/SpriteAtlas";
import { HoldRibbonLayer } from "./HoldRibbon";
import { HudLayer } from "./HudLayer";
import { liveEffectFrameAction, LiveUrpBloomPipeline, liveEffectFrameIndex } from "./LiveUrpBloom";
import { NoteLayer } from "./NoteLayer";
import { ParticleLayer } from "./ParticleLayer";
import { SimultaneousLineLayer } from "./SimultaneousLineLayer";
import { OurNotesStage, ScreenLaneBackdrop, StageProjector } from "./stageGeometry";
import {
  isRenderLaneEffectKind,
  type OurNotesRendererOptions,
  type OurNotesRendererStats,
  type RenderFrame,
} from "./types";

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

export interface RotatedContentSpace {
  hostLeft: number;
  hostTop: number;
  hostWidth: number;
  hostHeight: number;
  contentWidth: number;
  contentHeight: number;
  angleRadians: number;
}

/** Invert the centered CSS rotation used by RotatableViewport. */
export function clientPointInRotatedContent(
  clientX: number,
  clientY: number,
  space: RotatedContentSpace,
): { x: number; y: number } {
  const cos = Math.cos(space.angleRadians);
  const sin = Math.sin(space.angleRadians);
  const deltaX = clientX - (space.hostLeft + space.hostWidth / 2);
  const deltaY = clientY - (space.hostTop + space.hostHeight / 2);
  return {
    x: cos * deltaX + sin * deltaY + space.contentWidth / 2,
    y: -sin * deltaX + cos * deltaY + space.contentHeight / 2,
  };
}

/** Configure the LiveGameCamera after Unity +Z -> Three -Z reflection. */
export function configureOurNotesCamera(camera: PerspectiveCamera): PerspectiveCamera {
  camera.position.fromArray(OUR_NOTES_LIVE_GEOMETRY.cameraPosition);
  const pitch = (OUR_NOTES_LIVE_GEOMETRY.cameraXDegrees * Math.PI) / 180;
  const forward = new Vector3(0, -Math.sin(pitch), -Math.cos(pitch));
  camera.lookAt(camera.position.clone().add(forward.multiplyScalar(100)));
  camera.updateMatrixWorld(true);
  return camera;
}

/**
 * Rendering adapter for the original Our Notes live scene. Simulation and
 * judgement stay outside Three.js and enter as synchronously consumed RenderFrame DTOs.
 */
export class OurNotesRenderer {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly projector: StageProjector;
  readonly renderer: WebGLRenderer;
  readonly assetErrors: Error[] = [];

  private readonly options: OurNotesRendererOptions;
  private readonly stage: OurNotesStage;
  private readonly screenLane: ScreenLaneBackdrop;
  private readonly holds: HoldRibbonLayer;
  private readonly simultaneousLines: SimultaneousLineLayer;
  private readonly notes: NoteLayer;
  private readonly particles: ParticleLayer;
  private readonly effectScene = new Scene();
  private readonly liveBloom = new LiveUrpBloomPipeline();
  private readonly screenRoot = new Group();
  private readonly hud?: HudLayer;
  private atlas?: SpriteAtlas;
  private backgroundTexture?: Texture;
  private loadPromise?: Promise<void>;
  private assetsReady = false;
  private contextLost = false;
  private disposed = false;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private sized = false;
  private counts = { notes: 0, holds: 0, particleEffects: 0 };
  private readonly laneProjectionLeft = new Vector3();
  private readonly laneProjectionRight = new Vector3();
  private laneProjectionLeftNdcX = -1;
  private laneProjectionRightNdcX = 1;
  private readonly drawingBufferSize = new Vector2();
  private lastEffectFrame = -1;
  private effectCacheActive = false;
  private particleStateActive = false;
  private backgroundLoadRevision = 0;
  private effectRefreshed = false;

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
  };

  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    this.renderer.resetState();
    this.liveBloom.invalidate();
    this.effectCacheActive = false;
    this.lastEffectFrame = -1;
  };

  constructor(options: OurNotesRendererOptions) {
    this.options = options;
    const assets = options.assets;
    this.projector = new StageProjector({
      laneCount: options.laneCount,
      stageWidth: options.stageWidth,
      judgementZ: options.judgementZ,
      horizonZ: options.horizonZ,
      spawnY: options.spawnY,
    });

    this.camera = new PerspectiveCamera(
      OUR_NOTES_LIVE_GEOMETRY.cameraFovDegrees,
      1,
      OUR_NOTES_LIVE_GEOMETRY.cameraNear,
      OUR_NOTES_LIVE_GEOMETRY.cameraFar,
    );
    configureOurNotesCamera(this.camera);
    this.camera.add(this.screenRoot);
    // Unity's camera looks along local +Z, while Three.js looks along -Z.
    // Transform_203.asset is otherwise reproduced verbatim as a camera child.
    this.screenRoot.name = "OurNotesScreenRoot";
    this.screenRoot.position.set(0, 0, -OUR_NOTES_LIVE_GEOMETRY.screenRootZ);
    this.camera.updateMatrixWorld(true);

    this.renderer = new WebGLRenderer({
      canvas: options.canvas,
      antialias: options.antialias ?? true,
      alpha: options.alpha ?? true,
      powerPreference: "high-performance",
      premultipliedAlpha: true,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    // Accumulate diagnostics across the base, effect and composite passes.
    // The default auto reset would report only the final pass.
    this.renderer.info.autoReset = false;
    this.renderer.setClearColor(new Color(options.backgroundColor ?? "#030816"), options.backgroundAlpha ?? 0);

    this.stage = new OurNotesStage(this.projector, assets);
    this.screenLane = new ScreenLaneBackdrop();
    this.holds = new HoldRibbonLayer(this.projector, assets);
    this.simultaneousLines = new SimultaneousLineLayer(this.projector);
    this.notes = new NoteLayer(this.projector, assets);
    this.particles = new ParticleLayer(this.projector, assets, options.maxParticleEffects, options.particlesPerEffect);
    this.screenRoot.add(this.holds.group, this.simultaneousLines.group, this.notes.group);
    this.scene.add(this.camera, this.stage.group, this.particles.laneInputGroup);
    // LiveEffectCamera.asset is a separate layer-29 HDR camera with URP post
    // processing. Its Transform_131 is an identity child of LiveGameCamera,
    // so rendering the effectScene through this exact same camera preserves
    // the native view/projection without any screenshot-derived offset.
    // Keeping particles out of the layer-25 base scene prevents Bloom from
    // affecting the stage, notes, holds, WebGL background or HUD.
    this.effectScene.add(this.particles.group);
    this.renderer.autoClear = false;
    if (options.hudCanvas) this.hud = new HudLayer(options.hudCanvas, assets);

    options.canvas.addEventListener("webglcontextlost", this.onContextLost, false);
    options.canvas.addEventListener("webglcontextrestored", this.onContextRestored, false);
    const initialWidth = Math.max(1, options.canvas.clientWidth || options.canvas.width || 1);
    const initialHeight = Math.max(1, options.canvas.clientHeight || options.canvas.height || 1);
    this.resize(initialWidth, initialHeight, options.pixelRatio);
  }

  /** Idempotently load prepared runtime resources. Missing visual media is omitted. */
  load(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("OurNotesRenderer is disposed"));
    if (!this.loadPromise) this.loadPromise = this.loadAssets();
    return this.loadPromise;
  }

  /** Surface native-resource failures without substituting unrelated visuals. */
  reportAssetError(reason: unknown): Error {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    this.assetErrors.push(error);
    globalThis.console?.warn?.("[OurNotesRenderer] Native asset omitted", error);
    return error;
  }

  private async loadAssets(): Promise<void> {
    const assets = this.options.assets;
    const results = await Promise.allSettled([
      SpriteAtlas.load(assets.noteAtlas),
      this.screenLane.loadTexture(assets),
      this.stage.loadTextures(assets),
      this.holds.loadTexture(),
      this.particles.loadTextures(),
      this.hud?.loadAssets() ?? Promise.resolve(),
    ]);
    if (this.disposed) {
      if (results[0].status === "fulfilled") results[0].value.dispose();
      return;
    }
    if (results[0].status === "fulfilled") {
      this.notes.setAtlas(undefined);
      this.atlas?.dispose();
      this.atlas = results[0].value;
      this.notes.setAtlas(this.atlas);
    }
    for (const result of results) {
      if (result.status === "rejected") this.reportAssetError(result.reason);
    }
    this.assetsReady = true;
    // A paused frame may stay in one native 30-fps bucket while the decoded
    // effect assets arrive. Force that bucket to be rendered again.
    this.liveBloom.invalidate();
    this.effectCacheActive = false;
  }

  render(frame: RenderFrame): void {
    if (this.disposed || this.contextLost) return;
    this.renderer.info.reset();
    this.stage.update(frame.stage);
    this.screenLane?.setOpacity(frame.stage?.laneOpacity ?? 1);
    this.screenLane?.setBackgroundBrightness(frame.stage?.backgroundBrightness ?? 0.7);
    this.holds.update(frame.holds, frame.time);
    this.simultaneousLines.update(frame.simultaneousLines);
    this.notes.update(frame.notes);
    this.particles.updateLaneInput(frame.particles);
    this.renderer.clear(true, true, true);
    if (this.screenLane) {
      this.renderer.render(this.screenLane.scene, this.screenLane.camera);
      this.renderer.clearDepth();
    }
    this.renderer.render(this.scene, this.camera);
    const particleEffectCount = frame.particles?.length ?? 0;
    let noteParticleEffectCount = 0;
    for (const effect of frame.particles ?? []) if (!isRenderLaneEffectKind(effect.kind)) noteParticleEffectCount += 1;
    const effectAction = liveEffectFrameAction(
      noteParticleEffectCount,
      this.particleStateActive,
      this.effectCacheActive,
      this.lastEffectFrame,
      frame.time,
    );
    this.effectRefreshed = effectAction === "refresh";
    if (effectAction === "refresh") {
      const nativeEffectFrame = liveEffectFrameIndex(frame.time);
      // MonoBehaviour_45 keeps the base camera at 60 fps but renders the HDR
      // effect camera at 30. ParticleLayer samples absolute-age state, so
      // duplicate 60-fps base ticks in one native bucket need neither another
      // simulation pass nor another HDR render.
      this.particles.update(frame.particles);
      this.particleStateActive = true;
      this.camera.updateMatrixWorld(true);
      this.liveBloom.renderEffect(this.renderer, () => this.renderer.render(this.effectScene, this.camera));
      this.effectCacheActive = true;
      this.lastEffectFrame = nativeEffectFrame;
      this.liveBloom.composite(this.renderer);
    } else if (effectAction === "reuse") {
      this.liveBloom.composite(this.renderer);
    } else if (effectAction === "release") {
      if (this.particleStateActive) this.particles.update(undefined);
      this.particleStateActive = false;
      this.liveBloom.invalidate();
      this.effectCacheActive = false;
      this.lastEffectFrame = -1;
    }
    this.hud?.draw(frame.hud);
    let noteCount = 0;
    for (const note of frame.notes ?? []) if (note.visible !== false) noteCount += 1;
    let holdCount = 0;
    for (const hold of frame.holds ?? []) if (hold.visible !== false) holdCount += 1;
    this.counts.notes = noteCount;
    this.counts.holds = holdCount;
    this.counts.particleEffects = particleEffectCount;
  }

  resize(
    width: number,
    height: number,
    pixelRatio = this.options.pixelRatio ?? globalThis.devicePixelRatio ?? 1,
  ): void {
    if (this.disposed) return;
    const nextWidth = Math.max(1, width);
    const nextHeight = Math.max(1, height);
    const nextPixelRatio = clamp(pixelRatio, 0.5, 3);
    if (
      this.sized &&
      Math.abs(nextWidth - this.width) < 0.01 &&
      Math.abs(nextHeight - this.height) < 0.01 &&
      nextPixelRatio === this.pixelRatio
    )
      return;
    const pixelRatioChanged = !this.sized || nextPixelRatio !== this.pixelRatio;
    this.width = nextWidth;
    this.height = nextHeight;
    this.pixelRatio = nextPixelRatio;
    this.sized = true;
    if (pixelRatioChanged) this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(this.width, this.height, false);
    this.options.canvas.style.width = `${this.width}px`;
    this.options.canvas.style.height = `${this.height}px`;
    const currentAspect = this.width / this.height;
    const boundedAspect = Math.min(currentAspect, 16 / 9);
    const baseHalfFov = (OUR_NOTES_LIVE_GEOMETRY.cameraFovDegrees * Math.PI) / 360;
    this.camera.fov = (2 * Math.atan((Math.tan(baseHalfFov) * (16 / 9)) / boundedAspect) * 180) / Math.PI;
    this.camera.aspect = currentAspect;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
    this.updateLaneProjection();
    this.screenLane?.resize(this.width, this.height);
    this.renderer.getDrawingBufferSize(this.drawingBufferSize);
    this.liveBloom.setSize(this.drawingBufferSize.x, this.drawingBufferSize.y);
    this.effectCacheActive = false;
    this.lastEffectFrame = -1;
    this.particles.setPixelRatio(this.pixelRatio);
    this.hud?.resize(this.width, this.height, this.pixelRatio);
  }

  /** Convert DOM client coordinates to a half-lane, or -1 outside the judgement span. */
  clientPointToLane(clientX: number, clientY: number): number {
    const canvas = this.options.canvas;
    const rotationRoot = canvas.closest<HTMLElement>("[data-runtime-rotation]");
    const rotationHost = rotationRoot?.parentElement;
    if (rotationRoot && rotationHost) {
      let offsetX = 0;
      let offsetY = 0;
      let node: HTMLElement | null = canvas;
      while (node && node !== rotationRoot) {
        offsetX += node.offsetLeft;
        offsetY += node.offsetTop;
        node = node.offsetParent as HTMLElement | null;
      }

      if (node === rotationRoot) {
        const transform = getComputedStyle(rotationRoot).transform;
        const matrix = transform === "none" ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(transform);
        const angle = Math.atan2(matrix.b, matrix.a);
        const hostRect = rotationHost.getBoundingClientRect();
        const point = clientPointInRotatedContent(clientX, clientY, {
          hostLeft: hostRect.left,
          hostTop: hostRect.top,
          hostWidth: hostRect.width,
          hostHeight: hostRect.height,
          contentWidth: rotationRoot.clientWidth,
          contentHeight: rotationRoot.clientHeight,
          angleRadians: angle,
        });
        return this.canvasPointToLane(point.x - offsetX, point.y - offsetY, canvas.clientWidth, canvas.clientHeight);
      }
    }

    const rect = canvas.getBoundingClientRect();
    return this.canvasPointToLane(clientX - rect.left, clientY - rect.top, rect.width, rect.height);
  }

  /** Convert CSS-pixel canvas coordinates to native continuous lane centres (0..23). */
  canvasPointToLane(x: number, y: number, canvasWidth = this.width, canvasHeight = this.height): number {
    const width = Math.max(1, canvasWidth);
    const height = Math.max(1, canvasHeight);
    void y;
    // ScreenTouchInputProvider and LiveNoteViewJudgementRoot2D consume the
    // same LaneViewSettings.JudgementPositions array. In this renderer those
    // are the screen_root-local endpoints, not the physical 3D effect root.
    const left = (this.laneProjectionLeftNdcX * 0.5 + 0.5) * width;
    const right = (this.laneProjectionRightNdcX * 0.5 + 0.5) * width;
    // MasterLiveJudgementAreaOffset assist=0 stores maxOffset.x=3. Native
    // multiplies that by its 100 px/unit constant before the bounds check.
    const referenceScale = Math.min(width / 1920, height / 1080);
    const margin = 300 * referenceScale;
    if (x < left - margin || x > right + margin) return -1;
    if (x <= left) return 0;
    if (x >= right) return this.projector.laneCount - 1;
    return ((x - left) / Math.max(0.000001, right - left)) * (this.projector.laneCount - 1);
  }

  /** Camera and screen_root are static between resizes, so cache their projected lane span. */
  private updateLaneProjection(): void {
    this.laneProjectionLeftNdcX = this.screenRoot
      .localToWorld(
        this.laneProjectionLeft.set(this.projector.laneCenterToX(0, 1), OUR_NOTES_LIVE_GEOMETRY.screenJudgementY, 0),
      )
      .project(this.camera).x;
    this.laneProjectionRightNdcX = this.screenRoot
      .localToWorld(
        this.laneProjectionRight.set(
          this.projector.laneCenterToX(this.projector.laneCount - 1, 1),
          OUR_NOTES_LIVE_GEOMETRY.screenJudgementY,
          0,
        ),
      )
      .project(this.camera).x;
  }

  async setBackgroundTexture(url?: string, loader = new TextureLoader()): Promise<void> {
    const revision = ++this.backgroundLoadRevision;
    if (!url) {
      this.backgroundTexture?.dispose();
      this.backgroundTexture = undefined;
      this.screenLane.setBackgroundTexture(undefined);
      return;
    }
    // Do not clear the current stage while the replacement is in flight. A
    // rapid 1 -> 2 -> 1 switch can resolve out of order on the asset proxy, so
    // only the latest request may swap ownership into the renderer.
    const texture = await loader.loadAsync(url);
    if (this.disposed || revision !== this.backgroundLoadRevision) {
      texture.dispose();
      return;
    }
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = 4;
    texture.needsUpdate = true;
    const previous = this.backgroundTexture;
    this.backgroundTexture = texture;
    this.screenLane.setBackgroundTexture(texture);
    previous?.dispose();
  }

  get stats(): OurNotesRendererStats {
    const noteStats = this.notes.stats;
    const holdStats = this.holds.stats;
    const particleStats = this.particles.stats;
    return {
      ...this.counts,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      activeNoteVisuals: noteStats.activeVisuals,
      activeHoldVisuals: holdStats.activeVisuals,
      renderedParticles: particleStats.renderedParticles,
      effectRefreshed: this.effectRefreshed,
      cachedSpriteTextureViews: this.atlas?.stats.cachedTextureViews ?? 0,
      assetsReady: this.assetsReady,
      contextLost: this.contextLost,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.backgroundLoadRevision += 1;
    this.options.canvas.removeEventListener("webglcontextlost", this.onContextLost, false);
    this.options.canvas.removeEventListener("webglcontextrestored", this.onContextRestored, false);
    this.notes.dispose();
    this.simultaneousLines.dispose();
    this.holds.dispose();
    this.particles.dispose();
    this.liveBloom.dispose();
    this.stage.dispose();
    this.screenLane?.dispose();
    this.hud?.dispose();
    this.atlas?.dispose();
    this.atlas = undefined;
    this.backgroundTexture?.dispose();
    this.backgroundTexture = undefined;
    this.scene.clear();
    this.effectScene.clear();
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
  }
}
