export interface MutablePreviewValue<Value> {
  value: Value;
}

export interface StoryEditorPreviewSessionState<Compilation, Player, Snapshot> {
  readonly mounted: MutablePreviewValue<boolean>;
  readonly compilation: MutablePreviewValue<Compilation | undefined>;
  readonly player: MutablePreviewValue<Player | undefined>;
  readonly canPlay: MutablePreviewValue<boolean>;
  readonly debugReady: MutablePreviewValue<boolean>;
  readonly debugSnapshot: MutablePreviewValue<Snapshot | undefined>;
  readonly debugError: MutablePreviewValue<string>;
  readonly inspectorOpen: MutablePreviewValue<boolean>;
  readonly breakpoints: MutablePreviewValue<Set<number>>;
}

export const resetStoryEditorPreviewSession = <Compilation, Player, Snapshot>(
  state: StoryEditorPreviewSessionState<Compilation, Player, Snapshot>,
): void => {
  state.mounted.value = false;
  state.compilation.value = undefined;
  state.player.value = undefined;
  state.canPlay.value = false;
  state.debugReady.value = false;
  state.debugSnapshot.value = undefined;
  state.debugError.value = "";
  state.inspectorOpen.value = false;
  state.breakpoints.value = new Set();
};

export interface StoryEditorPreviewMountLifecycleOptions {
  readonly requestFrame: (callback: FrameRequestCallback) => number;
  readonly cancelFrame: (handle: number) => void;
  readonly setTimer: (callback: () => void, delay: number) => number;
  readonly clearTimer: (handle: number) => void;
  readonly canMount: () => boolean;
  readonly isMounted: () => boolean;
  readonly reset: () => void;
  readonly mount: () => void;
  readonly delay?: number;
}

export interface StoryEditorPreviewMountLifecycle {
  readonly pending: boolean;
  schedule(): boolean;
  stop(): void;
}

export interface StoryEditorPreviewStartupAttempt {
  readonly generation: number;
  isCurrent(): boolean;
}

export interface StoryEditorPreviewStartupLifecycle {
  readonly pending: boolean;
  start(operation: (attempt: StoryEditorPreviewStartupAttempt) => void | Promise<void>): Promise<void>;
  invalidate(): void;
}

/**
 * Deduplicates one preview startup without memoizing its terminal result.
 *
 * A failed attempt must be retryable, while an invalidated attempt may still
 * settle after a replacement has started. Identity checks in `finally` keep
 * that stale completion from clearing the replacement promise.
 */
export const createStoryEditorPreviewStartupLifecycle = (): StoryEditorPreviewStartupLifecycle => {
  let generation = 0;
  let startup:
    | {
        readonly generation: number;
        readonly promise: Promise<void>;
      }
    | undefined;

  const invalidate = () => {
    generation += 1;
    startup = undefined;
  };

  const start = (operation: (attempt: StoryEditorPreviewStartupAttempt) => void | Promise<void>): Promise<void> => {
    if (startup) return startup.promise;
    const attemptGeneration = ++generation;
    const attempt: StoryEditorPreviewStartupAttempt = Object.freeze({
      generation: attemptGeneration,
      isCurrent: () => generation === attemptGeneration,
    });
    const promise = Promise.resolve()
      .then(() => operation(attempt))
      .finally(() => {
        if (startup?.generation === attemptGeneration) startup = undefined;
      });
    startup = { generation: attemptGeneration, promise };
    return promise;
  };

  return {
    get pending() {
      return startup !== undefined;
    },
    start,
    invalidate,
  };
};

export const createStoryEditorPreviewMountLifecycle = (
  options: StoryEditorPreviewMountLifecycleOptions,
): StoryEditorPreviewMountLifecycle => {
  let frame: number | undefined;
  let timer: number | undefined;
  let generation = 0;

  const stop = () => {
    generation += 1;
    if (frame !== undefined) options.cancelFrame(frame);
    if (timer !== undefined) options.clearTimer(timer);
    frame = undefined;
    timer = undefined;
    options.reset();
  };

  const schedule = (): boolean => {
    if (!options.canMount() || options.isMounted() || frame !== undefined || timer !== undefined) return false;
    const targetGeneration = generation;
    const requestedFrame = options.requestFrame(() => {
      if (frame !== requestedFrame) return;
      frame = undefined;
      if (!options.canMount() || generation !== targetGeneration) return;
      const requestedTimer = options.setTimer(() => {
        if (timer !== requestedTimer) return;
        timer = undefined;
        if (!options.canMount() || generation !== targetGeneration) return;
        options.mount();
      }, options.delay ?? 100);
      timer = requestedTimer;
    });
    frame = requestedFrame;
    return true;
  };

  return {
    get pending() {
      return frame !== undefined || timer !== undefined;
    },
    schedule,
    stop,
  };
};
