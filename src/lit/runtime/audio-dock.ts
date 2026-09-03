import { LitElement, html, nothing } from "lit";
import "../../styles/audio.css";

export interface AudioTrack {
  id: string;
  queueId?: string;
  title: string;
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
const MODES: readonly PlaybackMode[] = ["sequential", "repeat-all", "repeat-one", "shuffle"];
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
const normalizedTrack = (value: AudioTrack, occurrence = 0): AudioTrack | null => {
  const id = String(value?.id || "");
  const url = String(value?.url || "");
  if (!id || !url) return null;
  return {
    id,
    queueId: value.queueId || `${id}:${occurrence}:${url}`,
    title: String(value.title || id),
    artist: String(value.artist || ""),
    cover: String(value.cover || ""),
    url,
    ...(value.detailPath ? { detailPath: String(value.detailPath) } : {}),
  };
};

export class AudioDock extends LitElement {
  static properties = {
    queue: { state: true },
    index: { state: true },
    playing: { state: true },
    currentTime: { state: true },
    duration: { state: true },
    volume: { state: true },
    queueOpen: { state: true },
    controlsOpen: { state: true },
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
  declare controlsOpen: boolean;
  declare collapsed: boolean;
  declare mode: PlaybackMode;
  declare draggedIndex: number;
  declare dropIndex: number;
  private audio = new Audio();
  private frame = 0;
  private restoredTime = 0;
  private inertTargets = new Set<HTMLElement>();
  private dockObserver?: ResizeObserver;
  private observedDock?: HTMLElement;

  constructor() {
    super();
    this.queue = [];
    this.index = -1;
    this.playing = false;
    this.currentTime = 0;
    this.duration = 0;
    this.volume = 0.82;
    this.queueOpen = false;
    this.controlsOpen = false;
    this.collapsed = false;
    this.mode = "repeat-all";
    this.draggedIndex = -1;
    this.dropIndex = -1;
    this.audio.preload = "metadata";
    this.restore();
    this.audio.volume = this.volume;
    this.audio.addEventListener("play", () => {
      this.playing = true;
      this.tick();
      this.emitState();
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    });
    this.audio.addEventListener("pause", () => {
      this.playing = false;
      this.persist();
      this.emitState();
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
    });
    this.audio.addEventListener("timeupdate", () => (this.currentTime = this.audio.currentTime || 0));
    this.audio.addEventListener("durationchange", () => {
      this.duration = Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
    });
    this.audio.addEventListener("loadedmetadata", () => {
      if (this.restoredTime > 0) {
        this.audio.currentTime = clamp(this.restoredTime, 0, this.duration || this.restoredTime);
        this.currentTime = this.audio.currentTime;
        this.restoredTime = 0;
      }
    });
    this.audio.addEventListener("ended", () => void this.next(true));
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    void import("@material/web/slider/slider.js");
    addEventListener("pagehide", this.persistBound);
    addEventListener("keydown", this.onGlobalKeydown, true);
    addEventListener("popstate", this.onPopState);
    if (this.track) void this.prepare(false, false);
    if ("mediaSession" in navigator) {
      try {
        navigator.mediaSession.setActionHandler("play", () => void this.audio.play());
        navigator.mediaSession.setActionHandler("pause", () => this.audio.pause());
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
    cancelAnimationFrame(this.frame);
    removeEventListener("pagehide", this.persistBound);
    removeEventListener("keydown", this.onGlobalKeydown, true);
    removeEventListener("popstate", this.onPopState);
    this.setOverlayIsolation(false);
    this.dockObserver?.disconnect();
    this.observedDock = undefined;
    document.documentElement.style.removeProperty("--audio-dock-height");
    this.persist();
    super.disconnectedCallback();
  }

  updated() {
    const dock = this.querySelector<HTMLElement>(".audio-dock");
    if (dock === this.observedDock) return;
    this.dockObserver?.disconnect();
    this.observedDock = dock || undefined;
    if (!dock) {
      document.documentElement.style.removeProperty("--audio-dock-height");
      return;
    }
    const publishHeight = () =>
      document.documentElement.style.setProperty(
        "--audio-dock-height",
        `${Math.ceil(dock.getBoundingClientRect().height)}px`,
      );
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
      this.collapsed = false;
      this.playing ? this.audio.pause() : await this.audio.play().catch(() => undefined);
      return;
    }
    this.audio.pause();
    this.queue = normalizedQueue;
    this.index = Math.max(
      0,
      this.queue.findIndex((entry) => entry.id === requested.id && entry.url === requested.url),
    );
    this.collapsed = false;
    this.currentTime = 0;
    this.duration = 0;
    await this.prepare(true);
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
    if ("mediaSession" in navigator && "MediaMetadata" in window)
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        artwork: track.cover ? [{ src: track.cover }] : [],
      });
    if (shouldPlay) await this.audio.play().catch(() => undefined);
    this.persist();
  }

  private tick = () => {
    cancelAnimationFrame(this.frame);
    const update = () => {
      this.currentTime = this.audio.currentTime || 0;
      if (this.playing) this.frame = requestAnimationFrame(update);
    };
    this.frame = requestAnimationFrame(update);
  };
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
  private modeIcon() {
    return this.mode === "shuffle"
      ? "/icons.svg#shuffle"
      : this.mode === "repeat-one"
        ? "/icons.svg#repeat_one"
        : this.mode === "sequential"
          ? "/icons.svg#arrow_right_alt"
          : "/icons.svg#repeat";
  }
  private seek(seconds: number) {
    const value = clamp(Number(seconds) || 0, 0, this.duration || Number(seconds) || 0);
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
    if (history.state?.__haneoka_audio_overlay) history.back();
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    delete this.audio.dataset.haneokaSource;
    this.queue = [];
    this.index = -1;
    this.currentTime = 0;
    this.duration = 0;
    this.queueOpen = false;
    this.controlsOpen = false;
    this.setOverlayIsolation(false);
    if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
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
  private onGlobalKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && (this.queueOpen || this.controlsOpen)) {
      event.preventDefault();
      this.closeOverlay();
      return;
    }
    if (event.key !== "Tab" || (!this.queueOpen && !this.controlsOpen)) return;
    const panel = this.querySelector<HTMLElement>(
      this.queueOpen ? ".audio-queue-panel" : ".audio-dock__mobile-controls",
    );
    const focusable = panel
      ? [
          ...panel.querySelectorAll<HTMLElement>(
            "button:not(:disabled),a[href],input:not(:disabled),md-slider,md-outlined-select",
          ),
        ]
      : [];
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (!panel?.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  private onPopState = () => {
    const overlay = history.state?.__haneoka_audio_overlay;
    this.queueOpen = overlay === "queue";
    this.controlsOpen = overlay === "controls";
    this.setOverlayIsolation(Boolean(overlay));
  };
  private setOverlayIsolation(open: boolean) {
    if (!open) {
      this.inertTargets.forEach((target) => target.removeAttribute("inert"));
      this.inertTargets.clear();
      return;
    }
    document.querySelectorAll<HTMLElement>("main, .navigation-drawer, .audio-dock").forEach((target) => {
      if (target.hasAttribute("inert")) return;
      target.setAttribute("inert", "");
      this.inertTargets.add(target);
    });
  }
  private openOverlay(kind: "queue" | "controls") {
    if (history.state?.__haneoka_audio_overlay !== kind)
      history.pushState({ ...history.state, __haneoka_audio_overlay: kind }, "", location.href);
    this.queueOpen = kind === "queue";
    this.controlsOpen = kind === "controls";
    this.setOverlayIsolation(true);
    void this.updateComplete.then(() =>
      this.querySelector<HTMLElement>(
        kind === "queue" ? ".audio-queue-panel button" : ".audio-dock__mobile-controls button",
      )?.focus(),
    );
  }
  private closeOverlay() {
    this.queueOpen = false;
    this.controlsOpen = false;
    this.setOverlayIsolation(false);
    if (history.state?.__haneoka_audio_overlay) history.back();
  }
  private format(value: number) {
    const seconds = Math.max(0, Math.floor(value || 0));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }

  private renderQueue() {
    if (!this.queueOpen) return nothing;
    return html`
      <button class="audio-dock__backdrop" aria-label="Close" @click=${this.closeOverlay}></button>
      <section class="audio-queue-panel" role="dialog" aria-modal="true" aria-label="Queue">
        <header>
          <span>
            <svg class="material-icon" width="19" height="19"><use href="/icons.svg#queue_music"></use></svg>
            <strong>Queue</strong>
            <small>${this.queue.length}</small>
          </span>
          <span>
            <button class="icon-button" aria-label="Previous" @click=${this.previous}>
              <svg class="material-icon" width="18" height="18"><use href="/icons.svg#skip_previous"></use></svg>
            </button>
            <button class="icon-button" aria-label="Next" @click=${() => this.next()}>
              <svg class="material-icon" width="18" height="18"><use href="/icons.svg#skip_next"></use></svg>
            </button>
            <button class="icon-button" aria-label="Clear queue" @click=${this.clearQueue}>
              <svg class="material-icon" width="18" height="18"><use href="/icons.svg#delete_sweep"></use></svg>
            </button>
            <button class="icon-button" aria-label="Close" @click=${this.closeOverlay}>
              <svg class="material-icon" width="18" height="18"><use href="/icons.svg#close"></use></svg>
            </button>
          </span>
        </header>
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
                  aria-label=${`Reorder ${entry.title}`}
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
                    <strong>${entry.title}</strong>
                    <small>${entry.artist}</small>
                  </span>
                </button>
                <small>${String(index + 1).padStart(2, "0")}</small>
                <button
                  class="icon-button audio-queue-panel__remove"
                  aria-label=${`Remove ${entry.title}`}
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

  render() {
    const track = this.track;
    if (!track) return nothing;
    if (this.collapsed)
      return html`
        <button
          class="audio-dock-collapsed"
          aria-label="Expand player"
          @click=${() => {
            this.collapsed = false;
            this.persist();
          }}
        >
          ${
            track.cover
              ? html`
                  <img src=${track.cover} alt="" />
                `
              : nothing
          }
          <svg class="material-icon" width="20" height="20"><use href="/icons.svg#expand_less"></use></svg>
        </button>
      `;
    return html`
      <aside class="audio-dock" aria-label="Music player">
        <a
          class="audio-dock__identity"
          href=${track.detailPath || `/catalog/songs?song=${encodeURIComponent(track.id)}`}
        >
          ${
            track.cover
              ? html`
                  <img class="audio-dock__cover" src=${track.cover} alt="" />
                `
              : html`
                  <span class="audio-dock__cover audio-dock__placeholder">
                    <svg class="material-icon" width="18" height="18"><use href="/icons.svg#queue_music"></use></svg>
                  </span>
                `
          }
          <span class="audio-dock__track">
            <strong>${track.title}</strong>
            <small>${track.artist}</small>
          </span>
        </a>
        <div class="audio-dock__transport">
          <button class="icon-button" @click=${this.previous} aria-label="Previous">
            <svg class="material-icon" width="21" height="21"><use href="/icons.svg#skip_previous"></use></svg>
          </button>
          <button
            class="icon-button audio-dock__play"
            @click=${() => (this.playing ? this.audio.pause() : void this.audio.play())}
            aria-label=${this.playing ? "Pause" : "Play"}
          >
            <svg class="material-icon" width="24" height="24">
              <use href=${this.playing ? "/icons.svg#pause" : "/icons.svg#play_arrow"}></use>
            </svg>
          </button>
          <button class="icon-button" @click=${() => this.next()} aria-label="Next">
            <svg class="material-icon" width="21" height="21"><use href="/icons.svg#skip_next"></use></svg>
          </button>
        </div>
        <button class="icon-button audio-dock__mode" @click=${this.cycleMode} aria-label=${this.mode}>
          <svg class="material-icon" width="20" height="20"><use href=${this.modeIcon()}></use></svg>
        </button>
        <div class="audio-dock__timeline">
          <small>${this.format(this.currentTime)}</small>
          <md-slider
            class="audio-dock__progress md3-slider md3-slider--compact"
            min="0"
            max=${this.duration || 1}
            step="0.01"
            .value=${String(this.currentTime)}
            @input=${(event: Event) => this.seek(Number((event.target as HTMLElement & { value?: number }).value))}
            aria-label="Playback position"
          ></md-slider>
          <small>${this.format(this.duration)}</small>
        </div>
        <label class="audio-dock__volume">
          <svg class="material-icon" width="18" height="18">
            <use href=${this.volume ? "/icons.svg#volume_up" : "/icons.svg#volume_off"}></use>
          </svg>
          <md-slider
            min="0"
            max="1"
            step="0.01"
            .value=${String(this.volume)}
            @input=${(event: Event) => this.setVolume(Number((event.target as HTMLElement & { value?: number }).value))}
            aria-label="Volume"
          ></md-slider>
        </label>
        <button
          class="icon-button audio-dock__queue-button"
          @click=${() => (this.queueOpen ? this.closeOverlay() : this.openOverlay("queue"))}
          aria-label="Queue"
          aria-expanded=${this.queueOpen}
        >
          <svg class="material-icon" width="21" height="21"><use href="/icons.svg#queue_music"></use></svg>
          <small>${this.queue.length}</small>
        </button>
        <button
          class="icon-button audio-dock__more"
          @click=${() => (this.controlsOpen ? this.closeOverlay() : this.openOverlay("controls"))}
          aria-label="More playback controls"
        >
          <svg class="material-icon" width="21" height="21"><use href="/icons.svg#more_vert"></use></svg>
        </button>
        <button
          class="icon-button audio-dock__collapse"
          @click=${() => {
            this.collapsed = true;
            if (this.queueOpen || this.controlsOpen) this.closeOverlay();
            this.persist();
          }}
          aria-label="Collapse"
        >
          <svg class="material-icon" width="21" height="21"><use href="/icons.svg#expand_more"></use></svg>
        </button>
        ${
          this.controlsOpen
            ? html`
                <section class="audio-dock__mobile-controls">
                  <button
                    @click=${() => {
                      this.openOverlay("queue");
                    }}
                  >
                    Queue
                    <span>${this.queue.length}</span>
                  </button>
                  <button @click=${this.cycleMode}>${this.mode}</button>
                  <label>
                    Volume
                    <md-slider
                      min="0"
                      max="1"
                      step="0.01"
                      .value=${String(this.volume)}
                      @input=${(event: Event) => this.setVolume(Number((event.target as HTMLElement & { value?: number }).value))}
                    ></md-slider>
                  </label>
                </section>
              `
            : nothing
        }
      </aside>
      ${this.renderQueue()}
    `;
  }
}

customElements.define("audio-dock", AudioDock);
