import type * as Spine from "@esotericsoftware/spine-threejs";
import type * as THREE from "three";

type Value = Record<string, unknown>;
type Resource = { name?: string; url?: string };
interface Entry extends Value {
  animations?: string[];
  atlases?: Array<{ pages?: Resource[] }>;
  runtime?: { atlas?: Resource; json?: Resource; scale?: number; status?: string };
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

export function installPainterOrder(mesh: Spine.SkeletonMesh, spine: typeof Spine) {
  const internals = mesh as unknown as { nextBatch(): Batcher };
  const next = internals.nextBatch.bind(mesh);
  const configured = new WeakSet<Batcher>();
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
      material.map = texture;
      Object.assign(material, spine.ThreeJsTexture.toThreeJsBlending(blend as Spine.BlendMode));
      material.needsUpdate = true;
      return index;
    };
    return batch;
  };
}

export class SpineStage {
  private active?: Loaded;
  private frame = 0;
  private lastFrame = 0;
  private observer?: ResizeObserver;
  private paused = false;
  private loop = true;
  private animation = "";

  constructor(private readonly host: HTMLElement) {}

  async load(entry: Entry) {
    this.dispose();
    const runtime = entry.runtime;
    const atlasUrl = String(runtime?.atlas?.url || "");
    const jsonUrl = String(runtime?.json?.url || "");
    const pages = (entry.atlases || []).flatMap((atlas) => atlas.pages || []).filter((page) => page.name && page.url);
    if (runtime?.status !== "ready" || !atlasUrl || !jsonUrl || !pages.length)
      throw new Error("Spine model is not browser-ready");
    const [three, spine, atlasResponse, jsonResponse] = await Promise.all([
      import("three"),
      import("@esotericsoftware/spine-threejs"),
      fetch(atlasUrl),
      fetch(jsonUrl),
    ]);
    if (!atlasResponse.ok || !jsonResponse.ok) throw new Error("Spine runtime asset request failed");
    const atlas = new spine.TextureAtlas(await atlasResponse.text());
    const exactPages = new Map(pages.map((page) => [String(page.name), page]));
    const bitmaps: ImageBitmap[] = [];
    for (const page of atlas.pages) {
      const resource = exactPages.get(page.name);
      if (!resource?.url) throw new Error(`Missing atlas page: ${page.name}`);
      const response = await fetch(resource.url);
      if (!response.ok) throw new Error(`Texture request failed: ${page.name}`);
      const bitmap = await createImageBitmap(await response.blob(), {
        premultiplyAlpha: page.pma ? "none" : "premultiply",
        colorSpaceConversion: "none",
      });
      bitmaps.push(bitmap);
      page.setTexture(new spine.ThreeJsTexture(bitmap, true));
    }
    const parser = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas));
    parser.scale = Number(runtime.scale ?? entry.scale ?? 1);
    const skeletonData = parser.readSkeletonData(await jsonResponse.json());
    const mesh = new spine.SkeletonMesh({
      skeletonData,
      twoColorTint: true,
      materialFactory: (parameters) =>
        new three.MeshBasicMaterial({ ...parameters, depthTest: false, depthWrite: false, forceSinglePass: true }),
    });
    installPainterOrder(mesh, spine);
    const skins = entry.skins || [];
    const skin = skins.includes("skin") ? "skin" : skins.includes("default") ? "default" : skins[0];
    if (skin) mesh.skeleton.setSkinByName(skin);
    mesh.skeleton.setToSetupPose();
    this.animation =
      (entry.animations || []).find((name) => name === "f_idle") ||
      (entry.animations || []).find((name) => name === "idle") ||
      entry.animations?.[0] ||
      "";
    if (this.animation) mesh.state.setAnimation(0, this.animation, this.loop);
    mesh.update(0);
    const renderer = new three.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setClearColor(0x000000, 0);
    renderer.sortObjects = false;
    const scene = new three.Scene();
    scene.add(mesh);
    const camera = new three.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    this.active = { three, spine, renderer, scene, camera, mesh, atlas, bitmaps };
    this.host.replaceChildren(renderer.domElement);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.host);
    this.resize();
    this.frame = requestAnimationFrame(this.render);
  }
  setPaused(value: boolean) {
    this.paused = value;
  }
  setLoop(value: boolean) {
    this.loop = value;
    if (this.active && this.animation) this.active.mesh.state.setAnimation(0, this.animation, value);
  }
  replay() {
    if (this.active && this.animation) {
      this.active.mesh.state.setAnimation(0, this.animation, this.loop);
      this.paused = false;
    }
  }
  play(name: string) {
    if (!this.active || !name) return false;
    this.animation = name;
    this.active.mesh.state.setAnimation(0, name, this.loop);
    this.paused = false;
    return true;
  }
  private resize() {
    const stage = this.active;
    if (!stage) return;
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    stage.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    stage.renderer.setSize(width, height, false);
    stage.mesh.updateMatrixWorld(true);
    const bounds = new stage.three.Box3().setFromObject(stage.mesh);
    if (bounds.isEmpty()) return;
    const size = bounds.getSize(new stage.three.Vector3());
    const center = bounds.getCenter(new stage.three.Vector3());
    const aspect = width / height;
    let w = size.x * 1.12;
    let h = size.y * 1.12;
    if (w / h < aspect) w = h * aspect;
    else h = w / aspect;
    Object.assign(stage.camera, { left: -w / 2, right: w / 2, top: h / 2, bottom: -h / 2 });
    stage.camera.position.set(center.x, center.y, 10);
    stage.camera.lookAt(center.x, center.y, 0);
    stage.camera.updateProjectionMatrix();
  }
  private render = (now: number) => {
    const stage = this.active;
    if (!stage) return;
    const delta = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, 0.1) : 0;
    this.lastFrame = now;
    if (!this.paused) stage.mesh.update(delta);
    stage.renderer.render(stage.scene, stage.camera);
    this.frame = requestAnimationFrame(this.render);
  };
  dispose() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.lastFrame = 0;
    this.observer?.disconnect();
    const stage = this.active;
    this.active = undefined;
    if (!stage) return;
    stage.mesh.traverse((child) => {
      const drawable = child as THREE.Mesh;
      drawable.geometry?.dispose();
      for (const material of Array.isArray(drawable.material) ? drawable.material : [drawable.material])
        material?.dispose();
    });
    stage.mesh.dispose();
    stage.atlas.dispose();
    for (const bitmap of stage.bitmaps) bitmap.close();
    stage.renderer.dispose();
    stage.renderer.forceContextLoss();
    stage.renderer.domElement.remove();
  }
}
