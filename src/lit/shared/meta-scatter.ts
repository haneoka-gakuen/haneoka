/** Charts as points: the official level or another metric across, one metric up, coloured by difficulty. */
import { html, svg, type TemplateResult } from "lit";
import "../../styles/components/meta-scatter.css";

export interface ScatterPoint {
  x: number;
  y: number;
  difficulty: string;
  label: string;
  href?: string;
}

const W = 960;
const H = 480;
const PAD = { left: 64, right: 16, top: 16, bottom: 40 };

function ticks(min: number, max: number, count: number) {
  const span = Math.max(1e-9, max - min);
  const raw = span / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((value) => value >= raw) ?? raw;
  const out: number[] = [];
  for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-6; value += step) out.push(Number(value.toFixed(10)));
  return out;
}

/** Without `xFormat` the horizontal axis is the official level, in whole steps. */
export function metaScatter(options: { points: readonly ScatterPoint[]; xLabel: string; yLabel: string; format: (value: number) => string; xFormat?: (value: number) => string; label: string }): TemplateResult {
  const points = options.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (!points.length) return html``;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const xPad = options.xFormat ? (Math.max(...xs) - Math.min(...xs)) * 0.05 || 1 : 0;
  const xMin = options.xFormat ? Math.min(...xs) - xPad : Math.floor(Math.min(...xs));
  const xMax = options.xFormat ? Math.max(...xs) + xPad : Math.ceil(Math.max(...xs));
  const yPad = (Math.max(...ys) - Math.min(...ys)) * 0.05 || 1;
  const yMin = Math.min(...ys) - yPad, yMax = Math.max(...ys) + yPad;
  const x = (value: number) => PAD.left + ((value - xMin) / (options.xFormat ? xMax - xMin : Math.max(1, xMax - xMin))) * (W - PAD.left - PAD.right);
  const y = (value: number) => H - PAD.bottom - ((value - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);
  const xTicks = options.xFormat ? ticks(xMin, xMax, 8) : ticks(xMin, xMax, 12).filter((value) => Number.isInteger(value));
  const yTicks = ticks(yMin, yMax, 6);
  return html`
    <figure class="meta-scatter">
      <svg viewBox=${`0 0 ${W} ${H}`} role="img" aria-label=${options.label}>
        ${yTicks.map(
          (value) => svg`<line class="meta-scatter__grid" x1=${PAD.left} x2=${W - PAD.right} y1=${y(value)} y2=${y(value)}></line>
            <text class="meta-scatter__tick" x=${PAD.left - 8} y=${y(value)} text-anchor="end" dominant-baseline="middle">${options.format(value)}</text>`,
        )}
        ${xTicks.map(
          (value) => svg`<line class="meta-scatter__grid" x1=${x(value)} x2=${x(value)} y1=${PAD.top} y2=${H - PAD.bottom}></line>
            <text class="meta-scatter__tick" x=${x(value)} y=${H - PAD.bottom + 18} text-anchor="middle">${options.xFormat ? options.xFormat(value) : value}</text>`,
        )}
        <text class="meta-scatter__axis" x=${W - PAD.right} y=${H - 6} text-anchor="end">${options.xLabel}</text>
        <text class="meta-scatter__axis" x=${PAD.left} y=${PAD.top - 4}>${options.yLabel}</text>
        ${points.map((point) => {
          const dot = svg`<circle class="meta-scatter__dot" cx=${x(point.x)} cy=${y(point.y)} r="6"
            style=${`--dot:var(--md-extended-color-difficulty-${point.difficulty === "special" ? "master" : point.difficulty})`}><title>${point.label}</title></circle>`;
          return point.href ? svg`<a href=${point.href} aria-label=${point.label}>${dot}</a>` : dot;
        })}
      </svg>
    </figure>
  `;
}
