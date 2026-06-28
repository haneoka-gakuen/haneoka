function finite(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/** Resolves Unity's negative “use the clip setting” sentinel for the Web SDK. */
export function resolveCubismFadeIn(requestedSeconds: unknown, authoredSeconds: unknown): number {
  const requested = finite(requestedSeconds, -1);
  if (requested >= 0) return requested;
  return Math.max(0, finite(authoredSeconds, 0));
}
