/** Values serialized on AdvChatView in UIAdvChatWidget. */
export const ADV_CHAT_WINDOW_TRANSITION = Object.freeze({
  showDuration: 0.3,
  hideDuration: 0.2,
  ease: 18,
  screenModeDuration: 0.18,
  screenModeEase: 9,
});

export type AdvChatWindowTransitionKind = "show" | "hide";

export function advChatWindowTransitionSeconds(
  kind: AdvChatWindowTransitionKind,
  playbackRate: number,
  shouldShortcut: boolean,
): number {
  if (shouldShortcut) return 0;
  const duration = kind === "show" ? ADV_CHAT_WINDOW_TRANSITION.showDuration : ADV_CHAT_WINDOW_TRANSITION.hideDuration;
  return duration / Math.max(0.0001, Number(playbackRate) || 1);
}

/** DOTween Ease.OutExpo (enum value 18), including its exact end-point branch. */
export function evaluateAdvChatOutExpo(progress: number): number {
  const t = Math.max(0, Math.min(1, Number(progress) || 0));
  if (t === 1) return 1;
  return 1 - Math.pow(2, -10 * t);
}

/** DOTween Ease.OutCubic (enum value 9), used by screen-mode transforms. */
export function evaluateAdvChatOutCubic(progress: number): number {
  const t = Math.max(0, Math.min(1, Number(progress) || 0));
  return 1 - Math.pow(1 - t, 3);
}
