import { buildChart, parseScore, TickConverter, type ChartDocument } from "@haneoka/chart/parser";
import { ProjectHistory } from "@haneoka/chart-editor/history";
import {
  createEmptyProject,
  createProjectId,
  resolveLinePointShape,
  structuredCloneValue,
  type EaseType,
  type LineKind,
  type LinePoint,
  type MeterEvent,
  type NoteDirection,
  type NoteType,
  type Project,
  type ProjectMeta,
  type TempoEvent,
  type TimeScaleEvent,
} from "@haneoka/chart-editor/model";
import { TempoMap } from "@haneoka/chart-editor/timing";
import { validateProject, type ProjectValidationResult } from "@haneoka/chart-editor/validation";
import { createWaveformBins, type WaveformBins } from "@haneoka/chart-editor/waveform";
import { importChart, projectToSs, type FormatWarning } from "@haneoka/chart-editor/formats";
import { clearChartEditorDraft, loadChartEditorDraft, saveChartEditorDraft } from "~/utils/chartEditorStorage.client";

export type ChartEditorTool = "select" | "pan" | "eraser" | "tap" | "flick" | "trace" | "long" | "guide";
export type ChartEditorStatus =
  "ready" | "autosaved" | "restored" | "imported" | "loadFailed" | "audioFailed" | "saveFailed";

export interface ChartEditorRemoteImport {
  chart?: {
    url: string;
    name: string;
    metadata?: Partial<ProjectMeta>;
  };
  audio?: {
    url: string;
    name: string;
  };
}

interface PreparedChartImport {
  project: Project;
  warnings: FormatWarning[];
  format: string;
}

interface PreparedAudioImport {
  blob: Blob;
  name: string;
}

interface ChartImportSource {
  name: string;
  metadata?: Partial<ProjectMeta>;
  load: (signal: AbortSignal) => Promise<Uint8Array>;
}

interface AudioImportSource {
  name: string;
  load: (signal: AbortSignal) => Promise<Blob>;
}

interface WorkspaceImportSources {
  chart?: ChartImportSource;
  audio?: AudioImportSource;
}

interface PreparedWorkspaceImport {
  chart?: PreparedChartImport;
  audio?: PreparedAudioImport;
}

interface ImportOperation {
  controller: AbortController;
  sequence: number;
  chartGeneration?: number;
  audioGeneration?: number;
}

class ChartEditorImportError extends Error {
  readonly resource: "chart" | "audio";

  constructor(resource: "chart" | "audio", reason: unknown) {
    super(errorDetail(reason));
    this.name = "ChartEditorImportError";
    this.resource = resource;
  }
}

export interface EditorPointDraft {
  tick: number;
  lane: number;
  size: number;
}

export interface CreateSinglePayload extends EditorPointDraft {
  type: NoteType;
  critical: boolean;
  direction: NoteDirection;
}

export interface CreateLinePayload {
  kind: LineKind;
  start: EditorPointDraft;
  end: EditorPointDraft;
  critical?: boolean;
}

export interface MoveItemsPayload {
  items: Array<{ id: string; tick: number; lane: number }>;
  commit: true;
}

export interface SelectionPatch {
  tick?: number;
  lane?: number | "auto";
  size?: number;
  type?: NoteType;
  critical?: boolean;
  direction?: NoteDirection;
  visible?: boolean;
  ease?: { left: EaseType; right: EaseType };
  lineKind?: LineKind;
}

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));

const meterDenominator = (value: number): number => {
  const exponent = Math.round(Math.log2(Math.max(1, value)));
  return 2 ** clamp(exponent, 0, 30);
};

const audioContextConstructor = () => {
  if (!import.meta.client) return undefined;
  return window.AudioContext;
};

const gunzip = async (bytes: Uint8Array): Promise<Uint8Array> => {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  if (typeof DecompressionStream === "undefined") throw new Error("This browser cannot decompress gzip charts");
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const safeFileStem = (value: string): string =>
  value
    .replace(/\.gz$/i, "")
    .replace(/\.(?:haneoka\.)?(?:json|ss|usc|sus|bytes|txt)$/i, "")
    .normalize("NFKC")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ") || "chart";

const defaultEase = () => ({ left: "linear" as const, right: "linear" as const });

const errorDetail = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const validatePlayableAudio = (blob: Blob, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Audio import was cancelled"));
      return;
    }

    const candidateUrl = URL.createObjectURL(blob);
    const candidate = new Audio();
    let settled = false;
    let metadataLoaded = false;

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      candidate.removeEventListener("loadedmetadata", onLoadedMetadata);
      candidate.removeEventListener("canplay", onCanPlay);
      candidate.removeEventListener("error", onError);
      candidate.pause();
      candidate.removeAttribute("src");
      candidate.load();
      URL.revokeObjectURL(candidateUrl);
    };

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };

    const validateDuration = (): boolean => {
      if (Number.isFinite(candidate.duration) && candidate.duration > 0) return true;
      finish(new Error("The selected file does not contain playable audio"));
      return false;
    };

    function onLoadedMetadata() {
      metadataLoaded = true;
      if (!validateDuration()) return;
      if (candidate.readyState >= 3) finish();
    }

    function onCanPlay() {
      if (!metadataLoaded && candidate.readyState < 1) return;
      if (validateDuration()) finish();
    }

    function onError() {
      finish(new Error("The selected audio format cannot be played by this browser"));
    }

    function onAbort() {
      finish(new Error("Audio import was cancelled"));
    }

    signal.addEventListener("abort", onAbort, { once: true });
    candidate.addEventListener("loadedmetadata", onLoadedMetadata);
    candidate.addEventListener("canplay", onCanPlay);
    candidate.addEventListener("error", onError);
    candidate.preload = "auto";
    candidate.src = candidateUrl;
    candidate.load();
  });

export const useChartEditorWorkspace = () => {
  const initialProject = createEmptyProject();
  let history = new ProjectHistory<Project>(initialProject, 200);
  const project = shallowRef<Project>(history.value);
  const canUndo = ref(false);
  const canRedo = ref(false);
  const revision = ref(0);
  const savedRevision = ref(0);
  const selectedIds = ref<string[]>([]);
  const importWarnings = ref<FormatWarning[]>([]);
  const status = ref<ChartEditorStatus>("ready");
  const statusDetail = ref("");
  const saving = ref(false);
  let saveGeneration = 0;
  const restored = ref(false);

  const audioBlob = shallowRef<Blob>();
  const audioName = ref("");
  const audioUrl = ref("");
  const audioDuration = ref(0);
  const waveform = shallowRef<WaveformBins>();
  const playheadSeconds = ref(0);
  const playing = ref(false);
  const playbackRate = ref(1);
  let audio: HTMLAudioElement | undefined;
  let audioObjectUrl = "";
  let waveformGeneration = 0;
  let animationFrame = 0;
  let autosaveTimer: number | undefined;
  let workspaceGeneration = 0;
  let chartImportGeneration = 0;
  let audioImportGeneration = 0;
  let importOperationSequence = 0;
  const activeImportOperations = new Set<ImportOperation>();
  let disposed = false;
  const { pause: pauseArchiveAudio } = useAudioPlayer();

  const refreshHistoryFlags = () => {
    canUndo.value = history.canUndo;
    canRedo.value = history.canRedo;
  };

  const replaceVisibleProject = (next: Project, changed = true) => {
    project.value = next;
    refreshHistoryFlags();
    if (changed) revision.value += 1;
  };

  const updateProject = (
    updater: (draft: Project) => Project | void,
    options: { mergeKey?: string; selected?: string[] } = {},
  ) => {
    const previousRevision = history.revision;
    const next = history.update(updater, options.mergeKey ? { mergeKey: options.mergeKey } : {});
    if (history.revision === previousRevision) return;
    workspaceGeneration += 1;
    replaceVisibleProject(next);
    if (options.selected) selectedIds.value = options.selected;
  };

  const resetHistory = (next: Project, changed = true) => {
    history = new ProjectHistory<Project>(next, 200);
    replaceVisibleProject(history.value, changed);
    selectedIds.value = [];
  };

  const undo = () => {
    if (!history.canUndo) return;
    replaceVisibleProject(history.undo());
    workspaceGeneration += 1;
    selectedIds.value = selectedIds.value.filter((id) => findEntity(project.value, id));
  };

  const redo = () => {
    if (!history.canRedo) return;
    replaceVisibleProject(history.redo());
    workspaceGeneration += 1;
    selectedIds.value = selectedIds.value.filter((id) => findEntity(project.value, id));
  };

  const endHistoryMerge = () => history.endMerge();

  const validation = computed<ProjectValidationResult>(() => validateProject(project.value));
  const tempoMap = computed(
    () =>
      new TempoMap(project.value.tempos, {
        resolution: project.value.resolution,
        audioOffset: project.value.audioOffset,
      }),
  );
  const chart = computed<ChartDocument>(() => {
    const score = projectToSs(project.value);
    const document = buildChart(parseScore(score));
    const converter = new TickConverter(score.score.events.bpm, score.score.events.sig);
    document.timeScaleChanges = project.value.timeScales.map((event) => ({
      timeMs: converter.tickToTimeMs(event.tick),
      scale: event.scale,
    }));
    return document;
  });
  const dirty = computed(() => revision.value !== savedRevision.value);

  const updateMeta = (patch: Partial<ProjectMeta>) => {
    updateProject((draft) => {
      Object.assign(draft.meta, structuredCloneValue(patch));
    });
  };

  const updateAudioOffset = (seconds: number) => {
    if (!Number.isFinite(seconds)) return;
    updateProject((draft) => {
      draft.audioOffset = seconds;
    });
  };

  const updateLaneBasis = (laneBasis: number) => {
    if (!Number.isFinite(laneBasis) || laneBasis <= 0) return;
    updateProject((draft) => {
      draft.laneBasis = Math.round(laneBasis);
    });
  };

  const createSingle = (payload: CreateSinglePayload) => {
    const id = createProjectId("note");
    updateProject(
      (draft) => {
        draft.singles.push({
          id,
          tick: Math.max(0, Math.round(payload.tick)),
          lane: payload.lane,
          size: Math.max(0, payload.size),
          type: payload.type,
          critical: payload.critical,
          direction: payload.type === "flick" ? payload.direction : "none",
          visible: true,
        });
        (draft.sourceOrder ??= []).push(id);
      },
      { selected: [id] },
    );
  };

  const createLine = (payload: CreateLinePayload) => {
    const id = createProjectId(payload.kind);
    const pointA = { ...payload.start };
    const pointB = { ...payload.end };
    const [start, end] = pointA.tick <= pointB.tick ? [pointA, pointB] : [pointB, pointA];
    const startId = createProjectId("point");
    const endId = createProjectId("point");
    updateProject(
      (draft) => {
        draft.lines.push({
          id,
          kind: payload.kind,
          points: [
            {
              id: startId,
              tick: Math.max(0, Math.round(start.tick)),
              lane: start.lane,
              size: Math.max(0, start.size),
              type: payload.kind === "guide" ? "trace" : "tap",
              critical: payload.critical === true,
              direction: "none",
              visible: true,
              ease: defaultEase(),
            },
            {
              id: endId,
              tick: Math.max(0, Math.round(end.tick)),
              lane: end.lane,
              size: Math.max(0, end.size),
              type: payload.kind === "guide" ? "trace" : "tap",
              critical: payload.critical === true,
              direction: "none",
              visible: true,
              ease: defaultEase(),
            },
          ],
        });
        (draft.sourceOrder ??= []).push(id);
      },
      { selected: [startId, endId] },
    );
  };

  const moveItems = (payload: MoveItemsPayload) => {
    updateProject((draft) => {
      const moves = new Map(payload.items.map((item) => [item.id, item]));
      const proposedSpans: Array<{ id: string; lane: number; size: number }> = [];
      for (const note of draft.singles) {
        const move = moves.get(note.id);
        if (move && Number.isFinite(move.lane))
          proposedSpans.push({ id: note.id, lane: move.lane, size: Math.max(0, note.size) });
      }
      for (const line of draft.lines) {
        for (const [index, point] of line.points.entries()) {
          const move = moves.get(point.id);
          if (!move || !Number.isFinite(move.lane)) continue;
          proposedSpans.push({
            id: point.id,
            lane: move.lane,
            size: Math.max(0, resolveLinePointShape(line.points, index).size),
          });
        }
      }
      const boundedLanes = new Map<string, number>();
      if (proposedSpans.length) {
        const laneBasis = Math.max(1, draft.laneBasis);
        const left = Math.min(...proposedSpans.map((span) => span.lane));
        const right = Math.max(...proposedSpans.map((span) => span.lane + span.size));
        const minimumCorrection = -left;
        const maximumCorrection = laneBasis - right;
        if (minimumCorrection <= maximumCorrection) {
          const correction = clamp(0, minimumCorrection, maximumCorrection);
          for (const span of proposedSpans) boundedLanes.set(span.id, span.lane + correction);
        } else {
          // Invalid imported groups wider than the stage cannot preserve one
          // shared delta; keep every item recoverable inside the visible lane.
          for (const span of proposedSpans)
            boundedLanes.set(span.id, clamp(span.lane, 0, Math.max(0, laneBasis - span.size)));
        }
      }
      for (const note of draft.singles) {
        const move = moves.get(note.id);
        if (!move) continue;
        note.tick = Math.max(0, Math.round(move.tick));
        note.lane = boundedLanes.get(note.id) ?? note.lane;
      }

      for (const line of draft.lines) {
        const automatic = new Set<string>();
        for (const point of line.points) {
          const move = moves.get(point.id);
          if (!move) continue;
          point.tick = Math.max(0, Math.round(move.tick));
          if (point.lane === "auto") automatic.add(point.id);
          else point.lane = boundedLanes.get(point.id) ?? point.lane;
        }
        if (!line.points.some((point) => moves.has(point.id))) continue;
        clearResolvedLineShapes(line);
        line.points.sort((left, right) => left.tick - right.tick || left.id.localeCompare(right.id));
        const resolvedSizes = new Map<string, number>();
        for (const [index, point] of line.points.entries()) {
          if (automatic.has(point.id)) resolvedSizes.set(point.id, resolveLinePointShape(line.points, index).size);
        }
        for (const point of line.points) {
          if (!automatic.has(point.id)) continue;
          const move = moves.get(point.id);
          if (!move) continue;
          point.size = resolvedSizes.get(point.id) ?? point.size;
          point.lane = boundedLanes.get(point.id) ?? point.lane;
          delete point.autoSize;
          delete point.resolvedLane;
          delete point.resolvedSize;
        }
        clearResolvedLineShapes(line);
      }
    });
  };

  const deleteItems = (ids: readonly string[]) => {
    if (!ids.length) return;
    const deleted = new Set(ids);
    updateProject((draft) => {
      draft.singles = draft.singles.filter((note) => !deleted.has(note.id));
      draft.lines = draft.lines.flatMap((line) => {
        if (deleted.has(line.id)) return [];
        const points = line.points.filter((point) => !deleted.has(point.id));
        return points.length < 2 ? [] : [{ ...line, points }];
      });
      if (draft.sourceOrder) {
        const retained = new Set([...draft.singles.map((note) => note.id), ...draft.lines.map((line) => line.id)]);
        draft.sourceOrder = draft.sourceOrder.filter((id) => retained.has(id));
      }
    });
    selectedIds.value = selectedIds.value.filter((id) => findEntity(project.value, id));
  };

  const patchSelection = (patch: SelectionPatch) => {
    if (!selectedIds.value.length) return;
    const selected = new Set(selectedIds.value);
    updateProject((draft) => {
      for (const single of draft.singles) {
        if (selected.has(single.id)) applyNotePatch(single, patch);
      }
      for (const line of draft.lines) {
        if (selected.has(line.id) && patch.lineKind) line.kind = patch.lineKind;
        for (const point of line.points) {
          if (selected.has(point.id)) {
            const pointIndex = line.points.findIndex((item) => item.id === point.id);
            const resolvedShape = pointIndex >= 0 ? resolveLinePointShape(line.points, pointIndex) : undefined;
            applyNotePatch(point, patch, resolvedShape?.size);
            if (patch.ease) point.ease = structuredCloneValue(patch.ease);
          }
        }
        if (patch.lineKind && line.points.some((point) => selected.has(point.id))) line.kind = patch.lineKind;
        if (line.points.some((point) => selected.has(point.id))) clearResolvedLineShapes(line);
        line.points.sort((left, right) => left.tick - right.tick || left.id.localeCompare(right.id));
      }
    });
  };

  const addTempo = (tick: number, bpm = 120) => {
    const safeTick = Math.max(0, Math.round(tick));
    updateProject((draft) => {
      const existing = draft.tempos.find((event) => event.tick === safeTick);
      if (existing) return;
      draft.tempos.push({ id: createProjectId("tempo"), tick: safeTick, bpm });
      draft.tempos.sort((left, right) => left.tick - right.tick || left.id.localeCompare(right.id));
    });
  };

  const updateTempo = (id: string, patch: Partial<Pick<TempoEvent, "tick" | "bpm">>) => {
    updateProject((draft) => {
      const event = draft.tempos.find((item) => item.id === id);
      if (!event) return;
      if (patch.tick !== undefined) {
        const nextTick = Math.max(0, Math.round(patch.tick));
        const removesOrigin =
          event.tick === 0 && nextTick !== 0 && !draft.tempos.some((item) => item.id !== id && item.tick === 0);
        const collides = draft.tempos.some((item) => item.id !== id && item.tick === nextTick);
        if (removesOrigin || collides) return;
        event.tick = nextTick;
      }
      if (patch.bpm !== undefined && Number.isFinite(patch.bpm) && patch.bpm > 0) event.bpm = patch.bpm;
      draft.tempos.sort((left, right) => left.tick - right.tick || left.id.localeCompare(right.id));
    });
  };

  const deleteTempo = (id: string) => {
    updateProject((draft) => {
      if (draft.tempos.length <= 1) return;
      const target = draft.tempos.find((event) => event.id === id);
      if (target?.tick === 0) return;
      draft.tempos = draft.tempos.filter((event) => event.id !== id);
    });
  };

  const addMeter = (tick: number, numerator = 4, denominator = 4) => {
    const safeTick = Math.max(0, Math.round(tick));
    updateProject((draft) => {
      const existing = draft.meters.find((event) => event.tick === safeTick);
      if (existing) return;
      draft.meters.push({
        id: createProjectId("meter"),
        tick: safeTick,
        numerator: Math.max(1, Math.round(numerator)),
        denominator: meterDenominator(denominator),
      });
      draft.meters.sort((left, right) => left.tick - right.tick || left.id.localeCompare(right.id));
    });
  };

  const updateMeter = (id: string, patch: Partial<Pick<MeterEvent, "tick" | "numerator" | "denominator">>) => {
    updateProject((draft) => {
      const event = draft.meters.find((item) => item.id === id);
      if (!event) return;
      if (patch.tick !== undefined) {
        const nextTick = Math.max(0, Math.round(patch.tick));
        const removesOrigin =
          event.tick === 0 && nextTick !== 0 && !draft.meters.some((item) => item.id !== id && item.tick === 0);
        const collides = draft.meters.some((item) => item.id !== id && item.tick === nextTick);
        if (removesOrigin || collides) return;
        event.tick = nextTick;
      }
      if (patch.numerator !== undefined) event.numerator = Math.max(1, Math.round(patch.numerator));
      if (patch.denominator !== undefined && Number.isFinite(patch.denominator) && patch.denominator > 0) {
        event.denominator = meterDenominator(patch.denominator);
      }
      draft.meters.sort((left, right) => left.tick - right.tick || left.id.localeCompare(right.id));
    });
  };

  const deleteMeter = (id: string) => {
    updateProject((draft) => {
      if (draft.meters.length <= 1) return;
      const target = draft.meters.find((event) => event.id === id);
      if (target?.tick === 0) return;
      draft.meters = draft.meters.filter((event) => event.id !== id);
    });
  };

  const addTimeScale = (tick: number, scale = 1) => {
    const safeTick = Math.max(0, Math.round(tick));
    updateProject((draft) => {
      const existing = draft.timeScales.find((event) => event.tick === safeTick);
      if (existing) return;
      draft.timeScales.push({ id: createProjectId("time-scale"), tick: safeTick, scale });
      draft.timeScales.sort((left, right) => left.tick - right.tick || left.id.localeCompare(right.id));
    });
  };

  const updateTimeScale = (id: string, patch: Partial<Pick<TimeScaleEvent, "tick" | "scale">>) => {
    updateProject((draft) => {
      const event = draft.timeScales.find((item) => item.id === id);
      if (!event) return;
      if (patch.tick !== undefined) {
        const nextTick = Math.max(0, Math.round(patch.tick));
        if (draft.timeScales.some((item) => item.id !== id && item.tick === nextTick)) return;
        event.tick = nextTick;
      }
      if (patch.scale !== undefined && Number.isFinite(patch.scale) && patch.scale > 0) event.scale = patch.scale;
      draft.timeScales.sort((left, right) => left.tick - right.tick || left.id.localeCompare(right.id));
    });
  };

  const deleteTimeScale = (id: string) => {
    updateProject((draft) => {
      draft.timeScales = draft.timeScales.filter((event) => event.id !== id);
    });
  };

  const stopAnimation = () => {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
  };

  const updatePlayhead = () => {
    if (!audio) return;
    playheadSeconds.value = audio.currentTime;
    if (!audio.paused) animationFrame = requestAnimationFrame(updatePlayhead);
  };

  const ensureAudio = () => {
    if (disposed || audio || !import.meta.client) return audio;
    audio = new Audio();
    audio.preload = "metadata";
    audio.addEventListener("loadedmetadata", () => {
      if (disposed) return;
      audioDuration.value = Number.isFinite(audio?.duration) ? audio!.duration : 0;
    });
    audio.addEventListener("play", () => {
      if (disposed) return;
      playing.value = true;
      stopAnimation();
      updatePlayhead();
    });
    audio.addEventListener("pause", () => {
      if (disposed) return;
      playing.value = false;
      stopAnimation();
      if (audio) playheadSeconds.value = audio.currentTime;
    });
    audio.addEventListener("ended", () => {
      if (disposed) return;
      playing.value = false;
      stopAnimation();
    });
    return audio;
  };

  const analyzeAudio = async (blob: Blob, generation: number) => {
    if (disposed) return;
    const AudioContextValue = audioContextConstructor();
    if (!AudioContextValue) return;
    const context = new AudioContextValue();
    try {
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      if (disposed || generation !== waveformGeneration) return;
      const binCount = clamp(Math.ceil(decoded.duration * 256), 4096, 131_072);
      waveform.value = createWaveformBins(decoded, binCount);
      audioDuration.value = decoded.duration;
    } finally {
      await context.close();
    }
  };

  const beginImportOperation = (sources: WorkspaceImportSources): ImportOperation => {
    const includesChart = Boolean(sources.chart);
    const includesAudio = Boolean(sources.audio);
    for (const operation of activeImportOperations) {
      const overlaps =
        (includesChart && operation.chartGeneration !== undefined) ||
        (includesAudio && operation.audioGeneration !== undefined);
      if (!overlaps) continue;
      operation.controller.abort();
      activeImportOperations.delete(operation);
    }

    const operation: ImportOperation = {
      controller: new AbortController(),
      sequence: ++importOperationSequence,
      ...(includesChart ? { chartGeneration: ++chartImportGeneration } : {}),
      ...(includesAudio ? { audioGeneration: ++audioImportGeneration } : {}),
    };
    activeImportOperations.add(operation);
    workspaceGeneration += 1;
    status.value = "ready";
    statusDetail.value = "";
    return operation;
  };

  const isImportOperationCurrent = (operation: ImportOperation): boolean =>
    !disposed &&
    !operation.controller.signal.aborted &&
    (operation.chartGeneration === undefined || operation.chartGeneration === chartImportGeneration) &&
    (operation.audioGeneration === undefined || operation.audioGeneration === audioImportGeneration);

  const isLatestImportOperation = (operation: ImportOperation): boolean =>
    operation.sequence === importOperationSequence;

  const cancelAllImportOperations = () => {
    for (const operation of activeImportOperations) operation.controller.abort();
    activeImportOperations.clear();
    chartImportGeneration += 1;
    audioImportGeneration += 1;
    importOperationSequence += 1;
  };

  const setAudio = (blob: Blob | undefined, name = ""): Promise<string | undefined> => {
    if (disposed) return Promise.resolve(undefined);
    // Allocate the replacement URL before mutating visible state. A browser
    // failure here therefore leaves the current audio untouched.
    const nextObjectUrl = blob ? URL.createObjectURL(blob) : "";
    const media = ensureAudio();
    media?.pause();
    waveformGeneration += 1;
    const generation = waveformGeneration;
    waveform.value = undefined;
    audioBlob.value = blob;
    audioName.value = blob ? name : "";
    playheadSeconds.value = 0;
    audioDuration.value = 0;
    const previousObjectUrl = audioObjectUrl;
    audioObjectUrl = nextObjectUrl;
    audioUrl.value = audioObjectUrl;
    if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl);
    if (media) {
      media.removeAttribute("src");
      if (audioObjectUrl) media.src = audioObjectUrl;
      media.playbackRate = playbackRate.value;
      media.load();
    }
    if (!blob) return Promise.resolve(undefined);
    return analyzeAudio(blob, generation)
      .then(() => undefined)
      .catch((error: unknown) => {
        if (disposed || generation !== waveformGeneration) return undefined;
        return errorDetail(error);
      });
  };

  const prepareAudioImport = async (blob: Blob, name: string, signal: AbortSignal): Promise<PreparedAudioImport> => {
    await validatePlayableAudio(blob, signal);
    return { blob, name };
  };

  const pause = () => ensureAudio()?.pause();

  const play = async () => {
    if (disposed) return;
    const media = ensureAudio();
    if (!media || !audioUrl.value) return;
    pauseArchiveAudio();
    try {
      await media.play();
    } catch (error) {
      status.value = "audioFailed";
      statusDetail.value = error instanceof Error ? error.message : String(error);
    }
  };

  const togglePlayback = async () => {
    if (playing.value) pause();
    else await play();
  };

  const seek = (seconds: number) => {
    const media = ensureAudio();
    const maximum = Number.isFinite(media?.duration) ? media!.duration : audioDuration.value;
    const next = clamp(Number.isFinite(seconds) ? seconds : 0, 0, Math.max(0, maximum || 0));
    if (media) media.currentTime = next;
    playheadSeconds.value = next;
  };

  const setPlaybackRate = (value: number) => {
    playbackRate.value = clamp(value, 0.25, 2);
    const media = ensureAudio();
    if (media) media.playbackRate = playbackRate.value;
  };

  const prepareChartImport = async (
    source: Uint8Array,
    name: string,
    metadata?: Partial<ProjectMeta>,
    signal?: AbortSignal,
  ): Promise<PreparedChartImport> => {
    if (signal?.aborted) throw new Error("Chart import was cancelled");
    const bytes = await gunzip(source);
    if (signal?.aborted) throw new Error("Chart import was cancelled");
    const result = importChart(bytes);
    const next = result.project;
    if (!next.meta.title) next.meta.title = safeFileStem(name);
    if (metadata) {
      const { extra, tags, ...fields } = metadata;
      Object.assign(next.meta, structuredCloneValue(fields));
      if (tags) next.meta.tags = [...tags];
      if (extra) next.meta.extra = { ...(next.meta.extra ?? {}), ...structuredCloneValue(extra) };
    }
    return { project: next, warnings: result.warnings, format: result.format };
  };

  const prepareWorkspaceImport = async (
    sources: WorkspaceImportSources,
    signal: AbortSignal,
  ): Promise<PreparedWorkspaceImport> => {
    const [chart, audio] = await Promise.all([
      sources.chart
        ? sources.chart
            .load(signal)
            .then((bytes) => prepareChartImport(bytes, sources.chart!.name, sources.chart!.metadata, signal))
            .catch((error: unknown) => {
              throw new ChartEditorImportError("chart", error);
            })
        : Promise.resolve(undefined),
      sources.audio
        ? sources.audio
            .load(signal)
            .then((blob) => prepareAudioImport(blob, sources.audio!.name, signal))
            .catch((error: unknown) => {
              throw new ChartEditorImportError("audio", error);
            })
        : Promise.resolve(undefined),
    ]);
    return { chart, audio };
  };

  const commitWorkspaceImport = (prepared: PreparedWorkspaceImport): Promise<string | undefined> => {
    // Audio setup is synchronous up to waveform analysis. Perform it first so
    // a setup failure cannot leave a newly replaced chart behind.
    const waveformAnalysis = prepared.audio
      ? setAudio(prepared.audio.blob, prepared.audio.name)
      : Promise.resolve(undefined);
    if (prepared.chart) {
      resetHistory(prepared.chart.project, false);
      importWarnings.value = prepared.chart.warnings;
    }
    // A chart+audio replacement is one authored workspace transaction.
    revision.value += 1;
    scheduleAutosave();
    return waveformAnalysis;
  };

  const importDetail = (prepared: PreparedWorkspaceImport): string =>
    [prepared.chart?.format.toUpperCase(), prepared.audio?.name].filter(Boolean).join(" · ");

  const runWorkspaceImport = async (sources: WorkspaceImportSources): Promise<boolean> => {
    if (disposed || (!sources.chart && !sources.audio)) return false;
    const operation = beginImportOperation(sources);
    try {
      const prepared = await prepareWorkspaceImport(sources, operation.controller.signal);
      if (!isImportOperationCurrent(operation)) return false;

      const waveformAnalysis = commitWorkspaceImport(prepared);
      if (isLatestImportOperation(operation)) {
        status.value = "imported";
        statusDetail.value = importDetail(prepared);
      }

      const waveformError = await waveformAnalysis;
      if (!isImportOperationCurrent(operation)) return true;
      if (waveformError && prepared.audio && isLatestImportOperation(operation)) {
        status.value = "imported";
        statusDetail.value = `${importDetail(prepared)} · waveform unavailable: ${waveformError}`;
      }
      await saveNow({
        announce: false,
        reportStatus: () => isLatestImportOperation(operation),
      });
      return true;
    } catch (error) {
      const current = isImportOperationCurrent(operation);
      operation.controller.abort();
      if (!current) return false;
      if (isLatestImportOperation(operation)) {
        status.value =
          error instanceof ChartEditorImportError && error.resource === "audio" ? "audioFailed" : "loadFailed";
        statusDetail.value = errorDetail(error);
      }
      throw error;
    } finally {
      activeImportOperations.delete(operation);
    }
  };

  const importAudioFile = async (file: File) => {
    try {
      await runWorkspaceImport({
        audio: {
          name: file.name,
          load: async () => file,
        },
      });
    } catch {
      // Audio selection is invoked from a file input without an awaiting error
      // boundary; statusDetail carries the actionable validation error.
    }
  };

  const importChartFile = async (file: File) => {
    await runWorkspaceImport({
      chart: {
        name: file.name,
        load: async () => new Uint8Array(await file.arrayBuffer()),
      },
    });
  };

  const fetchBlob = async (url: string, signal: AbortSignal): Promise<Blob> => {
    const response = await fetch(url, { signal, cache: "no-store" });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.blob();
  };

  const fetchBytes = async (url: string, signal: AbortSignal): Promise<Uint8Array> => {
    const response = await fetch(url, { signal, cache: "no-store" });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };

  /**
   * Atomically prepares catalog chart/audio resources before replacing the
   * visible project. A failed audio validation therefore cannot leave a newly
   * imported chart paired with the previous song.
   */
  const importRemoteResources = async (request: ChartEditorRemoteImport) => {
    await runWorkspaceImport({
      ...(request.chart
        ? {
            chart: {
              name: request.chart.name,
              metadata: request.chart.metadata,
              load: (signal: AbortSignal) => fetchBytes(request.chart!.url, signal),
            },
          }
        : {}),
      ...(request.audio
        ? {
            audio: {
              name: request.audio.name,
              load: (signal: AbortSignal) => fetchBlob(request.audio!.url, signal),
            },
          }
        : {}),
    });
  };

  const saveNow = async (options: { announce?: boolean; reportStatus?: () => boolean } = {}) => {
    if (!import.meta.client || disposed) return;
    const canReportStatus = () => options.reportStatus?.() ?? true;
    const projectValidation = validateProject(project.value);
    if (!projectValidation.valid) {
      if (canReportStatus()) {
        status.value = "saveFailed";
        statusDetail.value = projectValidation.errors.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
      }
      return;
    }
    saving.value = true;
    const generation = ++saveGeneration;
    const targetRevision = revision.value;
    const draft = {
      project: project.value,
      ...(audioBlob.value ? { audio: audioBlob.value, audioName: audioName.value } : {}),
      updatedAt: Date.now(),
    };
    try {
      await saveChartEditorDraft(draft);
      if (disposed) return;
      if (revision.value === targetRevision) savedRevision.value = targetRevision;
      if (options.announce !== false && canReportStatus()) {
        status.value = "autosaved";
        statusDetail.value = "";
      }
    } catch (error) {
      if (disposed) return;
      if (canReportStatus()) {
        status.value = "saveFailed";
        statusDetail.value = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (!disposed && generation === saveGeneration) saving.value = false;
    }
  };

  function scheduleAutosave() {
    if (!import.meta.client || disposed || !restored.value) return;
    if (autosaveTimer) window.clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(() => {
      autosaveTimer = undefined;
      void saveNow();
    }, 800);
  }

  const newProject = async () => {
    if (disposed) return;
    cancelAllImportOperations();
    workspaceGeneration += 1;
    pause();
    resetHistory(createEmptyProject());
    await setAudio(undefined);
    importWarnings.value = [];
    status.value = "ready";
    statusDetail.value = "";
    try {
      await clearChartEditorDraft();
      savedRevision.value = revision.value;
    } catch (error) {
      status.value = "saveFailed";
      statusDetail.value = error instanceof Error ? error.message : String(error);
    }
  };

  const restoreDraft = async () => {
    const generation = workspaceGeneration;
    try {
      const draft = await loadChartEditorDraft<Project>();
      if (disposed || generation !== workspaceGeneration) return;
      if (draft) {
        const result = validateProject(draft.project);
        if (!result.valid) {
          status.value = "loadFailed";
          statusDetail.value = result.errors.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
          return;
        }
        resetHistory(draft.project, false);
        if (draft.audio) await setAudio(draft.audio, draft.audioName || "");
        if (disposed || generation !== workspaceGeneration) return;
        status.value = "restored";
        savedRevision.value = revision.value;
      }
    } catch (error) {
      if (disposed) return;
      status.value = "loadFailed";
      statusDetail.value = error instanceof Error ? error.message : String(error);
    } finally {
      if (!disposed) {
        restored.value = true;
        if (dirty.value) scheduleAutosave();
      }
    }
  };

  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!dirty.value) return;
    event.preventDefault();
    event.returnValue = "";
  };

  watch(project, scheduleAutosave);

  onMounted(() => {
    ensureAudio();
    window.addEventListener("beforeunload", onBeforeUnload);
    void restoreDraft();
  });

  onBeforeUnmount(() => {
    const projectValidation = validateProject(project.value);
    const pendingDraft =
      dirty.value && projectValidation.valid
        ? {
            project: project.value,
            ...(audioBlob.value ? { audio: audioBlob.value, audioName: audioName.value } : {}),
            updatedAt: Date.now(),
          }
        : undefined;
    disposed = true;
    cancelAllImportOperations();
    workspaceGeneration += 1;
    waveformGeneration += 1;
    if (autosaveTimer) window.clearTimeout(autosaveTimer);
    if (pendingDraft) void saveChartEditorDraft(pendingDraft).catch(() => undefined);
    window.removeEventListener("beforeunload", onBeforeUnload);
    pause();
    stopAnimation();
    if (audio) {
      audio.removeAttribute("src");
      audio.load();
      audio = undefined;
    }
    if (audioObjectUrl) {
      URL.revokeObjectURL(audioObjectUrl);
      audioObjectUrl = "";
    }
  });

  return {
    project,
    chart,
    validation,
    tempoMap,
    canUndo,
    canRedo,
    dirty,
    saving,
    selectedIds,
    importWarnings,
    status,
    statusDetail,
    audioBlob,
    audioName,
    audioUrl,
    audioDuration,
    waveform,
    playheadSeconds,
    playing,
    playbackRate,
    updateMeta,
    updateAudioOffset,
    updateLaneBasis,
    updateProject,
    createSingle,
    createLine,
    moveItems,
    deleteItems,
    patchSelection,
    addTempo,
    updateTempo,
    deleteTempo,
    addMeter,
    updateMeter,
    deleteMeter,
    addTimeScale,
    updateTimeScale,
    deleteTimeScale,
    undo,
    redo,
    endHistoryMerge,
    importAudioFile,
    importChartFile,
    importRemoteResources,
    newProject,
    play,
    pause,
    togglePlayback,
    seek,
    setPlaybackRate,
    saveNow,
  };
};

type NoteEntity =
  | { kind: "single"; note: Project["singles"][number] }
  | { kind: "point"; note: LinePoint; line: Project["lines"][number] }
  | { kind: "line"; line: Project["lines"][number] };

const findEntity = (project: Project, id: string): NoteEntity | undefined => {
  const single = project.singles.find((note) => note.id === id);
  if (single) return { kind: "single", note: single };
  for (const line of project.lines) {
    if (line.id === id) return { kind: "line", line };
    const point = line.points.find((note) => note.id === id);
    if (point) return { kind: "point", note: point, line };
  }
  return undefined;
};

const applyNotePatch = (note: Project["singles"][number] | LinePoint, patch: SelectionPatch, resolvedSize?: number) => {
  if (patch.tick !== undefined && Number.isFinite(patch.tick)) note.tick = Math.max(0, Math.round(patch.tick));
  if (patch.lane !== undefined && (patch.lane === "auto" || Number.isFinite(patch.lane))) {
    if ("ease" in note) {
      if (note.lane === "auto" && typeof patch.lane === "number") {
        if (note.autoSize && resolvedSize !== undefined) note.size = resolvedSize;
        delete note.autoSize;
        delete note.resolvedSize;
      }
      note.lane = patch.lane;
      delete note.resolvedLane;
    } else if (typeof patch.lane === "number") note.lane = patch.lane;
  }
  if (patch.size !== undefined && Number.isFinite(patch.size)) {
    note.size = Math.max(0, patch.size);
    if ("ease" in note) {
      delete note.autoSize;
      delete note.resolvedSize;
    }
  }
  if (patch.type !== undefined) {
    note.type = patch.type;
    if (patch.type === "tap") note.direction = "none";
  }
  if (patch.critical !== undefined) note.critical = patch.critical;
  if (patch.direction !== undefined) {
    note.direction = patch.direction;
    if (patch.direction !== "none" && note.type === "tap") note.type = "flick";
  }
  if (patch.visible !== undefined) note.visible = patch.visible;
};

const clearResolvedLineShapes = (line: Project["lines"][number]) => {
  for (const point of line.points) {
    if (point.lane !== "auto") continue;
    delete point.resolvedLane;
    delete point.resolvedSize;
  }
};
