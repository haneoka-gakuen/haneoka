// L3 — GEB
// Input: 工程、媒体时钟、原生音符、资源身份及编辑器音频设置。
// Output: 与观看模式相同的音符音效、长音循环及随拍号变速的节拍器。
// Pos: [Map](../L2-2.md)；编辑时的音频反馈与资源生命周期。
// Effects/Dependencies: 独立 Web Audio、固定 release 素材和本地设置；暂停／定位立即停止，音效组准备成功后替换旧组。
import { ChartSession, type ChartDocument } from "@haneoka/cassiopeia";
import { NoteSoundPlayer, type NoteSoundAsset, type NoteSoundAssetKey, type NoteSoundAssetManifest } from "@haneoka/cassiopeia-host-web";
import { ourNotesNoteSoundsForRelease, type OurNotesNoteSeGroup } from "@haneoka/cassiopeia-plugin-our-notes";
import { readBytes } from "../../../packages/embed-core/src/io";
import type { HaneokaReleaseIdentity } from "../../../packages/api-client/src/haneoka";
import type { Project } from "../../../packages/chart-editor/src/model";
import { TempoMap } from "../../../packages/chart-editor/src/timing";
import { createPinnedPublicFetcher, pinnedPublicUrl } from "./public-songs";

export interface EditorAudioSettings {
  bgmVolume: number;
  noteVolume: number;
  metronomeVolume: number;
  notes: boolean;
  metronome: boolean;
  group: OurNotesNoteSeGroup;
}
export const DEFAULT_EDITOR_AUDIO: Readonly<EditorAudioSettings> = {
  bgmVolume: 0.82, noteVolume: 0.7, metronomeVolume: 0.5, notes: false, metronome: false, group: 1,
};
const storageKey = "haneoka-chart-audio-v1";
export function readEditorAudioSettings(): EditorAudioSettings {
  const result = { ...DEFAULT_EDITOR_AUDIO };
  if (typeof window === "undefined") return result;
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (value?.version !== 1) return result;
    for (const key of ["bgmVolume", "noteVolume", "metronomeVolume"] as const)
      if (typeof value[key] === "number" && Number.isFinite(value[key])) result[key] = Math.max(0, Math.min(1, value[key]));
    for (const key of ["notes", "metronome"] as const) if (typeof value[key] === "boolean") result[key] = value[key];
    if ([1, 2, 3, 4].includes(value.group)) result.group = value.group;
  } catch {}
  return result;
}
export function writeEditorAudioSettings(settings: EditorAudioSettings) {
  localStorage.setItem(storageKey, JSON.stringify({ version: 1, ...settings }));
}
interface SoundLease {
  key: string;
  controller: AbortController;
  urls: Set<string>;
  player?: NoteSoundPlayer;
  promise?: Promise<void>;
}

export class EditorAudioFeedback {
  private context?: AudioContext;
  private media?: HTMLMediaElement;
  private project?: Project;
  private chart?: ChartDocument;
  private identity?: HaneokaReleaseIdentity;
  private session?: ChartSession;
  private unlisten?: () => void;
  private map?: TempoMap;
  private meters: Project["meters"] = [];
  private timingKey = "";
  private active?: SoundLease;
  private pending?: SoundLease;
  private needsReset = true;
  private resetAfter = Number.NEGATIVE_INFINITY;
  private lastUpdatedTimeMs = Number.NEGATIVE_INFINITY;
  private pulse = "";
  private voices = new Set<OscillatorNode>();
  private disposed = false;
  constructor(private settings: EditorAudioSettings) {}

  setSettings(settings: EditorAudioSettings) {
    if (!this.settings.notes && settings.notes) this.needsReset = true;
    if (!this.settings.metronome && settings.metronome) this.pulse = "";
    this.settings = settings;
    if (!settings.notes) {
      this.active?.player?.stopAll(); this.unlisten?.(); this.unlisten = undefined; this.session = undefined;
      if (this.pending) { this.disposeLease(this.pending); this.pending = undefined; }
    }
    if (!settings.noteVolume) this.active?.player?.stopAll();
    if (!settings.metronome || !settings.metronomeVolume) this.stopMetronome();
  }
  bind(project: Project, media: HTMLMediaElement, chart?: ChartDocument, identity?: HaneokaReleaseIdentity) {
    const changed = project !== this.project || media !== this.media || !this.session && !!chart;
    const resetAfter = media === this.media && project.audioOffset === this.project?.audioOffset ? this.lastUpdatedTimeMs : Number.NEGATIVE_INFINITY;
    const timingKey = project === this.project ? this.timingKey : JSON.stringify([project.audioOffset, project.tempos, project.meters]);
    const timingChanged = timingKey !== this.timingKey || media !== this.media;
    if (media !== this.media) {
      this.detachMedia();
      this.media = media;
      for (const type of ["pause", "waiting", "stalled", "ended", "error"]) media.addEventListener(type, this.stop);
      media.addEventListener("seeking", this.seek);
      this.active?.player?.bindMedia(media);
      this.pending?.player?.bindMedia(media);
    }
    this.project = project;
    this.chart = chart;
    this.identity = identity;
    if (timingChanged) {
      this.timingKey = timingKey; this.pulse = "";
      this.map = new TempoMap(project.tempos, { resolution: project.resolution, audioOffset: project.audioOffset });
      this.meters = [...project.meters].sort((a, b) => a.tick - b.tick);
    }
    if (changed) {
      this.stop(); this.needsReset = true; this.resetAfter = resetAfter;
      this.unlisten?.();
      this.session = chart ? new ChartSession(chart, { mode: "watch" }) : undefined;
      this.unlisten = this.session?.on("judgement", event => {
        if (this.settings.notes && this.settings.noteVolume > 0 && !this.disposed && this.media && !this.media.paused && !this.media.seeking)
          this.active?.player?.queue(event);
      });
    }
  }
  async unlock() {
    if (this.disposed || !this.settings.notes && !this.settings.metronome) return;
    this.context ??= new AudioContext({ latencyHint: "interactive" });
    const resume = this.context.state === "running" ? Promise.resolve() : this.context.resume();
    await Promise.all([resume, this.settings.notes ? this.prepareSounds() : undefined]);
    if (this.settings.notes) await this.active?.player?.unlock();
  }
  private prepareSounds(): Promise<void> {
    const identity = this.identity;
    if (!identity || !this.chart || !this.context) return Promise.reject(new Error("editor_sound_source_missing"));
    const key = JSON.stringify([identity.server, identity.releaseId, this.settings.group]);
    if (this.active?.key === key) return Promise.resolve();
    if (this.pending?.key === key) return this.pending.promise!;
    if (this.pending) this.disposeLease(this.pending);
    const lease: SoundLease = { key, controller: new AbortController(), urls: new Set() };
    this.pending = lease;
    const context = this.context, group = this.settings.group, media = this.media;
    lease.promise = (async () => {
      try {
        const signal = lease.controller.signal, fetcher = createPinnedPublicFetcher(identity);
        const source = ourNotesNoteSoundsForRelease(identity.server, group);
        const keys = ["perfect", "flick", "flickDirection", "trace", "type10", "just", "slide"] as const;
        const resources = new Map<string, Promise<string>>();
        const resource = (key: string) => {
          let pending = resources.get(key);
          if (!pending) {
            pending = (async () => {
              const response = await fetcher(new Request(pinnedPublicUrl(key, identity), { signal }));
              const data = await readBytes(response, { signal, maxBytes: 4 * 1024 * 1024, locale: "en", fetcher, progress: () => {} });
              signal.throwIfAborted();
              const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: "audio/mpeg" }));
              lease.urls.add(url);
              return url;
            })();
            resources.set(key, pending);
          }
          return pending;
        };
        const resolved: Partial<Record<NoteSoundAssetKey, NoteSoundAsset>> = {};
        // Prepare two cues at a time on mobile.
        let next = 0;
        const worker = async () => {
          while (next < keys.length) {
            const key = keys[next++]!, cue = source[key];
            resolved[key] = typeof cue === "string" ? await resource(cue) : await Promise.all(cue.map(async layer => ({ ...layer, url: await resource(layer.url) })));
          }
        };
        await Promise.all([worker(), worker()]);
        signal.throwIfAborted();
        const player = new NoteSoundPlayer(resolved as NoteSoundAssetManifest, { audioContext: context, ...(media ? { mediaElement: media } : {}) });
        lease.player = player;
        const abort = () => player.dispose();
        signal.addEventListener("abort", abort, { once: true });
        try { await player.load(); }
        finally { signal.removeEventListener("abort", abort); }
        signal.throwIfAborted();
        if (this.disposed || this.pending !== lease) throw new DOMException("Aborted", "AbortError");
        player.bindMedia(this.media);
        const previous = this.active;
        this.active = lease; this.pending = undefined;
        if (previous) this.disposeLease(previous);
      } catch (error) {
        const cancelled = lease.controller.signal.aborted;
        this.disposeLease(lease);
        if (this.pending === lease) this.pending = undefined;
        if (cancelled) throw lease.controller.signal.reason;
        throw error;
      }
    })();
    return lease.promise;
  }
  sync(seconds: number, advancing: boolean) {
    if (this.disposed || !this.project || !this.media || !this.map) return;
    if (!advancing || document.hidden) { this.stop(); return; }
    const timeMs = Math.floor((seconds - this.project.audioOffset) * 1000);
    if (this.needsReset) {
      this.session?.reset(Math.max(timeMs, this.resetAfter + 1)); this.active?.player?.clearQueue(); this.needsReset = false;
    }
    if (this.settings.notes && this.session) {
      const snapshot = this.session.updateReusable(timeMs);
      this.lastUpdatedTimeMs = timeMs;
      this.active?.player?.flush(this.settings.noteVolume);
      this.active?.player?.setLongLineActive(snapshot.activeLongLine && this.settings.noteVolume > 0, this.settings.noteVolume);
    }
    if (this.settings.metronome && this.context?.state === "running") {
      const tick = this.map.secondsToTick(seconds);
      if (tick < 0) return;
      const meter = this.meters.findLast(meter => meter.tick <= tick) ?? this.meters[0]!;
      const step = this.project.resolution * 4 / meter.denominator, index = Math.floor((tick - meter.tick) / step + 1e-8);
      const pulse = `${meter.id}:${index}`;
      if (pulse !== this.pulse) {
        this.pulse = pulse;
        if (seconds - this.map.tickToSeconds(meter.tick + index * step) < 0.1) this.click(index % meter.numerator === 0);
      }
    }
  }
  private click(accent: boolean) {
    if (!this.context || !this.settings.metronomeVolume) return;
    const context = this.context, source = context.createOscillator(), gain = context.createGain(), at = context.currentTime;
    source.frequency.value = accent ? 1320 : 880;
    gain.gain.setValueAtTime(this.settings.metronomeVolume * 0.25, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.035);
    source.connect(gain).connect(context.destination);
    this.voices.add(source);
    source.onended = () => { source.disconnect(); gain.disconnect(); this.voices.delete(source); };
    source.start(at); source.stop(at + 0.04);
  }
  private stopMetronome() {
    for (const source of this.voices) { try { source.stop(); } catch {} }
    this.voices.clear();
  }
  readonly stop = () => { this.active?.player?.stopAll(); this.stopMetronome(); };
  private readonly seek = () => {
    this.stop(); this.needsReset = true; this.pulse = "";
    this.resetAfter = Number.NEGATIVE_INFINITY; this.lastUpdatedTimeMs = Number.NEGATIVE_INFINITY;
  };
  private detachMedia() {
    if (!this.media) return;
    for (const type of ["pause", "waiting", "stalled", "ended", "error"]) this.media.removeEventListener(type, this.stop);
    this.media.removeEventListener("seeking", this.seek);
  }
  private disposeLease(lease: SoundLease) {
    lease.controller.abort(); lease.player?.dispose();
    for (const url of lease.urls) URL.revokeObjectURL(url);
    lease.urls.clear();
  }
  async dispose() {
    this.disposed = true; this.detachMedia(); this.stop(); this.unlisten?.(); this.session = undefined;
    if (this.pending) this.disposeLease(this.pending);
    if (this.active) this.disposeLease(this.active);
    this.pending = undefined; this.active = undefined;
    await this.context?.close().catch(() => {});
  }
}
