const c1 = 1.70158;
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const n1 = 7.5625;
const d1 = 2.75;
type EaseFn = (x: number) => number;

function outBounce(x: number) {
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}

export const DOTWEEN_EASE_BY_ENUM: Readonly<Record<number, EaseFn>> = Object.freeze({
  1: (x: number) => x,
  2: (x: number) => 1 - Math.cos((x * Math.PI) / 2),
  3: (x: number) => Math.sin((x * Math.PI) / 2),
  4: (x: number) => -(Math.cos(Math.PI * x) - 1) / 2,
  5: (x: number) => x * x,
  6: (x: number) => 1 - (1 - x) * (1 - x),
  7: (x: number) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2),
  8: (x: number) => x * x * x,
  9: (x: number) => 1 - (1 - x) ** 3,
  10: (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2),
  11: (x: number) => x ** 4,
  12: (x: number) => 1 - (1 - x) ** 4,
  13: (x: number) => (x < 0.5 ? 8 * x ** 4 : 1 - (-2 * x + 2) ** 4 / 2),
  14: (x: number) => x ** 5,
  15: (x: number) => 1 - (1 - x) ** 5,
  16: (x: number) => (x < 0.5 ? 16 * x ** 5 : 1 - (-2 * x + 2) ** 5 / 2),
  17: (x: number) => (x === 0 ? 0 : 2 ** (10 * x - 10)),
  18: (x: number) => (x === 1 ? 1 : 1 - 2 ** (-10 * x)),
  19: (x: number) => (x === 0 ? 0 : x === 1 ? 1 : x < 0.5 ? 2 ** (20 * x - 10) / 2 : (2 - 2 ** (-20 * x + 10)) / 2),
  20: (x: number) => 1 - Math.sqrt(1 - x * x),
  21: (x: number) => Math.sqrt(1 - (x - 1) * (x - 1)),
  22: (x: number) => (x < 0.5 ? (1 - Math.sqrt(1 - (2 * x) ** 2)) / 2 : (Math.sqrt(1 - (-2 * x + 2) ** 2) + 1) / 2),
  26: (x: number) => c3 * x * x * x - c1 * x * x,
  27: (x: number) => 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2,
  28: (x: number) =>
    x < 0.5 ? ((2 * x) ** 2 * ((c2 + 1) * 2 * x - c2)) / 2 : ((2 * x - 2) ** 2 * ((c2 + 1) * (x * 2 - 2) + c2) + 2) / 2,
  29: (x: number) => 1 - outBounce(1 - x),
  30: outBounce,
  31: (x: number) => (x < 0.5 ? (1 - outBounce(1 - 2 * x)) / 2 : (1 + outBounce(2 * x - 1)) / 2),
});

const EASE_NAME_TO_ENUM: Readonly<Record<string, number>> = Object.freeze({
  linear: 1,
  insine: 2,
  outsine: 3,
  inoutsine: 4,
  inquad: 5,
  outquad: 6,
  inoutquad: 7,
  incubic: 8,
  outcubic: 9,
  inoutcubic: 10,
  inquart: 11,
  outquart: 12,
  inoutquart: 13,
  inquint: 14,
  outquint: 15,
  inoutquint: 16,
  inexpo: 17,
  outexpo: 18,
  inoutexpo: 19,
  incirc: 20,
  outcirc: 21,
  inoutcirc: 22,
  inback: 26,
  outback: 27,
  inoutback: 28,
  inbounce: 29,
  outbounce: 30,
  inoutbounce: 31,
});

export function resolveEase(value: unknown, fallback = 6): EaseFn {
  if (value == null || value === "") return DOTWEEN_EASE_BY_ENUM[fallback] || DOTWEEN_EASE_BY_ENUM[6];
  const numeric = Number(value);
  if (Number.isFinite(numeric) && DOTWEEN_EASE_BY_ENUM[numeric]) return DOTWEEN_EASE_BY_ENUM[numeric];
  const key = String(value)
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  return DOTWEEN_EASE_BY_ENUM[EASE_NAME_TO_ENUM[key]] || DOTWEEN_EASE_BY_ENUM[fallback] || DOTWEEN_EASE_BY_ENUM[6];
}

export function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export function tween({
  duration = 0,
  ease = (x: number) => x,
  update,
  signal,
}: {
  duration?: number;
  ease?: (x: number) => number;
  update?: (eased: number, raw: number) => void;
  signal?: AbortSignal;
}) {
  const seconds = Math.max(0, Number(duration) || 0);
  if (seconds <= 0) {
    update?.(1, 1);
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const start = performance.now();
    let frame = 0;
    let settled = false;
    const stop = () => {
      if (settled) return;
      settled = true;
      if (frame) cancelAnimationFrame(frame);
      signal?.removeEventListener("abort", stop);
      resolve();
    };
    if (signal?.aborted) {
      stop();
      return;
    }
    signal?.addEventListener("abort", stop, { once: true });
    const tick = (now: number) => {
      if (signal?.aborted) {
        stop();
        return;
      }
      const raw = clamp01((now - start) / (seconds * 1000));
      update?.(ease(raw), raw);
      if (raw >= 1) {
        stop();
      } else {
        frame = requestAnimationFrame(tick);
      }
    };
    frame = requestAnimationFrame(tick);
  });
}
