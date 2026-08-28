<script setup lang="ts">
import { MaterialIcon, UiIconButton, UiSelect } from "@haneoka/ui";
import type * as Spine from "@esotericsoftware/spine-threejs";
import type * as THREE from "three";

import type { CatalogContentOrigin } from "~/features/catalog/contentSource";
import type { SpineAtlas, SpineModel, SpineResource } from "~/types/spine";
import { releaseResourceUrl } from "~/composables/useReleaseServer";
import { versionedPreviewImageUrl } from "~/utils/previewImageUrl";

type OurNotesCatalogOrigin = Extract<CatalogContentOrigin, { provider: "release" }>;
type ViewerFieldValue = number | string;
type ViewerSelectOption = { readonly label: string; readonly value: ViewerFieldValue };
const SPINE_PREVIEW_SCHEMA = "haneoka-spine-preview-v5";

const props = defineProps<{
  entry: SpineModel;
  title: string;
  /** The exact release that supplied the verified SkeletonDataAsset graph. */
  origin?: OurNotesCatalogOrigin;
}>();

interface LoadedStage {
  three: typeof THREE;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  mesh: Spine.SkeletonMesh;
  atlas: Spine.TextureAtlas;
  bitmaps: ImageBitmap[];
}

const { releaseServer } = useReleaseServer();
const { messages, t } = useLocale();
const copy = messages("spinePage");
const host = ref<HTMLElement>();
const loading = ref(true);
const error = ref("");
const paused = ref(false);
const loop = ref(true);
const selectedAnimation = ref("");
const failedPreviews = ref<Set<string>>(new Set());
const activeRelease = computed(() => props.origin?.releaseId || releaseServer.value);
const availableAnimations = computed(() => props.entry.animations || []);
const animationOptions = computed<ViewerSelectOption[]>(() =>
  availableAnimations.value.map((value) => ({ value, label: value })),
);
const previewUrl = computed(() => {
  const preview = props.entry.preview;
  const pose = preview?.pose;
  return preview?.status === "rendered" &&
    preview.schema === SPINE_PREVIEW_SCHEMA &&
    preview.url &&
    pose?.kind === "setup" &&
    pose.animationApplied === false &&
    pose.animationStateAdvanced === false &&
    pose.physics === "none" &&
    !failedPreviews.value.has(props.entry.id)
    ? versionedPreviewImageUrl(preview.url, preview.sha256 || `${preview.schema}:${preview.width}x${preview.height}`)
    : undefined;
});

let active: LoadedStage | undefined;
let frameHandle = 0;
let lastFrame = 0;
let resizeObserver: ResizeObserver | undefined;
let generation = 0;
let loadController: AbortController | undefined;

type SpineBatcherInternals = THREE.Mesh & {
  clear(): unknown;
  findMaterialGroup(slotTexture: THREE.Texture, slotBlendMode: unknown): number;
  newMaterial(): THREE.Material & { map: THREE.Texture | null };
  material: THREE.Material[];
};

/**
 * Unity's source material deliberately disables ZWrite for these Spine
 * assets. A Three.js SkeletonMesh normally merges same-texture slots into a
 * single draw call, where that loses Spine's painter order for overlapping
 * semi-transparent pieces. Keep a reusable material group per authored slot
 * instead: geometry groups are submitted in `Skeleton.drawOrder`, and no
 * transparent fragment has to incorrectly occlude the next one.
 */
const installSpinePainterOrder = (mesh: Spine.SkeletonMesh, spine: typeof Spine): void => {
  const internals = mesh as unknown as {
    nextBatch(): SpineBatcherInternals;
  };
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
  return url ? releaseResourceUrl(url, activeRelease.value) : "";
};

const imageFromUrl = async (
  url: string,
  sourceUsesPremultipliedAlpha: boolean,
  signal: AbortSignal,
): Promise<ImageBitmap> => {
  const response = await fetch(url, { signal, cache: "force-cache" });
  if (!response.ok) throw new Error(`texture request failed (${response.status})`);
  // Spine's Three renderer blends its batches as premultiplied alpha.  An
  // ImageBitmap made from an ordinary straight-alpha atlas is not reliably
  // premultiplied later by CanvasTexture on every browser/GPU path, which
  // leaves bright fringes around antialiased pixels.  Normalize the decoded
  // bitmap here instead.  A page already flagged PMA must be preserved as-is.
  return createImageBitmap(await response.blob(), {
    premultiplyAlpha: sourceUsesPremultipliedAlpha ? "none" : "premultiply",
    colorSpaceConversion: "none",
  });
};

const atlasPages = (atlases: SpineAtlas[] | undefined): SpineResource[] =>
  (atlases || []).flatMap((atlas) => atlas.pages || []).filter((page) => Boolean(page.name && page.url));

const defaultAnimation = (entry: SpineModel): string => {
  const animations = entry.animations || [];
  return animations.includes("f_idle") ? "f_idle" : animations.includes("idle") ? "idle" : animations[0] || "";
};

const setupSkin = (entry: SpineModel): string => {
  const skins = [...new Set((entry.skins || []).filter((value) => Boolean(value)))].sort();
  // Game skeletons frequently store their setup attachments in `skin` rather
  // than Spine's automatic `default` skin. Select it before any optional
  // interactive animation so the initial slots have their authored geometry.
  if (skins.includes("skin")) return "skin";
  if (skins.includes("default")) return "default";
  return skins.length === 1 ? skins[0] : "";
};

const dispose = () => {
  loadController?.abort();
  loadController = undefined;
  if (frameHandle) cancelAnimationFrame(frameHandle);
  frameHandle = 0;
  lastFrame = 0;
  const stage = active;
  active = undefined;
  if (!stage) return;
  stage.mesh.traverse((child) => {
    const drawable = child as THREE.Mesh;
    drawable.geometry?.dispose();
    const materials = Array.isArray(drawable.material) ? drawable.material : [drawable.material];
    for (const material of materials) material?.dispose();
  });
  stage.mesh.dispose();
  stage.atlas.dispose();
  for (const bitmap of stage.bitmaps) bitmap.close();
  stage.renderer.dispose();
  stage.renderer.forceContextLoss();
  stage.renderer.domElement.remove();
};

const frameCamera = (three: typeof THREE, stage: LoadedStage) => {
  stage.mesh.updateMatrixWorld(true);
  const bounds = new three.Box3().setFromObject(stage.mesh);
  if (bounds.isEmpty()) throw new Error("rendered Spine geometry has no bounds");
  const size = bounds.getSize(new three.Vector3());
  if (!(size.x > 0) || !(size.y > 0)) throw new Error("rendered Spine geometry has zero bounds");
  const center = bounds.getCenter(new three.Vector3());
  const hostAspect = Math.max(1, host.value?.clientWidth || 1) / Math.max(1, host.value?.clientHeight || 1);
  const padding = 1.12;
  let width = size.x * padding;
  let height = size.y * padding;
  if (width / height < hostAspect) width = height * hostAspect;
  else height = width / hostAspect;
  stage.camera.left = -width / 2;
  stage.camera.right = width / 2;
  stage.camera.top = height / 2;
  stage.camera.bottom = -height / 2;
  stage.camera.position.set(center.x, center.y, 10);
  stage.camera.lookAt(center.x, center.y, 0);
  stage.camera.updateProjectionMatrix();
};

const resize = () => {
  const stage = active;
  const element = host.value;
  if (!stage || !element) return;
  const width = Math.max(1, Math.floor(element.clientWidth));
  const height = Math.max(1, Math.floor(element.clientHeight));
  stage.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  stage.renderer.setSize(width, height, false);
  frameCamera(stage.three, stage);
};

const renderLoop = (now: number) => {
  const stage = active;
  if (!stage) return;
  const delta = lastFrame ? Math.min((now - lastFrame) / 1_000, 0.1) : 0;
  lastFrame = now;
  if (!paused.value) stage.mesh.update(delta);
  stage.renderer.render(stage.scene, stage.camera);
  frameHandle = requestAnimationFrame(renderLoop);
};

const load = async () => {
  const currentGeneration = ++generation;
  loading.value = true;
  error.value = "";
  paused.value = false;
  dispose();
  await nextTick();

  const element = host.value;
  const runtime = props.entry.runtime;
  const atlasUrl = runtimeUrl(runtime?.atlas);
  const jsonUrl = runtimeUrl(runtime?.json);
  const pages = atlasPages(props.entry.atlases);
  if (!element || runtime?.status !== "ready" || !atlasUrl || !jsonUrl || !pages.length) {
    error.value = t("unavailable");
    loading.value = false;
    return;
  }

  const controller = new AbortController();
  loadController = controller;
  try {
    const [three, spine] = await Promise.all([import("three"), import("@esotericsoftware/spine-threejs")]);
    const [atlasResponse, skeletonResponse] = await Promise.all([
      fetch(atlasUrl, { signal: controller.signal, cache: "force-cache" }),
      fetch(jsonUrl, { signal: controller.signal, cache: "force-cache" }),
    ]);
    if (!atlasResponse.ok) throw new Error(`Spine atlas request failed (${atlasResponse.status})`);
    if (!skeletonResponse.ok) throw new Error(`Spine skeleton request failed (${skeletonResponse.status})`);
    const atlas = new spine.TextureAtlas(await atlasResponse.text());
    const exactPages = new Map(pages.map((page) => [String(page.name), page]));
    const bitmaps: ImageBitmap[] = [];
    for (const page of atlas.pages) {
      const record = exactPages.get(page.name);
      const pageUrl = runtimeUrl(record);
      if (!record || !pageUrl) throw new Error(`missing verified atlas page: ${page.name}`);
      const bitmap = await imageFromUrl(pageUrl, page.pma, controller.signal);
      bitmaps.push(bitmap);
      // `imageFromUrl` normalizes both atlas variants to PMA pixels, so pass
      // `true` to avoid a second upload-time conversion.
      page.setTexture(new spine.ThreeJsTexture(bitmap, true));
    }
    const parser = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas));
    parser.scale = Number(runtime.scale ?? props.entry.scale ?? 1);
    const skeletonData = parser.readSkeletonData(JSON.parse(await skeletonResponse.text()));
    // Match the verified Unity material (`_ZWrite = 0`). Slot ordering is
    // handled explicitly by `installSpinePainterOrder`, rather than relying
    // on Three's depth buffer to repair batched transparent geometry.
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
    const skin = setupSkin(props.entry);
    if (skin) mesh.skeleton.setSkinByName(skin);
    mesh.skeleton.setToSetupPose();
    const animation = selectedAnimation.value || defaultAnimation(props.entry);
    if (animation) mesh.state.setAnimation(0, animation, loop.value);
    mesh.update(0);
    const renderer = new three.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setClearColor(0x000000, 0);
    // Geometry groups now represent Spine's individual authored slots. Do
    // not let Three resort those transparent groups by object depth.
    renderer.sortObjects = false;
    const scene = new three.Scene();
    scene.add(mesh);
    const camera = new three.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    const stage: LoadedStage = { three, renderer, scene, camera, mesh, atlas, bitmaps };
    if (currentGeneration !== generation) {
      atlas.dispose();
      for (const bitmap of bitmaps) bitmap.close();
      renderer.dispose();
      return;
    }
    active = stage;
    element.replaceChildren(renderer.domElement);
    selectedAnimation.value = animation;
    resize();
    frameHandle = requestAnimationFrame(renderLoop);
  } catch (cause) {
    if (currentGeneration === generation) {
      error.value = cause instanceof Error ? cause.message : t("unavailable");
      dispose();
    }
  } finally {
    if (loadController === controller) loadController = undefined;
    if (currentGeneration === generation) loading.value = false;
  }
};

const updateAnimation = (value: ViewerFieldValue) => {
  const next = String(value || "");
  selectedAnimation.value = next;
  if (next && active) {
    active.mesh.state.setAnimation(0, next, loop.value);
    active.mesh.update(0);
    frameCamera(active.three, active);
    paused.value = false;
  }
};

const replay = () => {
  const stage = active;
  if (!stage || !selectedAnimation.value) return;
  stage.mesh.state.setAnimation(0, selectedAnimation.value, loop.value);
  stage.mesh.update(0);
  frameCamera(stage.three, stage);
  paused.value = false;
};

const togglePaused = () => {
  paused.value = !paused.value;
};

const toggleLoop = () => {
  loop.value = !loop.value;
  if (active && selectedAnimation.value) replay();
};

const markPreviewFailed = () => {
  failedPreviews.value = new Set(failedPreviews.value).add(props.entry.id);
};

watch(
  () => props.entry.id,
  () => void load(),
);
watch(
  () => activeRelease.value,
  () => void load(),
);
onMounted(() => {
  resizeObserver = new ResizeObserver(resize);
  if (host.value) resizeObserver.observe(host.value);
  void load();
});
onBeforeUnmount(() => {
  generation += 1;
  resizeObserver?.disconnect();
  dispose();
});
</script>

<template>
  <RuntimeViewerSurface :label="title" :busy="loading" :show-controls="!loading && !error">
    <div ref="host" class="spine-stage__canvas" />
    <div v-if="loading" class="spine-stage__state"><LoadingState variant="block" /></div>
    <div v-else-if="error" class="spine-stage__state spine-stage__state--error" role="status">
      <LoadingImage
        v-if="previewUrl"
        class="spine-stage__preview"
        :src="previewUrl"
        :alt="title"
        loading="eager"
        fit="contain"
        @error="markPreviewFailed"
      />
      <MaterialIcon v-else name="animation" :size="28" aria-hidden="true" />
      <span>{{ error }}</span>
      <UiIconButton :label="t('retry')" emphasis tone="surface" touch-target @click="load">
        <MaterialIcon name="refresh" :size="20" />
      </UiIconButton>
    </div>

    <template #controls>
      <UiSelect
        v-if="animationOptions.length > 1"
        :model-value="selectedAnimation"
        :options="animationOptions"
        :label="copy.animations"
        @update:model-value="updateAnimation"
      />
      <UiIconButton :label="paused ? t('play') : t('pause')" tone="runtime" touch-target @click="togglePaused">
        <MaterialIcon :name="paused ? 'play_arrow' : 'pause'" :size="20" />
      </UiIconButton>
      <UiIconButton :label="t('replay')" tone="runtime" touch-target @click="replay">
        <MaterialIcon name="replay" :size="20" />
      </UiIconButton>
      <UiIconButton :label="t('loop')" :pressed="loop" tone="runtime" touch-target @click="toggleLoop">
        <MaterialIcon name="all_inclusive" :size="20" />
      </UiIconButton>
    </template>
  </RuntimeViewerSurface>
</template>

<style scoped>
.spine-stage__canvas {
  position: absolute;
  inset: 0;
}

.spine-stage__canvas :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
}

.spine-stage__state {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  align-content: center;
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-4);
  color: var(--md-sys-color-on-surface-variant);
  text-align: center;
  overflow-wrap: anywhere;
}

.spine-stage__state--error {
  background: color-mix(in srgb, var(--md-sys-color-surface-container-low) 76%, transparent);
}

.spine-stage__preview {
  display: block;
  width: min(54%, 240px);
  height: min(54%, 240px);
}

</style>
