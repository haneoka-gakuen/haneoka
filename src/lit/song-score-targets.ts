import { LitElement, html, nothing } from "lit";
import { clientText } from "../i18n/client";
import {
  byScoreRank,
  isSongScoreRank,
  liveWeights,
  slotOrderRates,
  slotPowerNeeded,
  slotReach,
  type ChartRates,
  type DeckSlot,
} from "../lib/chart-rates";
import { DEFAULT_DECK, rememberDeck, rememberedDeck, type Deck } from "../lib/deck-state";
import { accordion } from "./ui/accordion";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import { scoreRankIcon } from "./shared/score-rank";
import { numberField } from "./ui/controls";
import { collectionTable } from "./ui/collection-view";
import "@material/web/textfield/outlined-text-field.js";

/** The selected chart's score ranks in a Live: the score each needs and the power a deck needs for it. */
export class SongScoreTargets extends LitElement {
  static properties = {
    rates: { attribute: false },
    greatFactor: { attribute: false },
    server: { type: String },
    locale: { type: String },
    href: { type: String },
    deck: { state: true },
    deckOpen: { state: true },
    deckMounted: { state: true },
  };
  declare rates: ChartRates | null;
  declare greatFactor: number;
  /** Release server whose rank emblems and assets the page shows. */
  declare server: string;
  declare locale: string;
  /** Song analysis, where the same deck scores every chart. */
  declare href: string;
  declare deck: Deck;
  declare deckOpen: boolean;
  declare deckMounted: boolean;
  constructor() {
    super();
    this.rates = null;
    this.greatFactor = 0.8;
    this.server = "intl";
    this.locale = "ja";
    this.href = "";
    this.deck = DEFAULT_DECK;
    this.deckOpen = false;
    this.deckMounted = false;
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
    return numberField({ label, value: Math.round(value * 100) / 100, min: 0, max,
      step: step === "any" ? "any" : Number(step), commitOnChange: true, onInput: apply });
  }
  render() {
    const rates = this.rates;
    if (!rates) return nothing;
    const deck = this.deck;
    const heading = this.text("powerNeeded", "Power needed");
    const number = new Intl.NumberFormat(this.locale);
    const percent = new Intl.NumberFormat(this.locale, { style: "percent", maximumFractionDigits: 1 });
    const orders = slotOrderRates(liveWeights(rates, deck.great / 100, this.greatFactor), deck.slots);
    const slot = (index: number, change: Partial<DeckSlot>) =>
      this.set({ slots: deck.slots.map((entry, at) => (at === index ? { ...entry, ...change } : entry)) });
    const ranks = byScoreRank(
      rates.ranks.filter(([rank]) => isSongScoreRank(rank)),
      ([rank]) => rank,
    );
    const deckFields = html`
      <div class="detail-fold__body">
        <div class="filter-range">
          ${this.number(deck.power, this.text("deckPower", "Power"), 99999999, "1", (value) => value >= 1 && this.set({ power: Math.round(value) }))}
          ${this.number(deck.great, this.text("deckGreat", "Great (%)"), 100, "1", (value) => this.set({ great: Math.round(value) }))}
        </div>
        <h4 class="song-detail-subheading">${this.text("deckSkills", "Score skills (%)")}</h4>
        <div class="filter-range filter-range--five">
          ${deck.slots.map((entry, index) =>
            this.number(entry.score + entry.perfect, String(index + 1), 1000, "any", (value) =>
              slot(index, entry.perfect && !entry.score ? { perfect: value } : { score: value, perfect: 0 }),
            ),
          )}
        </div>
        <h4 class="song-detail-subheading">${this.text("deckExtension", "Snap skill extension (s)")}</h4>
        <div class="filter-range filter-range--five">
          ${deck.slots.map((entry, index) =>
            this.number(entry.extensionMs / 1000, String(index + 1), 6, "0.25", (value) =>
              slot(index, { extensionMs: Math.round(value * 4) * 250 }),
            ),
          )}
        </div>
      </div>
    `;
    return html`
      ${renderDetailSectionHeading(heading, "stats")}
      ${collectionTable(heading, [this.text("deckRank", "Target rank"), this.text("rankScore", "Score"),
        this.text("averageOrder", "Average of the orders"), this.text("everyOrder", "Every order"),
        this.text("bestOrder", "Best order"), this.text("metaDeckReach", "Reach rate")],
        ranks.map(([rank, required]) => {
          const need = slotPowerNeeded(required, orders, rates.notes);
          return [scoreRankIcon(this.server, rank), number.format(required), number.format(need.mean), number.format(need.every),
            number.format(need.best), percent.format(slotReach(required, deck.power, orders, rates.notes))];
        }), { numeric: true })}
      ${accordion({
        id: "song-score-deck",
        label: this.text("deck", "Deck"),
        expanded: this.deckOpen,
        onExpandedChange: (expanded) => {
          this.deckOpen = expanded;
          if (expanded) this.deckMounted = true;
        },
        headingLevel: 3,
        className: "detail-fold song-deck",
        content: this.deckMounted ? deckFields : nothing,
      })}
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
