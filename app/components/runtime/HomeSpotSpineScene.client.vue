<script setup lang="ts">
import {
  createHaneokaThreeSpineHomeSpotScene,
  type HaneokaHomeSpotSceneController,
} from "@haneoka/vega-plugin-haneoka";
import { MaterialIcon, UiIconButton } from "@haneoka/ui";
import type { HomeSpot } from "~/types/archive";
import { loadHomeSpotSpineModules } from "./HomeSpotSpineModules";

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

let sceneController: HaneokaHomeSpotSceneController | null = null;
let loadController: AbortController | null = null;
let generation = 0;

const sceneClearColor = () => {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--md-sys-color-inverse-surface").trim();
  return value || "#272a58";
};

const disposeScene = (invalidate = true) => {
  if (invalidate) generation += 1;
  loadController?.abort();
  loadController = null;
  sceneController?.dispose();
  sceneController = null;
};

const renderScene = async () => {
  const currentGeneration = ++generation;
  loading.value = true;
  failed.value = false;
  disposeScene(false);
  await nextTick();

  const element = host.value;
  const descriptor = props.spot.spine;
  if (
    !element ||
    !descriptor?.supported ||
    !descriptor.atlas ||
    !descriptor.backgroundScene ||
    descriptor.backgroundTransform.length !== 16 ||
    !descriptor.layers?.length
  ) {
    loading.value = false;
    failed.value = true;
    return;
  }
  const pluginDescriptor = {
    ...descriptor,
    layers: descriptor.layers.map((layer) => ({ ...layer })),
  };

  const abort = new AbortController();
  loadController = abort;
  try {
    const modules = await loadHomeSpotSpineModules();
    if (generation !== currentGeneration || abort.signal.aborted) return;
    const nextController = await createHaneokaThreeSpineHomeSpotScene({
      host: element,
      descriptor: pluginDescriptor,
      modules,
      clearColor: sceneClearColor(),
      ariaLabel: t("homeStories"),
      selectedCharacterId: props.selectedCharacterId,
      signal: abort.signal,
    });
    if (generation !== currentGeneration || abort.signal.aborted) {
      nextController.dispose();
      return;
    }
    sceneController = nextController;
  } catch (cause) {
    if (generation !== currentGeneration || abort.signal.aborted) return;
    console.error("Home Spot scene failed", cause);
    failed.value = true;
    disposeScene(false);
  } finally {
    if (loadController === abort) loadController = null;
    if (generation === currentGeneration) loading.value = false;
  }
};

const replay = () => {
  sceneController?.replay();
};

const onPointerMove = (event: PointerEvent) => {
  sceneController?.pointerMove(event.clientX, event.clientY);
};

const onPointerLeave = () => {
  sceneController?.pointerLeave();
};

const onPointerClick = (event: MouseEvent) => {
  const characterId = sceneController?.selectAt(event.clientX, event.clientY);
  if (characterId) emit("selectCharacter", characterId);
};

watch(
  () => props.spot.spotId,
  () => void renderScene(),
);
watch(
  () => props.selectedCharacterId,
  (characterId) => sceneController?.setSelectedCharacter(characterId),
);
onMounted(() => void renderScene());
onBeforeUnmount(() => disposeScene());
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
