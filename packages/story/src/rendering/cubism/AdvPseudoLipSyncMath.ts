const OPEN_AGAIN_RATE = 0.75;
const OPEN_SCALE_MIN = 0.6;
const OPEN_SCALE_MAX = 1;
const OPEN_TIME_MIN = 0.05;
const OPEN_TIME_MAX = 0.15;
const CLOSE_TIME_MIN = 0.05;
const CLOSE_TIME_MAX = 0.15;
const OPEN_SMOOTH_TIME = 0.025;
const CLOSE_SMOOTH_TIME = 0.04;

export interface AdvPseudoLipSyncOscillatorState {
  speed: number;
  timer: number;
  openScale: number;
  isOpen: boolean;
  beforeLevel: number;
  dampVelocity: { value: number };
}

export interface AdvHoldOpenPseudoLipSyncStep {
  readonly deltaSeconds: number;
  /** Runtime SetPseudoLipSyncSpeed multiplier applied over the source speed. */
  readonly speedMultiplier?: number;
  /** CubismMouthController.MouthOpening before this update. */
  readonly currentMouthOpening: number;
  readonly manualLevel: number;
  readonly stopping?: boolean;
  readonly random: () => number;
}

export interface AdvPseudoLipSyncStep {
  readonly deltaSeconds: number;
  /** Runtime SetPseudoLipSyncSpeed multiplier applied over the source speed. */
  readonly speedMultiplier?: number;
  /** CubismMouthController.MouthOpening before this update. */
  readonly currentMouthOpening: number;
  readonly multiplier: number;
  readonly stopping?: boolean;
  readonly random: () => number;
}

export interface AdvPseudoLipSyncResult {
  /** `_beforeLevel * _pseudoLipSyncMultiplier`, before presentation policy. */
  readonly rawOpening: number;
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function lerp(left: number, right: number, amount: number): number {
  return left + (right - left) * amount;
}

/** Mathf.SmoothDamp with maxSpeed=Infinity, including Unity's overshoot rule. */
export function unitySmoothDamp(
  current: number,
  target: number,
  velocity: { value: number },
  smoothTime: number,
  deltaTime: number,
): number {
  const dt = Math.max(0, finite(deltaTime));
  const duration = Math.max(0.0001, finite(smoothTime, 0.0001));
  const omega = 2 / duration;
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const originalTarget = target;
  const change = current - target;
  const temporary = (velocity.value + omega * change) * dt;
  velocity.value = (velocity.value - omega * temporary) * decay;
  let output = target + (change + temporary) * decay;
  if (originalTarget - current > 0 === output > originalTarget) {
    output = originalTarget;
    velocity.value = dt > 0 ? (output - originalTarget) / dt : 0;
  }
  return output;
}

/**
 * Live2DLipSyncController.UpdateHoldOpenPseudoLipSync.
 *
 * The reference controller first damps its retained OpenScale toward the
 * clamped manual level. It then damps the output toward that scale, reusing
 * the same velocity reference for both operations. During the natural close
 * tail OpenScale is damped toward zero while IsOpen remains set.
 */
export function advanceAdvHoldOpenPseudoLipSync(
  state: AdvPseudoLipSyncOscillatorState,
  step: AdvHoldOpenPseudoLipSyncStep,
): AdvPseudoLipSyncResult {
  const deltaSeconds = Math.max(0, finite(step.deltaSeconds));
  const speed = Math.max(0.001, finite(state.speed, 1) * Math.max(0.001, finite(step.speedMultiplier ?? 1, 1)));
  const stopping = Boolean(step.stopping);
  const manualTarget = stopping ? 0 : Math.min(1, Math.max(0, finite(step.manualLevel, 1)));
  const manualSmoothTime = (stopping ? CLOSE_SMOOTH_TIME : OPEN_SMOOTH_TIME) / speed;
  state.openScale = unitySmoothDamp(
    finite(state.openScale),
    manualTarget,
    state.dampVelocity,
    manualSmoothTime,
    deltaSeconds,
  );

  if (stopping) {
    state.isOpen = true;
  } else {
    state.timer -= deltaSeconds * speed;
    if (state.timer <= 0) {
      state.isOpen = true;
      state.timer = lerp(OPEN_TIME_MIN, OPEN_TIME_MAX, step.random());
    }
  }

  const target = state.isOpen ? state.openScale : 0;
  const outputSmoothTime = (target > finite(step.currentMouthOpening) ? OPEN_SMOOTH_TIME : CLOSE_SMOOTH_TIME) / speed;
  state.beforeLevel = unitySmoothDamp(
    finite(state.beforeLevel),
    target,
    state.dampVelocity,
    outputSmoothTime,
    deltaSeconds,
  );
  return { rawOpening: state.beforeLevel };
}

/**
 * Live2DLipSyncController.UpdatePseudoLipSync.
 *
 * The random oscillator uses speed-scaled system delta. SmoothDamp uses the
 * unscaled Unity frame delta and divides its selected open/close time by Speed.
 * The pseudo multiplier is intentionally applied only after `_beforeLevel` is
 * smoothed; presentation-policy processing happens at the caller.
 */
export function advanceAdvPseudoLipSync(
  state: AdvPseudoLipSyncOscillatorState,
  step: AdvPseudoLipSyncStep,
): AdvPseudoLipSyncResult {
  const deltaSeconds = Math.max(0, finite(step.deltaSeconds));
  const speed = Math.max(0.001, finite(state.speed, 1) * Math.max(0.001, finite(step.speedMultiplier ?? 1, 1)));

  if (step.stopping) {
    state.isOpen = false;
  } else {
    state.timer -= deltaSeconds * speed;
    if (state.timer <= 0) {
      if (state.isOpen && step.random() > OPEN_AGAIN_RATE) {
        state.isOpen = false;
        state.timer = lerp(CLOSE_TIME_MIN, CLOSE_TIME_MAX, step.random());
      } else {
        state.isOpen = true;
        state.timer = lerp(OPEN_TIME_MIN, OPEN_TIME_MAX, step.random());
        state.openScale = lerp(OPEN_SCALE_MIN, OPEN_SCALE_MAX, step.random());
      }
    }
  }

  const target = state.isOpen ? state.openScale : 0;
  const smoothTime = (target > finite(step.currentMouthOpening) ? OPEN_SMOOTH_TIME : CLOSE_SMOOTH_TIME) / speed;
  state.beforeLevel = unitySmoothDamp(finite(state.beforeLevel), target, state.dampVelocity, smoothTime, deltaSeconds);
  return { rawOpening: state.beforeLevel * Math.max(0, finite(step.multiplier, 1)) };
}
