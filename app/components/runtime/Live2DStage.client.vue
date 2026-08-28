<script setup lang="ts">
import { MaterialIcon, UiButton, UiIconButton, UiList, UiListItem, UiRange, UiSelect, UiTextField } from "@haneoka/ui";

import { type AdvHarmonicMotionData } from "@haneoka/vega-plugin-cubism";
import { resolveHaneokaLive2DCatalogSource } from "@haneoka/vega-plugin-haneoka";
import {
  prepareCubismModelViewerRuntime,
  type CubismModelViewer as CubismModelViewerInstance,
} from "~/features/story/cubismRuntimeProvision";
import type { Live2DDetail } from "~/types/archive";
import type { CatalogContentOrigin } from "~/features/catalog/contentSource";
import { assetRootForRelease, releaseResourceUrl, runtimeRootForRelease } from "~/composables/useReleaseServer";

type InspectorMode = "motion" | "expression" | "transform" | "parameters";
type ParameterMode = "none" | "capture" | "pose";
type CubismParameterValue = ReturnType<CubismModelViewerInstance["parameters"]>[number];
type ViewerFieldValue = number | string;
type ViewerSelectOption = { readonly label: string; readonly value: ViewerFieldValue };

const props = defineProps<{
  entry: Live2DDetail;
  title: string;
  /** The exact Our Notes release that supplied this model. */
  origin?: Extract<CatalogContentOrigin, { provider: "release" }>;
}>();

const container = ref<HTMLElement>();
const canvas = ref<HTMLCanvasElement>();
const viewer = shallowRef<CubismModelViewerInstance>();
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
const catalogSource = computed(() =>
  resolveHaneokaLive2DCatalogSource(props.entry, {
    resolveResource: (value) => releaseResourceUrl(value, resolvedReleaseServer.value),
    runtimeAsset: (path) =>
      releaseResourceUrl(`${runtimeRootForRelease(resolvedReleaseServer.value)}/${path}`, resolvedReleaseServer.value),
    sourceAsset: (path) =>
      releaseResourceUrl(`${assetRootForRelease(resolvedReleaseServer.value)}/${path}`, resolvedReleaseServer.value),
  }),
);
const motions = computed(() => catalogSource.value.motions);
const expressions = computed(() => catalogSource.value.expressions);
const defaultMotionName = computed(() => catalogSource.value.defaultMotionName || "");
const headAnchor = computed(() => catalogSource.value.headAnchor || null);
const modelUrl = computed(() => catalogSource.value.modelUrl);
const motionOptions = computed<ViewerSelectOption[]>(() => motions.value.map((value) => ({ value, label: value })));

const expressionOptions = computed<ViewerSelectOption[]>(() => expressions.value.map((value) => ({ value, label: value })));
const inspectorOptions = computed(() => [
  { value: "motion" as const, label: t("motion"), icon: "play_arrow" },
  ...(expressions.value.length
    ? [{ value: "expression" as const, label: t("expression"), icon: "sentiment_satisfied" }]
    : []),
  { value: "transform" as const, label: t("transform"), icon: "open_with" },
  { value: "parameters" as const, label: t("parameters"), icon: "tune" },
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
    const { CubismModelViewer } = await prepareCubismModelViewerRuntime();
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
      harmonicMotion: (catalogSource.value.harmonicMotion || null) as AdvHarmonicMotionData | null,
      defaultMotionName: defaultMotionName.value || undefined,
    });
    if (generation !== loadGeneration) return;
    selectedMotion.value = defaultMotionName.value;
    loop.value = catalogSource.value.loopDefaultMotion;
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

const updateMotion = (value: ViewerFieldValue) => {
  const next = String(value || "");
  if (next) playMotion(next);
};

const replay = () => {
  if (selectedMotion.value) playMotion(selectedMotion.value);
};

const togglePaused = () => {
  if (parameterMode.value !== "pose") paused.value = !paused.value;
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
watch(catalogSource, load);

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
  <RuntimeViewerSurface :label="title" :busy="loading" :show-controls="!loading && !error && ready">
    <div ref="container" class="live2d-stage__viewport">
      <canvas ref="canvas" />
      <LoadingState v-if="loading" class="live2d-stage__state" />
      <ErrorState v-else-if="error || !ready" class="live2d-stage__state" @retry="load" />
    </div>



    <template #controls>
      <UiSelect
        v-if="motionOptions.length > 1"
        :model-value="selectedMotion"
        :options="motionOptions"
        :label="t('motion')"
        @update:model-value="updateMotion"
      />
      <UiIconButton
        :disabled="parameterMode === 'pose'"
        :label="paused || parameterMode === 'pose' ? t('play') : t('pause')"
        tone="runtime"
        touch-target
        @click="togglePaused"
      >
        <MaterialIcon :name="paused || parameterMode === 'pose' ? 'play_arrow' : 'pause'" :size="20" />
      </UiIconButton>
      <UiSelect
        v-if="expressionOptions.length"
        :model-value="selectedExpression"
        :options="expressionOptions"
        :label="t('expression')"
        @update:model-value="(value) => playExpression(String(value))"
      />
      <UiIconButton :label="t('loop')" :pressed="loop" tone="runtime" touch-target @click="loop = !loop">
        <MaterialIcon name="all_inclusive" :size="20" />
      </UiIconButton>
      <UiIconButton :label="t('breath')" :pressed="breath" tone="runtime" touch-target @click="breath = !breath">
        <MaterialIcon name="air" :size="20" />
      </UiIconButton>
      <UiIconButton :label="t('blink')" :pressed="blink" tone="runtime" touch-target @click="blink = !blink">
        <MaterialIcon :name="blink ? 'visibility' : 'visibility_off'" :size="20" />
      </UiIconButton>
      <UiIconButton
        :label="t('lookAtPointer')"
        :pressed="lookAtPointer"
        tone="runtime"
        touch-target
        @click="lookAtPointer = !lookAtPointer"
      >
        <MaterialIcon name="arrow_selector_tool" :size="20" />
      </UiIconButton>
      <div class="live2d-stage__sliders">
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
          <MaterialIcon name="recenter" :size="18" />
        </UiButton>
      </div>
    </template>
  </RuntimeViewerSurface>
</template>

<style scoped>
.live2d-stage__viewport {
  position: absolute;
  inset: 0;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background-color: var(--md-sys-color-surface-container-low);
}

.live2d-stage__viewport canvas {
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

.live2d-inspector__scroll {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  gap: var(--md-sys-spacing-2);
  padding: 0;
  overflow: hidden;
}

.live2d-inspector__toggles {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--md-sys-spacing-1);
}

.live2d-inspector__modes {
  display: flex;
  min-width: 0;
  flex: 0 0 auto;
  gap: var(--md-sys-spacing-1);
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

/* Keep the parameter editor's selected state in the runtime surface palette.
 * The Material default uses the page's secondary container, which can look
 * disconnected from this primary-accented viewer panel. */
.live2d-inspector__parameter-mode :deep(.md3-segments__option) {
  --md-outlined-segmented-button-outline-color: var(--md-comp-runtime-outline);
  --md-outlined-segmented-button-selected-container-color: var(--md-comp-runtime-primary-container);
  --md-outlined-segmented-button-selected-label-text-color: var(--md-sys-color-on-primary-container);
  --md-outlined-segmented-button-selected-hover-label-text-color: var(--md-sys-color-on-primary-container);
  --md-outlined-segmented-button-selected-focus-label-text-color: var(--md-sys-color-on-primary-container);
  --md-outlined-segmented-button-selected-pressed-label-text-color: var(--md-sys-color-on-primary-container);
  --md-outlined-segmented-button-selected-hover-state-layer-color: var(--md-sys-color-on-primary-container);
  --md-outlined-segmented-button-selected-pressed-state-layer-color: var(--md-sys-color-on-primary-container);
  --md-outlined-segmented-button-unselected-label-text-color: var(--md-comp-runtime-on-surface-variant);
  --md-outlined-segmented-button-unselected-hover-label-text-color: var(--md-comp-runtime-on-surface);
  --md-outlined-segmented-button-unselected-focus-label-text-color: var(--md-comp-runtime-on-surface);
  --md-outlined-segmented-button-unselected-pressed-label-text-color: var(--md-comp-runtime-on-surface);
  --md-outlined-segmented-button-unselected-hover-state-layer-color: var(--md-comp-runtime-primary);
  --md-outlined-segmented-button-unselected-pressed-state-layer-color: var(--md-comp-runtime-primary);
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
.live2d-stage__sliders {
  display: flex;
  min-width: 220px;
  flex: 1;
  align-items: center;
  gap: var(--md-sys-spacing-2);
}
</style>
