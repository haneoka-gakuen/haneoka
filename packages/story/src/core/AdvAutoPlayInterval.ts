export const AUTO_PLAY_INTERVAL_SECONDS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5] as const;

export type AdvAutoPlayInterval = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export const DEFAULT_AUTO_PLAY_INTERVAL: AdvAutoPlayInterval = 1;

export function normalizeAutoPlayInterval(
  value: unknown,
  fallback: AdvAutoPlayInterval = DEFAULT_AUTO_PLAY_INTERVAL,
): AdvAutoPlayInterval {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(AUTO_PLAY_INTERVAL_SECONDS.length - 1, Math.round(numeric))) as AdvAutoPlayInterval;
}

export function autoPlayIntervalSeconds(value: unknown): number {
  return AUTO_PLAY_INTERVAL_SECONDS[normalizeAutoPlayInterval(value)];
}

export function advAutoPlayReadDelaySeconds(
  minimumReadSeconds: number,
  textReadSeconds: number,
  remainingVoiceSeconds: number,
  intervalSeconds: number,
): number {
  return Math.max(minimumReadSeconds, textReadSeconds, remainingVoiceSeconds) + intervalSeconds;
}
