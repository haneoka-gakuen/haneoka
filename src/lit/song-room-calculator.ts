import { LitElement, html, type TemplateResult } from "lit";
import { clientText } from "../i18n/client";
import { roomRank } from "../lib/chart-rates";
import { scoreRankIcon } from "./shared/score-rank";
import { numberField } from "./ui/controls";
import "@material/web/textfield/outlined-text-field.js";

/** A Gekisou room: each player's score, the room total and the rank it reaches. */
export class SongRoomCalculator extends LitElement {
  static properties = {
    ranks: { attribute: false },
    server: { type: String },
    locale: { type: String },
    scores: { state: true },
  };
  /** [rank, battleRequired] in ascending rank. */
  declare ranks: [number, number][];
  declare server: string;
  declare locale: string;
  declare scores: (number | null)[];
  constructor() {
    super();
    this.ranks = [];
    this.server = "intl";
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
    const number = new Intl.NumberFormat(this.locale);
    const played = this.scores.filter((score): score is number => score !== null);
    const total = played.reduce((sum, score) => sum + score, 0);
    const result = played.length ? roomRank(this.ranks, total, played.length) : null;
    const facts: Array<[string, string | TemplateResult]> = [
      [this.text("roomTotal", "Room total"), played.length ? number.format(total) : "—"],
      [
        this.text("roomRank", "Room rank"),
        result
          ? html`<span class="score-rank-value">${scoreRankIcon(this.server, result.rank)}</span>`
          : "—",
      ],
      [
        this.text("roomNext", "Next rank"),
        result?.next
          ? html`<span class="score-rank-value"
              >${scoreRankIcon(this.server, result.next.rank)}<span class="tabular"
                >+${number.format(result.next.required - total)}</span
              ></span
            >`
          : "—",
      ],
    ];
    return html`
      <h4 class="song-detail-subheading">${this.text("roomScores", "Players' scores")}</h4>
      <div class="filter-range filter-range--scores">
        ${this.scores.map(
          (score, index) => numberField({ label: String(index + 1), ariaLabel: `${this.text("roomScores", "Players' scores")} ${index + 1}`,
            value: score, nullable: true, min: 0, step: 1,
            onInput: value => { this.scores = this.scores.map((entry, slot) => slot === index ? value === null ? null : Math.round(value) : entry); } }),
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
