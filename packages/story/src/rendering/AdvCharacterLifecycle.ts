export function registerCharacterItem<T>(
  items: Map<string, T>,
  target: string,
  item: T,
  applyCurrentRendererState: () => void,
): void {
  items.set(target, item);
  // The item must inherit the active light/blur/brightness state before its first visible frame.
  applyCurrentRendererState();
}

export type UnityCharacterFadeOptions = {
  from: number;
  to: number;
  duration: number;
  /** Browser lazy-load restoration resumes after Unity's three-frame gate. */
  delayFrames?: number;
  /** Progress already elapsed before an asynchronously loaded controller became available. */
  startRaw?: number;
  setAlpha: (alpha: number) => void;
  waitFrame: () => Promise<void>;
  tween: (duration: number, update: (progress: number) => void) => Promise<void>;
};

/** FadeCharacterAsync waits three Update frames before starting its DOTween. */
export const UNITY_CHARACTER_FADE_DELAY_FRAMES = 3;

export function unityCharacterFadeDuration(kind: "in" | "out", rawDuration: number, shouldShortCut: boolean) {
  const duration = Math.max(0, Number(rawDuration) || 0);
  if (duration > 0 || kind === "in" || shouldShortCut) return duration;
  return 0.05;
}

/**
 * Mirrors AdvFieldRendererManager's cancellation-token source per character position. A new fade
 * owns that position immediately, including the exact from-alpha write made before DelayFrame(3).
 */
export class UnityCharacterFadeCoordinator {
  private versions = new Map<number, number>();

  cancel(positionType: number) {
    const key = Number(positionType) || 0;
    this.versions.set(key, (this.versions.get(key) || 0) + 1);
  }

  async fade(positionType: number, options: UnityCharacterFadeOptions) {
    const key = Number(positionType) || 0;
    const version = (this.versions.get(key) || 0) + 1;
    this.versions.set(key, version);
    const ownsPosition = () => this.versions.get(key) === version;
    const setAlpha = (alpha: number) => {
      if (ownsPosition()) options.setAlpha(Math.max(0, Math.min(1, Number(alpha) || 0)));
    };

    const from = Math.max(0, Math.min(1, Number(options.from) || 0));
    const to = Math.max(0, Math.min(1, Number(options.to) || 0));
    const startRaw = Math.max(0, Math.min(1, Number(options.startRaw) || 0));
    setAlpha(from + (to - from) * startRaw);
    const delayFrames = Math.max(0, Math.trunc(options.delayFrames ?? UNITY_CHARACTER_FADE_DELAY_FRAMES));
    for (let frame = 0; frame < delayFrames; frame += 1) {
      await options.waitFrame();
      if (!ownsPosition()) return false;
    }

    if (options.duration <= 0) {
      setAlpha(to);
      return ownsPosition();
    }
    await options.tween(options.duration, (progress) => {
      const resumed = startRaw + (1 - startRaw) * (Number(progress) || 0);
      const t = Math.max(0, Math.min(1, resumed));
      setAlpha(from + (to - from) * t);
    });
    return ownsPosition();
  }
}
