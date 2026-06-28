import { Color, Texture } from "three";
import type { UnityAnimationCurve, UnityAnimationCurveKeyframe } from "../../../types/AdvRuntime";

const WEIGHTED_IN = 1;
const WEIGHTED_OUT = 2;
const DEFAULT_WEIGHT = 1 / 3;
const CURVE_EPSILON = 1e-7;

function cubicBezier(a: number, b: number, c: number, d: number, t: number): number {
  const inverse = 1 - t;
  return inverse * inverse * inverse * a + 3 * inverse * inverse * t * b + 3 * inverse * t * t * c + t * t * t * d;
}

function cubicBezierDerivative(a: number, b: number, c: number, d: number, t: number): number {
  const inverse = 1 - t;
  return 3 * inverse * inverse * (b - a) + 6 * inverse * t * (c - b) + 3 * t * t * (d - c);
}

function weightedSegment(left: UnityAnimationCurveKeyframe, right: UnityAnimationCurveKeyframe, time: number): number {
  const duration = right.time - left.time;
  const leftWeight = left.weightedMode & WEIGHTED_OUT ? finite(left.outWeight, DEFAULT_WEIGHT) : DEFAULT_WEIGHT;
  const rightWeight = right.weightedMode & WEIGHTED_IN ? finite(right.inWeight, DEFAULT_WEIGHT) : DEFAULT_WEIGHT;
  const x0 = left.time;
  const x1 = left.time + duration * leftWeight;
  const x2 = right.time - duration * rightWeight;
  const x3 = right.time;
  const y0 = left.value;
  const y1 = left.value + finite(left.outSlope) * duration * leftWeight;
  const y2 = right.value - finite(right.inSlope) * duration * rightWeight;
  const y3 = right.value;

  let parameter = Math.max(0, Math.min(1, (time - x0) / duration));
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const error = cubicBezier(x0, x1, x2, x3, parameter) - time;
    if (Math.abs(error) <= CURVE_EPSILON) break;
    const derivative = cubicBezierDerivative(x0, x1, x2, x3, parameter);
    if (Math.abs(derivative) <= CURVE_EPSILON) break;
    const candidate = parameter - error / derivative;
    if (candidate < 0 || candidate > 1) break;
    parameter = candidate;
  }

  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const x = cubicBezier(x0, x1, x2, x3, parameter);
    if (Math.abs(x - time) <= CURVE_EPSILON) break;
    if (x < time) low = parameter;
    else high = parameter;
    parameter = (low + high) * 0.5;
  }
  return cubicBezier(y0, y1, y2, y3, parameter);
}

function hermiteSegment(left: UnityAnimationCurveKeyframe, right: UnityAnimationCurveKeyframe, time: number): number {
  const duration = right.time - left.time;
  const t = (time - left.time) / duration;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return (
    h00 * left.value +
    h10 * duration * finite(left.outSlope) +
    h01 * right.value +
    h11 * duration * finite(right.inSlope)
  );
}

/** Evaluates Unity's unweighted Hermite and weighted Bezier curve segments. */
export function evaluateUnityAnimationCurve(curve: UnityAnimationCurve | undefined, time: number): number {
  const keys = curve?.keys;
  if (!keys?.length) return Math.max(0, Math.min(1, finite(time)));
  if (keys.length === 1) return finite(keys[0].value);
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (time <= first.time) return finite(first.value);
  if (time >= last.time) return finite(last.value);

  for (let index = 0; index < keys.length - 1; index += 1) {
    const left = keys[index];
    const right = keys[index + 1];
    if (time > right.time) continue;
    if (right.time - left.time <= CURVE_EPSILON) return finite(right.value);
    if (!Number.isFinite(left.outSlope) || !Number.isFinite(right.inSlope)) return finite(left.value);
    if (left.weightedMode & WEIGHTED_OUT || right.weightedMode & WEIGHTED_IN) {
      return weightedSegment(left, right, time);
    }
    return hermiteSegment(left, right, time);
  }
  return finite(last.value);
}

export const RULE_TRANSITION_FROM_VALUE = 1;
export const RULE_TRANSITION_TO_VALUE = -1;

export interface AdvRuleTransitionRenderState {
  readonly texture: Texture;
  readonly color: Color;
  readonly colorAlpha: number;
  readonly value: number;
  readonly useGradient: boolean;
  readonly visible: boolean;
}

export interface AdvRuleTransitionPlayOptions {
  readonly texture: Texture;
  readonly color: Readonly<{ r: number; g: number; b: number; a: number }>;
  readonly duration: number;
  readonly curve?: UnityAnimationCurve;
  readonly useGradient: boolean;
  readonly fadeOut: boolean;
}

interface ActiveTransition {
  readonly curve?: UnityAnimationCurve;
  readonly duration: number;
  readonly startValue: number;
  readonly endValue: number;
  readonly fadeOut: boolean;
  readonly resolve: () => void;
  current: number;
  completeOnNextUpdate: boolean;
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Exact scalar alpha emitted by the compiled UI/Transition GLES3 shader. */
export function unityRuleTransitionAlpha(
  ruleSample: number,
  value: number,
  useGradient: boolean,
  colorAlpha = 1,
): number {
  const unclamped = useGradient
    ? (finite(ruleSample) - (finite(value) * 0.600000024 + 0.400000006)) * 5
    : (1 - finite(value)) * 0.5;
  const t = Math.max(0, Math.min(1, unclamped));
  return t * t * (3 - 2 * t) * finite(colorAlpha, 1);
}

/**
 * Frame-loop controller for Fwk.UI.UIRuleTransitionView.Animate.
 *
 * It intentionally evaluates at current/duration, advances with the story
 * loop delta, yields one frame, and only then writes the terminal value. That
 * is the order produced by the iterator's MoveNext.
 */
export class AdvRuleTransitionController {
  private texture: Texture | null = null;
  private readonly color = new Color(0, 0, 0);
  private colorAlpha = 1;
  private value = RULE_TRANSITION_FROM_VALUE;
  private useGradient = false;
  private visible = false;
  private active: ActiveTransition | null = null;

  get renderState(): AdvRuleTransitionRenderState | null {
    if (!this.visible || !this.texture) return null;
    return {
      texture: this.texture,
      color: this.color,
      colorAlpha: this.colorAlpha,
      value: this.value,
      useGradient: this.useGradient,
      visible: true,
    };
  }

  play(options: AdvRuleTransitionPlayOptions): Promise<void> {
    this.finishActive();
    this.texture = options.texture;
    this.color.setRGB(options.color.r, options.color.g, options.color.b);
    this.colorAlpha = finite(options.color.a, 1);
    this.useGradient = options.useGradient;
    this.visible = true;
    const startValue = options.fadeOut ? RULE_TRANSITION_FROM_VALUE : RULE_TRANSITION_TO_VALUE;
    const endValue = options.fadeOut ? RULE_TRANSITION_TO_VALUE : RULE_TRANSITION_FROM_VALUE;
    this.value = startValue;
    const duration = Math.max(0, finite(options.duration));
    if (duration <= 0) {
      this.value = endValue;
      if (!options.fadeOut) this.visible = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.active = {
        curve: options.curve,
        duration,
        startValue,
        endValue,
        fadeOut: options.fadeOut,
        resolve,
        current: 0,
        completeOnNextUpdate: false,
      };
    });
  }

  update(deltaSeconds: number): void {
    const active = this.active;
    if (!active) return;
    if (active.completeOnNextUpdate) {
      this.value = active.endValue;
      if (!active.fadeOut) this.visible = false;
      this.active = null;
      active.resolve();
      return;
    }
    const normalized = active.current / active.duration;
    const eased = evaluateUnityAnimationCurve(active.curve, normalized);
    this.value = active.startValue + (active.endValue - active.startValue) * eased;
    active.current += Math.max(0, finite(deltaSeconds));
    if (active.current >= active.duration) active.completeOnNextUpdate = true;
  }

  clear(): void {
    this.finishActive();
    this.visible = false;
    this.texture = null;
  }

  private finishActive(): void {
    if (!this.active) return;
    const active = this.active;
    this.active = null;
    active.resolve();
  }
}
