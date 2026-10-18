import { LitElement, html } from "lit";
import { clientText } from "../i18n/client";
import { roomRank } from "../lib/chart-rates";

/** A Gekisou room: each player's score, the room total and the rank it reaches. */
export class SongRoomCalculator extends LitElement {
  static properties = {
    ranks: { attribute: false },
    locale: { type: String },
    scores: { state: true },
  };
  /** [rank, battleRequired] in ascending rank. */
  declare ranks: [number, number][];
  declare locale: string;
  declare scores: (number | null)[];
  constructor() {
    super();
    this.ranks = [];
    this.locale = "ja";
    this.scores = [null, null, null, null, null];
  }
  createRenderRoot() {
    return this;
  }
  private text(key: string, fallback: string) {
    return clientText(this.locale, `catalog.analysis.fields.${key}`, fallback);
  }
  render() {
    const names = ["", "E", "D", "C", "B", "A", "S", "SS"];
    const number = new Intl.NumberFormat(this.locale);
    const played = this.scores.filter((score): score is number => score !== null);
    const total = played.reduce((sum, score) => sum + score, 0);
    const result = played.length ? roomRank(this.ranks, total, played.length) : null;
    const facts: [string, string][] = [
      [this.text("roomTotal", "Room total"), played.length ? number.format(total) : "—"],
      [this.text("roomRank", "Room rank"), result ? names[result.rank] || "—" : "—"],
      [
        this.text("roomNext", "Next rank"),
        result?.next ? `${names[result.next.rank]} +${number.format(result.next.required - total)}` : "—",
      ],
    ];
    return html`
      <h3 class="song-detail-subheading">${this.text("roomScores", "Players' scores")}</h3>
      <div class="filter-range filter-range--scores">
        ${this.scores.map(
          (score, index) => html`
            <label>
              ${index + 1}
              <input
                type="number"
                min="0"
                step="1"
                inputmode="numeric"
                .value=${score === null ? "" : String(score)}
                @input=${(event: Event) => {
                  const raw = (event.target as HTMLInputElement).value;
                  const value = Math.round(Number(raw));
                  this.scores = this.scores.map((entry, slot) =>
                    slot === index ? (raw === "" || !Number.isFinite(value) || value < 0 ? null : value) : entry,
                  );
                }}
              />
            </label>
          `,
        )}
      </div>
      <dl class="song-data-grid">
        ${facts.map(
          ([label, value]) => html`
            <div>
              <dt>${label}</dt>
              <dd class="tabular">${value}</dd>
            </div>
          `,
        )}
      </dl>
    `;
  }
}
if (!customElements.get("song-room-calculator")) customElements.define("song-room-calculator", SongRoomCalculator);
