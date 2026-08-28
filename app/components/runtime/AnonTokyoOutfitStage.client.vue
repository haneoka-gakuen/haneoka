<script setup lang="ts">
import type * as Spine from "@esotericsoftware/spine-threejs";
import type * as THREE from "three";

import type { SpineModel, SpineResource } from "~/types/spine";
import { releaseResourceUrl } from "~/composables/useReleaseServer";

/**
 * Live dress-up stage: renders one SkeletonMesh per MasterATReplacementparts
 * part in a single scene, layered by the authored `_order` — the same way the
 * game composes independently authored part skeletons. Loading follows the
 * spine viewer's verified sequence per part.
 */

export interface OutfitStagePart {
  modelId?: string;
  order?: number;
}

const props = withDefaults(
  defineProps<{
    parts: OutfitStagePart[];
    /** Preferred animation; falls back to one all parts share. */
    animation?: string;
    /** Character group scale (MasterATCharacter._scale). */
    scale?: number;
  }>(),
  { parts: () => [], animation: "", scale: 1 },
);

const { releaseServer } = useReleaseServer();
const host = ref<HTMLElement | undefined>();
const failed = ref(false);

interface SpineBatcherInternals {
  clear(): void;
  findMaterialGroup(slotTexture: THREE.Texture, slotBlendMode: unknown): number;
  material: THREE.Material[];
  newMaterial(): THREE.Material & { map: THREE.Texture | null };
}

const installSpinePainterOrder = (mesh: Spine.SkeletonMesh, spine: typeof Spine): void => {
  const internals = mesh as unknown as { nextBatch(): SpineBatcherInternals };
  const nextBatch = internals.nextBatch.bind(mesh);
  const configured = new WeakSet<SpineBatcherInternals>();
  internals.nextBatch = () => {
    const batch = nextBatch();
    if (configured.has(batch)) return batch;
    configured.add(batch);

    let materialCursor = 0;
    const clear = batch.clear.bind(batch);
    batch.clear = () => {
      materialCursor = 0;
      return clear();
    };
    batch.findMaterialGroup = (slotTexture, slotBlendMode) => {
      const materials = batch.material;
      const materialIndex = materialCursor;
      const material =
        (materials[materialIndex] as (THREE.Material & { map: THREE.Texture | null }) | undefined) ??
        batch.newMaterial();
      if (!materials[materialIndex]) materials.push(material);
      materialCursor += 1;
      material.map = slotTexture;
      Object.assign(material, spine.ThreeJsTexture.toThreeJsBlending(slotBlendMode as Spine.BlendMode));
      material.needsUpdate = true;
      return materialIndex;
    };
    return batch;
  };
};

const runtimeUrl = (resource: SpineResource | undefined): string => {
  const url = String(resource?.url || "");
  return url ? releaseResourceUrl(url, releaseServer.value) : "";
};

const imageFromUrl = async (url: string, sourcePma: boolean, signal: AbortSignal): Promise<ImageBitmap> => {
  const response = await fetch(url, { signal, cache: "force-cache" });
  if (!response.ok) throw new Error(`image request failed (${response.status}): ${url}`);
  return createImageBitmap(await response.blob(), {
    premultiplyAlpha: sourcePma ? "none" : "premultiply",
    colorSpaceConversion: "none",
  });
};

const modelDoc = async (modelId: string, signal: AbortSignal): Promise<SpineModel> => {
  const response = await fetch(
    `/api/v1/servers/${encodeURIComponent(releaseServer.value)}/spine/${encodeURIComponent(modelId)}`,
    { signal },
  );
  if (!response.ok) throw new Error(`spine model request failed (${response.status}): ${modelId}`);
  return (await response.json()) as SpineModel;
};

interface LoadedPart {
  mesh: Spine.SkeletonMesh;
  atlas: Spine.TextureAtlas;
  bitmaps: ImageBitmap[];
  order: number;
  animated: boolean;
}

interface LiveStage {
  three: typeof THREE;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  group: THREE.Group;
  camera: THREE.OrthographicCamera;
  parts: LoadedPart[];
}

let stage: LiveStage | undefined;
let frameHandle = 0;
let lastFrame = 0;
let generation = 0;

const frameCamera = (three: typeof THREE, live: LiveStage): void => {
  live.group.updateMatrixWorld(true);
  const bounds = new three.Box3().setFromObject(live.group);
  if (bounds.isEmpty()) return;
  const size = bounds.getSize(new three.Vector3());
  const center = bounds.getCenter(new three.Vector3());
  if (!(size.x > 0) || !(size.y > 0)) return;
  const canvas = live.renderer.domElement;
  const hostAspect = Math.max(1, canvas.clientWidth || 1) / Math.max(1, canvas.clientHeight || 1);
  const padding = 1.12;
  let width = size.x * padding;
  let height = size.y * padding;
  if (width / height < hostAspect) width = height * hostAspect;
  else height = width / hostAspect;
  live.camera.left = -width / 2;
  live.camera.right = width / 2;
  live.camera.top = height / 2;
  live.camera.bottom = -height / 2;
  live.camera.position.set(center.x, center.y, 10);
  live.camera.lookAt(center.x, center.y, 0);
  live.camera.updateProjectionMatrix();
};

const resize = (): void => {
  if (!stage) return;
  const canvas = stage.renderer.domElement;
  const width = Math.max(1, Math.floor(canvas.parentElement?.clientWidth || 1));
  const height = Math.max(1, Math.floor(canvas.parentElement?.clientHeight || 1));
  stage.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  stage.renderer.setSize(width, height, false);
  frameCamera(stage.three, stage);
};

const disposeStage = (): void => {
  cancelAnimationFrame(frameHandle);
  frameHandle = 0;
  if (!stage) return;
  for (const part of stage.parts) {
    part.mesh.traverse((child) => {
      const renderable = child as unknown as { geometry?: { dispose(): void }; material?: THREE.Material | THREE.Material[] };
      if (renderable.geometry) renderable.geometry.dispose();
      const materials = Array.isArray(renderable.material) ? renderable.material : [renderable.material];
      for (const material of materials) material?.dispose();
    });
    (part.mesh as unknown as { dispose(): void }).dispose();
    part.atlas.dispose();
    for (const bitmap of part.bitmaps) bitmap.close();
  }
  stage.renderer.dispose();
  stage = undefined;
};

const renderLoop = (now: number): void => {
  if (!stage) return;
  const delta = lastFrame ? Math.min((now - lastFrame) / 1_000, 0.1) : 0;
  lastFrame = now;
  for (const part of stage.parts) {
    if (part.animated) part.mesh.update(delta);
  }
  stage.renderer.render(stage.scene, stage.camera);
  frameHandle = requestAnimationFrame(renderLoop);
};

const build = async (): Promise<void> => {
  const currentGeneration = ++generation;
  disposeStage();
  failed.value = false;
  const element = host.value;
  if (!element || !props.parts.length) return;

  try {
    const [three, spine] = await Promise.all([import("three"), import("@esotericsoftware/spine-threejs")]);
    const docs = await Promise.all(
      props.parts.map((part) => modelDoc(String(part.modelId || ""), AbortSignal.timeout(20000))),
    );
    if (currentGeneration !== generation) return;

    const renderer = new three.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setClearColor(0x000000, 0);
    renderer.sortObjects = false;
    const scene = new three.Scene();
    const group = new three.Group();
    group.scale.set(props.scale || 1, props.scale || 1, 1);
    scene.add(group);

    const live: LiveStage = {
      three,
      renderer,
      scene,
      group,
      camera: new three.OrthographicCamera(-1, 1, 1, -1, 0.1, 100),
      parts: [],
    };
    const loaded: LoadedPart[] = [];
    for (let index = 0; index < props.parts.length; index += 1) {
      const spec = props.parts[index];
      const doc = docs[index];
      const runtime = doc.runtime;
      const atlasUrl = runtimeUrl(runtime?.atlas);
      const pages = (doc.atlases || []).flatMap((atlas) => atlas.pages || []);
      if (runtime?.status !== "ready" || !atlasUrl || !pages.length) {
        throw new Error(`part is not browser-ready: ${spec.modelId}`);
      }
      const [atlasResponse, skeletonResponse] = await Promise.all([
        fetch(atlasUrl, { cache: "force-cache" }),
        fetch(runtimeUrl(runtime?.json), { cache: "force-cache" }),
      ]);
      if (!atlasResponse.ok || !skeletonResponse.ok) throw new Error(`part asset request failed: ${spec.modelId}`);
      const atlas = new spine.TextureAtlas(await atlasResponse.text());
      const exactPages = new Map(pages.map((page) => [String(page.name), page]));
      const bitmaps: ImageBitmap[] = [];
      for (const page of atlas.pages) {
        const record = exactPages.get(String(page.name));
        const pageUrl = runtimeUrl(record);
        if (!record || !pageUrl) throw new Error(`missing atlas page for ${spec.modelId}: ${page.name}`);
        const bitmap = await imageFromUrl(pageUrl, Boolean(page.pma), AbortSignal.timeout(20000));
        bitmaps.push(bitmap);
        page.setTexture(new spine.ThreeJsTexture(bitmap, true));
      }
      const parser = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas));
      parser.scale = Number(runtime.scale ?? doc.scale ?? 1);
      const skeletonData = parser.readSkeletonData(JSON.parse(await skeletonResponse.text()));
      const mesh = new spine.SkeletonMesh({
        skeletonData,
        twoColorTint: true,
        materialFactory: (parameters) =>
          new three.MeshBasicMaterial({
            ...parameters,
            depthTest: false,
            depthWrite: false,
            forceSinglePass: true,
          }),
      });
      installSpinePainterOrder(mesh, spine);
      const skins = [...new Set(doc.skins || [])];
      const skin = skins.includes("skin") ? "skin" : skins.includes("default") ? "default" : skins[0];
      if (skin) mesh.skeleton.setSkinByName(skin);
      mesh.skeleton.setToSetupPose();
      loaded.push({ mesh, atlas, bitmaps, order: Number(spec.order || 0), animated: false });
    }
    // Play one animation that every part shares so the character moves as one.
    const candidates = [props.animation, "f_idle", "b_idle", "idle"].filter(Boolean);
    const common = candidates.find((name) =>
      docs.every((doc) => (doc.animations || []).includes(name)),
    );
    for (const part of loaded) {
      if (common) {
        part.mesh.state.setAnimation(0, common, true);
        part.animated = true;
      }
      part.mesh.update(0);
      group.add(part.mesh);
    }
    if (currentGeneration !== generation) {
      disposeLoaded(loaded);
      return;
    }
    live.parts = loaded;
    stage = live;
    element.replaceChildren(renderer.domElement);
    resize();
    lastFrame = 0;
    frameHandle = requestAnimationFrame(renderLoop);
  } catch {
    if (currentGeneration === generation) failed.value = true;
  }
};

const disposeLoaded = (loaded: LoadedPart[]): void => {
  for (const part of loaded) {
    part.mesh.traverse((child) => {
      const renderable = child as unknown as { geometry?: { dispose(): void }; material?: THREE.Material | THREE.Material[] };
      if (renderable.geometry) renderable.geometry.dispose();
      const materials = Array.isArray(renderable.material) ? renderable.material : [renderable.material];
      for (const material of materials) material?.dispose();
    });
    (part.mesh as unknown as { dispose(): void }).dispose();
    part.atlas.dispose();
    for (const bitmap of part.bitmaps) bitmap.close();
  }
};

const rebuild = (): void => {
  if (host.value) void build();
};

const onResize = (): void => {
  resize();
};

onMounted(() => {
  rebuild();
  window.addEventListener("resize", onResize);
});
onUnmounted(() => {
  window.removeEventListener("resize", onResize);
  disposeStage();
});
watch(
  () => [props.parts, props.animation, props.scale],
  () => rebuild(),
);
</script>

<template>
  <div ref="host" class="anon-tokyo-outfit-stage">
    <div v-if="failed" class="anon-tokyo-outfit-stage__fallback">
      <slot name="fallback" />
    </div>
  </div>
</template>

<style scoped>
.anon-tokyo-outfit-stage {
  display: grid;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  place-items: center;
}

.anon-tokyo-outfit-stage :deep(canvas) {
  display: block;
  width: 100% !important;
  height: 100% !important;
}

.anon-tokyo-outfit-stage__fallback {
  display: grid;
  width: 100%;
  height: 100%;
  place-items: center;
  color: var(--md-sys-color-on-surface-variant);
}
</style>
