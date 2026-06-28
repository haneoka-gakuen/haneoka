import type { Song } from "~/types/archive";
import type { CompositeEntityVisual } from "~/types/compositeVisual";
import { displayTextFromUnknown, sameDisplayText, textOf, type DisplayText } from "~/types/displayText";

export interface AudioTrack {
  kind: "song";
  /** Queue-occurrence identity. It allows a playlist to contain the same song more than once. */
  queueId?: string;
  /** Catalog namespace that owns the song metadata and detail route. */
  catalogSource: string;
  /** Optional stable source page for queues assembled outside a song catalog. */
  detailPath?: string;
  id: number;
  title: DisplayText;
  band: DisplayText;
  bandId?: number;
  bandIcon?: string;
  /** Serializable band/guest artwork used by composite credit surfaces. */
  bandVisuals?: CompositeEntityVisual[];
  cover: string;
  source: string;
}

export type AudioRepeatMode = "off" | "all" | "one";
export type AudioPlaybackMode = "sequential" | "repeat-all" | "repeat-one" | "shuffle";

interface AudioPlayerSnapshot {
  queue: AudioTrack[];
  currentIndex: number;
  currentTime: number;
  duration: number;
  volume: number;
  playbackMode?: AudioPlaybackMode;
  /** Legacy v1 fields retained for backwards-compatible local-storage migration. */
  shuffle: boolean;
  repeatMode: AudioRepeatMode;
  shuffleOrder: string[];
  collapsed: boolean;
}

const STORAGE_KEY = "haneoka:audio:v1";

let audio: HTMLAudioElement | null = null;
let bound = false;
let initialized = false;
let pendingSeek: number | null = null;
let persistSnapshot: (() => void) | undefined;
let queueOccurrenceSequence = 0;

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
const trackCatalogKey = (track: Pick<AudioTrack, "catalogSource" | "id">) => `${track.catalogSource}\u0000${track.id}`;
const trackKey = (track: AudioTrack) =>
  track.queueId ? `queue\u0000${track.queueId}` : `${trackCatalogKey(track)}\u0000${track.source}`;
const queueOccurrenceId = (index: number) => {
  queueOccurrenceSequence += 1;
  if (import.meta.client && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${index.toString(36)}-${queueOccurrenceSequence.toString(36)}`;
};

const normalizeTrackVisuals = (value: unknown): CompositeEntityVisual[] => {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const entry = candidate as CompositeEntityVisual;
    const image = typeof entry.image === "string" ? entry.image : "";
    const imageCandidates = Array.isArray(entry.imageCandidates)
      ? entry.imageCandidates.filter(
          (candidate): candidate is string => typeof candidate === "string" && Boolean(candidate),
        )
      : [];
    const text = typeof entry.text === "string" ? entry.text : "";
    const icon = typeof entry.icon === "string" ? entry.icon : "";
    if (!image && !text && !icon) return [];
    const fit = entry.fit === "cover" || entry.fit === "contain" ? entry.fit : undefined;
    return [
      {
        ...(image ? { image } : {}),
        ...(imageCandidates.length ? { imageCandidates } : {}),
        ...(text ? { text } : {}),
        ...(typeof entry.lang === "string" && entry.lang ? { lang: entry.lang } : {}),
        ...(icon ? { icon } : {}),
        ...(fit ? { fit } : {}),
        ...(typeof entry.color === "string" && entry.color ? { color: entry.color } : {}),
      },
    ];
  });
};

const sameTrackVisuals = (
  left: readonly CompositeEntityVisual[] | undefined,
  right: readonly CompositeEntityVisual[] | undefined,
): boolean => {
  const leftItems = left || [];
  const rightItems = right || [];
  return (
    leftItems.length === rightItems.length &&
    leftItems.every((item, index) => {
      const other = rightItems[index];
      return (
        item.image === other?.image &&
        JSON.stringify(item.imageCandidates || []) === JSON.stringify(other?.imageCandidates || []) &&
        item.text === other?.text &&
        item.lang === other?.lang &&
        item.icon === other?.icon &&
        item.fit === other?.fit &&
        item.color === other?.color
      );
    })
  );
};

const normalizeTrack = (value: unknown): AudioTrack | null => {
  if (!value || typeof value !== "object") return null;
  if ((value as AudioTrack).kind !== "song") return null;
  const source = String((value as AudioTrack).source || "");
  const id = Number((value as AudioTrack).id);
  if (!source || !Number.isFinite(id)) return null;
  const bandVisuals = normalizeTrackVisuals((value as AudioTrack).bandVisuals);
  return {
    kind: "song",
    queueId: typeof (value as AudioTrack).queueId === "string" ? (value as AudioTrack).queueId : undefined,
    catalogSource: String((value as Partial<AudioTrack>).catalogSource || "catalog"),
    detailPath: typeof (value as AudioTrack).detailPath === "string" ? (value as AudioTrack).detailPath : undefined,
    id,
    title: displayTextFromUnknown((value as AudioTrack).title, `#${id}`),
    band: displayTextFromUnknown((value as AudioTrack).band),
    bandId: Number.isFinite(Number((value as AudioTrack).bandId)) ? Number((value as AudioTrack).bandId) : undefined,
    bandIcon: String((value as AudioTrack).bandIcon || ""),
    ...(bandVisuals.length ? { bandVisuals } : {}),
    cover: String((value as AudioTrack).cover || ""),
    source,
  };
};

const uniqueTracks = (values: readonly AudioTrack[]): AudioTrack[] => {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const track = normalizeTrack(value);
    if (!track || seen.has(trackKey(track))) return [];
    seen.add(trackKey(track));
    return [track];
  });
};

const shuffled = <T>(values: readonly T[]): T[] => {
  const output = [...values];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [output[index], output[target]] = [output[target], output[index]];
  }
  return output;
};

export const audioTrackFromSong = (
  song: Song,
  title: DisplayText,
  band: DisplayText,
  bandIcon = "",
  bandId = Number(song.bandId || 0),
  bandVisuals: readonly CompositeEntityVisual[] = [],
  catalogSource = "catalog",
): AudioTrack | null => {
  if (!song.musicUrl) return null;
  const normalizedVisuals = normalizeTrackVisuals(bandVisuals);
  return {
    kind: "song",
    catalogSource,
    id: song.musicId,
    title,
    band,
    bandId,
    bandIcon,
    ...(normalizedVisuals.length ? { bandVisuals: normalizedVisuals } : {}),
    cover: song.jacketUrl || song.jacketThumbUrl || "",
    source: song.musicUrl,
  };
};

export const useAudioPlayer = () => {
  const queue = useState<AudioTrack[]>("audio-queue", () => []);
  const currentIndex = useState("audio-current-index", () => -1);
  const playing = useState("audio-playing", () => false);
  const currentTime = useState("audio-current-time", () => 0);
  const duration = useState("audio-duration", () => 0);
  const volume = useState("audio-volume", () => 0.82);
  const playbackMode = useState<AudioPlaybackMode>("audio-playback-mode", () => "repeat-all");
  const shuffle = computed(() => playbackMode.value === "shuffle");
  const repeatMode = computed<AudioRepeatMode>(() =>
    playbackMode.value === "repeat-one" ? "one" : playbackMode.value === "repeat-all" ? "all" : "off",
  );
  const shuffleOrder = useState<string[]>("audio-shuffle-order", () => []);
  const collapsed = useState("audio-collapsed", () => false);
  const track = computed(() => queue.value[currentIndex.value] || null);

  const reconcileShuffleOrder = () => {
    if (playbackMode.value !== "shuffle") {
      shuffleOrder.value = [];
      return;
    }
    const keys = queue.value.map(trackKey);
    const available = new Set(keys);
    const present = shuffleOrder.value.filter(
      (key, index, values) => available.has(key) && values.indexOf(key) === index,
    );
    const known = new Set(present);
    shuffleOrder.value = [...present, ...keys.filter((key) => !known.has(key))];
  };

  const indexForKey = (key: string) => queue.value.findIndex((item) => trackKey(item) === key);

  const updateMediaSession = () => {
    if (!import.meta.client || !("mediaSession" in navigator) || !("MediaMetadata" in window) || !track.value) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: textOf(track.value.title),
      artist: textOf(track.value.band),
      artwork: track.value.cover ? [{ src: track.value.cover }] : [],
    });
  };

  function bind() {
    if (!import.meta.client) return null;
    audio ||= new Audio();
    audio.preload = "metadata";
    audio.volume = volume.value;
    if (bound) return audio;

    audio.addEventListener("timeupdate", () => {
      currentTime.value = audio?.currentTime || 0;
    });
    audio.addEventListener("durationchange", () => {
      duration.value = Number.isFinite(audio?.duration) ? audio?.duration || 0 : 0;
      persistSnapshot?.();
    });
    audio.addEventListener("loadedmetadata", () => {
      if (!audio || pendingSeek == null) return;
      audio.currentTime = clamp(pendingSeek, 0, Number.isFinite(audio.duration) ? audio.duration : pendingSeek);
      currentTime.value = audio.currentTime;
      pendingSeek = null;
    });
    audio.addEventListener("play", () => {
      playing.value = true;
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    });
    audio.addEventListener("pause", () => {
      playing.value = false;
      persistSnapshot?.();
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
    });
    audio.addEventListener("ended", () => {
      playing.value = false;
      void handleEnded();
    });

    if ("mediaSession" in navigator) {
      try {
        navigator.mediaSession.setActionHandler("play", () => void play());
        navigator.mediaSession.setActionHandler("pause", pause);
        navigator.mediaSession.setActionHandler("previoustrack", () => void playPrevious());
        navigator.mediaSession.setActionHandler("nexttrack", () => void advanceNext(false));
        navigator.mediaSession.setActionHandler("seekto", (details) => {
          if (details.seekTime != null) seek(details.seekTime);
        });
      } catch {
        // Some engines expose Media Session but implement only part of its actions.
      }
    }

    bound = true;
    return audio;
  }

  const prepareCurrent = (reset: boolean, create = true) => {
    const element = create ? bind() : audio;
    const current = track.value;
    if (!element || !current) return element;

    if (element.dataset.haneokaSource !== current.source) {
      pendingSeek = reset ? 0 : currentTime.value;
      duration.value = 0;
      if (reset) currentTime.value = 0;
      element.dataset.haneokaSource = current.source;
      element.src = current.source;
      element.load();
    } else if (reset) {
      pendingSeek = null;
      element.currentTime = 0;
      currentTime.value = 0;
    }
    element.volume = volume.value;
    updateMediaSession();
    return element;
  };

  const selectIndex = (index: number, reset = true) => {
    if (!queue.value.length) return false;
    const nextIndex = clamp(Math.trunc(index), 0, queue.value.length - 1);
    const sourceChanged = track.value?.source !== queue.value[nextIndex]?.source;
    if (reset && sourceChanged) {
      currentTime.value = 0;
      duration.value = 0;
      pendingSeek = 0;
    }
    currentIndex.value = nextIndex;
    prepareCurrent(reset && sourceChanged, false);
    persistSnapshot?.();
    return true;
  };

  async function play() {
    if (!track.value) return;
    const element = prepareCurrent(false);
    if (!element) return;
    try {
      await element.play();
    } catch {
      playing.value = false;
    }
  }

  function pause() {
    audio?.pause();
  }

  const toggle = async () => {
    if (playing.value) pause();
    else await play();
  };

  const playAt = async (index: number) => {
    if (!selectIndex(index)) return;
    await play();
  };

  async function advanceNext(automatic: boolean) {
    if (!queue.value.length) return;
    if (automatic && playbackMode.value === "repeat-one") {
      seek(0);
      await play();
      return;
    }

    let nextIndex = -1;
    if (playbackMode.value === "shuffle") {
      reconcileShuffleOrder();
      const currentKey = track.value ? trackKey(track.value) : "";
      const position = shuffleOrder.value.indexOf(currentKey);
      const nextKey = shuffleOrder.value[position + 1];
      if (nextKey) nextIndex = indexForKey(nextKey);
      else {
        const nextOrder = shuffled(queue.value.map(trackKey).filter((key) => key !== currentKey));
        shuffleOrder.value = [currentKey, ...nextOrder].filter(Boolean);
        nextIndex = indexForKey(nextOrder[0] || currentKey);
      }
    } else if (currentIndex.value + 1 < queue.value.length) nextIndex = currentIndex.value + 1;
    else if (!automatic || playbackMode.value === "repeat-all") nextIndex = 0;

    const restartCurrent = nextIndex === currentIndex.value;
    if (nextIndex < 0 || !selectIndex(nextIndex)) return;
    if (restartCurrent) seek(0);
    await play();
  }

  const playNext = () => advanceNext(false);

  async function playPrevious() {
    if (!queue.value.length) return;
    let previousIndex = -1;
    if (playbackMode.value === "shuffle") {
      reconcileShuffleOrder();
      const currentKey = track.value ? trackKey(track.value) : "";
      const position = shuffleOrder.value.indexOf(currentKey);
      const previousKey = shuffleOrder.value[position > 0 ? position - 1 : shuffleOrder.value.length - 1];
      if (previousKey) previousIndex = indexForKey(previousKey);
    } else previousIndex = currentIndex.value > 0 ? currentIndex.value - 1 : queue.value.length - 1;

    const restartCurrent = previousIndex === currentIndex.value;
    if (previousIndex < 0 || !selectIndex(previousIndex)) return;
    if (restartCurrent) seek(0);
    await play();
  }

  async function handleEnded() {
    await advanceNext(true);
  }

  const playInsertedNext = async (value: AudioTrack) => {
    const next = normalizeTrack(value);
    if (!next) return;
    const currentKey = track.value ? trackCatalogKey(track.value) : "";
    const nextKey = trackCatalogKey(next);

    if (currentKey === nextKey && currentIndex.value >= 0) {
      queue.value = queue.value.map((item, index) =>
        index === currentIndex.value ? { ...next, ...(item.queueId ? { queueId: item.queueId } : {}) } : item,
      );
      updateMediaSession();
      persistSnapshot?.();
      await play();
      return;
    }

    let preservedCurrentIndex = currentIndex.value;
    const nextQueue = [...queue.value];
    const existingIndex = queue.value.findIndex((item) => trackCatalogKey(item) === trackCatalogKey(next));
    if (existingIndex >= 0) {
      nextQueue.splice(existingIndex, 1);
      if (existingIndex < preservedCurrentIndex) preservedCurrentIndex -= 1;
    }

    const nextIndex = preservedCurrentIndex >= 0 ? preservedCurrentIndex + 1 : 0;
    nextQueue.splice(nextIndex, 0, next);
    queue.value = nextQueue;
    currentIndex.value = nextIndex;
    currentTime.value = 0;
    duration.value = 0;
    pendingSeek = 0;
    reconcileShuffleOrder();
    prepareCurrent(true, false);
    persistSnapshot?.();
    await play();
  };

  const reconcileQueue = (tracks: readonly AudioTrack[]) => {
    const currentSource = track.value?.source;
    const wasPlaying = playing.value;
    const canonical = new Map(
      tracks.flatMap((value) => {
        const normalized = normalizeTrack(value);
        return normalized ? [[trackCatalogKey(normalized), normalized] as const] : [];
      }),
    );
    let changed = false;
    const nextQueue = queue.value.map((item) => {
      const canonicalTrack = canonical.get(trackCatalogKey(item));
      const next = canonicalTrack
        ? { ...canonicalTrack, ...(item.queueId ? { queueId: item.queueId } : {}) }
        : undefined;
      if (!next) return item;
      if (
        sameDisplayText(item.title, next.title) &&
        sameDisplayText(item.band, next.band) &&
        item.bandId === next.bandId &&
        item.bandIcon === next.bandIcon &&
        sameTrackVisuals(item.bandVisuals, next.bandVisuals) &&
        item.cover === next.cover &&
        item.catalogSource === next.catalogSource &&
        item.detailPath === next.detailPath &&
        item.source === next.source
      ) {
        return item;
      }
      changed = true;
      return next;
    });
    if (!changed) return;

    queue.value = nextQueue;
    reconcileShuffleOrder();
    const sourceChanged = currentSource !== track.value?.source;
    prepareCurrent(sourceChanged, false);
    if (sourceChanged && wasPlaying) void play();
    else updateMediaSession();
    persistSnapshot?.();
  };

  const playSong = async (
    song: Song,
    title: DisplayText,
    band: DisplayText,
    bandIcon = "",
    bandId = Number(song.bandId || 0),
    bandVisuals: readonly CompositeEntityVisual[] = [],
    catalogSource = "catalog",
  ) => {
    const next = audioTrackFromSong(song, title, band, bandIcon, bandId, bandVisuals, catalogSource);
    if (next) await playInsertedNext(next);
  };

  const playQueue = async (values: readonly AudioTrack[], startIndex = 0) => {
    const nextQueue = values.flatMap((value, index) => {
      const normalized = normalizeTrack(value);
      return normalized ? [{ ...normalized, queueId: normalized.queueId || queueOccurrenceId(index) }] : [];
    });
    if (!nextQueue.length) return;

    pause();
    queue.value = nextQueue;
    currentIndex.value = clamp(Math.trunc(startIndex), 0, nextQueue.length - 1);
    currentTime.value = 0;
    duration.value = 0;
    pendingSeek = 0;
    if (playbackMode.value === "shuffle") {
      const currentKey = track.value ? trackKey(track.value) : "";
      shuffleOrder.value = [
        currentKey,
        ...shuffled(queue.value.map(trackKey).filter((key) => key !== currentKey)),
      ].filter(Boolean);
    } else shuffleOrder.value = [];
    prepareCurrent(true, false);
    persistSnapshot?.();
    await play();
  };

  const removeFromQueue = async (index: number) => {
    if (index < 0 || index >= queue.value.length) return;
    const removingCurrent = index === currentIndex.value;
    const shouldResume = removingCurrent && playing.value;
    const nextQueue = queue.value.filter((_, itemIndex) => itemIndex !== index);
    if (!nextQueue.length) {
      clearQueue();
      return;
    }

    queue.value = nextQueue;
    if (index < currentIndex.value) currentIndex.value -= 1;
    else if (removingCurrent) currentIndex.value = Math.min(index, nextQueue.length - 1);
    reconcileShuffleOrder();
    if (removingCurrent) {
      currentTime.value = 0;
      duration.value = 0;
      pendingSeek = 0;
      prepareCurrent(true, false);
    }
    persistSnapshot?.();
    if (shouldResume) await play();
  };

  const moveQueueItem = (fromIndex: number, toIndex: number) => {
    if (!queue.value.length) return;
    const from = Math.trunc(fromIndex);
    const to = Math.trunc(toIndex);
    if (from < 0 || from >= queue.value.length || to < 0 || to >= queue.value.length || from === to) return;

    const currentKey = track.value ? trackKey(track.value) : "";
    const nextQueue = [...queue.value];
    const [moved] = nextQueue.splice(from, 1);
    if (!moved) return;
    nextQueue.splice(to, 0, moved);
    queue.value = nextQueue;
    currentIndex.value = currentKey ? indexForKey(currentKey) : -1;
    reconcileShuffleOrder();
    persistSnapshot?.();
  };

  function clearQueue() {
    audio?.pause();
    if (audio) {
      audio.removeAttribute("src");
      delete audio.dataset.haneokaSource;
      audio.load();
    }
    queue.value = [];
    currentIndex.value = -1;
    currentTime.value = 0;
    duration.value = 0;
    playing.value = false;
    shuffleOrder.value = [];
    pendingSeek = null;
    if (import.meta.client && "mediaSession" in navigator) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
    }
    persistSnapshot?.();
  }

  function seek(value: number) {
    const next = clamp(Number(value) || 0, 0, duration.value || Number(value) || 0);
    currentTime.value = next;
    pendingSeek = next;
    if (audio?.dataset.haneokaSource === track.value?.source) {
      audio.currentTime = next;
      pendingSeek = null;
    }
    persistSnapshot?.();
  }

  const setVolume = (value: number) => {
    volume.value = clamp(Number(value) || 0, 0, 1);
    if (audio) audio.volume = volume.value;
    persistSnapshot?.();
  };

  const setPlaybackMode = (value: AudioPlaybackMode) => {
    playbackMode.value = value;
    if (value === "shuffle") {
      const currentKey = track.value ? trackKey(track.value) : "";
      shuffleOrder.value = [
        currentKey,
        ...shuffled(queue.value.map(trackKey).filter((key) => key !== currentKey)),
      ].filter(Boolean);
    } else shuffleOrder.value = [];
    persistSnapshot?.();
  };

  const cyclePlaybackMode = () => {
    const nextMode: Record<AudioPlaybackMode, AudioPlaybackMode> = {
      sequential: "repeat-all",
      "repeat-all": "repeat-one",
      "repeat-one": "shuffle",
      shuffle: "sequential",
    };
    setPlaybackMode(nextMode[playbackMode.value]);
  };

  if (import.meta.client && !initialized) {
    initialized = true;
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Partial<AudioPlayerSnapshot> | null;
      if (parsed) {
        queue.value = uniqueTracks(Array.isArray(parsed.queue) ? parsed.queue : []);
        currentIndex.value = queue.value.length
          ? clamp(Math.trunc(Number(parsed.currentIndex) || 0), 0, queue.value.length - 1)
          : -1;
        currentTime.value = Math.max(0, Number(parsed.currentTime) || 0);
        duration.value = Math.max(0, Number(parsed.duration) || 0);
        const storedVolume = Number(parsed.volume);
        volume.value = Number.isFinite(storedVolume) ? clamp(storedVolume, 0, 1) : 0.82;
        const storedMode = String(parsed.playbackMode || "");
        playbackMode.value = (
          ["sequential", "repeat-all", "repeat-one", "shuffle"].includes(storedMode)
            ? storedMode
            : parsed.shuffle
              ? "shuffle"
              : parsed.repeatMode === "all"
                ? "repeat-all"
                : parsed.repeatMode === "one"
                  ? "repeat-one"
                  : "repeat-all"
        ) as AudioPlaybackMode;
        shuffleOrder.value = Array.isArray(parsed.shuffleOrder) ? parsed.shuffleOrder.map(String) : [];
        collapsed.value = Boolean(parsed.collapsed);
        reconcileShuffleOrder();
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }

    persistSnapshot = () => {
      const snapshot: AudioPlayerSnapshot = {
        queue: queue.value,
        currentIndex: currentIndex.value,
        currentTime: currentTime.value,
        duration: duration.value,
        volume: volume.value,
        playbackMode: playbackMode.value,
        shuffle: shuffle.value,
        repeatMode: repeatMode.value,
        shuffleOrder: shuffleOrder.value,
        collapsed: collapsed.value,
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        return;
      }
    };
    watch([queue, currentIndex, volume, playbackMode, shuffleOrder, collapsed], () => persistSnapshot?.(), {
      deep: true,
    });
    window.addEventListener("pagehide", () => persistSnapshot?.());
  }

  return {
    track,
    queue,
    currentIndex,
    playing,
    currentTime,
    duration,
    volume,
    playbackMode,
    shuffle,
    repeatMode,
    collapsed,
    play,
    pause,
    toggle,
    playSong,
    playQueue,
    playAt,
    playNext,
    playPrevious,
    reconcileQueue,
    removeFromQueue,
    moveQueueItem,
    clearQueue,
    seek,
    setVolume,
    setPlaybackMode,
    cyclePlaybackMode,
  };
};
export const formatDuration = (value: number | null | undefined): string => {
  const seconds = Math.max(0, Math.round(value || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
