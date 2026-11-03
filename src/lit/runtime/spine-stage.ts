import type * as Spine from "@esotericsoftware/spine-threejs";
import type * as THREE from "three";
import { viewerBufferSize } from "./viewer-resolution";
import { ViewportRenderLoop } from "./viewport-render-loop";

type Value = Record<string, unknown>;
type Resource = { name?: string; url?: string };
export type SpineTransform = { offsetX: number; offsetY: number; scale: number };
export type SpineBackground = { r: number; g: number; b: number } | null;
interface Entry extends Value {
  animations?: string[];
  atlases?: Array<{ pages?: Resource[] }>;
  runtime?: { atlas?: Resource; json?: Resource; format?: string; scale?: number; status?: string };
  scale?: number;
  skins?: string[];
}
interface Loaded {
  three: typeof THREE;
  spine: typeof Spine;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  mesh: Spine.SkeletonMesh;
  atlas: Spine.TextureAtlas;
  bitmaps: ImageBitmap[];
}
type Batcher = THREE.Mesh & {
  clear(): unknown;
  findMaterialGroup(texture: THREE.Texture, blend: unknown): number;
  newMaterial(): THREE.Material & { map: THREE.Texture | null };
  material: THREE.Material[];
};

async function readAsset<T>(url: string, signal: AbortSignal, read: (response: Response) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(
    () => controller.abort(new DOMException("Spine asset request timed out", "TimeoutError")),
    30_000,
  );
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Spine asset request failed: HTTP ${response.status}`);
    return await read(response);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export function installPainterOrder(mesh: Spine.SkeletonMesh, spine: typeof Spine) {
  const internals = mesh as unknown as { nextBatch(): Batcher };
  const next = internals.nextBatch.bind(mesh);
  const configured = new WeakSet<Batcher>();
  const assignments = new WeakMap<THREE.Material, { texture: THREE.Texture; blend: unknown }>();
  const blendSettings = new Map<Spine.BlendMode, ReturnType<typeof spine.ThreeJsTexture.toThreeJsBlending>>();
  internals.nextBatch = () => {
    const batch = next();
    if (configured.has(batch)) return batch;
    configured.add(batch);
    let cursor = 0;
    const clear = batch.clear.bind(batch);
    batch.clear = () => {
      cursor = 0;
      return clear();
    };
    batch.findMaterialGroup = (texture, blend) => {
      const index = cursor++;
      const material =
        (batch.material[index] as (THREE.Material & { map: THREE.Texture | null }) | undefined) ?? batch.newMaterial();
      if (!batch.material[index]) batch.material.push(material);
      const mode = blend as Spine.BlendMode;
      let blending = blendSettings.get(mode);
      if (!blending) {
        blending = spine.ThreeJsTexture.toThreeJsBlending(mode);
        blendSettings.set(mode, blending);
      }
      const previous = assignments.get(material);
      // MeshBatcher.clear resets map/blending before every geometry update.
      material.map = texture;
      Object.assign(material, blending);
      if (!previous || previous.texture !== texture || previous.blend !== blend) {
        material.needsUpdate = true;
        assignments.set(material, { texture, blend });
      }
      return index;
    };
    return batch;
  };
}

export class SpineStage {
  private active?: Loaded;
  private request?: AbortController;
  private renderLoop?: ViewportRenderLoop;
  private lastFrame = 0;
  private observer?: ResizeObserver;
  private paused = false;
  private loop = true;
  private animation = "";
  private playbackRate = 1;
  private background: SpineBackground = null;
  private transform: SpineTransform = { offsetX: 0, offsetY: 0, scale: 1 };
  private fit?: { centerX: number; centerY: number; width: number; height: number };
  private bounds?: { x: number; y: number; width: number; height: number };
  private authoredBounds?: { x: number; y: number; width: number; height: number };
  private skin = "";

  constructor(private readonly host: HTMLElement) {}

  async load(entry: Entry, signal?: AbortSignal) {
    this.dispose();
    const controller = new AbortController();
    this.request = controller;
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const check = () => {
      if (controller.signal.aborted || this.request !== controller)
        throw new DOMException("Spine loading was cancelled", "AbortError");
    };
    const partial: {
      atlas?: Spine.TextureAtlas;
      mesh?: Spine.SkeletonMesh;
      renderer?: THREE.WebGLRenderer;
      bitmaps: ImageBitmap[];
    } = { bitmaps: [] };
    let committed = false;
    try {
      check();
      const runtime = entry.runtime;
      const binary = runtime?.format === "binary";
      const atlasUrl = String(runtime?.atlas?.url || "");
      const skeletonUrl = String(runtime?.json?.url || "");
      const pages = (entry.atlases || []).flatMap((atlas) => atlas.pages || []).filter((page) => page.name && page.url);
      if (runtime?.status !== "ready" || !atlasUrl || !skeletonUrl || !pages.length)
        throw new Error("Spine model is not browser-ready");
      const [three, spine, atlasText, skeletonSource] = await Promise.all([
        import("three"),
        import("@esotericsoftware/spine-threejs"),
        readAsset(atlasUrl, controller.signal, (response) => response.text()),
        readAsset(skeletonUrl, controller.signal, (response) => binary ? response.arrayBuffer() : response.json()),
      ]);
      check();
      const atlas = new spine.TextureAtlas(atlasText);
      partial.atlas = atlas;
      const exactPages = new Map(pages.map((page) => [String(page.name), page]));
      const bitmaps = partial.bitmaps;
      for (const page of atlas.pages) {
        const resource = exactPages.get(page.name);
        if (!resource?.url) throw new Error(`Missing atlas page: ${page.name}`);
        const blob = await readAsset(resource.url, controller.signal, (response) => response.blob());
        check();
        const bitmap = await createImageBitmap(blob, {
          premultiplyAlpha: page.pma ? "none" : "premultiply",
          colorSpaceConversion: "none",
        });
        bitmaps.push(bitmap);
        check();
        page.setTexture(new spine.ThreeJsTexture(bitmap, true));
      }
      const parser = binary
        ? new spine.SkeletonBinary(new spine.AtlasAttachmentLoader(atlas))
        : new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas));
      parser.scale = Number(runtime.scale ?? entry.scale ?? 1);
      check();
      const skeletonData = parser.readSkeletonData(binary ? new Uint8Array(skeletonSource) : skeletonSource);
      // Some animations begin with every attachment hidden. The exported
      // skeleton bounds reserve their framing until those attachments appear.
      this.authoredBounds = {
        x: skeletonData.x * parser.scale,
        y: skeletonData.y * parser.scale,
        width: skeletonData.width * parser.scale,
        height: skeletonData.height * parser.scale,
      };
      const mesh = new spine.SkeletonMesh({
        skeletonData,
        twoColorTint: true,
        materialFactory: (parameters) =>
          new three.MeshBasicMaterial({ ...parameters, depthTest: false, depthWrite: false, forceSinglePass: true }),
      });
      partial.mesh = mesh;
      installPainterOrder(mesh, spine);
      const skins = entry.skins || [];
      const availableSkins = skeletonData.skins.map((value) => value.name).filter(Boolean);
      const initialSkin =
        ["skin", "default", ...skins, ...availableSkins].find((value) => availableSkins.includes(value)) || "";
      if (initialSkin) mesh.skeleton.setSkinByName(initialSkin);
      this.skin = initialSkin;
      mesh.skeleton.setToSetupPose();
      this.animation =
        (entry.animations || []).find((name) => name === "f_idle") ||
        (entry.animations || []).find((name) => name === "idle") ||
        entry.animations?.[0] ||
        "";
      if (this.animation) mesh.state.setAnimation(0, this.animation, this.loop);
      mesh.update(0);
      const renderer = new three.WebGLRenderer({ alpha: true, antialias: true });
      partial.renderer = renderer;
      this.applyBackground(renderer, three);
      renderer.sortObjects = false;
      const scene = new three.Scene();
      scene.add(mesh);
      const camera = new three.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
      check();
      this.active = { three, spine, renderer, scene, camera, mesh, atlas, bitmaps };
      committed = true;
      this.host.replaceChildren(renderer.domElement);
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(this.host);
      this.resize();
      if (!this.fit || !this.captureFrame()) throw new Error("Spine model has no renderable frame");
      this.renderLoop = new ViewportRenderLoop(this.host, this.render);
      renderer.domElement.addEventListener("webglcontextrestored", this.contextRestored);
    } catch (error) {
      controller.abort();
      if (!committed) this.releaseResources(partial);
      else if (this.active?.renderer === partial.renderer) this.dispose();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (this.request === controller) this.request = undefined;
    }
  }

  captureFrame(): boolean {
    const stage = this.active;
    if (!stage || stage.renderer.getContext().isContextLost()) return false;
    stage.renderer.render(stage.scene, stage.camera);
    return true;
  }
  captureSupersampled(copy: (canvas: HTMLCanvasElement) => void): boolean {
    const stage = this.active;
    if (!stage || stage.renderer.getContext().isContextLost()) return false;
    const canvas = stage.renderer.domElement;
    const { width, height } = canvas;
    const size = viewerBufferSize(width, height, stage.renderer.getContext(), 4_000_000);
    try {
      stage.renderer.setSize(size.width, size.height, false);
      if (!this.captureFrame()) return false;
      copy(canvas);
      return true;
    } finally {
      stage.renderer.setSize(width, height, false);
      this.captureFrame();
    }
  }
  skins(): string[] {
    const skins = this.active?.mesh.skeleton.data.skins;
    return Array.isArray(skins) ? skins.map((value) => String(value.name || "")).filter(Boolean) : [];
  }
  skinName(): string {
    return this.skin;
  }
  animationName(): string {
    return this.animation;
  }
  setSkin(name: string): boolean {
    const stage = this.active;
    const value = String(name || "");
    if (!stage || !value || !this.skins().includes(value)) return false;
    stage.mesh.skeleton.setSkinByName(value);
    stage.mesh.skeleton.setToSetupPose();
    if (this.animation) stage.mesh.state.setAnimation(0, this.animation, this.loop);
    this.applyPlaybackRate(stage.mesh.state);
    stage.mesh.update(0);
    this.skin = value;
    this.bounds = undefined;
    this.resize();
    return true;
  }
  setPlaybackRate(value: number) {
    this.playbackRate = Math.min(2, Math.max(0.25, Number.isFinite(value) ? value : 1));
    if (this.active) this.applyPlaybackRate(this.active.mesh.state);
  }
  setBackgroundColor(color: SpineBackground) {
    this.background = color;
    const stage = this.active;
    if (stage) this.applyBackground(stage.renderer, stage.three);
    this.renderLoop?.request();
  }
  setTransform(transform: SpineTransform): SpineTransform {
    this.transform = {
      offsetX: Number.isFinite(transform.offsetX) ? transform.offsetX : 0,
      offsetY: Number.isFinite(transform.offsetY) ? transform.offsetY : 0,
      scale: Math.min(4, Math.max(0.25, Number.isFinite(transform.scale) ? transform.scale : 1)),
    };
    this.applyCameraTransform();
    return { ...this.transform };
  }
  resetTransform(): SpineTransform {
    return this.setTransform({ offsetX: 0, offsetY: 0, scale: 1 });
  }
  setPaused(value: boolean) {
    this.paused = value;
    this.lastFrame = 0;
    this.renderLoop?.request();
  }
  seek(seconds: number) {
    const stage = this.active;
    if (!stage || !this.animation) return;
    stage.mesh.skeleton.setToSetupPose();
    stage.mesh.state.clearTracks();
    stage.mesh.state.setAnimation(0, this.animation, this.loop);
    for (let remaining = seconds; remaining > 0; remaining -= 1 / 60) stage.mesh.update(Math.min(remaining, 1 / 60));
    stage.mesh.update(0);
    this.captureFrame();
  }
  setLoop(value: boolean) {
    this.loop = value;
    if (this.active && this.animation) {
      this.active.mesh.state.setAnimation(0, this.animation, value);
      this.applyPlaybackRate(this.active.mesh.state);
    }
    this.renderLoop?.request();
  }
  replay() {
    if (this.active && this.animation) {
      this.active.mesh.state.setAnimation(0, this.animation, this.loop);
      this.applyPlaybackRate(this.active.mesh.state);
      this.paused = false;
      this.lastFrame = 0;
      this.renderLoop?.request();
    }
  }
  play(name: string) {
    if (!this.active || !name || !this.active.mesh.skeleton.data.findAnimation(name)) return false;
    this.animation = name;
    this.active.mesh.state.setAnimation(0, name, this.loop);
    this.applyPlaybackRate(this.active.mesh.state);
    this.paused = false;
    this.lastFrame = 0;
    this.renderLoop?.request();
    return true;
  }
  private resize() {
    const stage = this.active;
    if (!stage) return;
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    const gl = stage.renderer.getContext();
    if (gl.isContextLost()) return;
    const size = viewerBufferSize(width, height, gl);
    stage.renderer.setPixelRatio(1);
    stage.renderer.setSize(size.width, size.height, false);
    // Keep the fitted pose stable while resizing an animated viewport.
    let bounds = this.bounds ?? stage.mesh.skeleton.getBoundsRect();
    if (!(bounds.width > 0 && bounds.height > 0) && this.authoredBounds) bounds = this.authoredBounds;
    if (
      !(bounds.width > 0 && bounds.height > 0) ||
      !Number.isFinite(bounds.x + bounds.y + bounds.width + bounds.height)
    )
      return;
    this.bounds = { ...bounds };
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const aspect = width / height;
    let w = bounds.width * 1.12;
    let h = bounds.height * 1.12;
    if (w / h < aspect) w = h * aspect;
    else h = w / aspect;
    this.fit = { centerX: center.x, centerY: center.y, width: w, height: h };
    this.applyCameraTransform();
  }
  private render = (now: number) => {
    const stage = this.active;
    if (!stage) return false;
    const delta = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, 0.1) : 0;
    this.lastFrame = now;
    if (!this.paused) stage.mesh.update(delta);
    if (stage.renderer.getContext().isContextLost()) {
      return false;
    }
    stage.renderer.render(stage.scene, stage.camera);
    return !this.paused && !!this.animation;
  };
  private readonly contextRestored = () => {
    this.lastFrame = 0;
    this.resize();
    this.renderLoop?.request();
  };
  dispose() {
    this.request?.abort();
    this.request = undefined;
    this.renderLoop?.dispose();
    this.renderLoop = undefined;
    this.lastFrame = 0;
    this.observer?.disconnect();
    this.fit = undefined;
    this.bounds = undefined;
    this.authoredBounds = undefined;
    this.skin = "";
    const stage = this.active;
    this.active = undefined;
    stage?.renderer.domElement.removeEventListener("webglcontextrestored", this.contextRestored);
    if (stage) this.releaseResources(stage);
  }

  private releaseResources(stage: {
    mesh?: Spine.SkeletonMesh;
    atlas?: Spine.TextureAtlas;
    renderer?: THREE.WebGLRenderer;
    bitmaps: ImageBitmap[];
  }) {
    stage.mesh?.dispose();
    stage.atlas?.dispose();
    for (const bitmap of stage.bitmaps) bitmap.close();
    stage.bitmaps.length = 0;
    stage.renderer?.dispose();
    stage.renderer?.forceContextLoss();
    stage.renderer?.domElement.remove();
  }

  private applyPlaybackRate(state: { timeScale: number }) {
    state.timeScale = this.playbackRate;
  }

  private applyBackground(renderer: THREE.WebGLRenderer, three: typeof THREE) {
    if (!this.background) {
      renderer.setClearColor(0x000000, 0);
      return;
    }
    renderer.setClearColor(new three.Color(this.background.r, this.background.g, this.background.b), 1);
  }

  private applyCameraTransform() {
    const stage = this.active;
    const fit = this.fit;
    if (!stage || !fit) return;
    const width = fit.width / this.transform.scale;
    const height = fit.height / this.transform.scale;
    const centerX = fit.centerX - (this.transform.offsetX * fit.width) / 2;
    const centerY = fit.centerY + (this.transform.offsetY * fit.height) / 2;
    Object.assign(stage.camera, {
      left: -width / 2,
      right: width / 2,
      top: height / 2,
      bottom: -height / 2,
    });
    stage.camera.position.set(centerX, centerY, 10);
    stage.camera.lookAt(centerX, centerY, 0);
    stage.camera.updateProjectionMatrix();
    this.renderLoop?.request();
  }
}
