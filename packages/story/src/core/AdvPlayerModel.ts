import { ADV_PLAYBACK_SPEED } from "./AdvConstants";
import { createAdvSettlingWait } from "./AdvSettlingWait";

export class AdvPlayerModel {
  CurrentEpisodeListIndex: number;
  NextStepState: number;
  playbackSpeed: number;
  isAutoPlay: boolean;
  forcedAutoPlay: boolean;
  isPause: boolean;
  isSubtitlesEnabled: boolean;
  isRandomChoice: boolean;
  shortCutIndex: number;
  directShortCutEnabled: boolean;
  shouldShortCut: boolean;
  waitingNext: (() => void) | null;
  currentTypingController: { finish: () => void } | null;
  private readonly nextWaiters: Set<() => void>;
  private disposed: boolean;

  constructor() {
    this.CurrentEpisodeListIndex = 0;
    this.NextStepState = 0;
    this.playbackSpeed = ADV_PLAYBACK_SPEED.Normal;
    this.isAutoPlay = false;
    this.forcedAutoPlay = false;
    this.isPause = false;
    this.isSubtitlesEnabled = true;
    this.isRandomChoice = false;
    this.shortCutIndex = -1;
    this.directShortCutEnabled = false;
    this.shouldShortCut = false;
    this.waitingNext = null;
    this.currentTypingController = null;
    this.nextWaiters = new Set();
    this.disposed = false;
  }

  getCurrentSpeedRate() {
    return (Number(this.playbackSpeed) || ADV_PLAYBACK_SPEED.Normal) / 10;
  }

  calcDuration(duration: number | string | undefined | null, defaultDuration = 0) {
    if (this.shortCutIndex >= 0 || this.shouldShortCut) return 0;
    const raw = Number(duration);
    let actual = defaultDuration;
    if (raw === 0) actual = defaultDuration;
    else if (raw > 0) actual = raw;
    else if (raw < 0) actual = 0;
    return actual / this.getCurrentSpeedRate();
  }

  get isAutoEnabled() {
    return this.isAutoPlay || this.forcedAutoPlay;
  }

  switchForceAutoPlay() {
    this.forcedAutoPlay = !this.forcedAutoPlay;
  }

  setSubtitlesEnabled(enabled: boolean) {
    this.isSubtitlesEnabled = Boolean(enabled);
  }

  changeIdleState() {
    this.NextStepState = 0;
  }

  changeAllowNextState() {
    this.NextStepState = 1;
  }

  changeGoNextState() {
    this.NextStepState = 2;
    this.resolveNextWaiters();
  }

  private resolveNextWaiters() {
    const waiters = [...this.nextWaiters];
    this.nextWaiters.clear();
    this.waitingNext = null;
    for (const resolve of waiters) resolve();
  }

  private refreshWaitingNext() {
    this.waitingNext = this.nextWaiters.size ? () => this.resolveNextWaiters() : null;
  }

  requestNext() {
    if (this.currentTypingController) {
      this.currentTypingController.finish();
      this.currentTypingController = null;
      return;
    }
    if (this.NextStepState === 1 || this.waitingNext) this.changeGoNextState();
  }

  waitForNext(signal?: AbortSignal) {
    if (this.disposed || signal?.aborted) return Promise.resolve();
    if (this.NextStepState === 2) {
      this.changeIdleState();
      return Promise.resolve();
    }
    this.changeAllowNextState();
    const wait = createAdvSettlingWait();
    const finish = () => {
      this.nextWaiters.delete(finish);
      this.refreshWaitingNext();
      signal?.removeEventListener("abort", finish);
      wait.settle();
    };
    // Unity's waits are independent UniTask.WaitUntil(IsNextStepGoNext)
    // observers. Chat helpers are Forget() tasks and can overlap another
    // blocking command, so replacing the previous resolver would complete it
    // before the native global GoNext state is actually reached.
    this.nextWaiters.add(finish);
    this.refreshWaitingNext();
    signal?.addEventListener("abort", finish, { once: true });
    if (this.disposed || signal?.aborted) finish();
    return wait.promise.finally(() => {
      if (!this.waitingNext) this.changeIdleState();
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.currentTypingController?.finish();
    this.currentTypingController = null;
    this.resolveNextWaiters();
    this.changeIdleState();
  }
}
