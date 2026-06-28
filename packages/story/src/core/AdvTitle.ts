import type { AdvStory } from "../types/AdvRuntime";

/**
 * the source `AdvTitle/Play` animator clip.
 * The first five seconds are a hold; the final second fades and translates
 * the title by -300 reference pixels with Unity's smoothstep tangents.
 */
export const ADV_TITLE_ANIMATION = Object.freeze({
  duration: 6,
  holdDuration: 5,
  exitX: -300,
});

export interface AdvTitleAnimationSample {
  opacity: number;
  x: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

/** Exact Hermite curve authored in the Unity title animator. */
export function sampleAdvTitleAnimation(elapsedSeconds: number): AdvTitleAnimationSample {
  const elapsed = Math.max(0, Number(elapsedSeconds) || 0);
  if (elapsed <= ADV_TITLE_ANIMATION.holdDuration) return { opacity: 1, x: 0 };
  const t = clamp01(elapsed - ADV_TITLE_ANIMATION.holdDuration);
  const smoothstep = t * t * (3 - 2 * t);
  return { opacity: 1 - smoothstep, x: ADV_TITLE_ANIMATION.exitX * smoothstep };
}

function flag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true";
}

export function isAdvStoryTitleHidden(story: AdvStory | null | undefined): boolean {
  return flag(story?.isHideTitle ?? story?.hideTitle);
}
