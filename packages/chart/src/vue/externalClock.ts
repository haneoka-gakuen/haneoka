export const EXTERNAL_CLOCK_BACKWARD_TOLERANCE_MS = 5;
export const EXTERNAL_CLOCK_JUMP_RESET_MS = 250;

export function normalizeExternalTimeMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Controlled playback normally advances once per owner frame. Paused changes
 * are seeks, while a backwards step or a large playing step is a timeline
 * discontinuity that must not replay every skipped judgement/effect.
 */
export function shouldResetExternalTimeline(previousMs: number, nextMs: number, playing: boolean): boolean {
  const delta = nextMs - previousMs;
  if (Math.abs(delta) <= Number.EPSILON) return false;
  if (!playing) return true;
  return delta < -EXTERNAL_CLOCK_BACKWARD_TOLERANCE_MS || delta > EXTERNAL_CLOCK_JUMP_RESET_MS;
}
