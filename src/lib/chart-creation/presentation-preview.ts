import type { Project } from "../../../packages/chart-editor/src/model";
import type {
  ChartEmbedHandle,
  ChartEmbedEvent,
  ChartEmbedPhase,
  ChartPlaybackOptions,
} from "../../../packages/embed-cassiopeia/src/types";
import type { CreationAudio } from "./audio";
import { CreationPreview, creationChartDocument, type PreviewColors } from "./preview";

/** Foreign source geometry stays unjudged; this uses the existing chart presentation and media clock. */
export function mountCreationPresentationPreview(
  container: HTMLElement,
  project: Project,
  audio: CreationAudio,
  options: ChartPlaybackOptions & {
    colors: PreviewColors;
    signal?: AbortSignal;
    label: string;
    onEvent?: (event: ChartEmbedEvent) => void;
  },
): ChartEmbedHandle {
  options.signal?.throwIfAborted();
  const canvas = document.createElement("canvas");
  canvas.className = "chart-creation__editor";
  canvas.dataset.presentationPreview = "true";
  canvas.setAttribute("aria-label", options.label);
  canvas.setAttribute("role", "img");
  canvas.tabIndex = 0;
  container.append(canvas);
  let phase: ChartEmbedPhase = "ready",
    time = 0,
    playing = false,
    disposed = false;
  const listeners = new Set<(event: ChartEmbedEvent) => void>();
  const snapshot = () => ({ phase, time, playing, duration: audio.analysis.duration });
  const emit = (event: ChartEmbedEvent) => {
    options.onEvent?.(event);
    listeners.forEach((listener) => listener(event));
  };
  const publish = () => emit({ type: "state", snapshot: snapshot() });
  let preview: CreationPreview | undefined;
  try {
    preview = new CreationPreview(
      canvas,
      creationChartDocument(project, audio.analysis.duration),
      audio.file,
      options.colors,
      (seconds, advancing) => {
        if (!disposed) {
          time = seconds;
          playing = advancing;
          publish();
        }
      },
      (error) => emit({ type: "error", error }),
    );
    preview.clock.volume = options.volume ?? 0.82;
    preview.clock.rate = options.rate ?? 1;
    preview.clock.loop = options.loop ?? false;
  } catch (error) {
    preview?.dispose();
    canvas.remove();
    throw error;
  }
  const player = preview;
  const release = (next: ChartEmbedPhase) => {
    if (disposed) {
      if (next === "disposed") phase = next;
      return;
    }
    disposed = true;
    phase = next;
    playing = false;
    options.signal?.removeEventListener("abort", abort);
    player.dispose();
    canvas.remove();
    publish();
    listeners.clear();
  };
  const abort = () => release("cancelled");
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const active = () => {
    if (disposed) throw new Error("preview_disposed");
  };
  return {
    ready: Promise.resolve(),
    get snapshot() {
      return snapshot();
    },
    async play() {
      active();
      await player.play();
    },
    pause() {
      if (!disposed) player.pause();
    },
    seek(seconds) {
      active();
      player.seek(Math.max(0, Math.min(audio.analysis.duration, seconds)));
    },
    async setOptions(patch) {
      active();
      if (patch.mode && patch.mode !== "chart") throw new Error("source_preview_mode");
      if (patch.volume !== undefined) player.clock.volume = patch.volume;
      if (patch.rate !== undefined) player.clock.rate = patch.rate;
      if (patch.loop !== undefined) player.clock.loop = patch.loop;
    },
    async setSkin() {
      active();
      throw new Error("source_preview_skin");
    },
    subscribe(listener) {
      active();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancel: abort,
    async dispose() {
      release("disposed");
    },
  };
}
