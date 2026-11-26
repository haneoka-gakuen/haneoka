// L3 — GEB
// Input: Selected region's event window and manually entered point and playtime targets.
// Output: Remaining PT, minimum pace, and optional play count.
// Pos: [Map](L2-2.md); calculator rendered inside the event tracker.
// Effects/Dependencies: Keeps its draft in the mounted event tab; no network or storage.
import { html, LitElement, nothing } from "lit";
import "@material/web/button/filled-button.js";
import "@material/web/textfield/outlined-text-field.js";
import { clientText } from "../i18n/client";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import { specList } from "./ui/spec";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function points(value: string, minimum: bigint) {
  if (!/^\d{1,19}$/u.test(value)) return null;
  const amount = BigInt(value);
  return amount >= minimum ? amount : null;
}

function divideUp(numerator: bigint, denominator: bigint) {
  return (numerator + denominator - 1n) / denominator;
}

type PaceInput = "current" | "target" | "minutes" | "perPlay";
interface PaceResult {
  remaining: bigint;
  hourly: bigint;
  plays: bigint | null;
}

export class EventPacePlanner extends LitElement {
  static properties = {
    locale: { type: String },
    startAtMs: { type: Number },
    endAtMs: { type: Number },
    initialPerPlay: { type: String },
    ended: { type: Boolean },
    errors: { state: true },
    result: { state: true },
  };

  declare locale: string;
  declare startAtMs: number;
  declare endAtMs: number;
  declare initialPerPlay: string;
  declare ended: boolean;
  declare private errors: Partial<Record<PaceInput, string>>;
  declare private result: PaceResult | null;

  constructor() {
    super();
    this.locale = "en";
    this.startAtMs = 0;
    this.endAtMs = 0;
    this.initialPerPlay = "";
    this.ended = false;
    this.errors = {};
    this.result = null;
  }

  createRenderRoot() {
    return this;
  }

  async useRankTarget(value: string) {
    await this.updateComplete;
    const field = this.querySelector<HTMLElement & { value: string }>("#event-pace-target");
    if (!field) return;
    field.value = value;
    field.dispatchEvent(new Event("input"));
    field.focus();
  }

  private label(key: string, fallback: string) {
    return clientText(this.locale, `tools.eventTracker.pace.${key}`, fallback);
  }

  private calculate(event: SubmitEvent) {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const input = (name: PaceInput) => String(form.get(name) ?? "").trim();
    const current = points(input("current"), 0n);
    const target = points(input("target"), 1n);
    const perPlayInput = input("perPlay");
    const perPlay = points(perPlayInput, 1n);
    const minutesInput = input("minutes");
    const minutes = /^\d+$/u.test(minutesInput) ? Number(minutesInput) : 0;
    const remainingMs = this.endAtMs - Math.max(Date.now(), this.startAtMs);
    const playtimeMs = minutesInput ? minutes * MINUTE_MS : remainingMs;

    const errors: Partial<Record<PaceInput, string>> = {};
    if (current === null) errors.current = this.label("invalidCurrent", "Enter current PT as a whole number.");
    if (target === null) errors.target = this.label("invalidTarget", "Enter target PT as a positive whole number.");
    if (minutesInput && (!minutes || playtimeMs > remainingMs)) {
      errors.minutes = this.label("invalidMinutes", "Enter whole minutes within the remaining event time.");
    }
    if (perPlayInput && perPlay === null) {
      errors.perPlay = this.label("invalidPerPlay", "Enter PT per play as a positive whole number.");
    }
    this.errors = errors;
    this.result = null;
    if (remainingMs <= 0) {
      this.ended = true;
      return;
    }
    void this.updateComplete.then(() => {
      const panel = this.querySelector<HTMLElement>("#event-pace-result");
      panel?.focus({ preventScroll: true });
      panel?.scrollIntoView({ block: "nearest" });
    });
    if (current === null || target === null || Object.keys(errors).length) return;

    const remaining = target > current ? target - current : 0n;
    this.result = {
      remaining,
      hourly: divideUp(remaining * BigInt(HOUR_MS), BigInt(playtimeMs)),
      plays: perPlay === null ? null : divideUp(remaining, perPlay),
    };
  }

  private field(name: PaceInput, label: string, value = "") {
    return html`
      <md-outlined-text-field
        id=${`event-pace-${name}`}
        name=${name}
        label=${label}
        inputmode="numeric"
        value=${value}
        ?error=${Boolean(this.errors[name])}
        @input=${() => {
          this.result = null;
          if (this.errors[name]) this.errors = { ...this.errors, [name]: undefined };
        }}
      ></md-outlined-text-field>
    `;
  }

  render() {
    if (this.ended) {
      return html`<p class="surface">${clientText(this.locale, "tools.eventTracker.ended", "Event ended")}</p>`;
    }
    const format = (value: bigint | null | undefined) => value == null ? "—" : value.toLocaleString(this.locale);
    return html`
      <div class="grid grid--fit" style="--grid-min: 20rem">
        <form class="surface stack field-stack" novalidate @submit=${this.calculate}>
          ${renderDetailSectionHeading(this.label("goal", "Event goal"), "stats")}
          ${this.field("current", this.label("current", "Current PT"), "0")}
          ${this.field("target", this.label("target", "Target PT"))}
          ${this.field("minutes", this.label("minutes", "Playtime in minutes (optional)"))}
          ${this.field("perPlay", this.label("perPlay", "PT per play (optional)"), this.initialPerPlay)}
          <md-filled-button type="submit">${this.label("calculate", "Calculate")}</md-filled-button>
        </form>
        <section id="event-pace-result" class="surface stack" tabindex="-1">
          ${renderDetailSectionHeading(this.label("requiredPace", "Required pace"), "stats")}
          <div role="status">
            ${specList([
              { label: this.label("remaining", "PT remaining"), value: format(this.result?.remaining) },
              { label: this.label("hourly", "PT per hour"), value: format(this.result?.hourly) },
              { label: this.label("plays", "Plays required"), value: format(this.result?.plays) },
            ], { numeric: true })}
          </div>
          ${Object.values(this.errors).some(Boolean) ? html`
            <ul role="alert" class="stack stack--tight">
              ${Object.entries(this.errors).map(([name, message]) => message ? html`
                <li><a href=${`#event-pace-${name}`} @click=${(event: MouseEvent) => {
                  event.preventDefault();
                  this.querySelector<HTMLElement>(`#event-pace-${name}`)?.focus();
                }}>${message}</a></li>
              ` : nothing)}
            </ul>` : nothing}
        </section>
      </div>
    `;
  }
}

if (!customElements.get("event-pace-planner")) customElements.define("event-pace-planner", EventPacePlanner);
