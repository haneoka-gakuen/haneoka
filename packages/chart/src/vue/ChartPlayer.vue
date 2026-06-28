<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RenderFrameBuilder, type RenderSettings } from "../adapter/renderFrame";
import type { OurNotesAssetManifest } from "../assets/manifest";
import { MediaClock } from "../audio/MediaClock";
import { NoteSoundPlayer } from "../audio/NoteSoundPlayer";
import type { ChartMode } from "../core/enums";
import { LANE_COUNT } from "../core/geometry";
import { ChartSession } from "../core/session";
import type { ChartDocument, LaneInputEffectEvent } from "../core/types";
import { OurNotesInput, type InputPoint } from "../input/OurNotesInput";
import { OurNotesRenderer } from "../render/OurNotesRenderer";
import { ChartPerfProbe } from "../render/PerfProbe";
import { nativeRenderPixelRatio } from "../render/pixelRatio";
import { normalizeExternalTimeMs, shouldResetExternalTimeline } from "./externalClock";
import type { ChartPlayerEvents, ChartPlayerExpose } from "./types";

const props = withDefaults(
  defineProps<{
    chart: ChartDocument;
    assets: OurNotesAssetManifest;
    audioUrl?: string;
    /**
     * Owner-controlled media time. Providing this disables the internal
     * MediaClock and note-audio graph; owner updates drive one render each.
     */
    externalTimeMs?: number;
    /** Visual playing state for a controlled clock. It never starts an rAF loop. */
    externalPlaying?: boolean;
    /** Sonolus/USC BGM offset: media time = chart time + offset. */
    bgmOffsetMs?: number;
    /** Lightweight live-stage texture composited inside the WebGL base camera. */
    backgroundUrl?: string;
    mode?: ChartMode;
    settings?: Partial<RenderSettings> & { judgementOffsetMs?: number; __perf?: boolean };
    volume?: number;
    rate?: number;
    loop?: boolean;
    noteSoundEnabled?: boolean;
    noteSoundVolume?: number;
    ariaLabel?: string;
    pauseLabel?: string;
    loadingLabel?: string;
  }>(),
  {
    audioUrl: "",
    bgmOffsetMs: 0,
    backgroundUrl: "",
    mode: "watch",
    settings: () => ({}),
    volume: 0.8,
    rate: 1,
    loop: false,
    noteSoundEnabled: true,
    noteSoundVolume: 0.7,
    ariaLabel: "Chart player",
    pauseLabel: "Pause",
    loadingLabel: "Loading",
  },
);

const emit = defineEmits<ChartPlayerEvents>();
const root = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const hudCanvas = ref<HTMLCanvasElement | null>(null);
const ready = ref(false);
const failed = ref<Error | null>(null);
let renderer: OurNotesRenderer | undefined;
let clock: MediaClock | undefined;
let session: ChartSession | undefined;
let frameBuilder: RenderFrameBuilder | undefined;
let noteSounds: NoteSoundPlayer | undefined;
let input: OurNotesInput | undefined;
let resizeObserver: ResizeObserver | undefined;
let animationFrame = 0;
let lastTimeEmit = -1;
let lastRenderedTimeMs = Number.NaN;
let suppressEffects = false;
let destroyed = false;
let dirty = true;
let perfProbe: ChartPerfProbe | undefined;
const activePointerIds = new Set<number>();
const inputFeedbackClaimedPointerIds = new Set<number>();
const lastLaneInputEffect = new Map<number, number>();
const LANE_INPUT_EFFECT_WIDTH = 2;
const externalClockControlled = computed(() => props.externalTimeMs !== undefined);
const presentationTimeMs = () =>
  externalClockControlled.value ? normalizeExternalTimeMs(props.externalTimeMs) : (clock?.timeMs ?? 0);
const chartTimeMs = () => presentationTimeMs() - props.bgmOffsetMs;
const playerIsPlaying = () =>
  externalClockControlled.value ? props.externalPlaying === true : clock?.playing === true;
const presentationDurationMs = () => Math.max(clock?.durationMs ?? 0, props.chart.durationMs + props.bgmOffsetMs, 0);

function renderPixelRatio(width: number, height: number): number {
  const quality = Math.max(0.5, Math.min(2, props.settings.graphicsQuality ?? 1));
  return Math.max(0.5, nativeRenderPixelRatio(width, height, window.devicePixelRatio || 1) * quality);
}

function errorOf(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function reportError(reason: unknown): void {
  failed.value = errorOf(reason);
  emit("error", failed.value);
}

async function applyBackgroundTexture(target: OurNotesRenderer, url: string): Promise<void> {
  try {
    await target.setBackgroundTexture(url);
  } catch (reason) {
    // TextureLoader failures keep the previous WebGL stage (or the opaque
    // black fallback on first load). Treat them like the other prepared runtime
    // asset fallbacks instead of replacing the entire player with an error UI.
    target.reportAssetError(reason);
  }
}

function attachSession(): void {
  activePointerIds.clear();
  inputFeedbackClaimedPointerIds.clear();
  lastLaneInputEffect.clear();
  session = new ChartSession(props.chart, {
    mode: props.mode,
    judgementOffsetMs: props.settings.judgementOffsetMs ?? 0,
  });
  frameBuilder = new RenderFrameBuilder(props.chart);
  session.on("judgement", (event) => {
    if (!suppressEffects) {
      frameBuilder?.addJudgement(event, chartTimeMs());
      if (props.noteSoundEnabled) noteSounds?.queue(event);
    }
    dirty = true;
    requestFrame();
    emit("judgement", event);
  });
  session.on("skill", (event) => emit("skill", event));
  session.on("fever", (event) => emit("fever", event));
  session.on("callChange", (event) => emit("callchange", event));
}

function addEmptyLaneInputEffect(point: InputPoint, phase: LaneInputEffectEvent["phase"]): void {
  if (!frameBuilder || !Number.isFinite(point.lane) || point.lane < 0 || point.lane > LANE_COUNT - 1) return;
  // SetInVainLane addresses the twelve physical lanes through odd chart-lane
  // centres (1, 3, ... 23), so blank feedback occupies one discrete pair.
  const lane = Math.max(0, Math.min(LANE_COUNT - LANE_INPUT_EFFECT_WIDTH, Math.floor(point.lane / 2) * 2));
  if (phase === "move" && lastLaneInputEffect.get(point.pointerId) === lane) return;
  frameBuilder.addLaneInput({
    pointerId: point.pointerId,
    lane,
    width: LANE_INPUT_EFFECT_WIDTH,
    timeMs: point.timeMs,
    phase,
  });
  lastLaneInputEffect.set(point.pointerId, lane);
  dirty = true;
  requestFrame();
}

function attachInput(): void {
  if (!root.value || !renderer) return;
  input?.destroy();
  activePointerIds.clear();
  const canJudge = () => props.mode === "play" && playerIsPlaying();
  input = new OurNotesInput(
    root.value,
    {
      tap: (point) => {
        if (!canJudge()) return;
        activePointerIds.add(point.pointerId);
        const judgement = session?.tap(point.lane, point.timeMs, point.pointerId);
        if (judgement) inputFeedbackClaimedPointerIds.add(point.pointerId);
        else if (!session?.hasInputCandidate(point.lane, point.timeMs, point.pointerId))
          addEmptyLaneInputEffect(point, "tap");
      },
      move: (point) => {
        if (!canJudge()) return;
        const judgement = session?.trace(point.lane, point.timeMs, point.pointerId);
        if (judgement) inputFeedbackClaimedPointerIds.add(point.pointerId);
        else if (
          !inputFeedbackClaimedPointerIds.has(point.pointerId) &&
          !session?.hasInputCandidate(point.lane, point.timeMs, point.pointerId)
        )
          addEmptyLaneInputEffect(point, "move");
      },
      release: (point) => {
        activePointerIds.delete(point.pointerId);
        if (canJudge()) session?.release(point.lane, point.timeMs, point.pointerId);
        else session?.cancel(point.pointerId);
        inputFeedbackClaimedPointerIds.delete(point.pointerId);
        lastLaneInputEffect.delete(point.pointerId);
      },
      flick: (point) => {
        if (!canJudge()) return;
        const judgement = session?.flick(
          point.previousLane,
          { dx: point.dx, dy: point.dy },
          point.timeMs,
          point.pointerId,
        );
        if (judgement) inputFeedbackClaimedPointerIds.add(point.pointerId);
      },
      cancel: (pointerId) => {
        activePointerIds.delete(pointerId);
        inputFeedbackClaimedPointerIds.delete(pointerId);
        lastLaneInputEffect.delete(pointerId);
        session?.cancel(pointerId);
      },
    },
    {
      now: chartTimeMs,
      laneAtClientPoint: (clientX, clientY) => renderer?.clientPointToLane(clientX, clientY) ?? 12,
      // PointerEvent coordinates are CSS pixels; CSS defines one inch as 96px.
      screenDpi: 96,
      flickDistanceCm: 0.1,
    },
  );
}

function renderFrame(): void {
  if (!renderer || !session || !frameBuilder) return;
  const playing = playerIsPlaying();
  if (!dirty && !playing) return;
  const timeMs = chartTimeMs();
  // A playing media element can report the same clock value for several rAFs
  // while buffering or while the platform audio clock advances at a lower
  // cadence. No simulator or visual state changes in those duplicate ticks.
  if (!dirty && timeMs === lastRenderedTimeMs) return;
  if (props.mode === "play" && playing && activePointerIds.size > 0) {
    for (const point of input?.activePoints ?? []) {
      if (session.trace(point.lane, timeMs, point.pointerId)) inputFeedbackClaimedPointerIds.add(point.pointerId);
    }
  }
  const snapshot = session.updateReusable(timeMs);
  if (props.noteSoundEnabled) {
    noteSounds?.flush(props.noteSoundVolume);
    noteSounds?.setLongLineActive(playing && snapshot.activeLongLine, props.noteSoundVolume);
  } else {
    noteSounds?.clearQueue();
    noteSounds?.stopLongLine();
  }
  if (perfProbe) {
    const buildStarted = performance.now();
    const frame = frameBuilder.buildReusable(timeMs, snapshot, props.settings);
    const renderStarted = performance.now();
    renderer.render(frame);
    const renderedAt = performance.now();
    perfProbe.record(renderStarted - buildStarted, renderedAt - renderStarted, renderer.stats);
    const summary = perfProbe.takeSummary(renderedAt);
    if (summary) emit("perf", summary);
  } else {
    renderer.render(frameBuilder.buildReusable(timeMs, snapshot, props.settings));
  }
  lastRenderedTimeMs = timeMs;
  dirty = false;
  const timeSeconds = presentationTimeMs() / 1000;
  if (lastTimeEmit < 0 || Math.abs(timeSeconds - lastTimeEmit) >= 0.03) {
    lastTimeEmit = timeSeconds;
    emit("timeupdate", timeSeconds);
  }
}

function animate(): void {
  animationFrame = 0;
  renderFrame();
  if (clock?.playing) requestFrame();
}

function requestFrame(): void {
  if (!destroyed && !animationFrame) animationFrame = requestAnimationFrame(animate);
}

function resize(): void {
  if (!renderer || !root.value) return;
  // CSS rotation changes getBoundingClientRect() to the transformed axis-
  // aligned box. The renderer needs the element's logical layout size so a
  // 90° transition cannot leave its canvas stuck at an intermediate ratio.
  const width = root.value.clientWidth;
  const height = root.value.clientHeight;
  renderer.resize(width, height, renderPixelRatio(width, height));
  dirty = true;
  requestFrame();
}

function resetTimeline(timeMs: number): void {
  if (!session || !frameBuilder) return;
  suppressEffects = true;
  activePointerIds.clear();
  inputFeedbackClaimedPointerIds.clear();
  lastLaneInputEffect.clear();
  noteSounds?.clearQueue();
  noteSounds?.stopLongLine();
  try {
    frameBuilder.reset();
    session.reset(timeMs);
  } finally {
    suppressEffects = false;
  }
  lastRenderedTimeMs = Number.NaN;
  dirty = true;
  requestFrame();
}

async function play(): Promise<void> {
  if (externalClockControlled.value) return;
  try {
    // Invoke both media unlocks synchronously inside the originating click;
    // awaiting cue fetch/decode first would consume Safari's user activation
    // before HTMLMediaElement.play() is called.
    const noteSoundUnlock = props.noteSoundEnabled ? noteSounds?.unlock() : undefined;
    const musicPlay = clock?.play();
    await Promise.all([noteSoundUnlock, musicPlay]);
    requestFrame();
  } catch (reason) {
    if (!destroyed) reportError(reason);
  }
}

function pause(): void {
  if (activePointerIds.size > 0) {
    for (const point of input?.activePoints ?? []) session?.cancel(point.pointerId);
  }
  activePointerIds.clear();
  inputFeedbackClaimedPointerIds.clear();
  lastLaneInputEffect.clear();
  noteSounds?.clearQueue();
  noteSounds?.stopLongLine();
  clock?.pause();
}

function seek(seconds: number): void {
  if (externalClockControlled.value || !clock || !session || !frameBuilder) return;
  clock.seek(seconds * 1000);
  resetTimeline(chartTimeMs());
}

function attachInternalAudio(): void {
  if (externalClockControlled.value || clock) return;
  const candidate = new MediaClock(props.audioUrl, {
    volume: props.volume,
    playbackRate: props.rate,
    loop: props.loop,
  });
  clock = candidate;
  noteSounds = new NoteSoundPlayer(props.assets.noteSounds);
  void noteSounds.load();
  const active = () => !destroyed && clock === candidate;
  candidate.audio.addEventListener("play", () => {
    if (active()) {
      requestFrame();
      emit("playing", true);
    }
  });
  candidate.audio.addEventListener("pause", () => {
    if (active()) {
      dirty = true;
      requestFrame();
      emit("playing", false);
    }
  });
  candidate.audio.addEventListener("ended", () => {
    if (active()) {
      dirty = true;
      requestFrame();
      emit("playing", false);
    }
  });
  candidate.audio.addEventListener("durationchange", () => {
    if (active()) emit("duration", presentationDurationMs() / 1000);
  });
  candidate.audio.addEventListener("error", () => {
    if (active()) reportError(candidate.audio.error?.message || "Audio could not be loaded");
  });
}

function detachInternalAudio(): void {
  const previousClock = clock;
  clock = undefined;
  previousClock?.destroy();
  noteSounds?.dispose();
  noteSounds = undefined;
}

async function initialize(): Promise<void> {
  if (!canvas.value || !hudCanvas.value || !root.value) return;
  try {
    perfProbe = props.settings.__perf ? new ChartPerfProbe() : undefined;
    const initialWidth = root.value.clientWidth;
    const initialHeight = root.value.clientHeight;
    const candidate = new OurNotesRenderer({
      canvas: canvas.value,
      hudCanvas: hudCanvas.value,
      alpha: true,
      antialias: true,
      pixelRatio: renderPixelRatio(initialWidth, initialHeight),
      assets: props.assets,
    });
    renderer = candidate;
    await Promise.all([candidate.load(), applyBackgroundTexture(candidate, props.backgroundUrl)]);
    if (destroyed || renderer !== candidate) {
      candidate.dispose();
      return;
    }
    attachInternalAudio();
    attachSession();
    attachInput();
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(root.value);
    ready.value = true;
    resize();
    if (externalClockControlled.value) resetTimeline(chartTimeMs());
    else requestFrame();
    emit("duration", presentationDurationMs() / 1000);
    emit("ready");
  } catch (reason) {
    if (!destroyed) reportError(reason);
  }
}

watch(
  () => props.backgroundUrl,
  async (value) => {
    const target = renderer;
    if (!target) return;
    await applyBackgroundTexture(target, value);
    if (destroyed || renderer !== target) return;
    dirty = true;
    requestFrame();
  },
);
watch(
  () => props.mode,
  (mode) => {
    session?.setMode(mode);
    pause();
    if (externalClockControlled.value) resetTimeline(chartTimeMs());
    else seek(0);
  },
);
watch(
  () => props.chart,
  () => {
    pause();
    attachSession();
    if (externalClockControlled.value) resetTimeline(chartTimeMs());
    else seek(0);
    emit("duration", presentationDurationMs() / 1000);
  },
);
watch(
  () => props.bgmOffsetMs,
  () => {
    pause();
    if (externalClockControlled.value) resetTimeline(chartTimeMs());
    else seek(0);
    emit("duration", presentationDurationMs() / 1000);
  },
);
watch(externalClockControlled, (controlled) => {
  if (!renderer) return;
  if (controlled) detachInternalAudio();
  else attachInternalAudio();
  resetTimeline(chartTimeMs());
  emit("duration", presentationDurationMs() / 1000);
});
watch(
  () => props.externalTimeMs,
  (value, previous) => {
    if (!externalClockControlled.value) return;
    if (previous === undefined) return;
    const nextTimeMs = normalizeExternalTimeMs(value);
    const previousTimeMs = normalizeExternalTimeMs(previous);
    if (shouldResetExternalTimeline(previousTimeMs, nextTimeMs, props.externalPlaying === true)) {
      resetTimeline(nextTimeMs - props.bgmOffsetMs);
      return;
    }
    dirty = true;
    requestFrame();
  },
);
watch(
  () => props.externalPlaying,
  (playing) => {
    if (!externalClockControlled.value) return;
    if (!playing) pause();
    dirty = true;
    requestFrame();
  },
);
watch(
  () => props.settings,
  (value) => {
    perfProbe = value.__perf ? (perfProbe ?? new ChartPerfProbe()) : undefined;
    session?.setOffset(value.judgementOffsetMs ?? 0);
    resize();
    dirty = true;
    requestFrame();
  },
  { deep: true },
);
watch(
  () => props.audioUrl,
  (value) => {
    if (!clock || !value || clock.source === value) return;
    clock.source = value;
    seek(0);
  },
);
watch(
  () => props.volume,
  (value) => {
    if (clock) clock.volume = value;
  },
);
watch(
  () => props.rate,
  (value) => {
    if (clock) clock.rate = value;
  },
);
watch(
  () => props.loop,
  (value) => {
    if (clock) clock.loop = value;
  },
);
watch(
  () => props.noteSoundEnabled,
  (enabled) => {
    if (!enabled) {
      noteSounds?.clearQueue();
      noteSounds?.stopLongLine();
    }
    dirty = true;
    requestFrame();
  },
);
defineExpose<ChartPlayerExpose>({ play, pause, seek, resize });

onMounted(() => nextTick(initialize));
onBeforeUnmount(() => {
  destroyed = true;
  activePointerIds.clear();
  inputFeedbackClaimedPointerIds.clear();
  lastLaneInputEffect.clear();
  cancelAnimationFrame(animationFrame);
  resizeObserver?.disconnect();
  input?.destroy();
  clock?.destroy();
  noteSounds?.dispose();
  renderer?.dispose();
  input = undefined;
  clock = undefined;
  noteSounds = undefined;
  renderer = undefined;
});
</script>

<template>
  <div ref="root" class="our-notes-player" :aria-label="ariaLabel">
    <div class="our-notes-player__stage" aria-hidden="true"></div>
    <canvas ref="canvas" class="our-notes-player__canvas"></canvas>
    <canvas ref="hudCanvas" class="our-notes-player__hud"></canvas>
    <button
      v-if="ready && !externalClockControlled"
      class="our-notes-player__pause-hit"
      type="button"
      :aria-label="pauseLabel"
      @pointerdown.stop
      @click.stop="pause"
    ></button>
    <div v-if="!ready && !failed" class="our-notes-player__status">
      <slot name="loading">{{ loadingLabel }}</slot>
    </div>
    <div v-else-if="failed" class="our-notes-player__status is-error">{{ failed.message }}</div>
  </div>
</template>
