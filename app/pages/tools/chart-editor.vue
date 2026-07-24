<script setup lang="ts">
import { MaterialIcon, UiButton, UiIconButton } from "@haneoka/ui";

import { chartCanvasOverviewPresentation } from "@haneoka/chart/overview";
import type {
  ChartEditorCatalogSelection,
  ChartEditorCatalogSource,
} from "~/components/tools/chart-editor/ChartEditorCatalogPicker.vue";
import type { NoteDirection } from "@haneoka/chart-editor/model";
import type { ValidationIssue } from "@haneoka/chart-editor/validation";
import { CHART_PLAYER_SETTING_LIMITS, useChartPlayerSettings } from "~/composables/useChartPlayerSettings";
import type { Band, Song, SongDifficulty } from "~/types/archive";
import { textOf } from "~/types/displayText";
import type { ChartEditorTool, EditorPointDraft } from "~/composables/useChartEditorWorkspace";
import {
  bestdoriOrigin,
  contentOriginKey,
  ourNotesReleaseOrigin,
  runtimeReleaseForCatalogOrigin,
  type CatalogContentOrigin,
} from "~/features/catalog/contentSource";

type PreviewResizeAxis = "x" | "y";
type PreviewMode = "chart" | "watch" | "play";
type PropertiesContext = "selection" | "tool" | "project" | "tempo" | "meter" | "timeScale";

interface PreviewResizeState {
  axis: PreviewResizeAxis;
  origin: number;
  pointerId: number;
  size: number;
}

interface ChartEditorPendingAction {
  title: string;
  confirmLabel: string;
  description: string;
  icon?: string;
  reopenCatalogOnCancel?: boolean;
  run(): Promise<void> | void;
}

const PREVIEW_BREAKPOINT = "(max-width: 639px)";

const { t, messages } = useLocale();
const copy = messages("chartEditorPage");
const chartPlayerSettings = useChartPlayerSettings();
const overviewPresentation = computed(() => {
  const settings = chartPlayerSettings.value;
  return chartCanvasOverviewPresentation(settings.zoom, settings.vertical, settings.noteSize, settings.longAlpha);
});
const overviewPresentationAtVertical = (vertical: number) => {
  const settings = chartPlayerSettings.value;
  return chartCanvasOverviewPresentation(settings.zoom, vertical, settings.noteSize, settings.longAlpha);
};
const pixelsPerSecond = computed(() => overviewPresentation.value.heightPerSecond);
const minimumPixelsPerSecond = computed(
  () => overviewPresentationAtVertical(CHART_PLAYER_SETTING_LIMITS.vertical.minimum).heightPerSecond,
);
const maximumPixelsPerSecond = computed(
  () => overviewPresentationAtVertical(CHART_PLAYER_SETTING_LIMITS.vertical.maximum).heightPerSecond,
);
const tool = ref<ChartEditorTool>("select");
const snapDivision = ref(4);
const noteSize = ref(2);
const critical = ref(false);
const direction = ref<NoteDirection>("up");
const viewStartSeconds = ref(-0.5);
const draftHoldStart = ref<EditorPointDraft | null>(null);
const chartInput = ref<HTMLInputElement>();
const audioInput = ref<HTMLInputElement>();
const catalogPickerOpen = ref(false);
const catalogSource = ref<ChartEditorCatalogSource>("current");
const pendingCatalogConfirmation = shallowRef<ChartEditorCatalogSelection>();
const pendingAction = shallowRef<ChartEditorPendingAction>();
const reopenCatalogAfterAction = ref(false);
const propertiesOpen = ref(false);
const propertiesContext = ref<PropertiesContext>("project");
const diagnosticsOpen = ref(false);
const workbench = ref<HTMLElement>();
const stage = ref<HTMLElement>();
const previewMode = ref<PreviewMode>("watch");
const previewModeOptions = computed(() => [
  { value: "chart", label: t("chart"), icon: "bar_chart" },
  { value: "watch", label: t("watch"), icon: "visibility" },
  { value: "play", label: t("play"), icon: "sports_esports" },
]);
const previewNarrow = ref(false);
const previewWidth = ref<number>();
const previewHeight = ref<number>();
const playbackReturnSeconds = ref(0);
let previewMedia: MediaQueryList | undefined;
let previewResizeState: PreviewResizeState | undefined;

const editor = useChartEditorWorkspace();
const { resolveLocalized } = useLocale();
const { releaseServer, assetUrl } = useReleaseServer();
const catalogOrigin = computed<CatalogContentOrigin>(() =>
  catalogSource.value === "bestdori" ? bestdoriOrigin("jp") : ourNotesReleaseOrigin(releaseServer.value),
);
// Bestdori supplies charts, not Our Notes runtime artwork. Keep its renderer
// fallback explicit instead of treating the Bestdori region as a release.
const chartRuntimeRelease = computed(() => runtimeReleaseForCatalogOrigin(catalogOrigin.value, releaseServer.value));
const songRequest = useLazyCatalogCollection<Song>("songs", catalogPickerOpen, catalogOrigin);
const bandRequest = useLazyCatalogCollection<Band>("bands", catalogPickerOpen, catalogOrigin);
const catalogSongs = computed(() => recordValues(songRequest.data.value));
const catalogBands = computed(() => recordValues(bandRequest.data.value));
const catalogPending = computed(() => songRequest.pending.value);
const catalogError = computed(() => songRequest.error.value);
const {
  assets: chartAssets,
  error: chartAssetsError,
  refresh: refreshChartAssets,
} = useOurNotesRuntimeAssets(chartRuntimeRelease);
const {
  project,
  chart,
  validation,
  tempoMap,
  canUndo,
  canRedo,
  selectedIds,
  importWarnings,
  status,
  statusDetail,
  audioUrl,
  audioDuration,
  waveform,
  playheadSeconds,
  playing,
  playbackRate,
} = editor;

const diagnostics = computed<ValidationIssue[]>(() => [
  ...validation.value.errors,
  ...validation.value.warnings,
  ...importWarnings.value.map((warning) => ({ ...warning, severity: "warning" as const })),
]);
const diagnosticErrors = computed(() => diagnostics.value.filter((issue) => issue.severity === "error").length);
const diagnosticWarnings = computed(() => diagnostics.value.filter((issue) => issue.severity === "warning").length);
const playheadTick = computed(() => Math.max(0, Math.round(tempoMap.value.secondsToTick(playheadSeconds.value))));
const noteCount = computed(
  () => project.value.singles.length + project.value.lines.reduce((count, line) => count + line.points.length, 0),
);
const hasAuthoredProject = computed(() => {
  const value = project.value;
  const meta = value.meta;
  return Boolean(
    audioUrl.value ||
    noteCount.value ||
    meta.title ||
    meta.artist ||
    meta.charter ||
    meta.difficulty ||
    meta.level ||
    meta.source ||
    meta.tags?.length ||
    (meta.extra && Object.keys(meta.extra).length) ||
    value.audioOffset !== 0 ||
    value.laneBasis !== 24 ||
    value.tempos.length !== 1 ||
    value.tempos[0]?.tick !== 0 ||
    value.tempos[0]?.bpm !== 120 ||
    value.meters.length !== 1 ||
    value.meters[0]?.tick !== 0 ||
    value.meters[0]?.numerator !== 4 ||
    value.meters[0]?.denominator !== 4 ||
    value.timeScales.length ||
    value.markers.skill.length ||
    value.markers.fever.length ||
    value.markers.call.length ||
    Object.keys(value.extensions).length,
  );
});
const timelineDuration = computed(() =>
  Math.max(60, audioDuration.value, chart.value.durationMs / 1000 + project.value.audioOffset),
);
const statusText = computed(() => {
  const key = `chartEditorPage.${status.value}` as const;
  if (status.value === "imported") return t(key, { format: statusDetail.value });
  return t(key);
});
const statusFailed = computed(() => ["loadFailed", "audioFailed", "saveFailed"].includes(status.value));
const activeToolLabel = computed(
  () =>
    ({
      select: copy.value.select,
      pan: copy.value.pan,
      tap: copy.value.tap,
      flick: copy.value.flick,
      trace: copy.value.trace,
      long: copy.value.hold,
      guide: copy.value.guide,
      eraser: copy.value.erase,
    })[tool.value],
);
const stageStyle = computed<Record<string, string>>(() => ({
  "--chart-editor-preview-width": previewWidth.value === undefined ? "50%" : `${previewWidth.value}px`,
  "--chart-editor-preview-height": previewHeight.value === undefined ? "50%" : `${previewHeight.value}px`,
}));

const clamp = (value: number, minimum: number, maximum: number) => Math.min(Math.max(value, minimum), maximum);

const setTimelinePixelsPerSecond = (value: number) => {
  const unitScale = overviewPresentationAtVertical(1).heightPerSecond;
  chartPlayerSettings.value.vertical = clamp(
    value / unitScale,
    CHART_PLAYER_SETTING_LIMITS.vertical.minimum,
    CHART_PLAYER_SETTING_LIMITS.vertical.maximum,
  );
};

const previewBounds = (axis: PreviewResizeAxis) => {
  const rect = stage.value?.getBoundingClientRect();
  const available = axis === "x" ? rect?.width || window.innerWidth : rect?.height || window.innerHeight;
  const hardMinimum = axis === "x" ? 220 : 160;
  const minimum = Math.min(Math.floor(available * 0.45), Math.max(hardMinimum, Math.floor(available * 0.2)));
  const maximum = Math.max(minimum, Math.floor(available * 0.8));
  return { minimum, maximum };
};

const setPreviewSize = (axis: PreviewResizeAxis, value: number) => {
  const { minimum, maximum } = previewBounds(axis);
  if (axis === "x") previewWidth.value = clamp(value, minimum, maximum);
  else previewHeight.value = clamp(value, minimum, maximum);
};

const fullscreenEditor = async () => {
  const element = workbench.value;
  if (!element) return;
  try {
    if (document.fullscreenElement === element) await document.exitFullscreen();
    else await element.requestFullscreen();
  } catch {
    // The editor remains usable when fullscreen is denied by the browser.
  }
};

const startPreviewResize = (event: PointerEvent) => {
  event.preventDefault();
  const axis: PreviewResizeAxis = previewNarrow.value ? "y" : "x";
  const rect = stage.value?.getBoundingClientRect();
  const defaultSize = (axis === "x" ? rect?.width : rect?.height) ?? 0;
  previewResizeState = {
    axis,
    origin: axis === "x" ? event.clientX : event.clientY,
    pointerId: event.pointerId,
    size: (axis === "x" ? previewWidth.value : previewHeight.value) ?? defaultSize / 2,
  };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
};

const resizePreview = (event: PointerEvent) => {
  if (!previewResizeState || previewResizeState.pointerId !== event.pointerId) return;
  const position = previewResizeState.axis === "x" ? event.clientX : event.clientY;
  setPreviewSize(previewResizeState.axis, previewResizeState.size + position - previewResizeState.origin);
};

const stopPreviewResize = (event: PointerEvent) => {
  if (!previewResizeState || previewResizeState.pointerId !== event.pointerId) return;
  const target = event.currentTarget as HTMLElement;
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
  previewResizeState = undefined;
};

const resizePreviewByKeyboard = (event: KeyboardEvent) => {
  const axis: PreviewResizeAxis = previewNarrow.value ? "y" : "x";
  const smallerKey = axis === "x" ? "ArrowLeft" : "ArrowUp";
  const largerKey = axis === "x" ? "ArrowRight" : "ArrowDown";
  const rect = stage.value?.getBoundingClientRect();
  const current =
    (axis === "x" ? previewWidth.value : previewHeight.value) ?? ((axis === "x" ? rect?.width : rect?.height) || 0) / 2;
  const { minimum, maximum } = previewBounds(axis);
  let next: number | undefined;
  if (event.key === smallerKey) next = current - (event.shiftKey ? 40 : 12);
  else if (event.key === largerKey) next = current + (event.shiftKey ? 40 : 12);
  else if (event.key === "Home") next = minimum;
  else if (event.key === "End") next = maximum;
  if (next === undefined) return;
  event.preventDefault();
  setPreviewSize(axis, next);
};

const syncPreviewLayout = (event?: MediaQueryListEvent) => {
  previewNarrow.value = event?.matches ?? previewMedia?.matches ?? false;
};

const chooseTool = (value: ChartEditorTool) => {
  tool.value = value;
  if (value !== "long" && value !== "guide") draftHoldStart.value = null;
};

const openProperties = (context: PropertiesContext) => {
  propertiesContext.value = context;
  propertiesOpen.value = true;
};

const requestAction = (action: ChartEditorPendingAction) => {
  pendingAction.value = action;
};

const cancelPendingAction = () => {
  const action = pendingAction.value;
  pendingAction.value = undefined;
  if (action?.reopenCatalogOnCancel) reopenCatalogAfterAction.value = true;
};

const confirmPendingAction = async () => {
  const action = pendingAction.value;
  if (!action) return;
  pendingAction.value = undefined;
  await action.run();
};

const onPendingActionClosed = () => {
  if (!reopenCatalogAfterAction.value) return;
  reopenCatalogAfterAction.value = false;
  catalogPickerOpen.value = true;
};

const importChartFile = async (file: File) => {
  try {
    await editor.importChartFile(file);
    viewStartSeconds.value = Math.min(-0.5, project.value.audioOffset - 0.5);
  } catch {
    // The status bar and diagnostics panel carry the actionable error.
  }
};

const onChartInput = async (event: Event) => {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (hasAuthoredProject.value) {
    requestAction({
      title: copy.value.importLocalChart,
      description: copy.value.importChartConfirm,
      confirmLabel: copy.value.importLocalChart,
      icon: "upload_file",
      run: () => importChartFile(file),
    });
    return;
  }
  await importChartFile(file);
};

const onAudioInput = async (event: Event) => {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) await editor.importAudioFile(file);
};

const resetProject = async () => {
  await editor.newProject();
  viewStartSeconds.value = -0.5;
  draftHoldStart.value = null;
};

const createNewProject = async () => {
  if (hasAuthoredProject.value) {
    requestAction({
      title: copy.value.newProject,
      description: copy.value.newProjectConfirm,
      confirmLabel: copy.value.newProject,
      icon: "note_add",
      run: resetProject,
    });
    return;
  }
  await resetProject();
};

const difficultyName = difficultyNameOf;
const difficultyLevel = (difficulty: SongDifficulty) =>
  Math.trunc(Number(difficulty.displayLevel ?? difficulty.playLevel ?? 0)) || undefined;
const audioFilename = (song: Song, origin: CatalogContentOrigin) => {
  const url = String(song.musicUrl || "");
  const pathname = (() => {
    try {
      return new URL(url, window.location.href).pathname;
    } catch {
      return url;
    }
  })();
  const name = decodeURIComponent(pathname.split("/").at(-1) || "");
  if (/\.[a-z0-9]{2,5}$/i.test(name)) return name;
  return origin.provider === "bestdori" ? `${name || song.musicId}.mp3` : name || `${song.musicId}.audio`;
};

const catalogResourceUrl = (value: unknown, origin: CatalogContentOrigin): string => {
  const url = String(value || "");
  return origin.provider === "bestdori" ? url : assetUrl(url, origin.releaseId);
};

const openCatalogPicker = () => {
  catalogPickerOpen.value = true;
};

const applyCatalogSelection = async (selection: ChartEditorCatalogSelection) => {
  const { origin, song, band, chart: includeChart, audio: includeAudio } = selection;
  const difficulty = selection.difficulty === undefined ? undefined : song.difficulty?.[selection.difficulty];
  if (includeChart && (!difficulty?.file || selection.difficulty === undefined)) return;
  if (includeAudio && !song.musicUrl) return;

  const title = textOf(
    resolveLocalized(song.musicTitle, { sourceHint: "ja", fallback: String(song.musicId) }),
    String(song.musicId),
  );
  const artist = textOf(resolveLocalized(band?.bandName, { sourceHint: "ja", fallback: "" }));
  const level = difficulty ? difficultyLevel(difficulty) : undefined;
  const source = `catalog:${contentOriginKey(origin)}:${song.musicId}${selection.difficulty === undefined ? "" : `:${selection.difficulty}`}`;
  catalogPickerOpen.value = false;

  try {
    await editor.importRemoteResources({
      ...(includeChart && difficulty?.file
        ? {
            chart: {
              url: catalogResourceUrl(difficulty.file, origin),
              name: `${song.musicId}-${selection.difficulty}.${origin.provider === "bestdori" ? "ss" : "json"}`,
              metadata: {
                title,
                artist,
                difficulty: difficultyName(difficulty, selection.difficulty!),
                level: level === undefined ? "" : String(level),
                source,
                extra: {
                  origin,
                  musicId: song.musicId,
                  difficulty: selection.difficulty!,
                },
              },
            },
          }
        : {}),
      ...(includeAudio && song.musicUrl
        ? {
            audio: {
              url: catalogResourceUrl(song.musicUrl, origin),
              name: audioFilename(song, origin),
            },
          }
        : {}),
    });
    if (includeChart) {
      viewStartSeconds.value = Math.min(-0.5, project.value.audioOffset - 0.5);
    }
  } catch {
    // Import status and diagnostics retain the actionable error.
  }
};

const importCatalogSelection = (selection: ChartEditorCatalogSelection) => {
  const difficulty = selection.difficulty === undefined ? undefined : selection.song.difficulty?.[selection.difficulty];
  if (selection.chart && (!difficulty?.file || selection.difficulty === undefined)) return;
  if (selection.audio && !selection.song.musicUrl) return;
  if (selection.chart && hasAuthoredProject.value) {
    pendingCatalogConfirmation.value = selection;
    catalogPickerOpen.value = false;
    return;
  }
  void applyCatalogSelection(selection);
};

const onCatalogPickerClosed = () => {
  const selection = pendingCatalogConfirmation.value;
  if (!selection) return;
  pendingCatalogConfirmation.value = undefined;
  requestAction({
    title: copy.value.importServerChart,
    description: copy.value.importChartConfirm,
    confirmLabel: copy.value.importServerChart,
    icon: "library_music",
    reopenCatalogOnCancel: true,
    run: () => applyCatalogSelection(selection),
  });
};

const onViewChange = (payload: { startSeconds: number; pixelsPerSecond: number }) => {
  viewStartSeconds.value = payload.startSeconds;
  setTimelinePixelsPerSecond(payload.pixelsPerSecond);
};

const seekEditor = (seconds: number) => {
  if (audioUrl.value) editor.seek(seconds);
  else playheadSeconds.value = Math.min(timelineDuration.value, Math.max(0, seconds));
};

const togglePlayback = async () => {
  if (!playing.value) playbackReturnSeconds.value = playheadSeconds.value;
  await editor.togglePlayback();
};

const stopPlayback = () => {
  if (!playing.value) return;
  editor.pause();
  seekEditor(playbackReturnSeconds.value);
};

const changePlaybackRate = (direction: -1 | 1) => {
  const rates = [0.25, 0.5, 0.75, 1, 1.5, 2];
  const next =
    direction < 0
      ? [...rates].reverse().find((rate) => rate < playbackRate.value)
      : rates.find((rate) => rate > playbackRate.value);
  if (next !== undefined) editor.setPlaybackRate(next);
};

const zoomEditor = (direction: -1 | 1) => {
  const previous = pixelsPerSecond.value;
  const next = clamp(
    previous * (direction > 0 ? 1.25 : 0.8),
    minimumPixelsPerSecond.value,
    maximumPixelsPerSecond.value,
  );
  const anchor = playheadSeconds.value;
  const anchorOffset = (anchor - viewStartSeconds.value) * previous;
  setTimelinePixelsPerSecond(next);
  viewStartSeconds.value = anchor - anchorOffset / next;
};

const textEditingTarget = (target: EventTarget | null) => {
  const element = target instanceof Element ? target : undefined;
  return Boolean(element?.closest("input, select, textarea, [contenteditable='true']"));
};
const controlTarget = (target: EventTarget | null) => {
  const element = target instanceof Element ? target : undefined;
  return Boolean(element?.closest("input, select, textarea, button, a, [contenteditable='true']"));
};

const onKeydown = (event: KeyboardEvent) => {
  if (event.composedPath().some((target) => target instanceof Element && target.matches("md-dialog"))) return;
  if (event.key === "Escape") {
    if (pendingAction.value) cancelPendingAction();
    else if (catalogPickerOpen.value) catalogPickerOpen.value = false;
    else if (propertiesOpen.value) propertiesOpen.value = false;
    else if (diagnosticsOpen.value) diagnosticsOpen.value = false;
    else selectedIds.value = [];
    return;
  }
  const command = event.metaKey || event.ctrlKey;
  if (command && event.key.toLowerCase() === "z" && !textEditingTarget(event.target)) {
    event.preventDefault();
    if (event.shiftKey) editor.redo();
    else editor.undo();
    return;
  }
  if (command && event.key.toLowerCase() === "y" && !textEditingTarget(event.target)) {
    event.preventDefault();
    editor.redo();
    return;
  }
  if (command || event.altKey || event.shiftKey || controlTarget(event.target)) return;

  const key = event.key.toLowerCase();
  const divisions: Record<string, number> = { "1": 1, "2": 2, "3": 3, "4": 4, "6": 6, "8": 8, "9": 12, "0": 16 };
  if (divisions[key]) {
    event.preventDefault();
    snapDivision.value = divisions[key];
    return;
  }

  const action = (() => {
    switch (key) {
      case "n":
        return () => void createNewProject();
      case "o":
        return () => chartInput.value?.click();
      case "p":
        return () => void editor.saveNow();
      case " ":
        return () => void togglePlayback();
      case "backspace":
        return stopPlayback;
      case "f":
        return () => chooseTool("select");
      case "g":
        return () => chooseTool("eraser");
      case "z":
        return editor.undo;
      case "y":
        return editor.redo;
      case "a":
        return () => chooseTool("tap");
      case "s":
        return () => chooseTool("long");
      case "q":
        return () => openProperties("tempo");
      case "w":
        return () => openProperties("timeScale");
      case ";":
        return () => changePlaybackRate(-1);
      case "'":
        return () => changePlaybackRate(1);
      case "[":
      case "-":
        return () => zoomEditor(-1);
      case "]":
      case "=":
        return () => zoomEditor(1);
    }
  })();
  if (!action) return;
  event.preventDefault();
  action();
};

watch(playheadSeconds, (seconds) => {
  if (playing.value) viewStartSeconds.value = seconds - 0.7;
});

watch(previewMode, () => {
  // Keep the editor's single audio clock aligned with ChartRuntime: changing
  // presentation modes stops playback before either renderer is replaced.
  if (playing.value) editor.pause();
});

onMounted(() => {
  previewMedia = window.matchMedia(PREVIEW_BREAKPOINT);
  syncPreviewLayout();
  previewMedia.addEventListener("change", syncPreviewLayout);
  window.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  previewMedia?.removeEventListener("change", syncPreviewLayout);
  window.removeEventListener("keydown", onKeydown);
});

useSeoMeta({
  title: () => `${t("chartEditor")} · haneoka`,
  description: () => t("chartEditor"),
});
</script>

<template>
  <WorkspaceScreen domain="tools" :title="t('chartEditor')" :count="noteCount" :detail-available="false">
    <template #heading-actions>
      <SegmentedControl v-model="previewMode" :options="previewModeOptions" :label="t('view')" icon-only />
    </template>

    <div ref="workbench" class="chart-editor-workbench" :style="stageStyle">
      <div ref="stage" class="chart-editor-stage">
        <section class="chart-editor-preview" :aria-label="copy.preview">
          <div class="chart-editor-preview__runtime">
            <ClientOnly>
              <ErrorState v-if="chartAssetsError" @retry="refreshChartAssets()" />
              <ChartEditorPreview
                v-else-if="chartAssets"
                v-model:mode="previewMode"
                :chart="chart"
                :assets="chartAssets"
                :presentation="overviewPresentation"
                :playhead-seconds="playheadSeconds"
                :playing="playing"
                :audio-available="Boolean(audioUrl)"
                :duration-seconds="audioDuration"
                :runtime-release="chartRuntimeRelease"
                :bgm-offset-ms="project.audioOffset * 1000"
                @toggle-playback="togglePlayback"
                @seek="seekEditor"
              />
              <LoadingState v-else />
              <template #fallback><LoadingState /></template>
            </ClientOnly>
          </div>
          <div
            class="chart-editor-preview__handle"
            role="separator"
            :aria-orientation="previewNarrow ? 'horizontal' : 'vertical'"
            tabindex="0"
            @keydown="resizePreviewByKeyboard"
            @pointerdown="startPreviewResize"
            @pointermove="resizePreview"
            @pointerup="stopPreviewResize"
            @pointercancel="stopPreviewResize"
          />
        </section>

        <section class="chart-editor-stage__editing">
          <ChartEditorCanvas
            :project="project"
            :assets="chartAssets"
            :waveform="waveform"
            :audio-duration="timelineDuration"
            :view-start-seconds="viewStartSeconds"
            :pixels-per-second="pixelsPerSecond"
            :min-pixels-per-second="minimumPixelsPerSecond"
            :max-pixels-per-second="maximumPixelsPerSecond"
            :presentation="overviewPresentation"
            :snap-division="snapDivision"
            :tool="tool"
            :selected-ids="selectedIds"
            :playhead-seconds="playheadSeconds"
            :playing="playing"
            :draft-hold-start="draftHoldStart"
            :note-size="noteSize"
            :critical="critical"
            :direction="direction"
            :timeline-label="t('chartEditor')"
            @select="selectedIds = $event.ids"
            @create-single="editor.createSingle"
            @create-hold="editor.createLine({ ...$event, critical })"
            @move="editor.moveItems"
            @delete="editor.deleteItems($event.ids)"
            @seek="seekEditor"
            @view-change="onViewChange"
            @draft-hold="draftHoldStart = $event"
            @request-properties="openProperties('selection')"
          />
          <ChartEditorCommandBar
            :assets="chartAssets"
            :tool="tool"
            :snap-division="snapDivision"
            :playing="playing"
            :audio-available="Boolean(audioUrl)"
            :playback-rate="playbackRate"
            :can-undo="canUndo"
            :can-redo="canRedo"
            @new-project="createNewProject"
            @import-chart="chartInput?.click()"
            @import-audio="audioInput?.click()"
            @open-catalog="openCatalogPicker"
            @open-project-properties="openProperties('project')"
            @open-tool-properties="openProperties('tool')"
            @open-timing="openProperties($event === 'bpm' ? 'tempo' : $event)"
            @undo="editor.undo"
            @redo="editor.redo"
            @update:tool="chooseTool"
            @update:snap-division="snapDivision = $event"
            @toggle-playback="togglePlayback"
            @stop-playback="stopPlayback"
            @update:playback-rate="editor.setPlaybackRate"
            @zoom-in="zoomEditor(1)"
            @zoom-out="zoomEditor(-1)"
            @fullscreen="fullscreenEditor"
          />
        </section>
      </div>

      <section v-if="diagnosticsOpen" class="chart-editor-diagnostics" :aria-label="copy.errors">
        <header>
          <MaterialIcon name="warning" :size="15" />
          <strong>{{ copy.errors }} / {{ copy.warnings }}</strong>
          <span class="display-number">{{ diagnosticErrors }} / {{ diagnosticWarnings }}</span>
          <UiIconButton
            class="chart-editor-diagnostics__close"
            size="compact"
            touch-target
            :label="t('close')"
            @click="diagnosticsOpen = false"
          >
            <MaterialIcon name="close" :size="15" />
          </UiIconButton>
        </header>
        <ul>
          <li v-for="issue in diagnostics" :key="`${issue.code}:${issue.path}`" :class="`is-${issue.severity}`">
            <MaterialIcon name="warning" :size="14" />
            <span>
              <strong>{{ issue.message }}</strong>
              <small>{{ issue.path }}</small>
            </span>
          </li>
        </ul>
      </section>

      <footer class="chart-editor-statusbar">
        <span class="chart-editor-statusbar__tool">{{ activeToolLabel }}</span>
        <UiButton
          v-if="diagnostics.length"
          class="chart-editor-statusbar__issues"
          tone="text"
          :aria-expanded="diagnosticsOpen"
          @click="diagnosticsOpen = !diagnosticsOpen"
        >
          {{ copy.errors }} {{ diagnosticErrors }} · {{ copy.warnings }} {{ diagnosticWarnings }}
        </UiButton>
        <span
          v-if="statusFailed"
          class="chart-editor-statusbar__failure"
          role="alert"
          aria-atomic="true"
          :title="statusDetail"
        >
          <MaterialIcon name="warning" :size="12" />
          <strong>{{ statusText }}</strong>
          <span v-if="statusDetail">{{ statusDetail }}</span>
        </span>
        <span class="display-number">1/{{ snapDivision }}</span>
        <span v-if="!statusFailed" class="sr-only" aria-live="polite" aria-atomic="true">
          {{ statusText }} {{ statusDetail }}
        </span>
      </footer>
    </div>

    <input
      ref="chartInput"
      class="sr-only"
      type="file"
      accept=".json,.ss,.usc,.sus,.bytes,.gz,.txt,application/json,application/gzip,application/octet-stream,text/plain"
      @change="onChartInput"
    />
    <input
      ref="audioInput"
      class="sr-only"
      type="file"
      accept="audio/*,.mp3,.ogg,.opus,.wav,.flac,.m4a,.aac,.webm"
      @change="onAudioInput"
    />
    <ChartEditorCatalogPicker
      v-model="catalogPickerOpen"
      v-model:source="catalogSource"
      :current-release="releaseServer"
      :songs="catalogSongs"
      :bands="catalogBands"
      :pending="catalogPending"
      :error="catalogError"
      @closed="onCatalogPickerClosed"
      @refresh="(songRequest.refresh(), bandRequest.refresh())"
      @select="importCatalogSelection"
    />
    <EditorActionDialog
      :open="Boolean(pendingAction)"
      :title="pendingAction?.title || ''"
      :description="pendingAction?.description"
      :confirm-label="pendingAction?.confirmLabel || ''"
      :cancel-label="t('cancel')"
      :icon="pendingAction?.icon"
      @cancel="cancelPendingAction"
      @closed="onPendingActionClosed"
      @confirm="confirmPendingAction"
    />
    <ChartEditorPropertiesDialog
      v-model="propertiesOpen"
      :context="propertiesContext"
      :project="project"
      :selected-ids="selectedIds"
      :playhead-tick="playheadTick"
      :tool="tool"
      :note-size="noteSize"
      :critical="critical"
      :direction="direction"
      @patch-meta="editor.updateMeta"
      @patch-audio-offset="editor.updateAudioOffset"
      @patch-lane-basis="editor.updateLaneBasis"
      @patch-selection="editor.patchSelection"
      @update:note-size="noteSize = $event"
      @update:critical="critical = $event"
      @update:direction="direction = $event"
      @add-tempo="editor.addTempo"
      @update-tempo="editor.updateTempo($event.id, $event.patch)"
      @delete-tempo="editor.deleteTempo"
      @add-meter="editor.addMeter"
      @update-meter="editor.updateMeter($event.id, $event.patch)"
      @delete-meter="editor.deleteMeter"
      @add-time-scale="editor.addTimeScale"
      @update-time-scale="editor.updateTimeScale($event.id, $event.patch)"
      @delete-time-scale="editor.deleteTimeScale"
    />
  </WorkspaceScreen>
</template>

<style scoped>
.chart-editor-workbench {
  position: relative;
  display: grid;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-template-rows: minmax(0, 1fr) 27px;
  overflow: hidden;
  background: var(--md-sys-color-surface-container-lowest);
}

.chart-editor-workbench:fullscreen {
  width: 100vw;
  height: 100vh;
}

.chart-editor-stage {
  position: relative;
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-columns: minmax(0, var(--chart-editor-preview-width)) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  overflow: hidden;
  background: var(--md-sys-color-surface-container-lowest);
}

.chart-editor-preview {
  position: relative;
  z-index: 10;
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-rows: minmax(0, 1fr);
  overflow: visible;
  border-right: 1px solid var(--md-sys-color-outline-variant);
  background: #060a16;
}

.chart-editor-preview__runtime {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.chart-editor-preview__runtime > :deep(*) {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.chart-editor-preview__handle {
  position: absolute;
  z-index: 20;
  top: 4px;
  right: -2px;
  bottom: 4px;
  width: 6px;
  outline: 0;
  cursor: ew-resize;
  touch-action: none;
}

.chart-editor-preview__handle::after {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 2px;
  width: 2px;
  border-radius: 2px;
  background: transparent;
  content: "";
}

.chart-editor-preview__handle:hover::after,
.chart-editor-preview__handle:active::after,
.chart-editor-preview__handle:focus-visible::after {
  background: var(--md-sys-color-primary);
}

.chart-editor-stage__editing {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: #060a16;
}

.chart-editor-stage > :deep(*) {
  min-width: 0;
  min-height: 0;
}

.chart-editor-stage :deep(.chart-editor-canvas) {
  width: 100%;
  height: 100%;
  min-height: 0;
  border: 0;
  border-radius: 0;
}

.chart-editor-diagnostics {
  position: absolute;
  z-index: calc(var(--md-sys-z-index-local-raised) + 1);
  right: var(--md-sys-spacing-2);
  bottom: calc(var(--md-comp-control-height-compact) + var(--md-sys-spacing-2));
  display: grid;
  width: min(420px, calc(100% - 16px));
  max-height: min(420px, calc(100% - 52px));
  grid-template-rows: 38px minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--md-sys-color-outline);
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-high);
  box-shadow: var(--md-sys-elevation-level3);
}

.chart-editor-diagnostics > header {
  display: flex;
  align-items: center;
  gap: var(--md-sys-spacing-2);
  padding: 0 var(--md-sys-spacing-1) 0 var(--md-sys-spacing-3);
  color: var(--md-sys-color-on-surface-variant);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  font-family: var(--md-sys-typescale-title-small-font);
}

.chart-editor-diagnostics > header strong {
  min-width: 0;
  flex: 1;
  color: var(--md-sys-color-on-surface);
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: var(--md-sys-typescale-title-small-weight);
  line-height: var(--md-sys-typescale-title-small-line-height);
}

.chart-editor-diagnostics > header span {
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  line-height: var(--md-sys-typescale-label-small-line-height);
}

.chart-editor-diagnostics__close {
  flex: 0 0 auto;
}

.chart-editor-diagnostics ul {
  display: grid;
  align-content: start;
  gap: 0;
  margin: 0;
  padding: 0;
  overflow: auto;
  list-style: none;
}

.chart-editor-diagnostics li {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-2) var(--md-sys-spacing-3);
  color: var(--md-sys-color-on-surface-variant);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.chart-editor-diagnostics li > :deep(.md3-material-icon) {
  color: var(--md-extended-color-attribute-yellow);
}

.chart-editor-diagnostics li.is-error > :deep(.md3-material-icon) {
  color: var(--md-extended-color-attribute-red);
}

.chart-editor-diagnostics li > span {
  display: grid;
  min-width: 0;
  gap: var(--md-sys-spacing-1);
}

.chart-editor-diagnostics li strong {
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-body-small-font);
  font-size: var(--md-sys-typescale-body-small-size);
  font-weight: var(--md-sys-typescale-body-small-weight);
  line-height: var(--md-sys-typescale-body-small-line-height);
}

.chart-editor-diagnostics li small {
  overflow-wrap: anywhere;
  color: var(--md-sys-color-outline);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  line-height: var(--md-sys-typescale-label-small-line-height);
}

.chart-editor-statusbar {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--md-sys-spacing-2);
  padding: 0 var(--md-sys-spacing-3);
  overflow: hidden;
  color: var(--md-sys-color-on-surface-variant);
  border-top: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-high);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  line-height: var(--md-sys-typescale-label-small-line-height);
  white-space: nowrap;
}

.chart-editor-statusbar__tool {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chart-editor-statusbar__issues {
  --md-text-button-container-height: var(--md-comp-control-height-compact);
  --md-text-button-leading-space: var(--md-sys-spacing-2);
  --md-text-button-trailing-space: var(--md-sys-spacing-2);
  --md-text-button-label-text-color: var(--md-sys-color-primary);

  flex: 0 0 auto;
  font-size: inherit;
}

.chart-editor-statusbar__failure {
  display: flex;
  min-width: 0;
  max-width: min(55%, 560px);
  align-items: center;
  gap: var(--md-sys-spacing-1);
  color: var(--md-sys-color-error);
}

.chart-editor-statusbar__failure > :deep(.md3-material-icon),
.chart-editor-statusbar__failure > strong {
  flex: 0 0 auto;
}

.chart-editor-statusbar__failure > span {
  min-width: 0;
  overflow: hidden;
  color: var(--md-sys-color-on-error-container);
  text-overflow: ellipsis;
}

@media (max-width: 639px) {
  .chart-editor-stage {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, var(--chart-editor-preview-height)) minmax(0, 1fr);
  }

  .chart-editor-preview__handle {
    top: auto;
    right: 4px;
    bottom: -2px;
    left: 4px;
    width: auto;
    height: 6px;
    cursor: ns-resize;
  }

  .chart-editor-preview__handle::after {
    inset: 2px 0 auto;
    width: auto;
    height: 2px;
  }

  .chart-editor-preview {
    border-right: 0;
    border-bottom: 1px solid var(--md-sys-color-outline-variant);
  }
}
</style>
