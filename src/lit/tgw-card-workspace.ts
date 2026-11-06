import { unpublishedState } from "./ui/unpublished-state";
import { canUseStaticCatalogScope } from "../lib/content-visibility";
import { SPOILER_CONTENT_EVENT } from "../lib/spoiler-content";
import { isContentListed, isContentVisible } from "../lib/content-release";
/**
 * T.G.W CARD — the game's membership benefits ladder.
 *
 * A rank picker grouped by card tier (Normal, Gold, Platinum, Black) selects
 * one rank; the page then shows that rank's composed card art with its points
 * threshold, its benefits, and its daily and rank-up grants. Each rank button
 * is also a link to the rank's own page, so the ladder stays crawlable and
 * opens in a new tab like any link.
 */

import { LitElement, html, nothing } from "lit";
import { readPageData } from "../lib/page-data";
import { adoptPrerenderedWorkspace } from "../lib/workspace-page-data";
import type { CatalogSystemPayload } from "../lib/catalog-system-data";
import { fetchCrossServerCatalog } from "../lib/cross-server/fetch";
import { crossServerPublicCache } from "../lib/cross-server/cache";
import { crossCatalogPresentation, pinCrossCatalogValue, type CrossCatalogPresentation } from "../lib/cross-server/presentation";
import { OFFICIAL_CATALOG_SERVERS, type OfficialCatalogServer } from "../lib/cross-server/catalog";
import { catalogServerBadge } from "./shared/server-availability";
import { syncEntityNavigation, updateEntityHeading } from "../lib/detail-navigation";
import { catalogResourceHref, entityHref, parseResourceRoute, type ReleaseServer } from "../lib/resource-route";
import { isPublicReleaseServer } from "../lib/release-server";
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
    selectedRank: { state: true },
    selectedSource: { state: true },
  };
  declare selectedRank: number;
  declare selectedSource: string;
  declare locale: string;
  declare entityId: string;
  declare phase: "loading" | "ready" | "error";
  declare tiers: Tier[];
  declare pointName: unknown;
  private server: ReleaseServer = "intl";
  private error = "";
  private request?: AbortController;
  private unionTiers?: CrossCatalogPresentation;
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
    this.selectedRank = 0;
    this.selectedSource = "";
  }
  createRenderRoot() {
    return this;
  }
  preparePage(payload: CatalogSystemPayload, locale: string, hash = "") {
    adoptPrerenderedWorkspace(this);
    this.locale = locale;
    this.server = payload.server;
    if (payload.entityId) {
      this.entityId = payload.entityId;
      this.unionTiers = undefined;
      this.applyTiers([payload.document as Tier], payload.pointName, hash);
      return;
    }
    const { entities, pointName } = this.applyCatalog(payload.catalog!, payload.tierDetails!);
    this.applyTiers(entities, pointName, hash);
  }
  private applyCatalog(dto: NonNullable<CatalogSystemPayload["catalog"]>, details: Record<string, JsonRecord>) {
    const presentation = crossCatalogPresentation(dto);
    const full = new Map<string, Tier>();
    for (const entry of dto.entries) {
      const server = entry.displayServer, identity = dto.identities[server]!;
      const detail = details[entry.key], source = entry.perServer[server]!;
      if (!detail || String(detail.id) !== source.id) throw new Error("T.G.W detail unavailable");
      const row = pinCrossCatalogValue({ ...source.row, ...detail }, identity) as Tier;
      presentation.entries.set(row, entry); full.set(entry.key, row);
    }
    this.unionTiers = presentation;
    return {
      entities: dto.entries.map((entry) => full.get(entry.key)!).sort((a, b) => a.rank - b.rank),
      pointName: ((dto.documents[this.server as OfficialCatalogServer] || Object.values(dto.documents)[0]) as JsonRecord | undefined)?.pointName,
    };
  }
  private applyTiers(entities: Tier[], pointName: unknown, hash: string) {
    this.tiers = this.entityId ? entities : entities.filter((tier) => isContentListed("tgw-card", tier, String(tier.id)));
    this.pointName = pointName;
    this.selectedSource = "";
    const hashed = Number(/^#tgw-rank-(\d+)$/u.exec(hash)?.[1] || 0);
    this.selectedRank = entities.some((tier) => tier.rank === hashed) ? hashed : entities[0]?.rank || 0;
    this.phase = "ready";
  }
  private contentAccessChanged = () => {
    this.request?.abort();
    this.request = undefined;
    this.loading?.cancel();
    this.unionTiers = undefined;
    this.tiers = [];
    this.pointName = [];
    void this.load();
  };
  connectedCallback() {
    addEventListener(SPOILER_CONTENT_EVENT, this.contentAccessChanged);
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
    removeEventListener(SPOILER_CONTENT_EVENT, this.contentAccessChanged);
    this.request?.abort();
    this.request = undefined;
    this.loading?.cancel();
    removeEventListener("haneoka:locale-ready", this.localeListener);
    super.disconnectedCallback();
  }
  private text(key: string, fallback: string, params?: MessageParams) {
    return clientText(this.locale, `catalog.tgwCard.${key}`, fallback, params);
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
  private tierEntry(tier: Tier) {
    return this.unionTiers?.entries.get(tier) || this.unionTiers?.byId.get(`${this.server}:${tier.id}`);
  }
  private selectedTier(): Tier | undefined {
    const matches = this.tiers.filter(tier => tier.rank === this.selectedRank);
    if (this.selectedSource) {
      const chosen = matches.filter(tier => this.tierServer(tier) === this.selectedSource);
      if (chosen.length === 1) return chosen[0];
    }
    const own = matches.filter(tier => this.tierEntry(tier)?.perServer[this.server]);
    return own.length === 1 ? own[0] : matches.length === 1 ? matches[0] : undefined;
  }
  private tierServer(tier: Tier) {
    return this.tierEntry(tier)?.displayServer || this.server;
  }
  /** A restricted edition has no page of its own; its picker selects in place. */
  private entityLink(tier: Tier) {
    const server = this.tierServer(tier);
    if (!isPublicReleaseServer(server)) return undefined;
    return entityHref({
      server,
      locale: this.locale as Locale,
      kind: "tgw-card",
      id: tier.id,
    });
  }
  private syncEntityHeading() {
    if (!this.entityId || !this.tiers[0]) return;
    const title = isContentVisible("tgw-card",this.tiers[0],this.entityId)
      ? this.name(this.tiers[0].title) || this.entityId : uiText(this.locale,"common.states.unpublished");
    updateEntityHeading(this, title, this.locale);
    syncEntityNavigation();
  }
  private async load() {
    const page = readPageData<CatalogSystemPayload>(this);
    if (page?.schema === "haneoka-catalog-system-v1" && page.kind === "tgw-card" && (this.entityId || canUseStaticCatalogScope()) && (page.entityId || "") === this.entityId) {
      this.preparePage(page, this.locale, location.hash);
      return;
    }
    this.request?.abort();
    const controller = new AbortController();
    this.request = controller;
    const progress = beginLoading(uiText(this.locale, "common.states.loading"), { scope: "owner", signal: controller.signal });
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
        if (String(detail.id || "") !== this.entityId) throw new Error(uiText(this.locale, "common.states.unavailable"));
        entities = [detail as Tier];
        pointName = index.pointName;
      } else if (OFFICIAL_CATALOG_SERVERS.includes(this.server as OfficialCatalogServer)) {
        const dto = await fetchCrossServerCatalog("tgw-card", this.server as OfficialCatalogServer, this.locale, { signal: controller.signal });
        if (Object.values(dto.sourceAvailability).every((value) => value !== "loaded")) throw new Error("T.G.W catalog unavailable");
        const full: Record<string, JsonRecord> = {};
        await Promise.all(OFFICIAL_CATALOG_SERVERS.map(async (server) => {
          const identity = dto.identities[server];
          const selected = dto.entries.filter((entry) => entry.displayServer === server);
          if (!identity || !selected.length) return;
          for (let offset = 0; offset < selected.length; offset += 80) {
            const chunk = selected.slice(offset, offset + 80), ids = chunk.map((entry) => entry.perServer[server]!.id);
            const details = await crossServerPublicCache().readEntities("tgw-card", identity, ids, controller.signal) as { items: Record<string, Tier> };
            for (const entry of chunk) {
              const id = entry.perServer[server]!.id, detail = details.items?.[id];
              if (!detail || String(detail.id) !== id) throw new Error("T.G.W detail unavailable");
              full[entry.key] = detail;
            }
          }
        }));
        if (controller.signal.aborted || this.request !== controller) return;
        ({ entities, pointName } = this.applyCatalog(dto, full));
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
              throw new Error(uiText(this.locale, "common.states.unavailable"));
            entities.push({ ...summary, ...detail });
          }
        }
        pointName = document.pointName;
      }
      if (this.request !== controller || controller.signal.aborted) {
        progress.cancel();
        return;
      }
      this.applyTiers(entities, pointName, location.hash);
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
    const tier = this.selectedTier();
    const href = catalogResourceHref(String(value.href || ""), tier ? this.tierServer(tier) : this.server, this.locale as Locale);
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
      // A zero row unlocks the setting; a positive value is the absolute per-play cap.
      return {
        label:
          rawValue === 0
            ? this.text("boostConsumptionUnlocked", label)
            : this.text("boostConsumptionLimit", label, { count: new Intl.NumberFormat(this.locale).format(rawValue) }),
      };
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
      parts.push(clientText(this.locale, "common.time.spanHours", `${number.format(hours)} h`, { count: number.format(hours) }));
    if (minutes)
      parts.push(
        clientText(this.locale, "common.time.spanMinutes", `${number.format(minutes)} m`, { count: number.format(minutes) }),
      );
    if (remainder || !parts.length)
      parts.push(this.text("durationSeconds", `${number.format(remainder)} s`, { count: number.format(remainder) }));
    return parts.join(" ");
  }
  /** Card tier from the rank art's file name: `tgwcard_gold_7.png` → gold. */
  private cardTier(tier: Tier): "normal" | "gold" | "platinum" | "black" {
    const match = /tgwcard_(normal|gold|platinum|black)_\d+\./u.exec(String(tier.image || ""));
    if (match) return match[1] as "normal" | "gold" | "platinum" | "black";
    return tier.rank >= 16 ? "black" : tier.rank >= 11 ? "platinum" : tier.rank >= 6 ? "gold" : "normal";
  }
  /** Sibling art in the rank image's folder: the tier's card face, rank plate and badge. */
  private cardArt(tier: Tier, suffix: "" | "_rank" | "_small") {
    const source = String(tier.image || "");
    const slash = source.lastIndexOf("/");
    if (slash < 0) return "";
    return `${source.slice(0, slash + 1)}tgwcard_${this.cardTier(tier)}${suffix}.png`;
  }
  private tierLabel(kind: ReturnType<TgwCardWorkspace["cardTier"]>) {
    const keys = { normal: "tierNormal", gold: "tierGold", platinum: "tierPlatinum", black: "tierBlack" } as const;
    const fallback = { normal: "Normal", gold: "Gold", platinum: "Platinum", black: "Black" } as const;
    return this.text(keys[kind], fallback[kind]);
  }
  private select(event: MouseEvent, tier: Tier) {
    // Plain clicks select in place; modified clicks keep the link behaviour.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const server = this.tierServer(tier);
    // A public peer keeps its own page; a restricted edition can only open here.
    if (server !== this.server && isPublicReleaseServer(server)) return;
    event.preventDefault();
    this.selectedRank = tier.rank;
    this.selectedSource = server;
    history.replaceState(history.state, "", `${location.pathname}${location.search}#tgw-rank-${tier.rank}`);
  }
  /** Public ranks stay links to their own page; restricted ranks are in-place buttons. */
  private rankButton(tier: Tier, rank: string) {
    const label = this.name(tier.title);
    const current = tier === this.selectedTier();
    const href = this.entityLink(tier);
    return href
      ? html`
          <a
            class="tgw-rank-button tabular"
            href=${href}
            aria-current=${current ? "true" : nothing}
            aria-label=${label}
            @click=${(event: MouseEvent) => this.select(event, tier)}
          >
            ${rank}
          </a>
        `
      : html`
          <button
            type="button"
            class="tgw-rank-button tabular"
            aria-pressed=${current}
            aria-label=${label}
            @click=${(event: MouseEvent) => this.select(event, tier)}
          >
            ${rank}
          </button>
        `;
  }
  private picker() {
    const groups = new Map<ReturnType<TgwCardWorkspace["cardTier"]>, Tier[]>();
    for (const tier of this.tiers) {
      const kind = this.cardTier(tier);
      const group = groups.get(kind);
      if (group) group.push(tier);
      else groups.set(kind, [tier]);
    }
    const pad = (rank: number) => String(rank).padStart(2, "0");
    return html`
      <nav class="tgw-picker" aria-label=${this.text("rank", "Rank")}>
        ${[...groups].map(([kind, tiers]) => {
          const first = tiers[0]!;
          const last = tiers[tiers.length - 1]!;
          return html`
            <section class="tgw-tier" data-tier=${kind}>
              <header class="tgw-tier__head">
                <img src=${this.cardArt(first, "_small")} alt="" width="60" height="28" decoding="async" />
                <strong>${this.tierLabel(kind)}</strong>
                <small class="tabular">${pad(first.rank)}–${pad(last.rank)}</small>
              </header>
              <div class="tgw-tier__ranks">
                ${tiers.map((tier) => this.rankButton(tier, pad(tier.rank)))}
              </div>
            </section>
          `;
        })}
      </nav>
    `;
  }
  private tier(tier: Tier) {
    const benefits = Array.isArray(tier.benefits) ? tier.benefits : [];
    const daily = Array.isArray(tier.dailyRewards) ? tier.dailyRewards : [];
    const rankRewards = Array.isArray(tier.rankRewards) ? tier.rankRewards : [];
    const points = Number(tier.pointsRequired || 0);
    const index = this.tiers.indexOf(tier);
    const next = this.entityId ? undefined : this.tiers[index + 1];
    const pointName = this.name(this.pointName);
    const kind = this.cardTier(tier);
    const labels = benefits.map((benefit) => this.benefitDisplay(benefit)).filter((entry) => entry.label);
    return html`
      <article class="tgw-rank" id=${`tgw-rank-${tier.rank}`} aria-labelledby=${`tgw-rank-title-${tier.rank}`}>
        <section class="tgw-summary surface" data-tier=${kind}>
          <figure class="tgw-art" role="img" aria-label=${this.name(tier.title)}>
            <img class="tgw-art__face" src=${this.cardArt(tier, "")} alt="" width="980" height="630" decoding="async" />
            <img class="tgw-art__plate" src=${this.cardArt(tier, "_rank")} alt="" decoding="async" />
            <img class="tgw-art__number" src=${String(tier.image || "")} alt="" decoding="async" />
          </figure>
          <div class="tgw-summary__copy">
            <h2 class="tgw-summary__title" id=${`tgw-rank-title-${tier.rank}`}>${this.name(tier.title)}${(() => { const entry = this.unionTiers?.entries.get(tier); return catalogServerBadge(entry, this.locale); })()}</h2>
            <span class="tgw-summary__tier">${this.tierLabel(kind)}</span>
            <dl class="tgw-summary__points">
              <dt>${this.text("requiredPoints", "Total points required")}</dt>
              <dd class="tabular">
                <b>${points.toLocaleString(this.locale)}</b>
                <span>${pointName}</span>
              </dd>
            </dl>
            ${
              this.entityId
                ? nothing
                : html`
                    <p class="tgw-summary__next">
                      ${
                        next
                          ? this.text("toNextRank", "{points} to the next rank", {
                              points: `${(Number(next.pointsRequired || 0) - points).toLocaleString(this.locale)} ${pointName}`,
                            })
                          : this.text("maxRank", "Highest rank")
                      }
                    </p>
                  `
            }
          </div>
        </section>
        <div class="tgw-panels">
          <section class="tgw-panel surface">
            <h3 class="detail-section-title">${this.text("benefits", "Rank benefits")}</h3>
            ${
              labels.length
                ? html`
                    <ul class="tgw-benefits" role="list">
                      ${labels.map(
                        ({ label, value }) => html`
                          <li>
                            <span class="tgw-benefits__mark">${icon("check_circle", 20)}</span>
                            <span>${label}</span>
                            ${
                              value !== undefined
                                ? html`
                                    <b class="tabular">${value}</b>
                                  `
                                : nothing
                            }
                          </li>
                        `,
                      )}
                    </ul>
                  `
                : html`
                    <p class="tgw-panel__empty">${this.text("noBenefits", "No benefits at this rank")}</p>
                  `
            }
          </section>
          <section class="tgw-panel surface">
            <h3 class="detail-section-title">${this.text("rewards", "Rewards")}</h3>
            ${
              daily.length || rankRewards.length
                ? html`
                    <dl class="tgw-grants">
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
                : html`
                    <p class="tgw-panel__empty">${this.text("noRewards", "No rewards at this rank")}</p>
                  `
            }
          </section>
        </div>
      </article>
    `;
  }
  render() {
    const selected = this.selectedTier();
    return html`
      <section class="page tgw-card" aria-label="T.G.W CARD">
        ${
          this.phase === "loading"
            ? loadingState(uiText(this.locale, "common.states.loading"))
            : this.phase === "error"
              ? errorState(
                  uiText(this.locale, "common.states.unavailable"),
                  uiText(this.locale, "common.actions.retry"),
                  () => void this.load(),
                  this.error,
                )
              : this.tiers.length
                ? html`
                    ${this.entityId || this.tiers.length < 2 ? nothing : this.picker()}
                    ${selected ? isContentVisible("tgw-card",selected,String(selected.id)) ? this.tier(selected) : unpublishedState(this.locale) : nothing}
                  `
                : emptyState({ title: this.text("empty", "No rank data in this release"), icon: "credit_card" })
        }
      </section>
    `;
  }
}

if (!customElements.get("tgw-card-workspace")) customElements.define("tgw-card-workspace", TgwCardWorkspace);
