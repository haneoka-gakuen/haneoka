import { installPainterOrder } from "./spine-stage";

type Value = Record<string, unknown>;
type Part = { modelId?: string; order?: number };
type LoadedPart = {
  mesh: import("@esotericsoftware/spine-threejs").SkeletonMesh;
  atlas: import("@esotericsoftware/spine-threejs").TextureAtlas;
  bitmaps: ImageBitmap[];
};

export class OutfitStage {
  private frame = 0;
  private last = 0;
  private generation = 0;
  private resizeObserver?: ResizeObserver;
  private referenceFrame?: { size: import("three").Vector3; center: import("three").Vector3 };
  private active?: {
    three: typeof import("three");
    renderer: import("three").WebGLRenderer;
    scene: import("three").Scene;
    group: import("three").Group;
    camera: import("three").OrthographicCamera;
    parts: LoadedPart[];
  };

  constructor(
    private readonly host: HTMLElement,
    private readonly server: string,
  ) {}

  async load(parts: Part[], animation = "f_idle", scale = 1) {
    this.dispose(true);
    const generation = ++this.generation;
    if (!parts.length) throw new Error("Outfit has no Spine parts");
    const [three, spine, docs] = await Promise.all([
      import("three"),
      import("@esotericsoftware/spine-threejs"),
      Promise.all(
        parts.map(async (part) => {
          const response = await fetch(
            `/api/v1/servers/${encodeURIComponent(this.server)}/spine/${encodeURIComponent(String(part.modelId || ""))}`,
          );
          if (!response.ok) throw new Error("Outfit Spine model is unavailable");
          return (await response.json()) as Value;
        }),
      ),
    ]);
    if (generation !== this.generation) return;
    const renderer = new three.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setClearColor(0x000000, 0);
    renderer.sortObjects = false;
    const scene = new three.Scene();
    const group = new three.Group();
    group.scale.set(scale, scale, 1);
    scene.add(group);
    const loaded: Array<LoadedPart & { order: number }> = [];
    for (let index = 0; index < docs.length; index += 1) {
      const doc = docs[index] || {};
      const runtime = doc.runtime as Value | undefined;
      const atlasResource = runtime?.atlas as Value | undefined;
      const jsonResource = runtime?.json as Value | undefined;
      const atlases = Array.isArray(doc.atlases) ? (doc.atlases as Value[]) : [];
      const pages = atlases.flatMap((atlas) => (Array.isArray(atlas.pages) ? (atlas.pages as Value[]) : []));
      const atlasUrl = String(atlasResource?.url || "");
      const jsonUrl = String(jsonResource?.url || "");
      if (runtime?.status !== "ready" || !atlasUrl || !jsonUrl || !pages.length)
        throw new Error("Outfit part is not ready");
      const [atlasResponse, jsonResponse] = await Promise.all([fetch(atlasUrl), fetch(jsonUrl)]);
      if (!atlasResponse.ok || !jsonResponse.ok) throw new Error("Outfit part request failed");
      const atlas = new spine.TextureAtlas(await atlasResponse.text());
      const byName = new Map(pages.map((page) => [String(page.name), String(page.url || "")]));
      const bitmaps: ImageBitmap[] = [];
      for (const page of atlas.pages) {
        const url = byName.get(page.name) || "";
        const response = await fetch(url);
        if (!response.ok) throw new Error("Outfit texture request failed");
        const bitmap = await createImageBitmap(await response.blob(), {
          premultiplyAlpha: page.pma ? "none" : "premultiply",
          colorSpaceConversion: "none",
        });
        bitmaps.push(bitmap);
        page.setTexture(new spine.ThreeJsTexture(bitmap, true));
      }
      const parser = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas));
      parser.scale = Number(runtime.scale ?? doc.scale ?? 1);
      const mesh = new spine.SkeletonMesh({
        skeletonData: parser.readSkeletonData(await jsonResponse.json()),
        twoColorTint: true,
        materialFactory: (parameters) =>
          new three.MeshBasicMaterial({ ...parameters, depthTest: false, depthWrite: false, forceSinglePass: true }),
      });
      installPainterOrder(mesh, spine);
      const skins = Array.isArray(doc.skins) ? (doc.skins as string[]) : [];
      const skin = skins.includes("skin") ? "skin" : skins.includes("default") ? "default" : skins[0];
      if (skin) mesh.skeleton.setSkinByName(skin);
      mesh.skeleton.setToSetupPose();
      loaded.push({ mesh, atlas, bitmaps, order: Number(parts[index]?.order || 0) });
    }
    loaded.sort((a, b) => a.order - b.order);
    const common = [animation, "f_idle", "b_idle", "idle"].find((name) =>
      docs.every((doc) => (Array.isArray(doc.animations) ? doc.animations : []).includes(name)),
    );
    for (const part of loaded) {
      if (common) part.mesh.state.setAnimation(0, common, true);
      part.mesh.update(0);
      group.add(part.mesh);
    }
    if (generation !== this.generation) {
      this.disposeParts(loaded);
      renderer.dispose();
      return;
    }
    this.active = {
      three,
      renderer,
      scene,
      group,
      camera: new three.OrthographicCamera(-1, 1, 1, -1, 0.1, 100),
      parts: loaded,
    };
    this.host.replaceChildren(renderer.domElement);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.resize();
    this.frame = requestAnimationFrame(this.render);
  }
  private resize() {
    const stage = this.active;
    if (!stage) return;
    const width = Math.max(1, this.host.clientWidth),
      height = Math.max(1, this.host.clientHeight);
    stage.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    stage.renderer.setSize(width, height, false);
    stage.group.updateMatrixWorld(true);
    const bounds = new stage.three.Box3().setFromObject(stage.group);
    if (bounds.isEmpty()) return;
    this.referenceFrame ??= {
      size: bounds.getSize(new stage.three.Vector3()),
      center: bounds.getCenter(new stage.three.Vector3()),
    };
    const size = this.referenceFrame.size,
      center = this.referenceFrame.center;
    let w = size.x * 1.12,
      h = size.y * 1.12;
    if (w / h < width / height) w = h * (width / height);
    else h = w / (width / height);
    Object.assign(stage.camera, { left: -w / 2, right: w / 2, top: h / 2, bottom: -h / 2 });
    stage.camera.position.set(center.x, center.y, 10);
    stage.camera.lookAt(center.x, center.y, 0);
    stage.camera.updateProjectionMatrix();
  }
  private render = (now: number) => {
    const stage = this.active;
    if (!stage) return;
    const delta = this.last ? Math.min((now - this.last) / 1000, 0.1) : 0;
    this.last = now;
    stage.parts.forEach((part) => part.mesh.update(delta));
    stage.renderer.render(stage.scene, stage.camera);
    this.frame = requestAnimationFrame(this.render);
  };
  private disposeParts(parts: LoadedPart[]) {
    for (const part of parts) {
      part.mesh.dispose();
      part.atlas.dispose();
      part.bitmaps.forEach((bitmap) => bitmap.close());
    }
  }
  dispose(preserveFrame = false) {
    this.generation += 1;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.last = 0;
    this.resizeObserver?.disconnect();
    if (this.active) {
      this.disposeParts(this.active.parts);
      this.active.renderer.dispose();
      this.active.renderer.forceContextLoss();
    }
    this.active = undefined;
    if (!preserveFrame) this.referenceFrame = undefined;
    this.host.replaceChildren();
  }
}
