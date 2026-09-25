/**
 * T.G.W CARD — the game's membership benefits ladder.
 *
 * Pure Material: one rung per rank on a surface, separated by hairlines —
 * rank numeral, tier name and points threshold, benefit rows with values,
 * and the tier's daily and rank-up grants. Every property below is a
 * design token; the game's data is rendered exactly as authored.
 */

import { LitElement, html, nothing } from "lit";
import {
  catalogUrl,
  fetchJson,
  localizedText,
  preferredLocale,
  recordValues,
  uiText,
  type JsonRecord,
} from "./shared/catalog";
import { emptyState, errorState, loadingState } from "./ui/state";
import { icon } from "./ui/icon";
import "../styles/tgw-card.css";

type Reward = JsonRecord;
interface Tier extends JsonRecord {
  id: string;
  rank: number;
  pointsRequired?: number;
  benefits?: JsonRecord[];
  dailyRewards?: Array<{ day: number; reward: Reward }>;
  rankRewards?: Reward[];
}

export class TgwCardWorkspace extends LitElement {
  static properties = {
    locale: { type: String },
    labels: { type: String },
    phase: { state: true },
    tiers: { state: true },
    pointName: { state: true },
  };
  declare locale: string;
  declare labels: string;
  declare phase: "loading" | "ready" | "error";
  declare tiers: Tier[];
  declare pointName: unknown;
  private copies: Record<string, Record<string, string>> = {};
  private request?: AbortController;
  private localeListener = () => {
    this.locale = preferredLocale(this.locale);
  };
  constructor() {
    super();
    this.locale = "ja";
    this.labels = "{}";
    this.phase = "loading";
    this.tiers = [];
    this.pointName = [];
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.locale = preferredLocale(this.locale);
    this.copies = JSON.parse(this.labels || "{}");
    addEventListener("haneoka:locale-ready", this.localeListener);
    void import("@material/web/progress/circular-progress.js");
    void this.load();
  }
  disconnectedCallback() {
    this.request?.abort();
    removeEventListener("haneoka:locale-ready", this.localeListener);
    super.disconnectedCallback();
  }
  private text(key: string, fallback: string) {
    return (this.copies[this.locale] || this.copies.ja || {})[key] || fallback;
  }
  private name(value: unknown) {
    return localizedText(value, this.locale);
  }
  private async load() {
    this.request?.abort();
    const controller = new AbortController();
    this.request = controller;
    this.phase = "loading";
    try {
      const document = await fetchJson<JsonRecord>(catalogUrl("tgw-card"), { signal: controller.signal });
      if (this.request !== controller) return;
      const entities = await Promise.all(
        recordValues(document.entries)
          .map((entry) => entry as Tier)
          .sort((a, b) => a.rank - b.rank)
          .map(async (summary) => {
            try {
              const detail = await fetchJson<Tier>(catalogUrl("tgw-card", String(summary.id)));
              return { ...summary, ...detail };
            } catch {
              return summary;
            }
          }),
      );
      this.tiers = entities;
      this.pointName = document.pointName;
      this.phase = "ready";
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error(error);
      this.phase = "error";
    }
  }
  private rewardItem(value: Reward) {
    const title = this.name(value.name) || this.text("reward", "Reward");
    const image = String(value.image || "");
    const href = String(value.href || "");
    const count = Number(value.count || 0);
    const body = html`
      ${
        image
          ? html`
              <img src=${image} alt="" loading="lazy" decoding="async" />
            `
          : icon("redeem", 18)
      }
      <span>${title}</span>
      ${
        count > 1
          ? html`
              <b class="tabular">×${count.toLocaleString(this.locale)}</b>
            `
          : nothing
      }
    `;
    return href
      ? html`
          <a class="tgw-chip state-layer" href=${href}>${body}</a>
        `
      : html`
          <span class="tgw-chip">${body}</span>
        `;
  }
  private tier(tier: Tier) {
    const benefits = Array.isArray(tier.benefits) ? tier.benefits : [];
    const daily = Array.isArray(tier.dailyRewards) ? tier.dailyRewards : [];
    const rankRewards = Array.isArray(tier.rankRewards) ? tier.rankRewards : [];
    const points = Number(tier.pointsRequired || 0);
    return html`
      <li class="tgw-rung" id=${`tgw-rank-${tier.rank}`}>
        <span class="tgw-rung__rank tabular">${tier.rank}</span>
        <div class="tgw-rung__body">
          <div class="tgw-rung__head">
            <strong class="tgw-rung__title">${this.name(tier.title)}</strong>
            <small class="tgw-rung__points tabular">
              ${points.toLocaleString(this.locale)} ${this.name(this.pointName)}
            </small>
          </div>
          ${
            benefits.length
              ? html`
                  <ul class="tgw-rung__benefits" role="list">
                    ${benefits.map((benefit) => {
                    const label = this.name(benefit.name);
                    const value = Number(benefit.value || 0);
                    return label
                      ? html`
                          <li>
                            <span class="tgw-rung__mark">${icon("check_circle", 18)}</span>
                            <span>${label}</span>
                            ${
                              value
                                ? html`
                                    <b class="tabular">+${value.toLocaleString(this.locale)}</b>
                                  `
                                : nothing
                            }
                          </li>
                        `
                      : nothing;
                  })}
                  </ul>
                `
              : nothing
          }
          ${
            daily.length || rankRewards.length
              ? html`
                  <dl class="tgw-rung__grants">
                    ${
                    daily.length
                      ? html`
                          <div>
                            <dt>${this.text("dailyRewards", "Daily rewards")}</dt>
                            <dd>${daily.map((slot) => this.rewardItem((slot.reward || {}) as Reward))}</dd>
                          </div>
                        `
                      : nothing
                  }
                    ${
                    rankRewards.length
                      ? html`
                          <div>
                            <dt>${this.text("rankRewards", "Rank-up rewards")}</dt>
                            <dd>${rankRewards.map((reward) => this.rewardItem(reward))}</dd>
                          </div>
                        `
                      : nothing
                  }
                  </dl>
                `
              : nothing
          }
        </div>
      </li>
    `;
  }
  render() {
    return html`
      <section class="page tgw-card" aria-label="T.G.W CARD">
        ${
          this.phase === "loading"
            ? loadingState(uiText(this.locale, "loading"))
            : this.phase === "error"
              ? errorState(uiText(this.locale, "unavailable"), uiText(this.locale, "retry"), () => void this.load())
              : this.tiers.length
                ? html`
                    <ol class="tgw-ladder" role="list">
                      ${this.tiers.map((tier) => this.tier(tier))}
                    </ol>
                  `
                : emptyState({ title: this.text("empty", "No rank data in this release"), icon: "credit_card" })
        }
      </section>
    `;
  }
}

if (!customElements.get("tgw-card-workspace")) customElements.define("tgw-card-workspace", TgwCardWorkspace);
