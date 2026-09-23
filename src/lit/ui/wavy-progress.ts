import { LitElement, html, svg, nothing, type TemplateResult } from "lit";

export interface WavyProgressOptions {
  value: number;
  thickness?: number;
  amplitude?: number;
  wavelength?: number;
  still?: boolean;
  label?: string;
}

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
const positive = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isFinite(value) ? Math.max(0, value) : fallback;
let sequence = 0;

export function rampedAmplitude(progress: number): number {
  const value = clamp01(progress);
  return value <= 0.1 || value >= 0.95 ? 0 : 1;
}

function wavePath(width: number, amplitude: number, wavelength: number): string {
  const step = wavelength / 24;
  const end = width + wavelength * 2;
  const points = [`M ${-wavelength} 0`];
  for (let x = -wavelength + step; x <= end; x += step)
    points.push(`L ${x.toFixed(3)} ${(-Math.sin((x / wavelength) * Math.PI * 2) * amplitude).toFixed(3)}`);
  return points.join(" ");
}

class WavyProgress extends LitElement {
  static properties = {
    options: { attribute: false },
    width: { state: true },
    reduced: { state: true },
  };
  declare options: WavyProgressOptions;
  declare width: number;
  declare reduced: boolean;
  private readonly clip = `haneoka-wave-${++sequence}`;
  private observer?: ResizeObserver;
  private media?: MediaQueryList;
  private shapeKey = "";
  private shapePath = "";
  private readonly onMotion = () => {
    this.reduced = this.media?.matches ?? false;
  };

  constructor() {
    super();
    this.options = { value: 0 };
    this.width = 0;
    this.reduced = false;
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (Math.abs(width - this.width) > 0.1) this.width = width;
    });
    this.observer.observe(this);
    this.media = matchMedia("(prefers-reduced-motion: reduce)");
    this.onMotion();
    this.media.addEventListener("change", this.onMotion);
  }
  disconnectedCallback() {
    this.observer?.disconnect();
    this.media?.removeEventListener("change", this.onMotion);
    super.disconnectedCallback();
  }
  render() {
    const value = clamp01(this.options.value);
    const thickness = Math.max(1, positive(this.options.thickness, 4));
    const peak = positive(this.options.amplitude, 6);
    const wavelength = Math.max(8, positive(this.options.wavelength, 40));
    const width = Math.max(1, this.width);
    const height = peak * 2 + thickness * 2;
    const middle = height / 2;
    const still = this.options.still || this.reduced;
    const amplitude = still ? 0 : rampedAmplitude(value);
    const edge = value * width;
    const active = value === 1 ? width : Math.max(0, edge - 2);
    const track = value === 0 ? thickness / 2 : Math.min(width, edge + 2 + thickness / 2);
    const label = this.options.label;
    const shapeKey = `${width}:${peak}:${wavelength}`;
    if (shapeKey !== this.shapeKey) {
      this.shapeKey = shapeKey;
      this.shapePath = wavePath(width, peak, wavelength);
    }
    return html`
      <div
        class=${`wavy-progress ${still ? "is-still" : ""}`}
        style=${`--wavy-thickness:${thickness}px;--wavy-wavelength:${wavelength}px;--wavy-height:${height}px`}
        role=${label ? "progressbar" : "presentation"}
        aria-label=${label ?? nothing}
        aria-valuemin=${label ? "0" : nothing}
        aria-valuemax=${label ? "100" : nothing}
        aria-valuenow=${label ? String(value * 100) : nothing}
      >
        ${svg`<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
          <defs><clipPath id=${this.clip}><rect x="0" y="0" width=${active} height=${height} rx=${thickness / 2} /></clipPath></defs>
          ${track < width && value < 1 ? svg`<path class="wavy-progress__track" d="M ${track} ${middle} L ${width - thickness / 2} ${middle}" />` : nothing}
          ${
            active > 0
              ? svg`<g clip-path=${`url(#${this.clip})`}><g transform="translate(0 ${middle})">
            <g class="wavy-progress__amplitude" style=${`transform:scaleY(${Math.max(0.001, amplitude)})`}>
              <path class="wavy-progress__wave" d=${this.shapePath} />
            </g>
          </g></g>`
              : nothing
          }
          ${value < 1 ? svg`<circle class="wavy-progress__stop" cx=${width - 2} cy=${middle} r="2" />` : nothing}
        </svg>`}
      </div>
    `;
  }
}
if (typeof customElements !== "undefined" && !customElements.get("haneoka-wavy-progress"))
  customElements.define("haneoka-wavy-progress", WavyProgress);

export function wavyProgress(options: WavyProgressOptions): TemplateResult {
  return html`
    <haneoka-wavy-progress .options=${options}></haneoka-wavy-progress>
  `;
}
