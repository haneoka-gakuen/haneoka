const MAX_REQUEST_ANIMATION_FRAME_DELTA_SECONDS = 0.1;
const FRAME_INTERVAL_EPSILON_SECONDS = 1e-8;

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Browser requestAnimationFrame adapter for Unity's Application.targetFrameRate.
 *
 * The scheduling remainder and elapsed scene time are deliberately independent:
 * the former decides whether this browser callback renders, while the latter is
 * consumed exactly once by the resulting Unity-equivalent update.
 */
export class UnityTargetFrameClock {
  private scheduleRemainderSeconds = 0;
  private updateElapsedSeconds = 0;

  reset(): void {
    this.scheduleRemainderSeconds = 0;
    this.updateElapsedSeconds = 0;
  }

  advance(elapsedSeconds: number, targetFrameRate: number): number | null {
    const elapsed = Math.max(0, Math.min(MAX_REQUEST_ANIMATION_FRAME_DELTA_SECONDS, finite(elapsedSeconds, 0)));
    const interval = 1 / Math.max(1, finite(targetFrameRate, 45));
    this.scheduleRemainderSeconds += elapsed;
    this.updateElapsedSeconds += elapsed;
    if (this.scheduleRemainderSeconds + FRAME_INTERVAL_EPSILON_SECONDS < interval) return null;

    // The epsilon can admit a value a few ulps below the interval. Treat that
    // as a consumed interval instead of `%` retaining an almost-full budget
    // and scheduling another update on the very next high-refresh callback.
    this.scheduleRemainderSeconds =
      this.scheduleRemainderSeconds >= interval ? this.scheduleRemainderSeconds % interval : 0;
    const updateDelta = this.updateElapsedSeconds;
    this.updateElapsedSeconds = 0;
    return updateDelta;
  }
}
