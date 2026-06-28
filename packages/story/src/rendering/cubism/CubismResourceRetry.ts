interface RetryState {
  failures: number;
  retryAtSeconds: number;
}

export function cubismRetryClockSeconds(): number {
  return (globalThis.performance?.now?.() ?? Date.now()) / 1000;
}

/** Frame-pumped retry state for browser resources backing one Cubism channel. */
export class CubismResourceRetrySchedule {
  private readonly states = new Map<string, RetryState>();

  constructor(
    private readonly baseDelaySeconds = 0.5,
    private readonly maximumDelaySeconds = 30,
  ) {}

  get empty(): boolean {
    return this.states.size === 0;
  }

  isDue(key: string, nowSeconds = cubismRetryClockSeconds()): boolean {
    const state = this.states.get(key);
    return !state || state.retryAtSeconds <= nowSeconds;
  }

  has(key: string): boolean {
    return this.states.has(key);
  }

  fail(key: string, nowSeconds = cubismRetryClockSeconds()): number {
    const state = this.states.get(key) || { failures: 0, retryAtSeconds: nowSeconds };
    state.failures += 1;
    state.retryAtSeconds =
      nowSeconds + Math.min(this.maximumDelaySeconds, this.baseDelaySeconds * 2 ** Math.min(6, state.failures - 1));
    this.states.set(key, state);
    return state.failures;
  }

  succeed(key: string): void {
    this.states.delete(key);
  }

  clear(): void {
    this.states.clear();
  }
}
