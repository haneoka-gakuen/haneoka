export function delaySeconds(seconds: number, signal?: AbortSignal): Promise<void> {
  const ms = Math.max(0, Number(seconds) || 0) * 1000;
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(id);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const id = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}

export type AdvCommandTransitionChannel = "focus" | "tilt" | "pan" | "role" | "pedestal" | "track" | "zoom";

interface AdvCommandTransitionOwner {
  readonly controller: AbortController;
  readonly detach: () => void;
}

export class AdvCommandDelayTokens {
  commonDelayCancellationTokenSource: AbortController;
  private readonly transitionOwners = new Map<AdvCommandTransitionChannel, AdvCommandTransitionOwner>();

  constructor() {
    this.commonDelayCancellationTokenSource = new AbortController();
  }

  refresh() {
    this.commonDelayCancellationTokenSource = new AbortController();
    return this.commonDelayCancellationTokenSource.signal;
  }

  cancel() {
    this.commonDelayCancellationTokenSource.abort();
    this.refresh();
  }

  refreshTransition(channel: AdvCommandTransitionChannel, parent?: AbortSignal): AbortSignal {
    this.cancelTransition(channel);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (parent?.aborted) controller.abort();
    else parent?.addEventListener("abort", abort, { once: true });
    const detach = (): void => parent?.removeEventListener("abort", abort);
    controller.signal.addEventListener("abort", detach, { once: true });
    this.transitionOwners.set(channel, { controller, detach });
    return controller.signal;
  }

  releaseTransition(channel: AdvCommandTransitionChannel, signal: AbortSignal): void {
    const owner = this.transitionOwners.get(channel);
    if (!owner || owner.controller.signal !== signal) return;
    owner.detach();
    this.transitionOwners.delete(channel);
  }

  cancelTransition(channel: AdvCommandTransitionChannel): void {
    const owner = this.transitionOwners.get(channel);
    if (!owner) return;
    this.transitionOwners.delete(channel);
    owner.detach();
    owner.controller.abort();
  }

  cancelTransitions(): void {
    for (const channel of [...this.transitionOwners.keys()]) this.cancelTransition(channel);
  }

  reset(): void {
    this.cancel();
    this.cancelTransitions();
  }

  delay(seconds: number, signal?: AbortSignal): Promise<boolean> {
    const own = this.commonDelayCancellationTokenSource.signal;
    const durationMs = Math.max(0, Number(seconds) || 0) * 1000;
    if (durationMs <= 0) return Promise.resolve(!own.aborted && !signal?.aborted);
    const linked = new AbortController();
    const abort = () => linked.abort();
    if (signal?.aborted || own.aborted) linked.abort();
    else {
      signal?.addEventListener("abort", abort, { once: true });
      own.addEventListener("abort", abort, { once: true });
      if (signal?.aborted || own.aborted) linked.abort();
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (completed: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        linked.signal.removeEventListener("abort", cancelled);
        signal?.removeEventListener("abort", abort);
        own.removeEventListener("abort", abort);
        resolve(completed);
      };
      const cancelled = (): void => finish(false);
      const timer = setTimeout(() => finish(true), durationMs);
      linked.signal.addEventListener("abort", cancelled, { once: true });
      if (linked.signal.aborted) cancelled();
    });
  }
}
