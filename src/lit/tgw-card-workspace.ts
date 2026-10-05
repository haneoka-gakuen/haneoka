/**
 * T.G.W CARD — the game's membership benefits ladder.
 *
 * Pure Material: one rung per rank on a surface, separated by hairlines —
 * rank numeral, tier name and points threshold, benefit rows with values,
 * and the tier's daily and rank-up grants. Every property below is a
 * design token; the game's data is rendered exactly as authored.
 */

import { LitElement, html, nothing } from "lit";
import { syncEntityNavigation, updateEntityHeading } from "../lib/detail-navigation";
import { entityHref, parseResourceRoute, type ReleaseServer } from "../lib/resource-route";
import {
  catalogUrl,
  currentReleaseServer,
  fetchJson,
  localizedText,
  preferredLocale,
  recordValues,
  uiText,
  type JsonRecord,
} from "./shared/catalog";
import { emptyState, errorState, loadingState } from "./ui/state";
import { beginLoading, type LoadingReporter } from "../lib/loading-progress";
import { icon } from "./ui/icon";
import { clientText } from "../i18n/client";
import type { Locale, MessageParams } from "@haneoka/i18n";
import "../styles/tgw-card.css";

type Reward = JsonRecord;
interface Benefit extends JsonRecord {
  vipBonusType?: number;
  value?: number;
}
interface Tier extends JsonRecord {
  id: string;
  rank: number;
  pointsRequired?: number;
  benefits?: Benefit[];
  dailyRewards?: Array<{ day: number; reward: Reward }>;
  rankRewards?: Reward[];
  image?: string;
  imageVariants?: JsonRecord;
}

export class TgwCardWorkspace extends LitElement {
  static properties = {
    locale: { type: String },
    entityId: { state: true },
    phase: { state: true },
    tiers: { state: true },
    pointName: { state: true },
  };
  declare locale: string;
  declare entityId: string;
  declare phase: "loading" | "ready" | "error";
  declare tiers: Tier[];
  declare pointName: unknown;
  private server: ReleaseServer = "intl";
  private error = "";
  private request?: AbortController;
  private loading?: LoadingReporter;
  private localeListener = () => {
    this.locale = preferredLocale(this.locale);
    this.syncEntityHeading();
  };
  constructor() {
    super();
    this.locale = "ja";
    this.entityId = "";
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
    const route = parseResourceRoute(location.pathname);
    this.entityId = route?.kind === "tgw-card" ? route.id || "" : "";
    this.server = route?.kind === "tgw-card" ? route.server : (currentReleaseServer() as ReleaseServer);
    addEventListener("haneoka:locale-ready", this.localeListener);
    void import("@material/web/progress/circular-progress.js");
    syncEntityNavigation();
    void this.load();
  }
  disconnectedCallback() {
    this.request?.abort();
    this.request = undefined;
    this.loading?.cancel();
    removeEventListener("haneoka:locale-ready", this.localeListener);
    super.disconnectedCallback();
  }
  private text(key: string, fallback: string, params?: MessageParams) {
    return clientText(this.locale, `tgw.${key}`, fallback, params);
  }
  private name(value: unknown) {
    return localizedText(value, this.locale);
  }
  private image(value: JsonRecord) {
    const source = String(value.image || "");
    const variants = value.imageVariants;
    if (!source || !variants || typeof variants !== "object") return source;
    const localized = (variants as JsonRecord)[source];
    if (!localized || typeof localized !== "object") return source;
    const key = ({ "zh-CN": "zh-Hans", "zh-TW": "zh-Hant" } as Record<string, string>)[this.locale] || this.locale;
    return typeof (localized as JsonRecord)[key] === "string" ? String((localized as JsonRecord)[key]) : source;
  }
  private entityLink(id: string) {
    return entityHref({
      server: this.server,
      locale: this.locale as Locale,
      kind: "tgw-card",
      id,
    });
  }
  private syncEntityHeading() {
    if (!this.entityId || !this.tiers[0]) return;
    const title = this.name(this.tiers[0].title) || this.entityId;
    updateEntityHeading(this, title, this.locale);
    syncEntityNavigation();
  }
  private async load() {
    this.request?.abort();
    const controller = new AbortController();
    this.request = controller;
    const progress = beginLoading(uiText(this.locale, "loading"), { scope: "owner", signal: controller.signal });
    this.loading = progress;
    this.phase = "loading";
    this.error = "";
    try {
      let entities: Tier[];
      let pointName: unknown;
      if (this.entityId) {
        const [detail, index] = await Promise.all([
          fetchJson<JsonRecord>(catalogUrl("tgw-card", this.entityId, this.server), { signal: controller.signal }),
          fetchJson<JsonRecord>(catalogUrl("tgw-card", "", this.server), { signal: controller.signal }),
        ]);
        if (String(detail.id || "") !== this.entityId) throw new Error(uiText(this.locale, "unavailable"));
        entities = [detail as Tier];
        pointName = index.pointName;
      } else {
        const document = await fetchJson<JsonRecord>(catalogUrl("tgw-card", "", this.server), {
          signal: controller.signal,
        });
        const summaries = recordValues(document.entries)
          .map((entry) => entry as Tier)
          .sort((a, b) => a.rank - b.rank);
        entities = [];
        for (let offset = 0; offset < summaries.length; offset += 80) {
          const chunk = summaries.slice(offset, offset + 80);
          const url = new URL(catalogUrl("tgw-card", "", this.server), location.origin);
          for (const tier of chunk) url.searchParams.append("id", String(tier.id));
          const details = await fetchJson<{ items: Record<string, Tier>; missing: string[] }>(url.toString(), {
            signal: controller.signal,
          });
          for (const summary of chunk) {
            const detail = details.items?.[String(summary.id)];
            if (!detail || String(detail.id || "") !== String(summary.id))
              throw new Error(uiText(this.locale, "unavailable"));
            entities.push({ ...summary, ...detail });
          }
        }
        pointName = document.pointName;
      }
      if (this.request !== controller || controller.signal.aborted) {
        progress.cancel();
        return;
      }
      this.tiers = entities;
      this.pointName = pointName;
      this.phase = "ready";
      this.syncEntityHeading();
      progress.finish();
    } catch (error) {
      if (controller.signal.aborted || this.request !== controller) {
        progress.cancel();
        return;
      }
      console.error(error);
      this.error = error instanceof Error ? error.message : String(error);
      this.phase = "error";
      progress.fail(error);
    } finally {
      if (this.request === controller && this.phase !== "error") {
        this.request = undefined;
        this.loading = undefined;
      }
    }
  }
  private rewardItem(value: Reward) {
    const title = this.name(value.name) || this.text("reward", "Reward");
    const image = this.image(value);
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
  private benefitDisplay(benefit: Benefit): { label: string; value?: string } {
    const label = this.name(benefit.name);
    const kind = benefit.vipBonusType;
    const rawValue = benefit.value;
    // Older DTOs have no enum; preserve their label without guessing a unit.
    if (
      typeof kind !== "number" ||
      !Number.isInteger(kind) ||
      typeof rawValue !== "number" ||
      !Number.isSafeInteger(rawValue) ||
      rawValue < 0
    )
      return { label };
    if (kind === 9) {
      // A present zero-valued row is an unlock; positive cap semantics are reviewed separately.
      return { label: rawValue === 0 ? this.text("boostConsumptionUnlocked", label) : label };
    }
    const number = new Intl.NumberFormat(this.locale, { maximumFractionDigits: 2 });
    const countKeys: Readonly<Partial<Record<number, string>>> = {
      1: "bandFormationBonus",
      3: "boostAutoRecoveryLimitBonus",
      8: "eventGachaFreeCountBonus",
    };
    const countKey = countKeys[kind];
    if (countKey) return { label: this.text(countKey, label, { count: number.format(rawValue) }) };
    if (kind === 6) {
      return { label: this.text("studioTimeExtension", label, { duration: this.benefitDuration(rawValue) }) };
    }
    const percentKeys: Readonly<Partial<Record<number, string>>> = {
      2: "boostRecoveryTimeReduction",
      5: "studioRewardBonus",
      7: "allParametersBoost",
    };
    const percentKey = percentKeys[kind];
    return percentKey ? { label: this.text(percentKey, label, { percent: number.format(rawValue / 100) }) } : { label };
  }
  private benefitDuration(seconds: number): string {
    const number = new Intl.NumberFormat(this.locale);
    const parts: string[] = [];
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    if (hours)
      parts.push(clientText(this.locale, "spanHours", `${number.format(hours)} h`, { count: number.format(hours) }));
    if (minutes)
      parts.push(
        clientText(this.locale, "spanMinutes", `${number.format(minutes)} m`, { count: number.format(minutes) }),
      );
    if (remainder || !parts.length)
      parts.push(this.text("durationSeconds", `${number.format(remainder)} s`, { count: number.format(remainder) }));
    return parts.join(" ");
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
            ${
              this.entityId
                ? html`<strong class="tgw-rung__title">${this.name(tier.title)}</strong>`
                : html`<a class="tgw-rung__title" href=${this.entityLink(tier.id)}>${this.name(tier.title)}</a>`
            }
            <small class="tgw-rung__points tabular">
              ${points.toLocaleString(this.locale)} ${this.name(this.pointName)}
            </small>
          </div>
          ${
            benefits.length
              ? html`
                  <ul class="tgw-rung__benefits" role="list">
                    ${benefits.map((benefit) => {
                      const { label, value } = this.benefitDisplay(benefit);
                      return label
                        ? html`
                            <li>
                              <span class="tgw-rung__mark">${icon("check_circle", 18)}</span>
                              <span>${label}</span>
                              ${
                                value !== undefined
                                  ? html`
                                      <b class="tabular">${value}</b>
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
              ? errorState(
                  uiText(this.locale, "unavailable"),
                  uiText(this.locale, "retry"),
                  () => void this.load(),
                  this.error,
                )
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
