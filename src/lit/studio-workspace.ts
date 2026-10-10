import { LitElement, html, nothing } from "lit";
import { releaseServerFromPath, resourcePath } from "../lib/resource-route";
import { beginLoading } from "../lib/loading-progress";
import { catalogUrl, currentReleaseServer, fetchJson, localizedText, preferredLocale, uiText } from "./shared/catalog";
import { emptyState, errorState, loadingState } from "./ui/state";
import { paneSection } from "./ui/pane";
import { accordion } from "./ui/accordion";
import { collectionList, collectionTable } from "./ui/collection-view";
import { renderLevelSwitch } from "./ui/level-switch";
import { LazyImages } from "./ui/lazy-images";
import { icon } from "./ui/icon";
import { clientText } from "../i18n/client";
import type { Locale } from "@haneoka/i18n";
import type { ReleaseServer } from "../lib/release-server";
import "../styles/studio.css";

interface Reward {
  resourceType: number;
  resourceId: number;
  name: unknown;
  image: string;
  href: string;
  count: number;
}
interface Level {
  level: number;
  exp: number;
  bandRank: number;
  efficiencyTime: number;
  limitTime: number;
  coin: number;
  memberExp: number;
  supportExp: number;
  studioExp: number;
  draws: number;
  dropGroup: number;
}
interface Unit {
  id: number;
  bandId: number;
  name: unknown;
  icon: string;
  levels: Level[];
  drops: Record<string, Array<{ weight: number; reward: Reward }>>;
}
interface Studio {
  units: Unit[];
  rewards?: Partial<Record<"coin" | "memberExp" | "supportExp", Reward>>;
  skipItems?: Reward[];
  expFactors: Array<{ bandRank: number; factor: number }>;
}

export class StudioWorkspace extends LitElement {
  static properties = {
    locale: { type: String },
    phase: { state: true },
    studio: { state: true },
    unitId: { state: true },
    bandRank: { state: true },
    level: { state: true },
    tableOpen: { state: true },
  };
  declare locale: string;
  declare phase: "loading" | "ready" | "error";
  declare studio: Studio | undefined;
  declare unitId: number;
  declare bandRank: number;
  declare level: number;
  declare tableOpen: boolean;
  private server: ReleaseServer = "intl";
  private error = "";
  private request?: AbortController;
  private lazyImages = new LazyImages();
  private localeListener = () => {
    this.locale = preferredLocale(this.locale);
  };
  constructor() {
    super();
    this.locale = "ja";
    this.phase = "loading";
    this.unitId = 0;
    this.bandRank = 0;
    this.level = 0;
    this.tableOpen = false;
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.locale = preferredLocale(this.locale);
    this.server = releaseServerFromPath(location.pathname) || (currentReleaseServer() as ReleaseServer);
    addEventListener("haneoka:locale-ready", this.localeListener);
    void this.load();
  }
  disconnectedCallback() {
    this.request?.abort();
    this.lazyImages.disconnect();
    removeEventListener("haneoka:locale-ready", this.localeListener);
    super.disconnectedCallback();
  }
  updated() {
    this.lazyImages.observe(this);
  }
  private text(key: string, fallback: string) {
    return clientText(this.locale, `catalog.studio.${key}`, fallback);
  }
  private async load() {
    this.request?.abort();
    const controller = new AbortController();
    this.request = controller;
    const progress = beginLoading(uiText(this.locale, "common.states.loading"), {
      scope: "owner",
      signal: controller.signal,
    });
    this.phase = "loading";
    try {
      const studio = await fetchJson<Studio>(catalogUrl("studio", "", this.server), { signal: controller.signal });
      if (controller.signal.aborted) return progress.cancel();
      this.studio = studio;
      const query = new URLSearchParams(location.search);
      const units = studio.units || [];
      this.unitId = units.find((unit) => unit.bandId === Number(query.get("band")))?.id || units[0]?.id || 0;
      const ranks = this.ranks();
      const rank = Number(query.get("rank"));
      this.bandRank = ranks.includes(rank) ? rank : ranks.at(-1) || 0;
      const range = this.levelRange();
      const level = Number(query.get("lv"));
      this.level = range.includes(level) ? level : range.at(-1) || 0;
      this.phase = "ready";
      progress.finish();
    } catch (error) {
      if (controller.signal.aborted) return progress.cancel();
      this.error = error instanceof Error ? error.message : String(error);
      this.phase = "error";
      progress.fail(error);
    }
  }
  private unit() {
    return this.studio?.units.find((unit) => unit.id === this.unitId);
  }
  private ranks() {
    const factors = this.studio?.expFactors || [];
    if (factors.length) return factors.map((entry) => entry.bandRank);
    const highest = Math.max(1, ...(this.unit()?.levels || []).map((level) => level.bandRank));
    return Array.from({ length: highest }, (_, index) => index + 1);
  }
  /** Practice levels open at the chosen band rank. */
  private levelRange() {
    return (this.unit()?.levels || []).filter((level) => level.bandRank <= this.bandRank).map((level) => level.level);
  }
  private remember() {
    const url = new URL(location.href);
    const unit = this.unit();
    if (unit) url.searchParams.set("band", String(unit.bandId));
    url.searchParams.set("rank", String(this.bandRank));
    url.searchParams.set("lv", String(this.level));
    history.replaceState(history.state, "", url);
  }
  private selectUnit(unit: Unit) {
    this.unitId = unit.id;
    this.remember();
  }
  private selectRank(rank: number) {
    this.bandRank = rank;
    const range = this.levelRange();
    if (!range.includes(this.level)) this.level = range.at(-1) || 0;
    this.remember();
  }
  private selectLevel(level: number) {
    this.level = level;
    this.remember();
  }
  private number(value: number) {
    return value.toLocaleString(this.locale);
  }
  private hours(seconds: number) {
    const hours = new Intl.NumberFormat(this.locale, { maximumFractionDigits: 2 }).format(seconds / 3600);
    return clientText(this.locale, "common.time.spanHours", `${hours}h`, { count: hours });
  }
  private href(reward: Reward) {
    if (!reward.href || reward.resourceType !== 1) return reward.href;
    return resourcePath({
      server: this.server,
      locale: this.locale as Locale,
      kind: "items",
      id: String(reward.resourceId),
    });
  }
  private settings(unit: Unit, level: Level) {
    const units = this.studio?.units || [];
    const range = this.levelRange();
    const factor = this.studio?.expFactors.find((entry) => entry.bandRank === this.bandRank)?.factor;
    const next = unit.levels.find((entry) => entry.level === level.level + 1);
    return html`
      <aside class="studio-settings surface stack">
        ${
          units.length > 1
            ? html`
                <div
                  class="chip-set"
                  role="radiogroup"
                  aria-label=${clientText(this.locale, "catalog.fields.band", "Band")}
                >
                  ${units.map(
                    (entry) => html`
                      <button
                        class="chip"
                        type="button"
                        role="radio"
                        aria-checked=${String(entry.id === unit.id)}
                        @click=${() => this.selectUnit(entry)}
                      >
                        ${
                        entry.icon
                          ? html`
                              <span class="chip__avatar">
                                <img src=${entry.icon} alt="" width="24" height="24" decoding="async" />
                              </span>
                            `
                          : nothing
                      }
                        <span class="chip__label">${localizedText(entry.name, this.locale)}</span>
                      </button>
                    `,
                  )}
                </div>
              `
            : nothing
        }
        ${renderLevelSwitch(this.text("bandRank", "Band Rank"), this.ranks(), this.bandRank, (rank) => this.selectRank(rank))}
        ${renderLevelSwitch(this.text("level", "Practice Lv."), range, this.level, (value) => this.selectLevel(value))}
        <dl class="spec-list spec-list--split spec-list--numeric">
          <div>
            <dt>${this.text("maxLevel", "Max Practice Lv.")}</dt>
            <dd class="tabular">${range.at(-1) ?? "—"}</dd>
          </div>
          ${
            factor
              ? html`
                  <div>
                    <dt>${this.text("expFactor", "EXP Multiplier")}</dt>
                    <dd class="tabular">
                      ×${new Intl.NumberFormat(this.locale, { maximumFractionDigits: 2 }).format(factor / 10000)}
                    </dd>
                  </div>
                `
              : nothing
          }
          <div>
            <dt>${this.text("requiredExp", "Required Practice EXP")}</dt>
            <dd class="tabular">${this.number(level.exp)}</dd>
          </div>
          ${
            next
              ? html`
                  <div>
                    <dt>${this.text("nextLevel", "To next Lv.")}</dt>
                    <dd class="tabular">${this.number(next.exp - level.exp)}</dd>
                  </div>
                `
              : nothing
          }
          <div>
            <dt>${this.text("practiceTime", "Practice Time")}</dt>
            <dd class="tabular">${this.hours(level.efficiencyTime)}</dd>
          </div>
          <div>
            <dt>${this.text("timeLimit", "Practice Time Limit")}</dt>
            <dd class="tabular">${this.hours(level.limitTime)}</dd>
          </div>
        </dl>
      </aside>
    `;
  }
  private related() {
    const skip = this.studio?.skipItems || [];
    if (!skip.length) return nothing;
    return paneSection(
      this.text("item", "Item"),
      icon("inventory_2", 18),
      collectionList(
        skip.map((reward) => ({
          id: String(reward.resourceId),
          title: localizedText(reward.name, this.locale),
          subtitle: this.text("item", "Item"),
          image: reward.image,
          href: this.href(reward),
        })),
      ),
    );
  }
  private metric(label: string, value: number, level: Level, media: unknown) {
    const session = level.efficiencyTime / 3600;
    return html`
      <div class="studio-metric">
        <span class="studio-metric__media">${media}</span>
        <span class="studio-metric__label">${label}</span>
        <strong class="studio-metric__value tabular">${this.number(value)}</strong>
        <span class="studio-metric__session tabular">
          ${this.hours(level.efficiencyTime)} · ${this.number(Math.round(value * session))}
        </span>
      </div>
    `;
  }
  private rewards(level: Level) {
    const art = this.studio?.rewards || {};
    const image = (reward: Reward | undefined, fallback: string) =>
      reward?.image
        ? html`
            <img src=${reward.image} alt="" width="40" height="40" decoding="async" />
          `
        : icon(fallback, 24);
    return paneSection(
      this.text("hourlyRewards", "Hourly Rewards"),
      icon("schedule", 18),
      html`
        <div class="studio-metrics">
          ${this.metric(this.text("coin", "Coin"), level.coin, level, image(art.coin, "redeem"))}
          ${this.metric(this.text("memberExp", "Member EXP"), level.memberExp, level, image(art.memberExp, "person"))}
          ${this.metric(this.text("supportExp", "Snapshot EXP"), level.supportExp, level, image(art.supportExp, "collections"))}
          ${this.metric(this.text("practiceExp", "Practice EXP"), level.studioExp, level, icon("trending_up", 24))}
          ${this.metric(this.text("lotSlots", "Item Lottery Slot"), level.draws, level, icon("casino", 24))}
        </div>
      `,
    );
  }
  private drops(unit: Unit, level: Level) {
    const entries = unit.drops[String(level.dropGroup)] || [];
    const total = entries.reduce((sum, entry) => sum + entry.weight, 0) || 1;
    const percent = new Intl.NumberFormat(this.locale, { style: "percent", maximumFractionDigits: 2 });
    return paneSection(
      this.text("lotSlots", "Item Lottery Slot"),
      icon("casino", 18),
      html`
        <div class="studio-drops">
          ${collectionList(
            [...entries]
              .sort((a, b) => b.weight - a.weight)
              .map(({ weight, reward }) => ({
                id: String(reward.resourceId),
                title: localizedText(reward.name, this.locale) || `#${reward.resourceId}`,
                subtitle: html`
                  <span class="tabular">${percent.format(weight / total)}</span>
                `,
                image: reward.image,
                href: this.href(reward),
              })),
          )}
        </div>
      `,
      entries.length,
    );
  }
  private table(unit: Unit) {
    const rows = unit.levels.map((level) => [
      level.level,
      this.number(level.exp),
      level.bandRank || "—",
      this.number(level.coin),
      this.number(level.memberExp),
      this.number(level.supportExp),
      this.number(level.studioExp),
      level.draws,
    ]);
    return accordion({
      id: "studio-levels",
      className: "surface",
      leading: icon("table_rows", 24),
      label: this.text("allLevels", "All Practice Lv."),
      metadata: String(unit.levels.length),
      expanded: this.tableOpen,
      onExpandedChange: (expanded) => {
        this.tableOpen = expanded;
      },
      content: collectionTable(
        this.text("allLevels", "All Practice Lv."),
        [
          this.text("level", "Practice Lv."),
          this.text("requiredExp", "Required Practice EXP"),
          this.text("bandRank", "Band Rank"),
          this.text("coin", "Coin"),
          this.text("memberExp", "Member EXP"),
          this.text("supportExp", "Snapshot EXP"),
          this.text("practiceExp", "Practice EXP"),
          this.text("lotSlots", "Item Lottery Slot"),
        ],
        rows,
        { numeric: true },
      ),
    });
  }
  render() {
    if (this.phase === "loading")
      return html`
        <section class="page studio">${loadingState(uiText(this.locale, "common.states.loading"))}</section>
      `;
    if (this.phase === "error")
      return html`
        <section class="page studio">
          ${errorState(uiText(this.locale, "common.states.unavailable"), uiText(this.locale, "common.actions.retry"), () => void this.load(), this.error)}
        </section>
      `;
    const unit = this.unit();
    const level = unit?.levels.find((entry) => entry.level === this.level);
    if (!unit || !level)
      return html`
        <section class="page studio">
          ${emptyState({ title: uiText(this.locale, "common.states.unavailable"), icon: "piano" })}
        </section>
      `;
    return html`
      <section class="page studio">
        <div class="studio-layout">
          ${this.settings(unit, level)}
          <div class="studio-results stack">
            ${this.rewards(level)} ${this.drops(unit, level)} ${this.related()}
            ${this.table(unit)}
          </div>
        </div>
      </section>
    `;
  }
}

if (!customElements.get("studio-workspace")) customElements.define("studio-workspace", StudioWorkspace);
