/**
 * A live's skill windows on one lane over its note density and fever
 * sections. Windows are numbered in firing order; a window that overlaps the
 * previous one drops to a second lane instead of hiding it.
 */
import { html, nothing, svg, type TemplateResult } from "lit";
import "../../styles/components/skill-timeline.css";

export interface SkillTimelineWindow {
  startMs: number;
  endMs: number;
  /** Fill of the window; the primary colour when absent. */
  color?: string;
  image?: string;
  label: unknown;
  /** Trailing value in the event list. */
  value?: unknown;
}

export interface SkillTimelineOptions {
  label: string;
  durationMs: number;
  /** Note counts per `bucketMs`. */
  density: readonly number[];
  bucketMs?: number;
  fever: readonly (readonly [number, number])[];
  windows: readonly SkillTimelineWindow[];
  /** Label of each fever (Gekisou) section, drawn at its start. */
  feverLabel?: (index: number) => string;
}

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
export const skillSeconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function skillTimeline(options: SkillTimelineOptions): TemplateResult {
  const duration = Math.max(1, options.durationMs);
  const at = (ms: number) => `${Math.min(100, Math.max(0, (ms / duration) * 100)).toFixed(3)}%`;
  const bucket = options.bucketMs ?? 500;
  const peak = Math.max(1, ...options.density);
  const points = options.density.map((count, index) => `${((index * bucket) / duration) * 1000},${40 - (count / peak) * 40}`).join(" ");
  const windows = [...options.windows].sort((a, b) => a.startMs - b.startMs);
  const lanes: number[] = [];
  const placed = windows.map((window) => {
    let lane = lanes.findIndex((end) => end <= window.startMs);
    if (lane < 0) lane = lanes.length;
    lanes[lane] = window.endMs;
    return { window, lane };
  });
  const ticks = Array.from({ length: Math.floor(duration / 30000) + 1 }, (_, index) => index * 30000).filter((ms) => ms < duration);
  return html`
    <figure class="skill-timeline" style=${`--skill-lanes:${Math.max(1, lanes.length)}`}>
      <div class="skill-timeline__plot" role="img" aria-label=${options.label}>
        ${options.fever.map(
          ([start, end], index) =>
            html`<span class="skill-timeline__fever" style=${`inset-inline-start:${at(start)};width:calc(${at(end)} - ${at(start)})`}
              >${options.feverLabel?.(index) ?? nothing}</span
            >`,
        )}
        <svg class="skill-timeline__density" viewBox="0 0 1000 40" preserveAspectRatio="none" aria-hidden="true">
          ${svg`<polygon points=${`0,40 ${points} 1000,40`}></polygon>`}
        </svg>
        <div class="skill-timeline__lanes">
          ${placed.map(
            ({ window, lane }, index) => html`
              <span
                class="skill-timeline__window"
                style=${`inset-inline-start:${at(window.startMs)};width:max(14px, calc(${at(window.endMs)} - ${at(window.startMs)}));--lane:${lane};${window.color ? `--window-color:${window.color}` : ""}`}
                title=${`${index + 1} · ${skillSeconds(window.startMs)}–${skillSeconds(window.endMs)}`}
              >${index + 1}</span>
            `,
          )}
        </div>
      </div>
      <div class="skill-timeline__axis tabular" aria-hidden="true">
        ${ticks.map((ms) => html`<span style=${`inset-inline-start:${at(ms)}`}>${clock(ms)}</span>`)}
      </div>
      <ol class="skill-timeline__events" role="list">
        ${windows.map(
          (window, index) => html`
            <li style=${window.color ? `--window-color:${window.color}` : ""}>
              <span class="skill-timeline__index">${index + 1}</span>
              ${window.image ? html`<img src=${window.image} alt="" width="28" height="28" loading="lazy" decoding="async" />` : nothing}
              <span class="skill-timeline__label">${window.label}</span>
              <span class="skill-timeline__time tabular">${skillSeconds(window.startMs)}</span>
              ${window.value === undefined ? nothing : html`<strong class="tabular">${window.value}</strong>`}
            </li>
          `,
        )}
      </ol>
    </figure>
  `;
}
