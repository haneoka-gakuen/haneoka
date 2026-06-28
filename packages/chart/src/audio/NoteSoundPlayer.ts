import type {
  NoteSoundAsset,
  NoteSoundAssetKey,
  NoteSoundAssetLayer,
  NoteSoundAssetManifest,
} from "../assets/manifest";
import { NoteDirection, NoteOperateType, NoteSimulateJudgement } from "../core/enums";
import type { JudgementEvent } from "../core/types";

const FLICK_TYPES = new Set<NoteOperateType>([
  NoteOperateType.Flick,
  NoteOperateType.SlideBeginFlick,
  NoteOperateType.SlideEndFlick,
  NoteOperateType.GuideBeginFlick,
]);
const TRACE_TYPES = new Set<NoteOperateType>([
  // GetTapSeType returns LiveNoteSeType.SlideConnect (10) for operate type
  // 21; MasterLiveNoteSe maps both 9 and 10 to the same default_trace sound
  // ID.
  NoteOperateType.SlideConnection,
  NoteOperateType.Trace,
  NoteOperateType.SlideBeginTrace,
  NoteOperateType.SlideConnectionTrace,
  NoteOperateType.SlideEndTrace,
  NoteOperateType.GuideBeginTrace,
  NoteOperateType.GuideEndTrace,
]);
const NATIVE_SOUND_TYPE_ORDER: ReadonlyArray<NoteSoundAssetKey> = [
  "good",
  "great",
  "perfect",
  "flick",
  "flickDirection",
  "slide",
  "just",
  "trace",
];

/** LiveSoundPlayer.GetJudgementSeType/GetTapSeType. */
export function noteSoundForJudgement(event: Pick<JudgementEvent, "judgement" | "note">): NoteSoundAssetKey | null {
  if (event.judgement === NoteSimulateJudgement.Good) return "good";
  if (event.judgement === NoteSimulateJudgement.Great) return "great";
  if (event.judgement === NoteSimulateJudgement.Just) return "just";
  if (event.judgement !== NoteSimulateJudgement.Perfect) return null;
  if (FLICK_TYPES.has(event.note.operateType)) {
    return event.note.direction === NoteDirection.Normal ? "flick" : "flickDirection";
  }
  if (TRACE_TYPES.has(event.note.operateType)) return "trace";
  return "perfect";
}

/**
 * PlayNoteSeFromLaneState uses a bool[type] cache while visiting notes, then
 * plays every marked type once after the visit. Keeping this queue separate
 * also makes the same-frame de-duplication testable without WebAudio.
 */
export class NoteSoundFrameQueue {
  private readonly queued = new Set<NoteSoundAssetKey>();

  queue(event: Pick<JudgementEvent, "judgement" | "note">): void {
    const key = noteSoundForJudgement(event);
    if (key) this.queued.add(key);
  }

  clear(): void {
    this.queued.clear();
  }

  take(target: NoteSoundAssetKey[] = []): NoteSoundAssetKey[] {
    target.length = 0;
    for (const key of NATIVE_SOUND_TYPE_ORDER) if (this.queued.has(key)) target.push(key);
    this.queued.clear();
    return target;
  }
}

function layersOf(asset: NoteSoundAsset): ReadonlyArray<NoteSoundAssetLayer> {
  return typeof asset === "string" ? [{ url: asset, gain: 1 }] : asset;
}

export class NoteSoundPlayer {
  private context?: AudioContext;
  private loadPromise?: Promise<void>;
  private readonly buffers = new Map<NoteSoundAssetKey, ReadonlyArray<{ buffer: AudioBuffer; gain: number }>>();
  private readonly sources = new Set<AudioBufferSourceNode>();
  private longSources: Array<{ source: AudioBufferSourceNode; gain: GainNode; layerGain: number }> = [];
  private readonly frameQueue = new NoteSoundFrameQueue();
  private readonly frameSoundKeys: NoteSoundAssetKey[] = [];
  private loadController?: AbortController;
  private disposed = false;

  constructor(private readonly assets: NoteSoundAssetManifest) {}

  load(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.loadPromise) return this.loadPromise;
    const context = (this.context ??= new AudioContext({ latencyHint: "interactive" }));
    const controller = new AbortController();
    this.loadController = controller;
    this.loadPromise = Promise.all(
      (Object.entries(this.assets) as Array<[NoteSoundAssetKey, NoteSoundAsset]>).map(async ([key, asset]) => {
        const decoded = await Promise.all(
          layersOf(asset).map(async (layer) => {
            try {
              const response = await fetch(layer.url, { cache: "force-cache", signal: controller.signal });
              if (!response.ok) return null;
              const buffer = await context.decodeAudioData(await response.arrayBuffer());
              return this.disposed ? null : { buffer, gain: layer.gain };
            } catch {
              // One unavailable optional layer must not disable the music player.
              return null;
            }
          }),
        );
        const available = decoded.filter((layer): layer is { buffer: AudioBuffer; gain: number } => layer !== null);
        if (!this.disposed && available.length) this.buffers.set(key, available);
      }),
    ).then(() => {
      if (this.loadController === controller) this.loadController = undefined;
    });
    return this.loadPromise;
  }

  async unlock(): Promise<void> {
    const loading = this.load();
    if (this.context?.state === "suspended") await this.context.resume();
    await loading;
  }

  queue(event: Pick<JudgementEvent, "judgement" | "note">): void {
    this.frameQueue.queue(event);
  }

  clearQueue(): void {
    this.frameQueue.clear();
  }

  /** Flush once per rendered lane-state frame, matching the native bool[type] cache. */
  flush(volume: number): void {
    const keys = this.frameQueue.take(this.frameSoundKeys);
    const context = this.context;
    if (!context || context.state !== "running") return;
    const masterVolume = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 0.7));
    const startAt = context.currentTime;
    for (const key of keys) {
      for (const layer of this.buffers.get(key) ?? []) {
        const source = context.createBufferSource();
        const gain = context.createGain();
        gain.gain.value = masterVolume * Math.max(0, layer.gain);
        source.buffer = layer.buffer;
        source.connect(gain).connect(context.destination);
        source.addEventListener(
          "ended",
          () => {
            source.disconnect();
            gain.disconnect();
            this.sources.delete(source);
          },
          { once: true },
        );
        this.sources.add(source);
        source.start(startAt);
      }
    }
  }

  /**
   * UpdateLongLineSe starts LiveNoteSeType.Slide with loop=true while any
   * normal Long line is Playing and pressed, and stops it when that predicate
   * becomes false. The cue is polyphonic, so every decoded layer starts at the
   * same AudioContext timestamp and loops independently.
   */
  setLongLineActive(active: boolean, volume: number): void {
    const context = this.context;
    const masterVolume = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 0.7));
    if (!active || !context || context.state !== "running") {
      this.stopLongLine();
      return;
    }
    if (this.longSources.length) {
      for (const node of this.longSources) node.gain.gain.value = masterVolume * Math.max(0, node.layerGain);
      return;
    }
    const layers = this.buffers.get("slide") ?? [];
    if (!layers.length) return;
    const startAt = context.currentTime;
    this.longSources = layers.map((layer) => {
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = layer.buffer;
      source.loop = true;
      gain.gain.value = masterVolume * Math.max(0, layer.gain);
      source.connect(gain).connect(context.destination);
      source.start(startAt);
      return { source, gain, layerGain: layer.gain };
    });
  }

  stopLongLine(): void {
    const nodes = this.longSources;
    this.longSources = [];
    for (const { source, gain } of nodes) {
      try {
        source.stop();
      } catch {
        // Already stopped by the audio backend.
      }
      source.disconnect();
      gain.disconnect();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadController?.abort();
    this.loadController = undefined;
    this.frameQueue.clear();
    this.stopLongLine();
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
      source.disconnect();
    }
    this.sources.clear();
    this.buffers.clear();
    void this.context?.close();
    this.context = undefined;
  }
}
