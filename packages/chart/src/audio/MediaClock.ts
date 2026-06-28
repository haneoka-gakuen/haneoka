export interface MediaClockOptions {
  volume?: number;
  playbackRate?: number;
  loop?: boolean;
}

/** Audio-element backed clock. Rendering always reads the media clock, never frame deltas. */
export class MediaClock extends EventTarget {
  readonly audio: HTMLAudioElement;

  constructor(source?: string, options: MediaClockOptions = {}) {
    super();
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.audio.crossOrigin = "anonymous";
    this.audio.volume = options.volume ?? 0.8;
    this.audio.playbackRate = options.playbackRate ?? 1;
    this.audio.loop = options.loop ?? false;
    if (source) this.source = source;
    for (const type of ["play", "pause", "ended", "timeupdate", "durationchange", "error"] as const) {
      this.audio.addEventListener(type, () => this.dispatchEvent(new Event(type)));
    }
  }

  get source(): string {
    return this.audio.src;
  }

  set source(value: string) {
    if (this.audio.getAttribute("src") === value) return;
    this.audio.src = value;
    this.audio.load();
  }

  get timeMs(): number {
    return Number.isFinite(this.audio.currentTime) ? this.audio.currentTime * 1000 : 0;
  }

  get durationMs(): number {
    return Number.isFinite(this.audio.duration) ? this.audio.duration * 1000 : 0;
  }

  get playing(): boolean {
    return !this.audio.paused && !this.audio.ended;
  }

  get volume(): number {
    return this.audio.volume;
  }

  set volume(value: number) {
    this.audio.volume = Math.max(0, Math.min(1, value));
  }

  get rate(): number {
    return this.audio.playbackRate;
  }

  set rate(value: number) {
    this.audio.playbackRate = Math.max(0.25, Math.min(4, value));
  }

  get loop(): boolean {
    return this.audio.loop;
  }

  set loop(value: boolean) {
    this.audio.loop = value;
  }

  async play(): Promise<void> {
    await this.audio.play();
  }

  pause(): void {
    this.audio.pause();
  }

  seek(timeMs: number): void {
    const maximum = this.durationMs || Number.POSITIVE_INFINITY;
    this.audio.currentTime = Math.max(0, Math.min(maximum, timeMs)) / 1000;
  }

  destroy(): void {
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
  }
}
