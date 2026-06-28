<script setup lang="ts">
import { MaterialIcon, UiIconButton } from "@haneoka/ui";
import {
  AssetManager,
  AtlasAttachmentLoader,
  SkeletonJson,
  SkeletonMesh,
  type TextureAtlas,
} from "@esotericsoftware/spine-threejs";

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { HomeSpot, HomeSpotSpineLayer } from "~/types/archive";

interface SpineInstance {
  characterId: number;
  sortingOrder: number;
  animation: string;
  hitPolygon?: HomeSpotSpineLayer["hitPolygon"];
  spine: SkeletonMesh;
}

const props = defineProps<{
  spot: HomeSpot;
  selectedCharacterId?: number;
}>();

const emit = defineEmits<{
  selectCharacter: [characterId: number];
}>();

const { t } = useLocale();
const host = ref<HTMLElement>();
const loading = ref(true);
const failed = ref(false);

const sceneClearColor = () => {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--md-sys-color-inverse-surface").trim();
  return value || "#272a58";
};

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let background: THREE.Object3D | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let manager: AssetManager | null = null;
let resizeObserver: ResizeObserver | null = null;
let instances: SpineInstance[] = [];
let generation = 0;
let previousFrameTime = 0;
let introStartedAt = 0;
let characterFadeStartedAt = 0;

const pointerTarget = new THREE.Vector2();
const smoothedAngles = new THREE.Vector2();
const basePosition = new THREE.Vector3();
const startPosition = new THREE.Vector3();
const targetPosition = new THREE.Vector3();
const baseRotation = new THREE.Euler(0, 0, 0, "YXZ");
const forward = new THREE.Vector3();

const numberAt = (value: number[] | undefined, index: number, fallback: number) => {
  const number = Number(value?.[index]);
  return Number.isFinite(number) ? number : fallback;
};

const unityVector = (value: number[] | undefined, fallback: [number, number, number]) =>
  new THREE.Vector3(numberAt(value, 0, fallback[0]), numberAt(value, 1, fallback[1]), -numberAt(value, 2, fallback[2]));

const convertedUnityMatrix = (value: number[] | undefined) => {
  if (!value || value.length !== 16) return new THREE.Matrix4();
  const unity = new THREE.Matrix4().set(
    ...(value as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ]),
  );
  const reflection = new THREE.Matrix4().makeScale(1, 1, -1);
  return reflection.clone().multiply(unity).multiply(reflection);
};

const disposeObject = (root: THREE.Object3D | null) => {
  root?.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of materials) {
      const withMap = material as THREE.Material & { map?: THREE.Texture | null };
      withMap.map?.dispose();
      material.dispose();
    }
  });
};

const configureBackground = (root: THREE.Object3D, activeRenderer: THREE.WebGLRenderer) => {
  const anisotropy = activeRenderer.capabilities.getMaxAnisotropy();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.renderOrder = 0;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      material.depthTest = true;
      material.depthWrite = !material.transparent;
      material.toneMapped = false;
      if (material.alphaTest > 0) material.alphaToCoverage = true;
      const withMap = material as THREE.Material & { map?: THREE.Texture | null };
      if (withMap.map) {
        withMap.map.anisotropy = anisotropy;
        withMap.map.needsUpdate = true;
      }
    }
  });
};

const configureSpine = (instance: SpineInstance, activeRenderer: THREE.WebGLRenderer) => {
  const anisotropy = activeRenderer.capabilities.getMaxAnisotropy();
  instance.spine.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.renderOrder = 100 + instance.sortingOrder;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      material.depthTest = true;
      material.depthWrite = false;
      material.toneMapped = false;
      const withMap = material as THREE.Material & { map?: THREE.Texture | null };
      if (withMap.map) {
        withMap.map.anisotropy = anisotropy;
        withMap.map.needsUpdate = true;
      }
    }
  });
};

const resize = () => {
  const element = host.value;
  if (!element || !renderer || !camera) return;
  const width = Math.max(1, element.clientWidth);
  const height = Math.max(1, element.clientHeight);
  const maximumRatio = Math.min(
    renderer.capabilities.maxTextureSize / width,
    renderer.capabilities.maxTextureSize / height,
  );
  renderer.setPixelRatio(Math.max(1, Math.min(window.devicePixelRatio || 1, maximumRatio, 2)));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
};

const easeIntro = (value: number, ease: number) => {
  const progress = THREE.MathUtils.clamp(value, 0, 1);
  return ease === 9 ? 1 - (1 - progress) ** 3 : progress;
};

const targetAngles = () => {
  const follow = props.spot.spine?.camera?.mouseFollow;
  if (!follow) return new THREE.Vector2();
  const yaw =
    pointerTarget.x < 0
      ? -pointerTarget.x * Number(follow.maxLeft || 0)
      : -pointerTarget.x * Number(follow.maxRight || 0);
  const pitch =
    pointerTarget.y < 0 ? -pointerTarget.y * Number(follow.maxUp || 0) : -pointerTarget.y * Number(follow.maxDown || 0);
  const threshold = Math.max(0, Number(follow.threshold) || 0);
  return new THREE.Vector2(Math.abs(yaw) >= threshold ? yaw : 0, Math.abs(pitch) >= threshold ? pitch : 0);
};

const applyCamera = (time: number, deltaTime: number) => {
  const settings = props.spot.spine?.camera;
  if (!camera || !settings) return;
  const duration = Math.max(0, Number(settings.introDuration) || 0) * 1000;
  const elapsed = Math.max(0, time - introStartedAt);
  if (duration > 0 && elapsed < duration) {
    camera.rotation.copy(baseRotation);
    forward.set(0, 0, -1).applyEuler(baseRotation);
    const orbitPosition = basePosition.clone().addScaledVector(forward, -(Number(settings.orbitRatio) || 0));
    camera.position.lerpVectors(
      startPosition,
      orbitPosition,
      easeIntro(elapsed / duration, Number(settings.introEase) || 0),
    );
    return;
  }

  const desired = targetAngles();
  const smoothTime = Math.max(0.001, Number(settings.mouseFollow?.smoothTime) || 0.1);
  smoothedAngles.lerp(desired, 1 - Math.exp(-Math.max(0, deltaTime) / smoothTime));
  camera.rotation.set(
    baseRotation.x + THREE.MathUtils.degToRad(smoothedAngles.y),
    baseRotation.y + THREE.MathUtils.degToRad(smoothedAngles.x),
    baseRotation.z,
    "YXZ",
  );
  forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
  camera.position.copy(basePosition).addScaledVector(forward, -(Number(settings.orbitRatio) || 0));
};

const selectionAlpha = (characterId: number) => {
  const selected = Number(props.selectedCharacterId) || 0;
  return !selected || !characterId || selected === characterId ? 1 : 0.3;
};

const renderFrame = (time: number) => {
  if (!renderer || !scene || !camera) return;
  const deltaTime = previousFrameTime ? Math.min(0.064, Math.max(0, (time - previousFrameTime) / 1000)) : 0;
  previousFrameTime = time;
  applyCamera(time, deltaTime);
  const fadeDuration = Math.max(0, Number(props.spot.spine?.fadeInDuration) || 0) * 1000;
  const fade = fadeDuration ? THREE.MathUtils.clamp((time - characterFadeStartedAt) / fadeDuration, 0, 1) : 1;
  for (const instance of instances) {
    instance.spine.skeleton.color.a = fade * selectionAlpha(instance.characterId);
    instance.spine.update(deltaTime);
  }
  renderer.render(scene, camera);
};

const replay = () => {
  const now = performance.now();
  introStartedAt = now;
  characterFadeStartedAt = now;
  previousFrameTime = 0;
  pointerTarget.set(0, 0);
  smoothedAngles.set(0, 0);
  for (const instance of instances) {
    instance.spine.state.clearTracks();
    instance.spine.skeleton.setToSetupPose();
    instance.spine.skeleton.color.a = 0;
    if (instance.animation) instance.spine.state.setAnimation(0, instance.animation, false);
    instance.spine.update(0);
    if (renderer) configureSpine(instance, renderer);
  }
  applyCamera(now, 0);
};

const pointInsidePolygon = (point: THREE.Vector2, polygon: THREE.Vector2[]) => {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const current = polygon[index];
    const prior = polygon[previous];
    if (!current || !prior) continue;
    const intersects =
      current.y > point.y !== prior.y > point.y &&
      point.x < ((prior.x - current.x) * (point.y - current.y)) / (prior.y - current.y || Number.EPSILON) + current.x;
    if (intersects) inside = !inside;
  }
  return inside;
};

const characterAt = (clientX: number, clientY: number) => {
  const element = host.value;
  if (!element || !camera) return 0;
  const rect = element.getBoundingClientRect();
  const pointer = new THREE.Vector2(clientX - rect.left, clientY - rect.top);
  for (const instance of [...instances].sort((left, right) => right.sortingOrder - left.sortingOrder)) {
    const hitPolygon = instance.hitPolygon;
    if (!instance.characterId || !hitPolygon) continue;
    instance.spine.updateMatrixWorld(true);
    const corners = hitPolygon.map((point) => {
      const projected = unityVector(point, [0, 0, 0])
        .applyMatrix4(instance.spine.matrixWorld)
        .project(camera as THREE.PerspectiveCamera);
      return new THREE.Vector2((projected.x + 1) * rect.width * 0.5, (1 - projected.y) * rect.height * 0.5);
    });
    if (pointInsidePolygon(pointer, corners)) return instance.characterId;
  }
  return 0;
};

const onPointerMove = (event: PointerEvent) => {
  const element = host.value;
  if (!element) return;
  const rect = element.getBoundingClientRect();
  pointerTarget.set(
    THREE.MathUtils.clamp(((event.clientX - rect.left) / rect.width) * 2 - 1, -1, 1),
    THREE.MathUtils.clamp(((event.clientY - rect.top) / rect.height) * 2 - 1, -1, 1),
  );
  element.style.cursor = characterAt(event.clientX, event.clientY) ? "pointer" : "default";
};

const onPointerLeave = () => {
  pointerTarget.set(0, 0);
  if (host.value) host.value.style.cursor = "default";
};

const onPointerClick = (event: MouseEvent) => {
  const characterId = characterAt(event.clientX, event.clientY);
  if (characterId) emit("selectCharacter", characterId);
};

const disposeScene = async (invalidate = true) => {
  if (invalidate) generation += 1;
  resizeObserver?.disconnect();
  resizeObserver = null;
  renderer?.setAnimationLoop(null);
  for (const instance of instances) instance.spine.dispose();
  instances = [];
  disposeObject(background);
  background = null;
  manager?.dispose();
  manager = null;
  renderer?.dispose();
  renderer?.forceContextLoss();
  renderer?.domElement.remove();
  renderer = null;
  scene = null;
  camera = null;
};

const renderScene = async () => {
  const currentGeneration = ++generation;
  loading.value = true;
  failed.value = false;
  await disposeScene(false);
  if (generation !== currentGeneration) return;
  await nextTick();

  const element = host.value;
  const runtime = props.spot.spine;
  if (
    !element ||
    !runtime?.supported ||
    !runtime.atlas ||
    !runtime.texture ||
    !runtime.backgroundScene ||
    runtime.backgroundTransform.length !== 16 ||
    !runtime.layers?.length
  ) {
    loading.value = false;
    failed.value = true;
    return;
  }

  try {
    const activeRenderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      depth: true,
      powerPreference: "high-performance",
    });
    activeRenderer.outputColorSpace = THREE.SRGBColorSpace;
    activeRenderer.setClearColor(new THREE.Color(sceneClearColor()), 1);
    activeRenderer.domElement.classList.add("home-spot-canvas");
    activeRenderer.domElement.setAttribute("role", "img");
    activeRenderer.domElement.setAttribute("aria-label", t("homeStories"));
    renderer = activeRenderer;
    element.appendChild(activeRenderer.domElement);

    const activeScene = new THREE.Scene();
    scene = activeScene;
    const settings = runtime.camera;
    const activeCamera = new THREE.PerspectiveCamera(
      Number(settings?.fieldOfView) || 20,
      Number(settings?.aspect) || 16 / 9,
      0.01,
      1000,
    );
    camera = activeCamera;
    basePosition.copy(unityVector(settings?.position, [0, 0, -1]));
    startPosition.copy(unityVector(settings?.startPosition, [0, 0, -2]));
    targetPosition.copy(unityVector(settings?.target, [0, 0, 0]));
    activeCamera.position.copy(basePosition);
    activeCamera.lookAt(targetPosition);
    baseRotation.copy(activeCamera.rotation).reorder("YXZ");
    resize();
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(element);

    const activeManager = new AssetManager();
    manager = activeManager;
    activeManager.loadTextureAtlas(runtime.atlas);
    for (const layer of runtime.layers) activeManager.loadJson(layer.skeleton);
    const [gltf] = await Promise.all([new GLTFLoader().loadAsync(runtime.backgroundScene), activeManager.loadAll()]);
    if (generation !== currentGeneration) {
      disposeObject(gltf.scene);
      return;
    }

    background = gltf.scene;
    gltf.scene.matrixAutoUpdate = false;
    gltf.scene.matrix.fromArray(runtime.backgroundTransform);
    gltf.scene.updateMatrixWorld(true);
    configureBackground(gltf.scene, activeRenderer);
    activeScene.add(gltf.scene);
    const atlas = activeManager.require(runtime.atlas) as TextureAtlas;
    instances = runtime.layers.map((layer) => {
      const parser = new SkeletonJson(new AtlasAttachmentLoader(atlas));
      parser.scale = Number(runtime.scale) || 0.01;
      const spine = new SkeletonMesh({
        skeletonData: parser.readSkeletonData(activeManager.require(layer.skeleton)),
        twoColorTint: true,
        materialFactory: (parameters) =>
          new THREE.MeshBasicMaterial({ ...parameters, depthWrite: false, toneMapped: false }),
      });
      spine.zOffset = 0;
      spine.matrixAutoUpdate = false;
      spine.matrix.copy(convertedUnityMatrix(layer.transform));
      const animation = layer.animation || runtime.animation || "";
      if (animation) spine.state.setAnimation(0, animation, false);
      spine.update(0);
      const instance = {
        characterId: Number(layer.characterId) || 0,
        sortingOrder: Number(layer.sortingOrder) || 0,
        animation,
        hitPolygon: layer.hitPolygon,
        spine,
      } satisfies SpineInstance;
      configureSpine(instance, activeRenderer);
      activeScene.add(spine);
      return instance;
    });

    replay();
    activeRenderer.render(activeScene, activeCamera);
    activeRenderer.setAnimationLoop(renderFrame);
  } catch (cause) {
    if (generation !== currentGeneration) return;
    console.error("Home Spot scene failed", cause);
    failed.value = true;
    await disposeScene(false);
  } finally {
    if (generation === currentGeneration) loading.value = false;
  }
};

watch(
  () => props.spot.spotId,
  () => void renderScene(),
);
onMounted(() => void renderScene());
onBeforeUnmount(() => void disposeScene());
</script>

<template>
  <section class="home-spot-scene" :aria-busy="loading" @pointerleave="onPointerLeave">
    <div ref="host" class="home-spot-scene__host" @pointermove="onPointerMove" @click="onPointerClick" />
    <UiIconButton
      v-if="!loading"
      class="home-spot-scene__replay"
      emphasis
      tone="surface"
      touch-target
      :label="failed ? t('retry') : t('replay')"
      @click="failed ? renderScene() : replay()"
    >
      <MaterialIcon name="refresh" :size="20" />
    </UiIconButton>
    <LoadingState v-if="loading" class="home-spot-scene__state" variant="block" />
    <div v-else-if="failed" class="home-spot-scene__state" role="status">
      <MaterialIcon name="image_not_supported" :size="28" />
      <span>{{ t("unavailable") }}</span>
    </div>
  </section>
</template>

<style scoped>
.home-spot-scene {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-inverse-surface);
  isolation: isolate;
}

.home-spot-scene__host {
  position: absolute;
  inset: 0;
}

.home-spot-scene__replay {
  position: absolute;
  z-index: 3;
  top: var(--md-sys-spacing-2);
  right: var(--md-sys-spacing-2);
}

.home-spot-scene__state {
  position: absolute;
  z-index: 2;
  inset: 0;
  display: grid;
  place-items: center;
  align-content: center;
  gap: var(--md-sys-spacing-2);
  color: var(--md-sys-color-inverse-on-surface);
  background: color-mix(in srgb, var(--md-sys-color-inverse-surface) 72%, transparent);
  font: var(--md-sys-typescale-body-medium-weight) var(--md-sys-typescale-body-medium-size) /
    var(--md-sys-typescale-body-medium-line-height) var(--md-sys-typescale-body-medium-font);
  text-align: center;
  backdrop-filter: blur(2px);
  pointer-events: none;
}

.home-spot-scene__state :deep(.loading-state__label) {
  color: var(--md-sys-color-inverse-on-surface);
}

.home-spot-scene__state :deep(.md3-circular-progress),
.home-spot-scene__state :deep(.md3-linear-progress) {
  --md-circular-progress-active-indicator-color: var(--md-sys-color-inverse-primary);
  --md-linear-progress-active-indicator-color: var(--md-sys-color-inverse-primary);
  --md-linear-progress-track-color: color-mix(in srgb, var(--md-sys-color-inverse-on-surface) 20%, transparent);
}

:deep(.home-spot-canvas) {
  display: block;
  width: 100%;
  height: 100%;
}

@media (max-width: 760px) {
  .home-spot-scene {
    border-radius: 0;
  }
}
</style>
