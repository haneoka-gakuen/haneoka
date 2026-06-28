import { Howl, Howler } from "howler";
import { requireCanonicalStoryResourceUrl } from "../runtime";

// --- Local types for game-engine sound descriptors and state ---

type AdvSoundCategory = "Bgm" | "Se" | "Voice";

/** A sound resource descriptor from the game engine (Sound, CueSheet, etc.) */
interface AdvSoundDescriptor {
  categoryName?: string;
  soundId?: number;
  id?: number;
  cueName?: string;
  cueSheetName?: string;
  playableUrl?: string;
  isLoop?: boolean;
  /** Per-cue gain authored by the source story (before category/user gain). */
  volume?: number;
}

/** Audio configuration from the story runtime */
interface AdvSoundRuntime {
  audio?: {
    categoryVolumes?: Partial<Record<AdvSoundCategory, number>>;
  };
}

/** Mutable audio state shared with the story engine */
interface AdvSoundState {
  audio: {
    bgm: string;
    se: string;
    voice: string;
  };
  session?: {
    sePlayIds?: number[];
    currentVoicePlayIds?: number[];
  };
}

type SePlayOptions = {
  delaySeconds?: number;
  durationSeconds?: number;
  fadeOutSeconds?: number;
};

type ManagedHowl = {
  playId: number;
  howlId: number;
  soundId: number;
  label: string;
  category: AdvSoundCategory;
  sound: AdvSoundDescriptor | null;
  howl: Howl;
  analyzer: AdvVoiceAnalyzer | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  stopping: boolean;
  playbackStarted: boolean;
  playbackSettled: boolean;
};

type VoicePlaybackCompletion = "ended" | "stopped" | "failed";

export interface WaitForVoicePlaybackOptions {
  signal?: AbortSignal;
  scopeSignal?: AbortSignal;
  isScopeCurrent?: () => boolean;
}

type BgmFadeState = {
  readonly target: "effective-volume" | "silence";
  readonly endsAtMilliseconds: number;
  completionTimer: ReturnType<typeof setTimeout> | null;
};

export type AdvVoiceAnalyzer = {
  sampleRms: () => number;
  sampleMotionSync: () => AdvVoiceMotionSyncSample | null;
  sampleMotionSyncPcm: () => AdvVoiceMotionSyncPcmSnapshot | null;
  dispose: () => void;
};

export type AdvVoiceMotionSyncSample = {
  rms: number;
  centroid: number;
  low: number;
  mid: number;
  high: number;
};

export type AdvVoiceMotionSyncPcmSnapshot = {
  sourceKey: number | string;
  channelData: Float32Array;
  sampleRate: number;
  samplePosition: number;
};

/** Snapshot type for save/restore of BGM state */
export type AdvSoundSnapshot = {
  bgm: AdvSoundDescriptor | null;
  bgmPositionSeconds: number;
  bgmPlaying: boolean;
  movieSoundVolume: number;
  categoryVolumes: [AdvSoundCategory, number][];
  frameStamp: number;
  lastBgmOrSeFrame: number;
  lastBgmLabel: string;
  lastSeLabel: string;
};

// --- Internal Howler type extensions for voice analysis ---
// These access private Howler APIs (_soundById, _webAudio, _sounds, _node)
// not covered by @types/howler.

/** Minimal duck type for Howler's internal audio node tree */
interface HowlSoundNode {
  connect(node: AudioNode): void;
  disconnect(node?: AudioNode): void;
  bufferSource?: HowlSoundNode;
  buffer?: AudioBuffer;
}

/** Howler's internal sound instance */
interface HowlSoundInternal {
  _node?: HowlSoundNode;
  _paused?: boolean;
  _ended?: boolean;
}

/** Howl extended with internal APIs needed for voice analysis */
interface HowlExtended extends Howl {
  /** @internal Howler private: look up a sound instance by ID */
  _soundById(id: number): HowlSoundInternal | null;
  /** @internal Howler private: whether this Howl uses Web Audio backend */
  _webAudio?: boolean;
  /** @internal Howler private: pool of sound instances */
  _sounds?: HowlSoundInternal[];
  /** @internal Howler private: playback start is waiting on load/resume */
  _playLock?: boolean;
  /** @internal Howler private: deferred operations, including queued play */
  _queue?: Array<{ event?: string }>;
}

// --- Utility functions ---

function clampVolume(value: number | undefined | null, fallback = 1): number {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(0, Math.min(1, next));
}

function finiteSeconds(value: number | undefined | null, fallback = 0): number {
  const next = Number(value);
  return Number.isFinite(next) ? Math.max(0, next) : fallback;
}

function categoryKey(soundOrName: string | AdvSoundDescriptor | null | undefined): AdvSoundCategory | "" {
  const raw = typeof soundOrName === "string" ? soundOrName : soundOrName?.categoryName;
  const key = String(raw || "").toLowerCase();
  if (key === "bgm") return "Bgm";
  if (key === "se") return "Se";
  if (key === "voice") return "Voice";
  return "";
}

function soundId(sound: AdvSoundDescriptor | null | undefined): number {
  const id = Number(sound?.soundId ?? sound?.id ?? 0);
  return Number.isFinite(id) ? Math.trunc(id) : 0;
}

function soundLabel(sound: AdvSoundDescriptor | null | undefined): string {
  return sound?.cueName || sound?.cueSheetName || String(soundId(sound) || "");
}

function localPlaybackUrl(url: string | undefined | null, label: string): string {
  const value = String(url || "");
  if (!value) return "";
  if (/^https?:\/\//i.test(value))
    throw new Error(`ADV ${label} playback must use local assets, got remote URL: ${value}`);
  return requireCanonicalStoryResourceUrl(value, `${label} playback`);
}

function clonePlain<T>(value: T): T {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function monotonicMilliseconds(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function attachVoiceAnalyzer(entry: ManagedHowl): AdvVoiceAnalyzer | null {
  if (entry.category !== "Voice" || entry.analyzer) return entry.analyzer;
  const howl = entry.howl as HowlExtended;
  const ctx = Howler.ctx;
  if (!ctx || !howl?._webAudio) return null;
  const sound = typeof howl._soundById === "function" ? howl._soundById(entry.howlId) : null;
  const outputNode = sound?._node;
  const sourceNode: HowlSoundNode | undefined = outputNode?.bufferSource ?? outputNode;
  if (!sourceNode?.connect) return null;
  try {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    sourceNode.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const spectrum = new Uint8Array(analyser.frequencyBinCount);
    const sampleRate = Math.max(1, Number(ctx.sampleRate) || 44100);
    const resolveAudioBuffer = (): AudioBuffer | null => {
      const buffer =
        sourceNode?.bufferSource?.buffer ||
        sound?._node?.bufferSource?.buffer ||
        howl?._sounds?.[0]?._node?.bufferSource?.buffer;
      return buffer && typeof buffer.getChannelData === "function" ? buffer : null;
    };
    const currentSamplePosition = (audioSampleRate: number) => {
      try {
        const seek = Number(howl.seek(entry.howlId));
        return Math.max(0, Math.floor((Number.isFinite(seek) ? seek : 0) * audioSampleRate));
      } catch {
        return 0;
      }
    };
    const sampleRms = () => {
      try {
        analyser.getFloatTimeDomainData(samples);
      } catch {
        return 0;
      }
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
      return Math.sqrt(sum / Math.max(1, samples.length));
    };
    return {
      sampleRms,
      sampleMotionSync: () => {
        try {
          analyser.getByteFrequencyData(spectrum);
        } catch {
          return null;
        }
        const nyquist = sampleRate * 0.5;
        const binHz = nyquist / Math.max(1, spectrum.length);
        let total = 0;
        let weighted = 0;
        let low = 0;
        let mid = 0;
        let high = 0;
        for (let i = 0; i < spectrum.length; i += 1) {
          const hz = (i + 0.5) * binHz;
          if (hz < 80 || hz > 5000) continue;
          const mag = spectrum[i] / 255;
          const energy = mag * mag;
          total += energy;
          weighted += energy * hz;
          if (hz < 500) low += energy;
          else if (hz < 1800) mid += energy;
          else high += energy;
        }
        if (total <= 0.000001) return { rms: sampleRms(), centroid: 0, low: 0, mid: 0, high: 0 };
        return {
          rms: sampleRms(),
          centroid: Math.max(0, Math.min(1, weighted / total / 5000)),
          low: low / total,
          mid: mid / total,
          high: high / total,
        };
      },
      sampleMotionSyncPcm: () => {
        const audioBuffer = resolveAudioBuffer();
        if (!audioBuffer || audioBuffer.numberOfChannels < 1) return null;
        const audioSampleRate = Math.max(1, Math.trunc(Number(audioBuffer.sampleRate) || sampleRate));
        const channelData = audioBuffer.getChannelData(0);
        return {
          sourceKey: entry.playId,
          channelData,
          sampleRate: audioSampleRate,
          samplePosition: Math.min(channelData.length, currentSamplePosition(audioSampleRate)),
        };
      },
      dispose: () => {
        try {
          sourceNode.disconnect(analyser);
        } catch {}
      },
    };
  } catch {
    return null;
  }
}

export class AdvSoundManager {
  runtime: AdvSoundRuntime;
  state: AdvSoundState;
  masterVolume: number;
  categoryVolumes: Map<AdvSoundCategory, number>;
  userCategoryVolumes: Map<AdvSoundCategory, number>;
  bgm: ManagedHowl | null;
  se: Set<ManagedHowl>;
  seBySoundId: Map<number, Set<ManagedHowl>>;
  voices: Set<ManagedHowl>;
  pendingTimers: Set<ReturnType<typeof setTimeout>>;
  movieSoundVolume: number;
  lastBgmOrSeFrame: number;
  frameStamp: number;
  lastBgmLabel: string;
  lastSeLabel: string;
  warmHowls: Map<string, Howl>;
  nextPlayIdValue: number;
  private readonly bgmFades: Map<ManagedHowl, BgmFadeState>;
  private readonly voicePlaybackCompletions: Map<number, VoicePlaybackCompletion>;
  private readonly voicePlaybackWaiters: Map<number, Set<(completion: VoicePlaybackCompletion) => void>>;

  constructor(runtime: AdvSoundRuntime | null | undefined, state: AdvSoundState) {
    this.runtime = runtime || {};
    this.state = state;
    const defaults = runtime?.audio?.categoryVolumes || {};
    this.masterVolume = 1;
    this.categoryVolumes = new Map<AdvSoundCategory, number>([
      ["Bgm", clampVolume(defaults.Bgm, 0.7)],
      ["Se", clampVolume(defaults.Se, 1)],
      ["Voice", clampVolume(defaults.Voice, 1)],
    ]);
    this.userCategoryVolumes = new Map<AdvSoundCategory, number>([
      ["Bgm", 1],
      ["Se", 1],
      ["Voice", 1],
    ]);
    this.bgm = null;
    this.se = new Set<ManagedHowl>();
    this.seBySoundId = new Map<number, Set<ManagedHowl>>();
    this.voices = new Set<ManagedHowl>();
    this.pendingTimers = new Set<ReturnType<typeof setTimeout>>();
    this.movieSoundVolume = 1;
    this.lastBgmOrSeFrame = -1;
    this.frameStamp = 0;
    this.lastBgmLabel = "";
    this.lastSeLabel = "";
    this.warmHowls = new Map();
    this.nextPlayIdValue = 1;
    this.bgmFades = new Map();
    this.voicePlaybackCompletions = new Map();
    this.voicePlaybackWaiters = new Map();
  }

  setMovieSoundVolume(volume: number | undefined | null) {
    const next = Number(volume);
    this.movieSoundVolume = Number.isFinite(next) ? Math.max(0, Math.min(1, next)) : 1;
    if (this.bgm) this.applyEntryVolume(this.bgm, 0);
  }

  advanceFrame() {
    this.frameStamp += 1;
  }

  isLastBgmOrSePlaybackFrame() {
    return this.frameStamp === this.lastBgmOrSeFrame;
  }

  updateLastBgmOrSePlaybackFrame() {
    this.lastBgmOrSeFrame = this.frameStamp;
  }

  dispose() {
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
    this.stopAllBgmImmediately();
    for (const entry of [...this.se, ...this.voices]) this.stopEntry(entry, 0);
    this.se.clear();
    this.seBySoundId.clear();
    this.voices.clear();
    for (const howl of this.warmHowls.values()) {
      try {
        howl.unload();
      } catch {}
    }
    this.warmHowls.clear();
    this.syncSessionSePlayIds();
  }

  effectiveVolume(soundOrName: string | AdvSoundDescriptor | null | undefined) {
    const category = categoryKey(soundOrName);
    const authoredVolume = typeof soundOrName === "string" ? 1 : clampVolume(soundOrName?.volume, 1);
    const base =
      clampVolume(this.masterVolume, 1) *
      clampVolume(category ? this.categoryVolumes.get(category) : 1, 1) *
      clampVolume(category ? this.userCategoryVolumes.get(category) : 1, 1) *
      authoredVolume;
    return category === "Bgm" ? base * this.movieSoundVolume : base;
  }

  makeHowl(sound: AdvSoundDescriptor | null | undefined, category: AdvSoundCategory, loop = false): Howl | null {
    const src = localPlaybackUrl(sound?.playableUrl, "audio");
    if (!src) return null;
    const warmed = this.warmHowls.get(src);
    if (warmed) {
      this.warmHowls.delete(src);
      try {
        warmed.loop(loop);
        warmed.volume(this.effectiveVolume(sound));
      } catch {}
      return warmed;
    }
    return new Howl({
      src: [src],
      html5: category !== "Voice",
      loop,
      volume: this.effectiveVolume(sound),
    });
  }

  warmSound(
    sound: AdvSoundDescriptor | null | undefined,
    categoryValue: AdvSoundCategory | string = sound?.categoryName ?? "",
  ) {
    const category = categoryKey(categoryValue) || categoryKey(sound);
    if (!category || !sound?.playableUrl) return;
    const src = localPlaybackUrl(sound.playableUrl, "audio");
    if (!src || this.warmHowls.has(src)) return;
    const howl = new Howl({
      src: [src],
      html5: category !== "Voice",
      loop: category === "Bgm",
      volume: 0,
      preload: true,
    });
    this.warmHowls.set(src, howl);
  }

  getVoiceVolume() {
    return this.effectiveVolume({ categoryName: "Voice" });
  }

  createEntry(
    sound: AdvSoundDescriptor | null | undefined,
    category: AdvSoundCategory,
    loop = false,
  ): ManagedHowl | null {
    const howl = this.makeHowl(sound, category, loop);
    if (!howl) return null;
    const entry: ManagedHowl = {
      playId: this.nextPlayIdValue++,
      howlId: 0,
      soundId: soundId(sound),
      label: soundLabel(sound),
      category,
      sound: sound ?? null,
      howl,
      analyzer: null,
      stopTimer: null,
      cleanupTimer: null,
      stopping: false,
      playbackStarted: false,
      playbackSettled: false,
    };
    // Backfill the real audio duration onto the sound entry once the Howl loads,
    // so duration-based presentation logic works when the producer did not
    // precompute durationMs.
    // `entry.sound` is the same object the player holds in voices[]/bgm/se, so
    // maxSoundDurationSeconds picks this up.
    const fillDuration = (): void => {
      const duration = Number(howl.duration());
      if (Number.isFinite(duration) && duration > 0 && entry.sound) {
        (entry.sound as { durationMs?: number }).durationMs = Math.round(duration * 1000);
      }
    };
    if (howl.state() === "loaded") fillDuration();
    else howl.once("load", fillDuration);
    return entry;
  }

  addSeEntry(entry: ManagedHowl) {
    this.se.add(entry);
    if (!this.seBySoundId.has(entry.soundId)) this.seBySoundId.set(entry.soundId, new Set<ManagedHowl>());
    this.seBySoundId.get(entry.soundId)?.add(entry);
    this.state.audio.se = entry.label;
    this.syncSessionSePlayIds();
  }

  addVoiceEntry(entry: ManagedHowl) {
    this.voices.add(entry);
    this.state.audio.voice = entry.label;
    const ids = this.state?.session?.currentVoicePlayIds;
    if (Array.isArray(ids)) ids.push(entry.playId);
  }

  removeEntry(entry: ManagedHowl) {
    entry.playbackSettled = true;
    this.clearBgmFade(entry);
    if (entry.stopTimer) clearTimeout(entry.stopTimer);
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    try {
      entry.analyzer?.dispose();
    } catch {}
    entry.analyzer = null;
    entry.stopTimer = null;
    entry.cleanupTimer = null;
    if (entry.category === "Bgm") {
      if (this.bgm === entry) this.bgm = null;
      if (!this.bgm) this.state.audio.bgm = "";
    } else if (entry.category === "Se") {
      this.se.delete(entry);
      const bucket = this.seBySoundId.get(entry.soundId);
      bucket?.delete(entry);
      if (bucket && !bucket.size) this.seBySoundId.delete(entry.soundId);
      if (!this.se.size) this.state.audio.se = "";
      this.syncSessionSePlayIds();
    } else {
      this.settleVoicePlayback(entry.playId, "stopped");
      this.voices.delete(entry);
      if (!this.voices.size) this.state.audio.voice = "";
    }
  }

  private settleVoicePlayback(playId: number, completion: VoicePlaybackCompletion): void {
    const id = Math.trunc(Number(playId) || 0);
    if (id <= 0 || this.voicePlaybackCompletions.has(id)) return;
    const entry = this.getVoicePlayback(id);
    if (entry) entry.playbackSettled = true;
    this.voicePlaybackCompletions.set(id, completion);
    while (this.voicePlaybackCompletions.size > 256) {
      const oldest = this.voicePlaybackCompletions.keys().next().value;
      if (typeof oldest !== "number") break;
      this.voicePlaybackCompletions.delete(oldest);
    }
    const waiters = this.voicePlaybackWaiters.get(id);
    this.voicePlaybackWaiters.delete(id);
    for (const resolve of waiters || []) resolve(completion);
  }

  private getVoicePlayback(playId: number): ManagedHowl | null {
    for (const entry of this.voices) {
      if (entry.playId === playId) return entry;
    }
    return null;
  }

  private observeVoicePlayback(entry: ManagedHowl): VoicePlaybackCompletion | "pending" {
    const howl = entry.howl as HowlExtended;
    try {
      const state = howl.state();
      if (state === "unloaded") return "failed";
      const sound = entry.howlId > 0 ? howl._soundById(entry.howlId) : null;
      if (!sound) {
        if (state === "loaded") return "failed";
        return "pending";
      }

      const seek = Number(howl.seek(entry.howlId || undefined));
      const duration = Number(howl.duration(entry.howlId || undefined));
      const hasPlaybackPosition = Number.isFinite(seek) && seek >= 0;
      const reachedNaturalEnd =
        entry.playbackStarted &&
        hasPlaybackPosition &&
        Number.isFinite(duration) &&
        duration > 0 &&
        sound._paused !== false &&
        seek >= Math.max(0, duration - 0.005);

      // Howler sets `_ended = false` before queueing an unloaded sound and
      // restores it after end, stop, or playback failure. We separately record
      // a real start so a lost play-error callback is not mistaken for speech.
      if (sound._ended === true || reachedNaturalEnd) return entry.playbackStarted ? "ended" : "failed";
      if (sound._paused === false) {
        entry.playbackStarted = true;
        return "pending";
      }

      const hasQueuedPlay = howl._queue?.some((task) => task?.event === "play") ?? false;
      if (state === "loaded" && howl._playLock === false && !hasQueuedPlay) return "failed";
    } catch {}
    return "pending";
  }

  /**
   * Waits for the exact voice instances owned by one ADV command. Natural
   * Howler `end` events are the completion source; stop/error and scope loss
   * release the wait without pretending that playback completed normally.
   */
  waitForVoicePlayback(playIds: readonly number[], options: WaitForVoicePlaybackOptions = {}): Promise<boolean> {
    const ids = [...new Set(playIds.map((value) => Math.trunc(Number(value) || 0)).filter((value) => value > 0))];
    if (!ids.length) return Promise.resolve(true);
    if (
      options.signal?.aborted ||
      options.scopeSignal?.aborted ||
      (options.isScopeCurrent && !options.isScopeCurrent())
    ) {
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      const pending = new Set(ids);
      const subscriptions: Array<readonly [number, (completion: VoicePlaybackCompletion) => void]> = [];
      let observationTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      let allCompletedNaturally = true;

      const cleanup = (): void => {
        if (observationTimer) clearTimeout(observationTimer);
        observationTimer = null;
        options.signal?.removeEventListener("abort", abort);
        options.scopeSignal?.removeEventListener("abort", abort);
        for (const [id, listener] of subscriptions) {
          const waiters = this.voicePlaybackWaiters.get(id);
          waiters?.delete(listener);
          if (waiters && !waiters.size) this.voicePlaybackWaiters.delete(id);
        }
      };
      const finish = (completedNaturally: boolean): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(completedNaturally);
      };
      const abort = (): void => finish(false);
      const onCompletion = (id: number, completion: VoicePlaybackCompletion): void => {
        if (settled) return;
        if (completion !== "ended") allCompletedNaturally = false;
        pending.delete(id);
        if (!pending.size) finish(allCompletedNaturally);
      };
      const observePendingPlayback = (): void => {
        if (settled) return;
        if (options.isScopeCurrent && !options.isScopeCurrent()) {
          finish(false);
          return;
        }
        for (const id of [...pending]) {
          const completed = this.voicePlaybackCompletions.get(id);
          if (completed) {
            onCompletion(id, completed);
            continue;
          }
          const entry = this.getVoicePlayback(id);
          const observation = entry ? this.observeVoicePlayback(entry) : "stopped";
          if (observation !== "pending") {
            this.settleVoicePlayback(id, observation);
            if (entry) this.forceStopEntry(entry);
          }
        }
        if (!settled) observationTimer = setTimeout(observePendingPlayback, 100);
      };

      options.signal?.addEventListener("abort", abort, { once: true });
      options.scopeSignal?.addEventListener("abort", abort, { once: true });
      for (const id of ids) {
        const completed = this.voicePlaybackCompletions.get(id);
        if (completed) {
          onCompletion(id, completed);
          continue;
        }
        if (!this.getVoicePlayback(id)) {
          allCompletedNaturally = false;
          pending.delete(id);
          continue;
        }
        const listener = (completion: VoicePlaybackCompletion): void => onCompletion(id, completion);
        const waiters = this.voicePlaybackWaiters.get(id) || new Set<(completion: VoicePlaybackCompletion) => void>();
        waiters.add(listener);
        this.voicePlaybackWaiters.set(id, waiters);
        subscriptions.push([id, listener]);
      }
      if (!settled && !pending.size) finish(allCompletedNaturally);
      if (!settled && (options.signal?.aborted || options.scopeSignal?.aborted)) finish(false);
      if (!settled) observePendingPlayback();
    });
  }

  syncSessionSePlayIds() {
    const ids = this.state?.session?.sePlayIds;
    if (Array.isArray(ids)) {
      ids.length = 0;
      ids.push(...[...this.se].map((entry) => entry.playId));
    }
  }

  stopEntry(entry?: ManagedHowl | null, fadeSeconds = 0) {
    if (!entry) return;
    const fade = finiteSeconds(fadeSeconds, 0);
    if (entry.stopTimer) {
      clearTimeout(entry.stopTimer);
      entry.stopTimer = null;
    }
    if (entry.stopping && fade > 0) return;
    entry.stopping = true;
    if (fade > 0) {
      try {
        const from = Number(entry.howl.volume()) || 0;
        if (entry.category === "Bgm") this.startBgmFade(entry, from, 0, fade, "silence");
        else entry.howl.fade(from, 0, fade * 1000);
        entry.cleanupTimer = setTimeout(() => this.forceStopEntry(entry), fade * 1000 + 80);
        return;
      } catch {}
    }
    this.forceStopEntry(entry);
  }

  forceStopEntry(entry: ManagedHowl) {
    if (entry.category === "Voice") this.settleVoicePlayback(entry.playId, "stopped");
    try {
      entry.howl.stop();
      entry.howl.unload();
    } catch {}
    this.removeEntry(entry);
  }

  applyEntryVolume(entry: ManagedHowl, fadeSeconds = 0) {
    const target = this.effectiveVolume(entry.sound);
    try {
      if (fadeSeconds > 0) {
        const from = Number(entry.howl.volume()) || 0;
        if (entry.category === "Bgm") this.startBgmFade(entry, from, target, fadeSeconds, "effective-volume");
        else entry.howl.fade(from, target, fadeSeconds * 1000);
      } else {
        if (entry.category === "Bgm") this.clearBgmFade(entry);
        entry.howl.volume(target);
      }
    } catch {}
  }

  private clearBgmFade(entry: ManagedHowl): void {
    const fade = this.bgmFades.get(entry);
    if (!fade) return;
    if (fade.completionTimer) clearTimeout(fade.completionTimer);
    fade.completionTimer = null;
    this.bgmFades.delete(entry);
  }

  private scheduleBgmFadeCompletion(entry: ManagedHowl, fade: BgmFadeState): void {
    if (fade.completionTimer) clearTimeout(fade.completionTimer);
    if (fade.target === "silence") {
      fade.completionTimer = null;
      return;
    }
    const remaining = Math.max(0, fade.endsAtMilliseconds - monotonicMilliseconds());
    fade.completionTimer = setTimeout(() => {
      if (this.bgmFades.get(entry) !== fade) return;
      fade.completionTimer = null;
      this.bgmFades.delete(entry);
    }, remaining);
  }

  private startBgmFade(
    entry: ManagedHowl,
    from: number,
    to: number,
    durationSeconds: number,
    target: BgmFadeState["target"],
  ): void {
    this.clearBgmFade(entry);
    const durationMilliseconds = finiteSeconds(durationSeconds, 0) * 1000;
    entry.howl.fade(from, to, durationMilliseconds);
    const fade: BgmFadeState = {
      target,
      endsAtMilliseconds: monotonicMilliseconds() + durationMilliseconds,
      completionTimer: null,
    };
    this.bgmFades.set(entry, fade);
    this.scheduleBgmFadeCompletion(entry, fade);
  }

  private stopAllBgmImmediately(): void {
    const entries = new Set<ManagedHowl>(this.bgmFades.keys());
    if (this.bgm) entries.add(this.bgm);
    this.bgm = null;
    this.state.audio.bgm = "";
    for (const entry of entries) this.forceStopEntry(entry);
  }

  private retargetBgmFades(previousGain: number, nextGain: number): void {
    const now = monotonicMilliseconds();
    for (const [entry, fade] of [...this.bgmFades]) {
      const remaining = Math.max(0, fade.endsAtMilliseconds - now);
      if (remaining <= 0) {
        if (fade.target === "silence") this.forceStopEntry(entry);
        else {
          this.clearBgmFade(entry);
          this.applyEntryVolume(entry, 0);
        }
        continue;
      }
      try {
        const current = Math.max(0, Number(entry.howl.volume()) || 0);
        const scaledCurrent = previousGain > 0 ? current * (nextGain / previousGain) : 0;
        const target = fade.target === "silence" ? 0 : this.effectiveVolume(entry.sound);
        entry.howl.fade(scaledCurrent, target, remaining);
        this.scheduleBgmFadeCompletion(entry, fade);
      } catch {}
    }
  }

  scheduleTimer(seconds: number, callback: () => void) {
    const delay = finiteSeconds(seconds, 0);
    if (delay <= 0) {
      callback();
      return null;
    }
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      callback();
    }, delay * 1000);
    this.pendingTimers.add(timer);
    return timer;
  }

  playBgm(sound: AdvSoundDescriptor | null | undefined, fadeSeconds = 0, startTimeSeconds = 0) {
    if (!sound?.playableUrl) return null;
    const label = soundLabel(sound);
    if (this.isLastBgmOrSePlaybackFrame() && this.lastBgmLabel === label) return this.bgm;
    this.lastBgmLabel = label;
    this.updateLastBgmOrSePlaybackFrame();

    if (this.bgm && (this.bgm.soundId === soundId(sound) || this.bgm.label === label)) {
      this.bgm.sound = sound;
      this.state.audio.bgm = label;
      this.applyEntryVolume(this.bgm, finiteSeconds(fadeSeconds, 0));
      const start = finiteSeconds(startTimeSeconds, 0);
      if (start > 0) {
        try {
          this.bgm.howl.seek(start, this.bgm.howlId || undefined);
        } catch {}
      }
      return this.bgm;
    }

    this.stopBgm(fadeSeconds);
    const entry = this.createEntry(sound, "Bgm", true);
    if (!entry) return null;
    this.bgm = entry;
    this.state.audio.bgm = entry.label;
    const target = this.effectiveVolume(sound);
    const start = finiteSeconds(startTimeSeconds, 0);
    if (start > 0) {
      entry.howl.once("play", (id: number) => {
        try {
          entry.howl.seek(start, Number.isFinite(id) ? id : entry.howlId || undefined);
        } catch {}
      });
    }
    if (fadeSeconds > 0) {
      entry.howl.volume(0);
      entry.howlId = Number(entry.howl.play()) || 0;
      this.startBgmFade(entry, 0, target, fadeSeconds, "effective-volume");
    } else {
      entry.howl.volume(target);
      entry.howlId = Number(entry.howl.play()) || 0;
    }
    if (start > 0) {
      try {
        entry.howl.seek(start, entry.howlId || undefined);
      } catch {}
    }
    return entry;
  }

  stopBgm(fadeSeconds = 0) {
    const entry = this.bgm;
    this.bgm = null;
    this.state.audio.bgm = "";
    if (entry) this.stopEntry(entry, fadeSeconds);
  }

  playSe(sound: AdvSoundDescriptor | null | undefined, options: SePlayOptions = {}) {
    const delaySeconds = finiteSeconds(options.delaySeconds, 0);
    if (delaySeconds > 0) {
      this.scheduleTimer(delaySeconds, () => this.playSe(sound, { ...options, delaySeconds: 0 }));
      return null;
    }

    if (!sound?.playableUrl) return null;
    const label = soundLabel(sound);
    if (this.isLastBgmOrSePlaybackFrame() && this.lastSeLabel === label) return null;
    this.lastSeLabel = label;
    this.updateLastBgmOrSePlaybackFrame();

    const entry = this.createEntry(sound, "Se", Boolean(sound?.isLoop));
    if (!entry) return null;
    this.addSeEntry(entry);
    entry.howl.once("end", () => {
      if (!entry.stopping) this.removeEntry(entry);
      try {
        entry.howl.unload();
      } catch {}
    });
    entry.howl.play();

    const durationSeconds = finiteSeconds(options.durationSeconds, 0);
    if (durationSeconds > 0)
      this.scheduleSoundAutoStop(entry, durationSeconds, finiteSeconds(options.fadeOutSeconds, 0));
    return entry;
  }

  scheduleSoundAutoStop(entry: ManagedHowl, durationSeconds: number, fadeOutSeconds = 0, onStop?: () => void) {
    if (entry.stopTimer) clearTimeout(entry.stopTimer);
    const duration = finiteSeconds(durationSeconds, 0);
    if (duration <= 0) {
      entry.stopTimer = null;
      return;
    }
    entry.stopTimer = setTimeout(() => {
      entry.stopTimer = null;
      this.stopEntry(entry, fadeOutSeconds);
      onStop?.();
    }, duration * 1000);
  }

  stopSe(soundOrId?: number | AdvSoundDescriptor | null, fadeSeconds = 0, delaySeconds = 0) {
    const delay = finiteSeconds(delaySeconds, 0);
    if (delay > 0) {
      this.scheduleTimer(delay, () => this.stopSe(soundOrId, fadeSeconds, 0));
      return;
    }
    const id = typeof soundOrId === "number" ? Math.trunc(soundOrId) : soundId(soundOrId);
    const entries = id ? [...(this.seBySoundId.get(id) || [])] : [...this.se];
    for (const entry of entries) this.stopEntry(entry, fadeSeconds);
  }

  playVoice(sound: AdvSoundDescriptor | null | undefined) {
    const entry = this.createEntry(sound, "Voice", false);
    if (!entry) return null;
    this.addVoiceEntry(entry);
    entry.howl.once("end", () => {
      this.settleVoicePlayback(entry.playId, "ended");
      if (!entry.stopping) this.removeEntry(entry);
      try {
        entry.howl.unload();
      } catch {}
    });
    const fail = (): void => {
      this.settleVoicePlayback(entry.playId, "failed");
      this.removeEntry(entry);
      try {
        entry.howl.unload();
      } catch {}
    };
    entry.howl.once("loaderror", fail);
    entry.howl.once("playerror", fail);
    const markPlaybackStarted = (): void => {
      const howl = entry.howl as HowlExtended;
      const active = entry.howlId > 0 ? howl._soundById(entry.howlId) : null;
      if (active?._paused === false && active._ended !== true) {
        entry.playbackStarted = true;
      }
    };
    entry.howl.once("load", markPlaybackStarted);
    entry.howl.once("play", (id: number) => {
      entry.howlId = Number.isFinite(id) ? id : entry.howlId;
      entry.playbackStarted = true;
      entry.analyzer = attachVoiceAnalyzer(entry);
    });
    try {
      const howlId = entry.howl.play();
      entry.howlId = Number.isFinite(howlId) ? howlId : 0;
      markPlaybackStarted();
      entry.analyzer = attachVoiceAnalyzer(entry);
    } catch {
      fail();
      return null;
    }
    return entry;
  }

  stopVoices() {
    for (const entry of [...this.voices]) this.stopEntry(entry, 0);
    this.voices.clear();
    this.state.audio.voice = "";
    const ids = this.state?.session?.currentVoicePlayIds;
    if (Array.isArray(ids)) ids.length = 0;
  }

  /** Stops the exact voice instances owned by one command without touching concurrent dialogue. */
  stopVoicePlaybacks(playIds: readonly number[]) {
    const ids = new Set(playIds.map((value) => Math.trunc(Number(value) || 0)).filter((value) => value > 0));
    if (!ids.size) return;
    for (const entry of [...this.voices]) {
      if (ids.has(entry.playId)) this.stopEntry(entry, 0);
    }
  }

  /** Transient SE/voice/timers cannot be resumed at an exact audio playhead. */
  get isSeekSnapshotSafe(): boolean {
    return this.se.size === 0 && this.voices.size === 0 && this.pendingTimers.size === 0 && this.bgmFades.size === 0;
  }

  setMasterVolume(nextVolume: number): void {
    const previous = clampVolume(this.masterVolume, 1);
    const next = clampVolume(nextVolume, previous);
    if (next === previous) return;
    this.masterVolume = next;

    if (this.bgm && !this.bgmFades.has(this.bgm)) this.applyEntryVolume(this.bgm, 0);
    for (const entry of this.se) if (!entry.stopping) this.applyEntryVolume(entry, 0);
    for (const entry of this.voices) if (!entry.stopping) this.applyEntryVolume(entry, 0);
    this.retargetBgmFades(previous, next);
  }

  setCategoryVolume(
    categoryValue: string | AdvSoundDescriptor | null | undefined,
    nextVolume: number | undefined | null,
    fadeSeconds = 0,
  ) {
    const category = categoryKey(categoryValue);
    if (!category) return;
    const previous = this.categoryVolumes.get(category) ?? 1;
    const value = clampVolume(nextVolume, previous);
    this.categoryVolumes.set(category, value);
    if (category === "Bgm" && value !== previous) this.retargetBgmFades(previous, value);
    const entries: ManagedHowl[] = [];
    if (category === "Bgm" && this.bgm && !this.bgmFades.has(this.bgm)) entries.push(this.bgm);
    if (category === "Se") entries.push(...this.se);
    if (category === "Voice") entries.push(...this.voices);
    const fade = finiteSeconds(fadeSeconds, 0);
    for (const entry of entries) this.applyEntryVolume(entry, fade);
  }

  /** Browser/user gain is intentionally outside authored SoundVolume state. */
  setUserCategoryVolume(categoryValue: string | AdvSoundDescriptor | null | undefined, nextVolume: number): void {
    const category = categoryKey(categoryValue);
    if (!category) return;
    const previous = this.userCategoryVolumes.get(category) ?? 1;
    const next = clampVolume(nextVolume, previous);
    if (next === previous) return;
    this.userCategoryVolumes.set(category, next);
    if (category === "Bgm") this.retargetBgmFades(previous, next);
    const entries: ManagedHowl[] = [];
    if (category === "Bgm" && this.bgm && !this.bgmFades.has(this.bgm)) entries.push(this.bgm);
    if (category === "Se") entries.push(...this.se);
    if (category === "Voice") entries.push(...this.voices);
    for (const entry of entries) this.applyEntryVolume(entry, 0);
  }

  stopTransientForSeek(): void {
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
    this.stopVoices();
    this.stopSe();
  }

  /** Stop old-scene audio before an asynchronous visual checkpoint restore. */
  suspendForSeek(): void {
    this.stopTransientForSeek();
    this.stopAllBgmImmediately();
  }

  createSnapshot(): AdvSoundSnapshot {
    let bgmPositionSeconds = 0;
    // BGM entries are looped and have no paused state in ADV. Howler's
    // `playing()` remains false while an HTML5 source is still loading, so it
    // cannot represent the authored intent at a just-executed Bgm boundary.
    const bgmPlaying = Boolean(this.bgm && !this.bgm.stopping);
    if (this.bgm) {
      try {
        bgmPositionSeconds = finiteSeconds(Number(this.bgm.howl.seek()), 0);
      } catch {}
    }
    return {
      bgm: clonePlain(this.bgm?.sound || null),
      bgmPositionSeconds,
      bgmPlaying,
      movieSoundVolume: this.movieSoundVolume,
      categoryVolumes: [...this.categoryVolumes.entries()],
      frameStamp: this.frameStamp,
      lastBgmOrSeFrame: this.lastBgmOrSeFrame,
      lastBgmLabel: this.lastBgmLabel,
      lastSeLabel: this.lastSeLabel,
    };
  }

  restoreSnapshot(snapshotValue: unknown) {
    const snapshot = snapshotValue as Partial<AdvSoundSnapshot> | null;
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
    this.stopVoices();
    this.stopSe();
    this.movieSoundVolume = clampVolume(snapshot?.movieSoundVolume, 1);
    if (Array.isArray(snapshot?.categoryVolumes)) this.categoryVolumes = new Map(snapshot.categoryVolumes);
    // Restore through a dedicated path so the command-frame duplicate guard
    // cannot swallow BGM on a newly rebuilt player.
    this.stopAllBgmImmediately();
    if (snapshot?.bgm?.playableUrl) {
      const sound = clonePlain(snapshot.bgm);
      const entry = this.createEntry(sound, "Bgm", true);
      if (entry) {
        this.bgm = entry;
        this.state.audio.bgm = entry.label;
        entry.howl.volume(this.effectiveVolume(sound));
        entry.howlId = Number(entry.howl.play()) || 0;
        const position = finiteSeconds(snapshot.bgmPositionSeconds, 0);
        if (position > 0) {
          try {
            entry.howl.seek(position, entry.howlId || undefined);
          } catch {}
        }
        if (snapshot.bgmPlaying === false) {
          try {
            entry.howl.pause(entry.howlId || undefined);
          } catch {}
        }
      }
    }
    this.frameStamp = Math.max(0, Math.trunc(Number(snapshot?.frameStamp) || 0));
    this.lastBgmOrSeFrame = Number.isFinite(Number(snapshot?.lastBgmOrSeFrame))
      ? Math.trunc(Number(snapshot?.lastBgmOrSeFrame))
      : -1;
    this.lastBgmLabel = String(snapshot?.lastBgmLabel || "");
    this.lastSeLabel = String(snapshot?.lastSeLabel || "");
  }
}
