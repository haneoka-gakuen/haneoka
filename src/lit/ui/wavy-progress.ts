import { html, svg, type TemplateResult } from "lit";

/**
 * Material 3 Expressive wavy linear progress indicator.
 *
 * Anatomy, per the Expressive spec and the Android implementation
 * (`Widget.Material3Expressive.LinearProgressIndicator.Wavy`):
 *
 *   · the ACTIVE indicator is a wave; the remaining TRACK is a flat line;
 *   · a 4dp gap separates the two (`indicatorTrackGapSize`);
 *   · a 4dp stop indicator marks the end of the track
 *     (`trackStopIndicatorSize`), required when the track's contrast with
 *     its container is below 3:1;
 *   · the stroke is 4dp by default, 8dp for the thick variant, with a fully
 *     rounded cap (`trackCornerRadius: 50%`, or 4dp at 8dp thickness);
 *   · amplitude ramps in over progress 0.1–0.9
 *     (`waveAmplitudeRampProgressMin/Max`) so the wave flattens as it
 *     approaches either end — a full-amplitude wave at 0% or 100% would read
 *     as noise rather than motion;
 *   · the wave travels one wavelength per second (`waveSpeed = wavelength`).
 *
 * The wave is an SVG path recomputed per frame of progress, not a CSS
 * animation, because its geometry depends on the progress value. The scroll
 * is a single CSS transform on the path, so the browser animates it off the
 * main thread and a paused player costs nothing.
 *
 * Deliberately NOT wavy while paused: motion means "this is playing". A
 * static wave would be decoration, and the spec notes the shape reads poorly
 * at rest anyway.
 */

export interface WavyProgressOptions {
  /** 0–1. Values outside the range are clamped, as the spec requires. */
  value: number;
  /** Stroke thickness in px: 4 (default) or 8 (thick). */
  thickness?: number;
  /** Peak wave height in px, before the progress ramp is applied. */
  amplitude?: number;
  /** px per wave cycle. Android's determinate default is a long wave. */
  wavelength?: number;
  /** Flattens the wave and stops the scroll (paused / reduced motion). */
  still?: boolean;
  label?: string;
}

const RAMP_MIN = 0.1;
const RAMP_MAX = 0.9;
const GAP = 4;
const STOP = 4;
const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/**
 * Amplitude as a function of progress: zero at the ends, full in the middle.
 * Mirrors `WavyProgressIndicatorDefaults.indicatorAmplitude`.
 */
export function rampedAmplitude(progress: number): number {
  const value = clamp01(progress);
  if (value <= RAMP_MIN || value >= 1) return 0;
  if (value >= RAMP_MAX) return (1 - value) / (1 - RAMP_MAX);
  return Math.min(1, (value - RAMP_MIN) / (RAMP_MAX - RAMP_MIN));
}

/** Sine wave along `width`, sampled finely enough to stay smooth. */
function wavePath(width: number, midline: number, amplitude: number, wavelength: number): string {
  if (amplitude <= 0.01 || width <= 0) return `M 0 ${midline} L ${Math.max(0, width)} ${midline}`;
  // Whole cycles only, so the scrolling wave is continuous at the seam.
  const cycles = Math.max(1, Math.round(width / wavelength));
  const step = width / (cycles * 12);
  const points: string[] = [`M 0 ${midline}`];
  for (let x = step; x <= width + step / 2; x += step) {
    const at = Math.min(x, width);
    const y = midline - Math.sin((at / width) * cycles * Math.PI * 2) * amplitude;
    points.push(`L ${at.toFixed(2)} ${y.toFixed(2)}`);
  }
  return points.join(" ");
}

export function wavyProgress(options: WavyProgressOptions): TemplateResult {
  const value = clamp01(options.value);
  const thickness = options.thickness ?? 4;
  const wavelength = options.wavelength ?? 40;
  const height = (options.amplitude ?? 6) * 2 + thickness * 2;
  const midline = height / 2;
  // A viewBox in px with a 100-unit width lets the same path scale to any
  // container while the stroke stays a true thickness via vector-effect.
  const width = 100;
  const activeWidth = Math.max(0, value * width - (value > 0 && value < 1 ? GAP / 2 : 0));
  const trackStart = Math.min(width, value * width + GAP / 2);
  const amplitude = options.still ? 0 : rampedAmplitude(value) * (options.amplitude ?? 6);

  return html`
    <div
      class=${`wavy-progress ${options.still ? "is-still" : ""}`}
      style=${`--wavy-thickness:${thickness}px;--wavy-wavelength:${wavelength}px`}
      role="presentation"
    >
      ${svg`
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
          <!-- Remaining track: flat, starting after the 4dp gap. -->
          ${
            trackStart < width
              ? svg`<path class="wavy-progress__track" d="M ${trackStart} ${midline} L ${width} ${midline}" />`
              : svg``
          }
          <!-- Active indicator: the wave, clipped to the played portion. -->
          ${
            activeWidth > 0
              ? svg`
                  <path
                    class="wavy-progress__wave"
                    d=${wavePath(width, midline, amplitude, wavelength)}
                    style=${`clip-path: inset(0 ${(100 - (activeWidth / width) * 100).toFixed(3)}% 0 0)`}
                  />
                `
              : svg``
          }
          <!-- Stop indicator at the end of the track. -->
          ${
            value < 1
              ? svg`<circle class="wavy-progress__stop" cx=${width - STOP / 2} cy=${midline} r=${STOP / 2} />`
              : svg``
          }
        </svg>
      `}
    </div>
  `;
}
