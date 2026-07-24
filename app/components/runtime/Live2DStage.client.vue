<script setup lang="ts">
import { MaterialIcon, UiButton, UiIconButton, UiList, UiListItem, UiRange, UiTextField } from "@haneoka/ui";

import { CubismModelViewer, type AdvHarmonicMotionData } from "@haneoka/story/viewer";
import type { Live2DDetail } from "~/types/archive";
import type { CatalogContentOrigin } from "~/features/catalog/contentSource";
import { assetRootForRelease, releaseResourceUrl, runtimeRootForRelease } from "~/composables/useReleaseServer";

type InspectorMode = "motion" | "expression" | "transform" | "parameters";
type BackgroundMode = "common" | "mygo" | "mujica" | "none";
type ParameterMode = "none" | "capture" | "pose";
type CubismParameterValue = ReturnType<CubismModelViewer["parameters"]>[number];

const props = defineProps<{
  entry: Live2DDetail;
  title: string;
  /** The exact Our Notes release that supplied this model. */
  origin?: Extract<CatalogContentOrigin, { provider: "release" }>;
}>();

const container = ref<HTMLElement>();
const canvas = ref<HTMLCanvasElement>();
const viewer = shallowRef<CubismModelViewer>();
const ready = ref(false);
const loading = ref(true);
const error = ref("");
const paused = ref(false);
const breath = ref(true);
const blink = ref(true);
const lookAtPointer = ref(false);
const loop = ref(false);
const scale = ref(1);
const offsetX = ref(0);
const offsetY = ref(0);
const selectedMotion = ref("");
const selectedExpression = ref("");
const inspector = ref<InspectorMode>("motion");
const background = ref<BackgroundMode>("common");
const parameters = ref<CubismParameterValue[]>([]);
const parameterMode = ref<ParameterMode>("none");
const draftValues = ref<Record<string, number>>({});
const importValue = ref("");
let resizeObserver: ResizeObserver | undefined;
let loadGeneration = 0;
let lastParameterCapture = 0;
let lastPointerPosition: { x: number; y: number } | null = null;

const { pause: pauseGlobalAudio } = useAudioPlayer();
const { releaseServer } = useReleaseServer();
const { t } = useLocale();
const resolvedReleaseServer = computed(() => props.origin?.releaseId || releaseServer.value);
const assetRoot = computed(() => assetRootForRelease(resolvedReleaseServer.value));
const motions = computed(() => (props.entry.motions || []).map((motion) => motion.name || "").filter(Boolean));
const expressions = computed(() =>
  (props.entry.expressions || []).map((expression) => expression.name || "").filter(Boolean),
);
const defaultMotionName = computed(() => {
  const preferred = props.entry.profile?.defaultMotionName || "";
  if (preferred && motions.value.includes(preferred)) return preferred;
  if (props.entry.modelType === "live" && motions.value.includes("mtn_idle_01")) return "mtn_idle_01";
  return "";
});
const headAnchor = computed(() => props.entry.profile?.anchors?.head?.position || null);
const modelUrl = computed(
  () =>
    releaseResourceUrl(props.entry.runtime?.model, resolvedReleaseServer.value) ||
    `${runtimeRootForRelease(resolvedReleaseServer.value)}/live2d/${props.entry.live2dKey}/model3.json`,
);
const backgroundAsset = (value: Exclude<BackgroundMode, "none">) => {
  if (value === "mygo") return `${assetRoot.value}/Assets/AddressableResources/Band/1/band_studio_background.png`;
  if (value === "mujica") return `${assetRoot.value}/Assets/AddressableResources/Band/2/band_studio_background.png`;
  return `${assetRoot.value}/Assets/AddressableResources/UI/Texture/common_background.png`;
};
const backgroundUrl = computed(() => (background.value === "none" ? "" : backgroundAsset(background.value)));

const inspectorOptions = computed(() => [
  { value: "motion" as const, label: t("motion"), icon: "play_arrow" },
  ...(expressions.value.length
    ? [{ value: "expression" as const, label: t("expression"), icon: "sentiment_satisfied" }]
    : []),
  { value: "transform" as const, label: t("transform"), icon: "open_with" },
  { value: "parameters" as const, label: t("parameters"), icon: "tune" },
]);
const backgroundOptions = computed(() => [
  { value: "common" as const, label: t("stage"), image: backgroundAsset("common"), imageFit: "cover" as const },
  { value: "mygo" as const, label: "MyGO!!!!!", image: backgroundAsset("mygo"), imageFit: "cover" as const },
  { value: "mujica" as const, label: "Ave Mujica", image: backgroundAsset("mujica"), imageFit: "cover" as const },
  { value: "none" as const, label: t("none"), icon: "block" },
]);
const parameterModeOptions = computed(() => [
  { value: "none" as const, label: t("none") },
  { value: "capture" as const, label: t("captureMode") },
  { value: "pose" as const, label: t("pose") },
]);

const naturalParameterOrder = (values: CubismParameterValue[]) =>
  [...values].sort((left, right) => left.id.localeCompare(right.id, "en", { numeric: true, sensitivity: "base" }));

const isFocusParameter = (id: string) =>
  /^(?:param_?eye_?ball_?[xy]|param_?angle_?[xyz]|param_?body_?angle_?x)$/i.test(id.replaceAll("-", "_"));

const poseOverrides = () =>
  Object.fromEntries(
    parameters.value
      .filter((parameter) => !(lookAtPointer.value && isFocusParameter(parameter.id)))
      .map((parameter) => [
        parameter.id,
        Math.max(
          parameter.minimum,
          Math.min(parameter.maximum, draftValues.value[parameter.id] ?? parameter.defaultValue),
        ),
      ]),
  );

const applyParameterMode = () => {
  const current = viewer.value;
  if (!current) return;
  if (parameterMode.value === "pose") {
    current.setParameterOverrides(poseOverrides());
    current.setPaused(true);
    return;
  }
  current.setParameterOverrides({});
  current.setPaused(paused.value);
};

const captureParameterFrame = () => {
  if (parameterMode.value !== "capture" || paused.value) return;
  const now = performance.now();
  if (now - lastParameterCapture < 66) return;
  const current = viewer.value;
  if (!current) return;
  const values = naturalParameterOrder(current.parameters());
  parameters.value = values;
  draftValues.value = Object.fromEntries(values.map((parameter) => [parameter.id, parameter.value]));
  lastParameterCapture = now;
};

const centerLookPosition = () => viewer.value?.setLookPosition(null);

const refreshLookPosition = () => {
  const position = lastPointerPosition;
  if (!lookAtPointer.value || !position) {
    centerLookPosition();
    return;
  }
  viewer.value?.setLookAtClientPosition(position.x, position.y, headAnchor.value);
};

const updateLookPosition = (event: PointerEvent) => {
  lastPointerPosition = { x: event.clientX, y: event.clientY };
  if (lookAtPointer.value) refreshLookPosition();
};

const resetLookPosition = () => {
  lastPointerPosition = null;
  centerLookPosition();
};

const handleVisibilityChange = () => {
  if (document.hidden) resetLookPosition();
};

const resize = () => {
  const host = container.value;
  const current = viewer.value;
  if (!host || !current) return;
  const rect = host.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  current.setSize(Math.max(1, Math.round(rect.width * ratio)), Math.max(1, Math.round(rect.height * ratio)));
};

const load = async () => {
  if (!canvas.value) return;
  const generation = ++loadGeneration;
  selectedMotion.value = "";
  selectedExpression.value = "";
  loading.value = true;
  ready.value = false;
  error.value = "";
  pauseGlobalAudio();
  try {
    viewer.value?.destroy();
    const current = markRaw(
      new CubismModelViewer({
        canvas: canvas.value,
        onFrame: captureParameterFrame,
        onError: (cause) => {
          error.value = cause instanceof Error ? cause.message : String(cause);
          ready.value = false;
        },
      }),
    );
    viewer.value = current;
    resize();
    await current.load({
      modelUrl: modelUrl.value,
      harmonicMotion: (props.entry.runtime?.harmonicMotion ||
        props.entry.harmonicMotion ||
        null) as AdvHarmonicMotionData | null,
      defaultMotionName: defaultMotionName.value || undefined,
    });
    if (generation !== loadGeneration) return;
    selectedMotion.value = defaultMotionName.value;
    loop.value = props.entry.modelType === "live" && Boolean(defaultMotionName.value);
    current.setLoopMotion(loop.value ? defaultMotionName.value : null);
    current.setBreathEnabled(breath.value);
    current.setEyeBlinkEnabled(blink.value);
    current.setTransform({ scale: scale.value, offsetX: offsetX.value, offsetY: offsetY.value });
    parameters.value = naturalParameterOrder(current.parameters());
    draftValues.value = Object.fromEntries(parameters.value.map((parameter) => [parameter.id, parameter.value]));
    applyParameterMode();
    refreshLookPosition();
    ready.value = current.ready;
  } catch (cause) {
    if (generation === loadGeneration) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
};

const playMotion = (name: string) => {
  selectedMotion.value = name;
  if (parameterMode.value !== "pose") paused.value = false;
  viewer.value?.playMotion(name);
  viewer.value?.setLoopMotion(loop.value ? name : null);
  applyParameterMode();
};

const playExpression = (name: string) => {
  selectedExpression.value = name;
  viewer.value?.playExpression(name);
};

const setParameter = (parameter: CubismParameterValue, value: number) => {
  draftValues.value = { ...draftValues.value, [parameter.id]: value };
  if (parameterMode.value === "pose") viewer.value?.setParameterOverrides(poseOverrides());
};

const resetParameters = () => {
  draftValues.value = Object.fromEntries(parameters.value.map((parameter) => [parameter.id, parameter.defaultValue]));
  if (parameterMode.value === "pose") viewer.value?.setParameterOverrides(poseOverrides());
};

const copyParameters = async () => {
  const changed = Object.fromEntries(
    parameters.value
      .filter(
        (parameter) =>
          Math.abs((draftValues.value[parameter.id] ?? parameter.defaultValue) - parameter.defaultValue) > 0.000001,
      )
      .map((parameter) => [parameter.id, draftValues.value[parameter.id] ?? parameter.defaultValue]),
  );
  const value = JSON.stringify(changed);
  importValue.value = value;
  await navigator.clipboard?.writeText(value);
};

const importParameters = () => {
  try {
    const parsed = JSON.parse(importValue.value || "{}") as Record<string, number>;
    const imported = Object.fromEntries(
      parameters.value
        .filter(
          (parameter) =>
            Object.prototype.hasOwnProperty.call(parsed, parameter.id) && Number.isFinite(Number(parsed[parameter.id])),
        )
        .map((parameter) => [
          parameter.id,
          Math.max(parameter.minimum, Math.min(parameter.maximum, Number(parsed[parameter.id]))),
        ]),
    );
    draftValues.value = { ...draftValues.value, ...imported };
    if (parameterMode.value === "pose") viewer.value?.setParameterOverrides(poseOverrides());
  } catch {
    return;
  }
};

watch(paused, applyParameterMode);
watch(breath, (value) => viewer.value?.setBreathEnabled(value));
watch(blink, (value) => viewer.value?.setEyeBlinkEnabled(value));
watch(parameterMode, () => {
  lastParameterCapture = 0;
  applyParameterMode();
  if (parameterMode.value === "capture") captureParameterFrame();
});
watch(lookAtPointer, (enabled) => {
  if (enabled) refreshLookPosition();
  else centerLookPosition();
  if (parameterMode.value === "pose") viewer.value?.setParameterOverrides(poseOverrides());
});
watch(loop, (value) => viewer.value?.setLoopMotion(value && selectedMotion.value ? selectedMotion.value : null));
watch([scale, offsetX, offsetY], () => {
  viewer.value?.setTransform({ scale: scale.value, offsetX: offsetX.value, offsetY: offsetY.value });
  refreshLookPosition();
});
watch([() => props.entry.live2dKey, resolvedReleaseServer], load);

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    resize();
    refreshLookPosition();
  });
  if (container.value) resizeObserver.observe(container.value);
  document.addEventListener("pointermove", updateLookPosition, { passive: true });
  document.documentElement.addEventListener("pointerleave", resetLookPosition, { passive: true });
  document.addEventListener("pointercancel", resetLookPosition, { passive: true });
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("blur", resetLookPosition);
  window.addEventListener("scroll", refreshLookPosition, { passive: true, capture: true });
  void load();
});

onBeforeUnmount(() => {
  loadGeneration += 1;
  resizeObserver?.disconnect();
  document.removeEventListener("pointermove", updateLookPosition);
  document.documentElement.removeEventListener("pointerleave", resetLookPosition);
  document.removeEventListener("pointercancel", resetLookPosition);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  window.removeEventListener("blur", resetLookPosition);
  window.removeEventListener("scroll", refreshLookPosition, true);
  viewer.value?.destroy();
  viewer.value = undefined;
});
</script>

<template>
  <div class="live2d-workbench">
    <section class="live2d-stage">
      <div
        ref="container"
        class="live2d-stage__viewport"
        :style="backgroundUrl ? { backgroundImage: `url(${backgroundUrl})` } : undefined"
      >
        <canvas ref="canvas" />
        <LoadingState v-if="loading" class="live2d-stage__state" />
        <ErrorState v-else-if="error || !ready" class="live2d-stage__state" @retry="load" />
      </div>

      <div class="live2d-stage__transport" role="toolbar" aria-label="Live2D">
        <UiIconButton
          :disabled="parameterMode === 'pose'"
          :label="paused || parameterMode === 'pose' ? t('play') : t('pause')"
          @click="paused = !paused"
        >
          <MaterialIcon name="play_arrow" v-if="paused || parameterMode === 'pose'" :size="17" />
          <MaterialIcon name="pause" v-else :size="17" />
        </UiIconButton>
        <UiIconButton :label="t('loop')" :pressed="loop" @click="loop = !loop">
          <MaterialIcon name="refresh" :size="17" />
        </UiIconButton>
        <UiIconButton :label="t('breath')" :pressed="breath" @click="breath = !breath">
          <MaterialIcon name="air" :size="17" />
        </UiIconButton>
        <UiIconButton :label="t('blink')" :pressed="blink" @click="blink = !blink">
          <MaterialIcon name="visibility" v-if="blink" :size="17" />
          <MaterialIcon name="visibility_off" v-else :size="17" />
        </UiIconButton>
        <UiIconButton :label="t('lookAtPointer')" :pressed="lookAtPointer" @click="lookAtPointer = !lookAtPointer">
          <MaterialIcon name="arrow_selector_tool" :size="17" />
        </UiIconButton>
      </div>
    </section>

    <aside class="live2d-inspector" :aria-label="t('settings')">
      <header class="live2d-inspector__header">
        <strong>{{ t("settings") }}</strong>
      </header>
      <div class="live2d-inspector__scroll">
        <div class="live2d-inspector__modes">
          <SegmentedControl v-model="inspector" :options="inspectorOptions" :label="t('details')" icon-only />
          <SegmentedControl v-model="background" :options="backgroundOptions" :label="t('stage')" icon-only />
        </div>

        <UiList v-if="inspector === 'motion'" class="live2d-inspector__list" :aria-label="t('motion')">
          <UiListItem
            v-for="motion in motions"
            :key="motion"
            type="button"
            :class="{ 'is-selected': motion === selectedMotion }"
            :aria-pressed="motion === selectedMotion"
            @click="playMotion(motion)"
          >
            <template #headline>{{ motion }}</template>
            <template #end><MaterialIcon name="play_arrow" :size="18" /></template>
          </UiListItem>
        </UiList>

        <UiList v-else-if="inspector === 'expression'" class="live2d-inspector__list" :aria-label="t('expression')">
          <UiListItem
            v-for="expression in expressions"
            :key="expression"
            type="button"
            :class="{ 'is-selected': expression === selectedExpression }"
            :aria-pressed="expression === selectedExpression"
            @click="playExpression(expression)"
          >
            <template #headline>{{ expression }}</template>
            <template #end><MaterialIcon name="sentiment_satisfied" :size="18" /></template>
          </UiListItem>
        </UiList>

        <div v-else-if="inspector === 'transform'" class="live2d-inspector__sliders">
          <UiRange v-model="scale" :label="t('size')" :min="0.3" :max="3" :step="0.01" :value-label="scale.toFixed(2)">
            <template #icon><MaterialIcon name="zoom_in" :size="18" /></template>
          </UiRange>
          <UiRange v-model="offsetX" label="X" :min="-2" :max="2" :step="0.01" :value-label="offsetX.toFixed(2)">
            <template #icon><MaterialIcon name="swap_horiz" :size="18" /></template>
          </UiRange>
          <UiRange v-model="offsetY" label="Y" :min="-2" :max="2" :step="0.01" :value-label="offsetY.toFixed(2)">
            <template #icon><MaterialIcon name="swap_vert" :size="18" /></template>
          </UiRange>
          <UiButton
            @click="
              scale = 1;
              offsetX = 0;
              offsetY = 0;
            "
          >
            <template #icon><MaterialIcon name="rotate_left" :size="15" /></template>
            <span>{{ t("reset") }}</span>
          </UiButton>
        </div>

        <div v-else class="live2d-inspector__parameters">
          <SegmentedControl v-model="parameterMode" :options="parameterModeOptions" :label="t('parameters')" />
          <div v-for="parameter in parameters" :key="parameter.id" class="live2d-inspector__parameter">
            <strong>{{ parameter.id }}</strong>
            <UiRange
              class="live2d-inspector__parameter-range"
              :label="parameter.id"
              :min="parameter.minimum"
              :max="parameter.maximum"
              :step="0.001"
              :disabled="parameterMode === 'capture'"
              :model-value="draftValues[parameter.id] ?? parameter.defaultValue"
              :value-label="(draftValues[parameter.id] ?? parameter.defaultValue).toFixed(2)"
              @update:model-value="setParameter(parameter, $event)"
            />
          </div>
          <UiTextField
            v-model="importValue"
            class="live2d-inspector__parameter-json"
            type="textarea"
            :label="t('parameters')"
            :disabled="parameterMode === 'capture'"
            rows="4"
            spellcheck="false"
          />
          <div class="live2d-inspector__parameter-actions">
            <UiButton :disabled="parameterMode === 'capture'" @click="importParameters">
              {{ t("import") }}
            </UiButton>
            <UiIconButton label="Copy parameter JSON" @click="copyParameters">
              <MaterialIcon name="content_copy" :size="17" />
            </UiIconButton>
            <UiButton :disabled="parameterMode === 'capture'" @click="resetParameters">
              {{ t("reset") }}
            </UiButton>
          </div>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.live2d-workbench {
  display: grid;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-template-columns: minmax(0, 1fr) clamp(216px, 30%, 360px);
  overflow: hidden;
}

.live2d-stage,
.live2d-inspector {
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-small);
}

.live2d-stage {
  display: grid;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-template-rows: minmax(0, 1fr) auto;
  border-radius: 0;
}

.live2d-stage__viewport {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background-color: var(--md-sys-color-surface-container-low);
  background-position: center;
  background-size: cover;
}

.live2d-stage__viewport::after {
  position: absolute;
  inset: 0;
  border: 1px solid color-mix(in srgb, var(--md-sys-color-outline-variant) 52%, transparent);
  content: "";
  pointer-events: none;
}

.live2d-stage canvas {
  position: absolute;
  z-index: 1;
  inset: 0;
  width: 100%;
  height: 100%;
}

.live2d-stage__state {
  position: absolute;
  z-index: 2;
  inset: 0;
  background: color-mix(in srgb, var(--md-sys-color-surface) 72%, transparent);
}

.live2d-stage__transport {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--md-sys-spacing-1);
  padding: var(--md-sys-spacing-2);
  border-top: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-low);
}

.live2d-stage__transport .md3-icon-button:disabled {
  opacity: 0.38;
  cursor: default;
}

.live2d-inspector {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  border-left: 1px solid var(--md-sys-color-outline-variant);
  border-radius: 0;
  background: var(--md-sys-color-surface-container-low);
}

.live2d-inspector__header {
  display: flex;
  min-height: var(--md-comp-control-height-touch);
  flex: 0 0 auto;
  align-items: center;
  padding: 0 var(--md-sys-spacing-3);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  color: var(--md-sys-color-on-surface);
  font-family: var(--md-sys-typescale-title-small-font);
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: var(--md-sys-typescale-title-small-weight);
  line-height: var(--md-sys-typescale-title-small-line-height);
}

.live2d-inspector__scroll {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-2);
  overflow: hidden;
}

.live2d-inspector__modes {
  display: flex;
  min-width: 0;
  flex: 0 0 auto;
  flex-direction: column;
  gap: var(--md-sys-spacing-2);
}

.live2d-inspector__modes > :deep(.md3-segments:not(.is-icon-only)) {
  width: 100%;
}

.live2d-inspector__modes > :deep(.md3-segments:not(.is-icon-only) .md3-segments__option) {
  --md-outlined-segmented-button-container-height: var(--md-comp-control-height);
}

.live2d-inspector__list,
.live2d-inspector__parameters {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: var(--md-sys-spacing-1);
  padding-right: var(--md-sys-spacing-1);
  overflow: auto;
  scrollbar-width: thin;
}

.live2d-inspector__list {
  padding-block: 0;
  background: transparent;
}

.live2d-inspector__list :deep(.md3-list-item) {
  flex: 0 0 auto;
  --md-list-item-one-line-container-height: var(--md-comp-control-height-touch);
}

.live2d-inspector__list :deep(.md3-list-item.is-selected) {
  --md-list-item-container-color: var(--md-sys-color-secondary-container);
  --md-list-item-label-text-color: var(--md-sys-color-on-secondary-container);
  --md-list-item-trailing-icon-color: var(--md-sys-color-on-secondary-container);
}

.live2d-inspector__sliders {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: var(--md-sys-spacing-4);
  padding: var(--md-sys-spacing-3) var(--md-sys-spacing-1);
  overflow: auto;
  scrollbar-width: thin;
}

.live2d-inspector__sliders > :deep(.md3-range) {
  flex: 0 0 auto;
}

.live2d-inspector__parameter {
  display: flex;
  min-width: 0;
  flex: 0 0 auto;
  flex-direction: column;
  gap: var(--md-sys-spacing-1);
  padding: var(--md-sys-spacing-2) var(--md-sys-spacing-1);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.live2d-inspector__parameter > strong {
  overflow: hidden;
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.live2d-inspector__parameters > :deep(.md3-segments) {
  position: sticky;
  z-index: 2;
  top: 0;
  width: 100%;
  flex: 0 0 auto;
  background: var(--md-sys-color-surface-container-low);
}

.live2d-inspector__parameters > :deep(.md3-segments .md3-segments__option) {
  --md-outlined-segmented-button-container-height: var(--md-comp-control-height);
}

.live2d-inspector__parameter-range {
  flex: 0 0 auto;
}

.live2d-inspector__parameter-json {
  flex: 0 0 auto;
  margin-top: var(--md-sys-spacing-2);
  --md-outlined-text-field-input-text-font: var(--md-ref-typeface-code);
}

.live2d-inspector__parameter-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--md-sys-spacing-2);
  padding-top: var(--md-sys-spacing-2);
}

@media (max-width: 650px) {
  .live2d-workbench {
    grid-template-columns: minmax(0, 1fr) minmax(176px, 44%);
  }

  .live2d-stage {
    min-height: 0;
  }

  .live2d-stage__transport {
    gap: var(--md-sys-spacing-1);
    padding: var(--md-sys-spacing-2);
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
  }

  .live2d-inspector__header {
    min-height: var(--md-comp-control-height-touch);
    padding-inline: var(--md-sys-spacing-2);
  }

  .live2d-inspector__scroll {
    gap: var(--md-sys-spacing-2);
    padding: var(--md-sys-spacing-2);
  }
}
</style>
