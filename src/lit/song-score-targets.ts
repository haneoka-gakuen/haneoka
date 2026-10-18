import { LitElement, html, nothing } from "lit";
import { clientText } from "../i18n/client";
import {
  liveWeights,
  slotOrderRates,
  slotPowerNeeded,
  slotReach,
  type ChartRates,
  type DeckSlot,
} from "../lib/chart-rates";
import { DEFAULT_DECK, rememberDeck, rememberedDeck, type Deck } from "../lib/deck-state";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";

/** The selected chart's score ranks in a Live: the score each needs and the power a deck needs for it. */
export class SongScoreTargets extends LitElement {
  static properties = {
    rates: { attribute: false },
    greatFactor: { attribute: false },
    locale: { type: String },
    href: { type: String },
    deck: { state: true },
  };
  declare rates: ChartRates | null;
  declare greatFactor: number;
  declare locale: string;
  /** Song analysis, where the same deck scores every chart. */
  declare href: string;
  declare deck: Deck;
  constructor() {
    super();
    this.rates = null;
    this.greatFactor = 0.8;
    this.locale = "ja";
    this.href = "";
    this.deck = DEFAULT_DECK;
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.classList.add("detail-section", "song-detail-section", "song-score-targets");
    this.deck = rememberedDeck();
  }
  private text(key: string, fallback: string) {
    return clientText(this.locale, `catalog.analysis.fields.${key}`, fallback);
  }
  private set(change: Partial<Deck>) {
    this.deck = { ...this.deck, ...change };
    rememberDeck(this.deck);
  }
  private number(value: number, label: string, max: number, step: string, apply: (value: number) => void) {
    return html`
      <label>
        ${label}
        <input
          type="number"
          min="0"
          max=${max}
          step=${step}
          inputmode="decimal"
          .value=${String(Math.round(value * 100) / 100)}
          @change=${(event: Event) => {
            const parsed = Number((event.target as HTMLInputElement).value);
            if (Number.isFinite(parsed) && parsed >= 0 && parsed <= max) apply(parsed);
          }}
        />
      </label>
    `;
  }
  render() {
    const rates = this.rates;
    if (!rates) return nothing;
    const deck = this.deck;
    const names = ["", "E", "D", "C", "B", "A", "S", "SS"];
    const number = new Intl.NumberFormat(this.locale);
    const percent = new Intl.NumberFormat(this.locale, { style: "percent", maximumFractionDigits: 1 });
    const orders = slotOrderRates(liveWeights(rates, deck.great / 100, this.greatFactor), deck.slots);
    const slot = (index: number, change: Partial<DeckSlot>) =>
      this.set({ slots: deck.slots.map((entry, at) => (at === index ? { ...entry, ...change } : entry)) });
    const ranks = rates.ranks.filter(([rank]) => rank >= 3).reverse();
    return html`
      ${renderDetailSectionHeading(this.text("powerNeeded", "Power needed"), "stats")}
      <div
        class="table-scroll"
        role="region"
        tabindex="0"
        aria-label=${this.text("powerNeeded", "Power needed")}
        data-scroll-region
      >
        <table class="data-table">
          <thead>
            <tr>
              <th scope="col">${this.text("deckRank", "Target rank")}</th>
              <th scope="col" class="is-numeric">${this.text("rankScore", "Score")}</th>
              <th scope="col" class="is-numeric">${this.text("averageOrder", "Average of the orders")}</th>
              <th scope="col" class="is-numeric">${this.text("everyOrder", "Every order")}</th>
              <th scope="col" class="is-numeric">${this.text("bestOrder", "Best order")}</th>
              <th scope="col" class="is-numeric">${this.text("metaDeckReach", "Reach rate")}</th>
            </tr>
          </thead>
          <tbody>
            ${ranks.map(([rank, required]) => {
              const need = slotPowerNeeded(required, orders, rates.notes);
              return html`
                <tr>
                  <th scope="row">${names[rank]}</th>
                  <td class="is-numeric tabular">${number.format(required)}</td>
                  <td class="is-numeric tabular">${number.format(need.mean)}</td>
                  <td class="is-numeric tabular">${number.format(need.every)}</td>
                  <td class="is-numeric tabular">${number.format(need.best)}</td>
                  <td class="is-numeric tabular">
                    ${percent.format(slotReach(required, deck.power, orders, rates.notes))}
                  </td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      </div>
      <h3 class="song-detail-subheading">${this.text("deck", "Deck")}</h3>
      <div class="filter-range">
        ${this.number(deck.power, this.text("deckPower", "Power"), 99999999, "1", (value) => value >= 1 && this.set({ power: Math.round(value) }))}
        ${this.number(deck.great, this.text("deckGreat", "Great (%)"), 100, "1", (value) => this.set({ great: Math.round(value) }))}
      </div>
      <p class="song-detail-subheading">${this.text("deckSkills", "Score skills (%)")}</p>
      <div class="filter-range filter-range--five">
        ${deck.slots.map((entry, index) =>
          this.number(entry.score + entry.perfect, String(index + 1), 1000, "any", (value) =>
            slot(index, entry.perfect && !entry.score ? { perfect: value } : { score: value, perfect: 0 }),
          ),
        )}
      </div>
      <p class="song-detail-subheading">${this.text("deckExtension", "Snap skill extension (s)")}</p>
      <div class="filter-range filter-range--five">
        ${deck.slots.map((entry, index) =>
          this.number(entry.extensionMs / 1000, String(index + 1), 6, "0.25", (value) =>
            slot(index, { extensionMs: Math.round(value * 4) * 250 }),
          ),
        )}
      </div>
      ${
        this.href
          ? html`
              <a class="button button--text" href=${this.href}>${this.text("allCharts", "Every chart")}</a>
            `
          : nothing
      }
    `;
  }
}
if (!customElements.get("song-score-targets")) customElements.define("song-score-targets", SongScoreTargets);
