import type { AdvCommand, AdvTimeline, AdvTimelineSignal } from "../types/AdvRuntime";

const ADV_TIMELINE_COMMAND = 45;
const PLAYBACK_SPEED_POLL_SECONDS = 0.05;

export interface AdvTimelineClock {
  nowSeconds(): number;
  waitSeconds(seconds: number, signal?: AbortSignal): Promise<void>;
}

export interface AdvPlayableDirectorOptions {
  executeEpisode(episode: AdvCommand, signal: AbortSignal): Promise<void> | void;
  getPlaybackSpeed?: () => number;
  clock?: AdvTimelineClock;
  onBackgroundError?: (error: unknown) => void;
}

type ObservedTaskResult = { error?: unknown };

const defaultClock: AdvTimelineClock = {
  nowSeconds: () => (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000,
  waitSeconds: (seconds, signal) => {
    const milliseconds = Math.max(0, Number(seconds) || 0) * 1000;
    if (milliseconds <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      signal?.addEventListener("abort", finish, { once: true });
    });
  },
};

function cancellationError(): Error {
  const error = new Error("ADV Timeline playback was cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw cancellationError();
}

function isCancellationError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function timelineTime(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function timelineDuration(timeline: AdvTimeline): number {
  const duration = Number(timeline.duration);
  if (Number.isFinite(duration) && duration >= 0) return duration;
  return Math.max(0, ...timeline.signals.map((signal) => timelineTime(signal.time)));
}

function isExecutableSignal(signal: AdvTimelineSignal): boolean {
  return Number(signal.episode?.command) !== ADV_TIMELINE_COMMAND;
}

function timelineAssetName(command: AdvCommand): string {
  const targetAssetName = String(command.targetAssetName || "");
  return targetAssetName.trim() ? targetAssetName : String(command.targetName || "");
}

/**
 * Unity's `List<(double time, AdvEpisodeSignal)>.Sort` compares only `time`.
 * Modern JavaScript retains source order for equal keys because Array#sort is
 * stable; that is a host-runtime difference, not an authored native tie-break.
 */
export function sortAdvTimelineSignals(signals: readonly AdvTimelineSignal[]): AdvTimelineSignal[] {
  return [...signals].sort((left, right) => timelineTime(left.time) - timelineTime(right.time));
}

function linkAbortSignals(parent: AbortSignal | undefined, lifecycle: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent?.aborted || lifecycle.aborted) controller.abort();
  else {
    parent?.addEventListener("abort", abort, { once: true });
    lifecycle.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      parent?.removeEventListener("abort", abort);
      lifecycle.removeEventListener("abort", abort);
    },
  };
}

/**
 * Browser counterpart of `AdvSystem.AdvPlayableDirector`.
 *
 * Normal playback adapts the PlayableDirector clock to a browser timer, starts
 * signal episodes without awaiting them, then awaits every started task after
 * the duration elapses. Immediate playback has no duration cutoff and awaits
 * signals in timestamp order. Dispatch and task ownership follow the two native
 * paths, while frame scheduling remains host-specific.
 */
export class AdvPlayableDirector {
  private readonly executeEpisode: AdvPlayableDirectorOptions["executeEpisode"];
  private readonly getPlaybackSpeed: () => number;
  private readonly clock: AdvTimelineClock;
  private readonly onBackgroundError?: (error: unknown) => void;
  private lifecycleController = new AbortController();
  private readonly backgroundTasks = new Set<Promise<void>>();

  constructor(options: AdvPlayableDirectorOptions) {
    this.executeEpisode = options.executeEpisode;
    this.getPlaybackSpeed = options.getPlaybackSpeed || (() => 1);
    this.clock = options.clock || defaultClock;
    this.onBackgroundError = options.onBackgroundError;
  }

  async execute(command: AdvCommand, shouldShortCut: boolean, signal?: AbortSignal): Promise<void> {
    const timeline = command.timeline;
    if (!timeline) {
      const assetName = timelineAssetName(command).trim();
      throw new Error(`ADV Timeline asset was not found${assetName ? `: Adv/Timeline/${assetName}` : ""}`);
    }
    if (shouldShortCut) {
      await this.playImmediate(timeline, signal);
      return;
    }
    const task = this.play(timeline, signal);
    if (command.noWait) {
      this.observeBackgroundTask(task);
      return;
    }
    await task;
  }

  async play(timeline: AdvTimeline, signal?: AbortSignal): Promise<void> {
    const linked = linkAbortSignals(signal, this.lifecycleController.signal);
    const token = linked.signal;
    const duration = timelineDuration(timeline);
    const signals = sortAdvTimelineSignals(timeline.signals).filter(
      (entry) => isExecutableSignal(entry) && timelineTime(entry.time) <= duration,
    );
    const tasks: Array<Promise<ObservedTaskResult>> = [];
    let playhead = 0;

    try {
      throwIfCancelled(token);
      for (const entry of signals) {
        const time = timelineTime(entry.time);
        await this.advanceTimelineTime(time - playhead, token);
        playhead = time;
        throwIfCancelled(token);
        tasks.push(this.observeEpisodeTask(entry.episode, token));
      }
      await this.advanceTimelineTime(duration - playhead, token);
      throwIfCancelled(token);

      const results = await Promise.all(tasks);
      const failure = results.find((result) => "error" in result);
      if (failure) throw failure.error;
    } finally {
      linked.dispose();
    }
  }

  async playImmediate(timeline: AdvTimeline, signal?: AbortSignal): Promise<void> {
    const linked = linkAbortSignals(signal, this.lifecycleController.signal);
    const token = linked.signal;
    try {
      for (const entry of sortAdvTimelineSignals(timeline.signals)) {
        if (!isExecutableSignal(entry)) continue;
        throwIfCancelled(token);
        await this.executeEpisode(entry.episode, token);
      }
    } finally {
      linked.dispose();
    }
  }

  /** Mirrors `Refresh`/`Deactivate`: stop the active director and its no-wait runs. */
  deactivate(): void {
    this.lifecycleController.abort();
    this.lifecycleController = new AbortController();
  }

  async waitForBackgroundTasks(): Promise<void> {
    await Promise.all([...this.backgroundTasks]);
  }

  get hasBackgroundTasks(): boolean {
    return this.backgroundTasks.size > 0;
  }

  private observeEpisodeTask(episode: AdvCommand, signal: AbortSignal): Promise<ObservedTaskResult> {
    return Promise.resolve()
      .then(() => this.executeEpisode(episode, signal))
      .then(
        () => ({}),
        (error: unknown) => ({ error }),
      );
  }

  private observeBackgroundTask(task: Promise<void>): void {
    this.backgroundTasks.add(task);
    void task
      .catch((error: unknown) => {
        if (!isCancellationError(error)) this.onBackgroundError?.(error);
      })
      .finally(() => this.backgroundTasks.delete(task));
  }

  private async advanceTimelineTime(deltaSeconds: number, signal: AbortSignal): Promise<void> {
    let remaining = Math.max(0, deltaSeconds);
    while (remaining > 0) {
      throwIfCancelled(signal);
      const speed = Number(this.getPlaybackSpeed());
      if (!Number.isFinite(speed) || speed <= 0) {
        await this.clock.waitSeconds(PLAYBACK_SPEED_POLL_SECONDS, signal);
        continue;
      }
      const requestedWallSeconds = Math.min(remaining / speed, PLAYBACK_SPEED_POLL_SECONDS);
      const startedAt = this.clock.nowSeconds();
      await this.clock.waitSeconds(requestedWallSeconds, signal);
      throwIfCancelled(signal);
      const measuredWallSeconds = this.clock.nowSeconds() - startedAt;
      const elapsedWallSeconds =
        Number.isFinite(measuredWallSeconds) && measuredWallSeconds > 0 ? measuredWallSeconds : requestedWallSeconds;
      remaining = Math.max(0, remaining - elapsedWallSeconds * speed);
    }
  }
}
