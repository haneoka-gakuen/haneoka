import { audioTrackKey } from "../../lib/audio-track-key";
import { observeSongDisplay, songTitle } from "../../lib/song-display";
import { resolveLocalizedText } from "../../lib/localized-text";
import { LitElement, html, nothing, render } from "lit";
import "../../styles/audio.css";
import { iconButton } from "../ui/controls";
import { icon } from "../ui/icon";
import { wavyProgress } from "../ui/wavy-progress";
import { trapFocus } from "../../lib/overlay";
import { preferredLocale, uiText } from "../shared/catalog";

export interface AudioTrack {
  id: string;
  songKey?: string;
  queueId?: string;
  title: string;
  titleSource?: unknown;
  artistSource?: unknown;
  titleLanguage?: string;
  artist: string;
  cover: string;
  url: string;
  detailPath?: string;
}

type PlaybackMode = "sequential" | "repeat-all" | "repeat-one" | "shuffle";
interface Snapshot {
  queue: AudioTrack[];
  index: number;
  currentTime: number;
  volume: number;
  mode: PlaybackMode;
  collapsed: boolean;
}

const STORAGE_KEY = "haneoka:audio:v2";
const compactQuery = typeof matchMedia === "function" ? matchMedia("(max-width: 599px)") : ({ matches: false } as MediaQueryList);
const MODES: readonly PlaybackMode[] = ["sequential", "repeat-all", "repeat-one", "shuffle"];
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
const normalizedTrack = (value: AudioTrack, occurrence = 0): AudioTrack | null => {
  const id = String(value?.id || "");
  const url = String(value?.url || "");
  if (!id || !url) return null;
  return {
    id,
    songKey: audioTrackKey({ id, url, songKey: typeof value.songKey === "string" ? value.songKey : undefined }),
    queueId: value.queueId || `${id}:${occurrence}:${url}`,
    title: String(value.title || id),
    titleSource: value.titleSource,
    artistSource: value.artistSource,
    titleLanguage: value.titleLanguage,
    artist: String(value.artist || ""),
    cover: String(value.cover || ""),
    url,
    ...(value.detailPath ? { detailPath: String(value.detailPath) } : {}),
  };
};

export class AudioDock extends LitElement {
  private uiLanguage = preferredLocale();
  private readonly onLocale = () => {
    this.uiLanguage = preferredLocale();
    this.refreshLabels();
  };
  private disposeSongDisplay?: () => void;
  private refreshLabels() {
    this.queue = this.queue.map((track) => {
      const title =
        track.titleSource == null
          ? { text: track.title, locale: track.titleLanguage || this.uiLanguage }
          : songTitle({ title: track.titleSource }, this.uiLanguage);
      return {
        ...track,
        title: title.text,
        titleLanguage: title.locale,
        artist:
          track.artistSource == null ? track.artist : resolveLocalizedText(track.artistSource, this.uiLanguage).text,
      };
    });
    if (this.track) this.updateMetadata(this.track);
  }
  private updateMetadata(track: AudioTrack) {
    if ("mediaSession" in navigator && "MediaMetadata" in window)
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        artwork: track.cover ? [{ src: track.cover }] : [],
      });
  }
  private t(key: string): string {
    return uiText(this.uiLanguage, key);
  }
  static properties = {
    queue: { state: true },
    index: { state: true },
    playing: { state: true },
    currentTime: { state: true },
    duration: { state: true },
    volume: { state: true },
    queueOpen: { state: true },
    collapsed: { state: true },
    mode: { state: true },
    draggedIndex: { state: true },
    dropIndex: { state: true },
  };
  declare queue: AudioTrack[];
  declare index: number;
  declare playing: boolean;
  declare currentTime: number;
  declare duration: number;
  declare volume: number;
  declare queueOpen: boolean;
  declare collapsed: boolean;
  declare mode: PlaybackMode;
  declare draggedIndex: number;
  declare dropIndex: number;
  private audio = new Audio();
  private playbackGeneration = 0;
  private restoredTime = 0;
  private inertTargets = new Set<HTMLElement>();
  private dockObserver?: ResizeObserver;
  private observedDock?: HTMLElement;
  private queuePanel?: HTMLElement;
  private releaseQueueFocus?: () => void;
  private afterNavigation = () => {
    this.observedDock = undefined;
    // The shell (and the rail/app-bar slots the collapsed player lives in)
    // is swapped on every page.
    queueMicrotask(() => this.syncCollapsedSlots());
    // The compact full player is a sheet over the page it was opened on;
    // arriving somewhere new (often through its own title link) folds it.
    if (compactQuery.matches && !this.collapsed) {
      this.collapsed = true;
      this.persist();
    }
    this.requestUpdate();
  };
  private sheetDrag?: { pointer: number; startY: number; dy: number };

  constructor() {
    super();
    this.queue = [];
    this.index = -1;
    this.playing = false;
    this.currentTime = 0;
    this.duration = 0;
    this.volume = 0.82;
    this.queueOpen = false;
    this.collapsed = false;
    this.mode = "repeat-all";
    this.draggedIndex = -1;
    this.dropIndex = -1;
    this.audio.preload = "metadata";
    this.restore();
    this.audio.volume = this.volume;
    this.observeAudio(this.audio);
  }

  private observeAudio(audio: HTMLAudioElement) {
    const active = () => audio === this.audio && Boolean(this.track);
    audio.addEventListener("play", () => {
      if (!active() || audio.paused) return;
      this.playing = true;
      this.emitState();
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    });
    audio.addEventListener("pause", () => {
      if (!active() || !audio.paused) return;
      this.playing = false;
      this.persist();
      this.emitState();
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
    });
    audio.addEventListener("timeupdate", () => {
      if (active()) this.currentTime = audio.currentTime || 0;
    });
    audio.addEventListener("durationchange", () => {
      if (active()) this.duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    });
    audio.addEventListener("loadedmetadata", () => {
      if (!active()) return;
      if (this.restoredTime > 0) {
        audio.currentTime = clamp(this.restoredTime, 0, this.duration || this.restoredTime);
        this.currentTime = audio.currentTime;
        this.restoredTime = 0;
      }
    });
    audio.addEventListener("ended", () => {
      if (active() && audio.ended) void this.next(true);
    });
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.disposeSongDisplay = observeSongDisplay(() => this.refreshLabels());
    void import("@material/web/slider/slider.js");
    addEventListener("haneoka:locale-ready", this.onLocale);
    this.onLocale();
    addEventListener("pagehide", this.persistBound);
    document.addEventListener("astro:after-swap", this.afterNavigation);
    addEventListener("popstate", this.onPopState);
    addEventListener("keydown", this.onKeydown);
    if (this.track) void this.prepare(false, false);
    if ("mediaSession" in navigator) {
      try {
        navigator.mediaSession.setActionHandler("play", () => {
          if (this.track && this.audio.paused) void this.togglePlayback();
        });
        navigator.mediaSession.setActionHandler("pause", () => this.audio.pause());
        navigator.mediaSession.setActionHandler("stop", () => this.clearQueue());
        navigator.mediaSession.setActionHandler("previoustrack", () => void this.previous());
        navigator.mediaSession.setActionHandler("nexttrack", () => void this.next());
        navigator.mediaSession.setActionHandler("seekto", (details) => {
          if (details.seekTime != null) this.seek(details.seekTime);
        });
      } catch {
        /* A browser may expose only part of Media Session. */
      }
    }
  }

  disconnectedCallback() {
    this.disposeSongDisplay?.();
    removeEventListener("haneoka:locale-ready", this.onLocale);
    removeEventListener("pagehide", this.persistBound);
    document.removeEventListener("astro:after-swap", this.afterNavigation);
    this.releaseQueueFocus?.();
    this.releaseQueueFocus = undefined;
    this.queuePanel = undefined;
    removeEventListener("popstate", this.onPopState);
    removeEventListener("keydown", this.onKeydown);
    this.setOverlayIsolation(false);
    this.dockObserver?.disconnect();
    this.observedDock = undefined;
    document.documentElement.style.removeProperty("--audio-dock-height");
    document.documentElement.style.removeProperty("--audio-dock-clearance");
    for (const slot of document.querySelectorAll<HTMLElement>("[data-nav-player], [data-app-bar-player]"))
      render(nothing, slot);
    this.persist();
    super.disconnectedCallback();
  }

  updated() {
    this.syncCollapsedSlots();
    const panel = this.queueOpen ? this.querySelector<HTMLElement>(".audio-queue-panel") : null;
    if (panel !== (this.queuePanel ?? null)) {
      this.releaseQueueFocus?.();
      this.queuePanel = panel ?? undefined;
      this.releaseQueueFocus = panel ? trapFocus(panel, { onDismiss: () => this.closeOverlay() }) : undefined;
    }
    const dock = this.querySelector<HTMLElement>(".player");
    if (dock === this.observedDock) return;
    this.dockObserver?.disconnect();
    this.observedDock = dock || undefined;
    if (!dock) {
      document.documentElement.style.removeProperty("--audio-dock-height");
      document.documentElement.style.removeProperty("--audio-dock-clearance");
      return;
    }
    // The pane reserves room for the docked player so it never covers the
    // last row of a page. The compact expanded player is a sheet over the
    // page, so there only the mini player's height is reserved.
    // The full player is docked: the pane reserves its height so it never
    // covers the page. Collapsed, the player is not at the bottom at all (it
    // lives in the rail / app bar), and the compact full player is a sheet
    // over the page, so neither reserves anything.
    const publishHeight = () => {
      if (dock !== this.observedDock || !this.track) return;
      const root = document.documentElement.style;
      const docked = dock.dataset.state === "full" && !compactQuery.matches;
      root.setProperty("--audio-dock-height", docked ? `${Math.ceil(dock.offsetHeight) + 16}px` : "0px");
      root.setProperty("--audio-dock-clearance", "0px");
    };
    publishHeight();
    this.dockObserver = new ResizeObserver(publishHeight);
    this.dockObserver.observe(dock);
  }

  get track() {
    return this.queue[this.index];
  }

  async playTrack(track: AudioTrack, queue: AudioTrack[]) {
    const normalizedQueue = (queue.length ? queue : [track]).flatMap((entry, occurrence) => {
      const normalized = normalizedTrack(entry, occurrence);
      return normalized ? [normalized] : [];
    });
    const requested = normalizedTrack(track);
    if (!requested || !normalizedQueue.length) return;
    if (this.track?.id === requested.id && this.track.url === requested.url) {
      await this.togglePlayback();
      return;
    }
    this.audio.pause();
    this.queue = normalizedQueue;
    this.index = Math.max(
      0,
      this.queue.findIndex((entry) => entry.id === requested.id && entry.url === requested.url),
    );
    // A new track always surfaces the player: the docked bar on wider
    // windows, the mini player on compact ones (the full sheet would cover
    // the list the reader is choosing from).
    this.collapsed = compactQuery.matches;
    this.currentTime = 0;
    this.duration = 0;
    await this.prepare(true);
  }

  async enqueueTrack(track: AudioTrack, playAdded = false) {
    const requested = normalizedTrack(track, this.queue.length);
    if (!requested) return;
    const key = audioTrackKey(requested);
    const existing =
      this.track && audioTrackKey(this.track) === key
        ? this.index
        : this.queue.findIndex((entry) => audioTrackKey(entry) === key);
    if (existing >= 0) {
      const changed = this.index !== existing;
      this.index = existing;
      await this.prepare(changed, true);
      this.emitState();
      return;
    }
    this.queue = [...this.queue, requested];
    if (this.index < 0) {
      this.index = 0;
      await this.prepare(true, playAdded);
    } else if (playAdded) {
      this.index = this.queue.length - 1;
      await this.prepare(true, true);
    } else this.persist();
    this.emitState();
  }

  private restore() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Partial<Snapshot> | null;
      if (!parsed) return;
      this.queue = (Array.isArray(parsed.queue) ? parsed.queue : []).flatMap((entry, occurrence) => {
        const normalized = normalizedTrack(entry, occurrence);
        return normalized ? [normalized] : [];
      });
      this.index = this.queue.length ? clamp(Math.trunc(Number(parsed.index) || 0), 0, this.queue.length - 1) : -1;
      this.restoredTime = Math.max(0, Number(parsed.currentTime) || 0);
      this.currentTime = this.restoredTime;
      this.volume = clamp(Number.isFinite(Number(parsed.volume)) ? Number(parsed.volume) : 0.82, 0, 1);
      this.mode = MODES.includes(parsed.mode as PlaybackMode) ? (parsed.mode as PlaybackMode) : "repeat-all";
      this.collapsed = Boolean(parsed.collapsed);
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  private persistBound = () => this.persist();
  private persist() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          queue: this.queue,
          index: this.index,
          currentTime: this.currentTime,
          volume: this.volume,
          mode: this.mode,
          collapsed: this.collapsed,
        } satisfies Snapshot),
      );
    } catch {
      /* Playback still works without storage. */
    }
  }

  private async prepare(reset: boolean, shouldPlay = true) {
    const track = this.track;
    if (!track) return;
    const generation = ++this.playbackGeneration;
    const audio = this.audio;
    if (this.audio.dataset.haneokaSource !== track.url) {
      this.audio.dataset.haneokaSource = track.url;
      this.audio.src = track.url;
      this.audio.load();
    }
    if (reset) {
      this.restoredTime = 0;
      this.audio.currentTime = 0;
      this.currentTime = 0;
    }
    this.audio.volume = this.volume;
    this.updateMetadata(track);
    if (shouldPlay) await audio.play().catch(() => undefined);
    if (generation !== this.playbackGeneration || audio !== this.audio) return;
    this.persist();
  }

  private emitState() {
    dispatchEvent(
      new CustomEvent("haneoka-audio-state", { detail: { id: this.track?.id || "", playing: this.playing } }),
    );
  }
  private async select(index: number) {
    if (index >= 0 && index < this.queue.length) {
      this.index = index;
      await this.prepare(true);
    }
  }
  private randomIndex() {
    if (this.queue.length < 2) return this.index;
    let next = this.index;
    while (next === this.index) next = Math.floor(Math.random() * this.queue.length);
    return next;
  }
  private async next(automatic = false) {
    if (!this.queue.length) return;
    if (automatic && this.mode === "repeat-one") {
      this.seek(0);
      await this.audio.play().catch(() => undefined);
      return;
    }
    let nextIndex = this.index + 1;
    if (this.mode === "shuffle") nextIndex = this.randomIndex();
    else if (nextIndex >= this.queue.length) {
      if (automatic && this.mode === "sequential") {
        this.audio.pause();
        this.seek(0);
        return;
      }
      nextIndex = 0;
    }
    await this.select(nextIndex);
  }
  private async previous() {
    if (!this.queue.length) return;
    if (this.audio.currentTime > 3) {
      this.seek(0);
      return;
    }
    await this.select(
      this.mode === "shuffle" ? this.randomIndex() : (this.index - 1 + this.queue.length) % this.queue.length,
    );
  }
  private cycleMode() {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length] || "repeat-all";
    this.persist();
  }
  private seek(seconds: number) {
    if (!Number.isFinite(this.duration) || this.duration <= 0 || this.audio.readyState < 1) return;
    const value = clamp(Number(seconds) || 0, 0, this.duration);
    this.audio.currentTime = value;
    this.currentTime = value;
    this.persist();
  }
  private setVolume(value: number) {
    this.volume = clamp(Number(value) || 0, 0, 1);
    this.audio.volume = this.volume;
    this.persist();
  }

  private removeQueueItem(index: number) {
    if (index < 0 || index >= this.queue.length) return;
    const removingCurrent = index === this.index;
    const resume = removingCurrent && this.playing;
    const next = this.queue.filter((_, itemIndex) => itemIndex !== index);
    if (!next.length) {
      this.clearQueue();
      return;
    }
    this.queue = next;
    if (index < this.index) this.index -= 1;
    else if (removingCurrent) this.index = Math.min(index, next.length - 1);
    if (removingCurrent) void this.prepare(true, resume);
    this.persist();
  }

  private moveQueueItem(from: number, to: number) {
    if (from < 0 || to < 0 || from >= this.queue.length || to >= this.queue.length || from === to) return;
    const current = this.track?.queueId;
    const next = [...this.queue];
    const [item] = next.splice(from, 1);
    if (!item) return;
    next.splice(to, 0, item);
    this.queue = next;
    this.index = Math.max(
      0,
      next.findIndex((entry) => entry.queueId === current),
    );
    this.persist();
  }

  private clearQueue() {
    const returnFocus =
      this.contains(document.activeElement) ||
      Boolean(document.activeElement?.closest("[data-nav-player], [data-app-bar-player]"));
    if (history.state?.__haneoka_audio_overlay) {
      const { __haneoka_audio_overlay: _overlay, ...state } = history.state;
      history.replaceState(state, "", location.href);
    }
    ++this.playbackGeneration;
    // Retire the old element so its queued events and play promises cannot
    // change a player that is closed or has already started another track.
    const audio = this.audio;
    this.audio = new Audio();
    this.audio.preload = "metadata";
    this.audio.volume = this.volume;
    this.observeAudio(this.audio);
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    this.queue = [];
    this.index = -1;
    this.playing = false;
    this.restoredTime = 0;
    this.currentTime = 0;
    this.duration = 0;
    this.queueOpen = false;
    this.draggedIndex = -1;
    this.dropIndex = -1;
    this.sheetDrag = undefined;
    this.releaseQueueFocus?.();
    this.releaseQueueFocus = undefined;
    this.queuePanel = undefined;
    this.setOverlayIsolation(false);
    this.dockObserver?.disconnect();
    this.observedDock = undefined;
    document.documentElement.style.removeProperty("--audio-dock-height");
    document.documentElement.style.removeProperty("--audio-dock-clearance");
    this.syncCollapsedSlots();
    if (returnFocus) document.querySelector<HTMLElement>("#main-content")?.focus({ preventScroll: true });
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
      try {
        navigator.mediaSession.setPositionState();
      } catch {
        /* Position state is optional in Media Session. */
      }
    }
    this.persist();
    this.emitState();
  }

  private reorderByKeyboard(event: KeyboardEvent, index: number) {
    const target =
      event.key === "ArrowUp"
        ? index - 1
        : event.key === "ArrowDown"
          ? index + 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? this.queue.length - 1
              : -1;
    if (target < 0 || target >= this.queue.length) return;
    event.preventDefault();
    this.moveQueueItem(index, target);
    void this.updateComplete.then(() =>
      this.querySelector<HTMLButtonElement>(`[data-drag-index="${target}"]`)?.focus({ preventScroll: true }),
    );
  }
  private onPopState = () => {
    const overlay = this.track && history.state?.__haneoka_audio_overlay;
    this.queueOpen = overlay === "queue";
    this.setOverlayIsolation(Boolean(overlay));
  };
  private setOverlayIsolation(open: boolean) {
    if (!open) {
      this.inertTargets.forEach((target) => target.removeAttribute("inert"));
      this.inertTargets.clear();
      return;
    }
    document.querySelectorAll<HTMLElement>(".app-shell__body, .nav, .nav-bar, .player").forEach((target) => {
      if (target.hasAttribute("inert")) return;
      target.setAttribute("inert", "");
      this.inertTargets.add(target);
    });
  }
  private openOverlay(kind: "queue") {
    if (!this.track) return;
    if (history.state?.__haneoka_audio_overlay !== kind)
      history.pushState({ ...history.state, __haneoka_audio_overlay: kind }, "", location.href);
    this.queueOpen = true;
    this.setOverlayIsolation(true);
    void this.updateComplete.then(() => this.querySelector<HTMLElement>(".audio-queue-panel button")?.focus());
  }
  private closeOverlay() {
    this.queueOpen = false;
    this.setOverlayIsolation(false);
    if (history.state?.__haneoka_audio_overlay) history.back();
  }
  private format(value: number) {
    const seconds = Math.max(0, Math.floor(value || 0));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }

  pausePlayback() {
    this.audio.pause();
  }
  private async togglePlayback() {
    if (!this.track) return;
    const generation = this.playbackGeneration;
    const audio = this.audio;
    if (this.playing) this.audio.pause();
    else
      await audio.play().catch(() => {
        if (generation === this.playbackGeneration && audio === this.audio) this.playing = false;
      });
  }

  /**
   * Mini player ⇄ full player. The two are one surface, so the change is a
   * container transform: a same-document view transition morphs the
   * player's box on the spatial spring while the rest of the page holds
   * still (base styles turn the page's own transition off for it).
   */
  private setExpanded(expanded: boolean) {
    if (this.collapsed === !expanded) return;
    if (!expanded && this.queueOpen) this.closeOverlay();
    const root = document.documentElement;
    const apply = async () => {
      this.collapsed = !expanded;
      this.persist();
      await this.updateComplete;
    };
    const start = (document as Document & { startViewTransition?: (update: () => Promise<void>) => { finished: Promise<void> } }).startViewTransition;
    if (!start || matchMedia("(prefers-reduced-motion: reduce)").matches || root.dataset.playerTransition) {
      void apply().then(() => this.focusAfterToggle(expanded));
      return;
    }
    root.dataset.playerTransition = "true";
    const transition = start.call(document, apply);
    void transition.finished.finally(() => {
      delete root.dataset.playerTransition;
      this.focusAfterToggle(expanded);
    });
  }
  private focusAfterToggle(expanded: boolean) {
    const target = expanded
      ? this.querySelector<HTMLElement>(".player__collapse")
      : document.querySelector<HTMLElement>(
          compactQuery.matches ? "[data-app-bar-player] .now-playing" : "[data-nav-player] .now-playing__expand",
        );
    if (target && this.contains(document.activeElement)) target.focus({ preventScroll: true });
    else if (target && expanded && compactQuery.matches) target.focus({ preventScroll: true });
  }
  private collapsePlayer() {
    this.setExpanded(false);
  }
  private onKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || this.collapsed || this.queueOpen || !compactQuery.matches || !this.track) return;
    event.preventDefault();
    this.setExpanded(false);
  };
  /** The compact sheet follows a downward drag on its handle and collapses past a threshold. */
  private onSheetPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !compactQuery.matches) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.sheetDrag = { pointer: event.pointerId, startY: event.clientY, dy: 0 };
  };
  private onSheetPointerMove = (event: PointerEvent) => {
    const drag = this.sheetDrag;
    if (!drag || drag.pointer !== event.pointerId) return;
    drag.dy = Math.max(0, event.clientY - drag.startY);
    const sheet = this.querySelector<HTMLElement>(".player");
    if (sheet) {
      sheet.style.transition = "none";
      sheet.style.translate = `0 ${drag.dy}px`;
    }
  };
  private onSheetPointerUp = (event: PointerEvent) => {
    const drag = this.sheetDrag;
    if (!drag || drag.pointer !== event.pointerId) return;
    this.sheetDrag = undefined;
    const sheet = this.querySelector<HTMLElement>(".player");
    if (sheet) {
      sheet.style.removeProperty("transition");
      sheet.style.removeProperty("translate");
    }
    // A tap (no travel) is handled by the handle's click.
    if (drag.dy > 96) this.setExpanded(false);
  };

  private renderQueue() {
    if (!this.queueOpen) return nothing;
    return html`
      <button class="scrim" type="button" aria-label=${this.t("close")} @click=${this.closeOverlay}></button>
      <section class="audio-queue-panel" role="dialog" aria-modal="true" aria-label=${this.t("queue")}>
        <header>
          <span>
            <svg class="material-icon" width="19" height="19"><use href="/icons.svg#queue_music"></use></svg>
            <strong>${this.t("queue")}</strong>
            <small>${this.queue.length}</small>
          </span>
          <span>
            <button class="icon-button audio-queue-panel__skip" aria-label=${this.t("previous")} @click=${this.previous}>
              <svg class="material-icon" width="18" height="18"><use href="/icons.svg#skip_previous"></use></svg>
            </button>
            <button class="icon-button audio-queue-panel__skip" aria-label=${this.t("next")} @click=${() => this.next()}>
              <svg class="material-icon" width="18" height="18"><use href="/icons.svg#skip_next"></use></svg>
            </button>
            ${this.renderCloseButton("audio-queue-panel__clear")}
            <button class="icon-button" aria-label=${this.t("close")} @click=${this.closeOverlay}>
              <svg class="material-icon" width="18" height="18"><use href="/icons.svg#close"></use></svg>
            </button>
          </span>
        </header>
        <div class="audio-queue-panel__compact-actions">
          <button class="button button--text" type="button" @click=${this.cycleMode}>
            ${icon(this.modeIconName(), 20)}${this.modeLabel()}
          </button>
          <button class="button button--text" type="button" @click=${this.collapsePlayer}>
            ${icon("expand_more", 20)}${this.t("collapse")}
          </button>
        </div>
        <div class="audio-queue-panel__list">
          ${this.queue.map(
            (entry, index) => html`
              <article
                class=${`audio-queue-panel__row${index === this.index ? " selected" : ""}${index === this.dropIndex ? " drop-target" : ""}`}
                draggable="true"
                @dragstart=${(event: DragEvent) => {
                  this.draggedIndex = index;
                  event.dataTransfer?.setData("text/plain", String(index));
                }}
                @dragover=${(event: DragEvent) => {
                  event.preventDefault();
                  this.dropIndex = index;
                }}
                @drop=${(event: DragEvent) => {
                  event.preventDefault();
                  this.moveQueueItem(this.draggedIndex, index);
                  this.draggedIndex = -1;
                  this.dropIndex = -1;
                }}
                @dragend=${() => {
                  this.draggedIndex = -1;
                  this.dropIndex = -1;
                }}
              >
                <button
                  class="icon-button audio-queue-panel__drag"
                  data-drag-index=${index}
                  aria-label=${`${this.t("reorder")} · ${entry.title}`}
                  aria-keyshortcuts="ArrowUp ArrowDown Home End"
                  @keydown=${(event: KeyboardEvent) => this.reorderByKeyboard(event, index)}
                >
                  <svg class="material-icon" width="17" height="17"><use href="/icons.svg#drag_indicator"></use></svg>
                </button>
                <button class="audio-queue-panel__select" @click=${() => this.select(index)}>
                  ${
                    entry.cover
                      ? html`
                          <img src=${entry.cover} alt="" loading="lazy" />
                        `
                      : html`
                          <span class="audio-queue-panel__placeholder">
                            <svg class="material-icon" width="17" height="17">
                              <use href="/icons.svg#queue_music"></use>
                            </svg>
                          </span>
                        `
                  }
                  <span>
                    <strong lang=${entry.titleLanguage || this.uiLanguage}>${entry.title}</strong>
                    <small>${entry.artist}</small>
                  </span>
                </button>
                <small>${String(index + 1).padStart(2, "0")}</small>
                <button
                  class="icon-button audio-queue-panel__remove"
                  aria-label=${`${this.t("remove")} · ${entry.title}`}
                  @click=${() => this.removeQueueItem(index)}
                >
                  <svg class="material-icon" width="17" height="17"><use href="/icons.svg#delete"></use></svg>
                </button>
              </article>
            `,
          )}
        </div>
      </section>
    `;
  }

  private renderCover(track: AudioTrack, size: number) {
    return html`
      <span class="player__cover">
        ${
          track.cover
            ? html`
                <img src=${track.cover} alt="" width=${size} height=${size} decoding="async" />
              `
            : icon("queue_music", Math.round(size / 2))
        }
      </span>
    `;
  }

  /**
   * One surface in two states (Material 3 Expressive media player):
   *   mini  — a 64dp floating bar: cover, title and artist (tap to expand),
   *           play/pause, next and an explicit expand button, with a thin
   *           progress line along its foot;
   *   full  — on medium and wider windows a docked player bar (identity,
   *           transport, actions, then the seek row); on compact windows a
   *           bottom sheet with large artwork and large transport controls,
   *           dismissed by its handle, a downward drag, the scrim or Escape.
   */
  render() {
    const track = this.track;
    if (!track) return nothing;
    const full = !this.collapsed;
    const progress = this.duration > 0 ? clamp(this.currentTime / this.duration, 0, 1) : 0;
    const title = html`
      <strong lang=${track.titleLanguage || this.uiLanguage}>${track.title}</strong>
      <small>${track.artist || "\u00a0"}</small>
    `;
    const detailHref = track.detailPath || `/catalog/songs?song=${encodeURIComponent(track.id)}`;
    const play = html`
      <button
        class="player__play"
        data-playing=${String(this.playing)}
        type="button"
        aria-label=${this.t(this.playing ? "pause" : "play")}
        title=${this.t(this.playing ? "pause" : "play")}
        @click=${() => void this.togglePlayback()}
      >
        ${this.playing ? icon("pause", full ? 32 : 24) : icon("play_arrow", full ? 32 : 24)}
      </button>
    `;
    if (!full) return this.renderQueue();
    return html`
      <button class="player-scrim" type="button" tabindex="-1" aria-label=${this.t("collapse")} @click=${() => this.setExpanded(false)}></button>
      <aside class="player" data-state="full" aria-label=${this.t("musicPlayer")}>
        <button
          class="player__handle"
          type="button"
          aria-label=${this.t("collapse")}
          @click=${() => this.setExpanded(false)}
          @pointerdown=${this.onSheetPointerDown}
          @pointermove=${this.onSheetPointerMove}
          @pointerup=${this.onSheetPointerUp}
          @pointercancel=${this.onSheetPointerUp}
        >
          <span aria-hidden="true"></span>
        </button>
        <a class="player__identity state-layer" aria-label=${`${track.title} · ${track.artist}`} title=${track.title} href=${detailHref}>
          ${this.renderCover(track, 56)}
          <span class="player__copy">${title}</span>
        </a>
        <div class="player__transport">
          ${iconButton({ label: this.t("previous"), icon: "skip_previous", className: "player__skip", onClick: () => void this.previous() })}
          ${play}
          ${iconButton({ label: this.t("next"), icon: "skip_next", className: "player__skip", onClick: () => void this.next() })}
        </div>
        <div class="player__timeline">
          <span class="player__time tabular">${this.format(this.currentTime)}</span>
          <span class="player__seek">
          ${wavyProgress({ value: progress, thickness: 4, amplitude: 3, wavelength: 28, still: !this.playing })}
          <md-slider
            class="player__scrub md3-slider"
            labeled
            .min=${0}
            .max=${this.duration || 1}
            .step=${0.01}
            .value=${this.currentTime}
            .valueLabel=${this.format(this.currentTime)}
            ?disabled=${this.duration <= 0}
            aria-label=${this.t("playbackPosition")}
            aria-valuetext=${`${this.format(this.currentTime)} / ${this.format(this.duration)}`}
            @input=${(event: Event) => this.seek(Number((event.target as HTMLElement & { value: number }).value))}
          ></md-slider>
          </span>
          <span class="player__time tabular">${this.format(this.duration)}</span>
        </div>
        <div class="player__actions">
          ${iconButton({
            label: this.modeLabel(),
            icon: this.modeIconName(),
            onClick: this.cycleMode,
            pressed: this.mode !== "sequential",
            toggle: true,
          })}
          ${iconButton({
            label: this.t("queue"),
            icon: "queue_music",
            onClick: () => (this.queueOpen ? this.closeOverlay() : this.openOverlay("queue")),
            pressed: this.queueOpen,
            toggle: true,
            badge: this.queue.length,
          })}
          <div class="player__volume">
            <button
              class="icon-button"
              type="button"
              aria-label=${this.t(this.volume ? "mute" : "unmute")}
              title=${this.t(this.volume ? "mute" : "unmute")}
              @click=${() => this.setVolume(this.volume ? 0 : 0.82)}
            >
              ${this.volume ? icon("volume_up", 24) : icon("volume_off", 24)}
            </button>
            <md-slider
              class="player__volume-slider md3-slider"
              labeled
              .min=${0}
              .max=${1}
              .step=${0.01}
              .value=${this.volume}
              .valueLabel=${`${Math.round(this.volume * 100)}%`}
              aria-label=${this.t("volume")}
              aria-valuetext=${`${Math.round(this.volume * 100)}%`}
              @input=${(event: Event) => this.setVolume(Number((event.target as HTMLElement & { value: number }).value))}
            ></md-slider>
          </div>
          ${iconButton({
            label: this.t("collapse"),
            className: "player__collapse",
            icon: "keyboard_arrow_down",
            onClick: () => this.setExpanded(false),
          })}
          ${this.renderCloseButton("player__close")}
        </div>
      </aside>
      ${this.renderQueue()}
    `;
  }

  /**
   * Collapsed, the player leaves the bottom of the screen and lives in the
   * navigation: a now-playing item in the rail (cover with a wavy progress
   * ring, play/pause; in the expanded rail also title, artist and next), or,
   * on compact windows that have no rail, a now-playing button at the start
   * of the top app bar's actions. Either one expands the full player, and
   * shares its view-transition name, so expanding and collapsing are one
   * container transform between the rail and the bottom bar.
   */
  private syncCollapsedSlots() {
    const track = this.track;
    const collapsed = Boolean(track) && this.collapsed;
    const rail = document.querySelector<HTMLElement>("[data-nav-player]");
    const bar = document.querySelector<HTMLElement>("[data-app-bar-player]");
    if (rail) render(collapsed && track ? this.renderRailPlayer(track) : nothing, rail);
    if (bar) render(collapsed && track ? this.renderBarPlayer(track) : nothing, bar);
  }
  private progressRatio() {
    return this.duration > 0 ? clamp(this.currentTime / this.duration, 0, 1) : 0;
  }
  private renderRailPlayer(track: AudioTrack) {
    const progress = this.progressRatio();
    return html`
      <section class="now-playing-rail" aria-label=${this.t("musicPlayer")}>
        <button
          class="now-playing__expand"
          type="button"
          aria-label=${`${this.t("expandPlayer")} · ${track.title} · ${track.artist}`}
          title=${this.t("expandPlayer")}
          @click=${() => this.setExpanded(true)}
        >
          <span class="now-playing__cover" style=${`--player-progress:${progress}`}>
            ${
              track.cover
                ? html`<img src=${track.cover} alt="" width="40" height="40" decoding="async" />`
                : icon("queue_music", 20)
            }
          </span>
          <span class="now-playing__copy">
            <strong lang=${track.titleLanguage || this.uiLanguage}>${track.title}</strong>
            <small>${track.artist || "\u00a0"}</small>
          </span>
          <span class="now-playing__chevron" aria-hidden="true">${icon("keyboard_arrow_up", 20)}</span>
        </button>
        <span class="now-playing__progress" aria-hidden="true">
          ${wavyProgress({ value: progress, thickness: 3, amplitude: 2, wavelength: 16, still: !this.playing })}
        </span>
        <span class="now-playing__controls">
          <button
            class="icon-button now-playing__play"
            type="button"
            data-playing=${String(this.playing)}
            aria-label=${this.t(this.playing ? "pause" : "play")}
            title=${this.t(this.playing ? "pause" : "play")}
            @click=${() => void this.togglePlayback()}
          >
            ${this.playing ? icon("pause", 24) : icon("play_arrow", 24)}
          </button>
          ${iconButton({ label: this.t("next"), icon: "skip_next", className: "now-playing__next", onClick: () => void this.next() })}
          ${this.renderCloseButton("now-playing__close")}
        </span>
      </section>
    `;
  }
  private renderBarPlayer(track: AudioTrack) {
    const progress = this.progressRatio();
    return html`
      <button
        class="now-playing"
        type="button"
        data-playing=${String(this.playing)}
        aria-label=${`${this.t("expandPlayer")} · ${track.title} · ${track.artist}`}
        title=${`${track.title} · ${track.artist}`}
        style=${`--player-progress:${progress}`}
        @click=${() => this.setExpanded(true)}
      >
        <span class="now-playing__cover">
          ${
            track.cover
              ? html`<img src=${track.cover} alt="" width="32" height="32" decoding="async" />`
              : icon("queue_music", 18)
          }
        </span>
      </button>
    `;
  }

  private modeLabel() {
    return this.t(
      { sequential: "playInOrder", "repeat-all": "repeatQueue", "repeat-one": "repeatTrack", shuffle: "shuffle" }[
        this.mode
      ],
    );
  }
  private renderCloseButton(className: string) {
    return iconButton({
      label: this.t("closePlayerAndClearQueue"),
      icon: "close",
      className,
      onClick: () => this.clearQueue(),
    });
  }
  private modeIconName() {
    return {
      sequential: "playlist_play",
      "repeat-all": "repeat",
      "repeat-one": "repeat_one",
      shuffle: "shuffle",
    }[this.mode];
  }
}

customElements.define("audio-dock", AudioDock);
