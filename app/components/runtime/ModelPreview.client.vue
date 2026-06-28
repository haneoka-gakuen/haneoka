<script setup lang="ts">
import type { Material, Mesh, Object3D, Texture } from "three";

const props = defineProps<{ src: string }>();

const host = ref<HTMLElement>();
const loading = ref(true);
const error = ref(false);
let generation = 0;
let cleanup: (() => void) | undefined;

const disposeObject = (root: Object3D) => {
  root.traverse((object) => {
    const mesh = object as Mesh;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    materials.forEach((material: Material) => {
      Object.values(material).forEach((value) => {
        if (value && typeof value === "object" && "isTexture" in value && value.isTexture) (value as Texture).dispose();
      });
      material.dispose();
    });
  });
};

const load = async () => {
  const container = host.value;
  if (!container) return;
  const current = ++generation;
  cleanup?.();
  cleanup = undefined;
  container.replaceChildren();
  loading.value = true;
  error.value = false;

  try {
    const [THREE, { GLTFLoader }, { OrbitControls }] = await Promise.all([
      import("three"),
      import("three/examples/jsm/loaders/GLTFLoader.js"),
      import("three/examples/jsm/controls/OrbitControls.js"),
    ]);
    if (current !== generation) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.append(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 1000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    const resources: { scene?: Object3D; observer?: ResizeObserver } = {};
    let frame = 0;
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      resources.observer?.disconnect();
      controls.dispose();
      if (resources.scene) disposeObject(resources.scene);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
    cleanup = dispose;

    scene.add(new THREE.HemisphereLight(0xf4f7ff, 0x28335c, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.7);
    key.position.set(3, 4, 5);
    scene.add(key);

    const gltf = await new GLTFLoader().loadAsync(props.src);
    if (current !== generation) {
      disposeObject(gltf.scene);
      dispose();
      return;
    }
    resources.scene = gltf.scene;
    scene.add(gltf.scene);
    const bounds = new THREE.Box3().setFromObject(gltf.scene);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = Math.max(bounds.getSize(new THREE.Vector3()).length(), 0.1);
    gltf.scene.position.sub(center);
    camera.position.set(size * 0.35, size * 0.18, size * 0.85);
    camera.near = Math.max(size / 1000, 0.001);
    camera.far = size * 20;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.update();

    const resize = () => {
      const rect = container.getBoundingClientRect();
      renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);
      camera.aspect = Math.max(1, rect.width) / Math.max(1, rect.height);
      camera.updateProjectionMatrix();
    };
    resources.observer = new ResizeObserver(resize);
    resources.observer.observe(container);
    resize();

    const render = () => {
      if (disposed) return;
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    render();
  } catch {
    if (current === generation) {
      cleanup?.();
      cleanup = undefined;
      error.value = true;
    }
  } finally {
    if (current === generation) loading.value = false;
  }
};

watch(() => props.src, load);
onMounted(load);
onBeforeUnmount(() => {
  generation += 1;
  cleanup?.();
});
</script>

<template>
  <div class="model-preview">
    <div ref="host" class="model-preview__canvas" />
    <LoadingState v-if="loading" class="model-preview__state" />
    <ErrorState v-else-if="error" class="model-preview__state" @retry="load" />
  </div>
</template>

<style scoped>
.model-preview,
.model-preview__canvas {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 420px;
}

.model-preview__canvas :deep(canvas) {
  width: 100%;
  height: 100%;
  touch-action: none;
}

.model-preview__state {
  position: absolute;
  inset: 0;
}

@media (max-width: 980px) {
  .model-preview,
  .model-preview__canvas {
    min-height: 300px;
  }
}
</style>
