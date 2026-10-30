// L3 — GEB
// Input: 工作区提供的账号、规范记录、卡池规则、统计及云状态。
// Output: 账号概览、运气、卡池、收获、明细与趋势分页，统一卡牌、兑换进度和显式操作事件。
// Pos: [Map](L2-2.md)；抽卡历史展示与资料边界。
// Effects/Dependencies: light DOM 与 SSR 共用；消费共享分析／图表／卡牌，导入及云状态由工作区持有。
import type { GachaTargetProgress } from "@haneoka/game-data-exporter/gacha-history-points";
import { modal } from "./ui/modal";
import "./ui/image-gallery";
import {
  analyzeGachaHistory,
  gachaHistoryDay,
  gachaHistoryHits,
  gachaHistoryLuck,
  gachaHistoryMonths,
  summarizeGachaHistoryMoney,
  type GachaDrawInterval,
  type GachaHit,
  type GachaLuck,
  type GachaPoolHits,
} from "@haneoka/game-data-exporter/gacha-history-analysis";
import "./shared/gacha-history-chart";
import "@lit-labs/ssr-client/lit-element-hydrate-support.js";
import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { hydrateWorkspace as hydrate } from "./shared/hydrate-workspace";
import { keyed } from "lit/directives/keyed.js";
import { clientText } from "../i18n/client";
import { clearAppBarSearch, setAppBarSearch } from "../lib/app-bar";
import type {
  GachaHistoryAccount,
  GachaHistoryPool,
  GachaHistoryBatch,
  GachaHistoryPrize,
  GachaHistoryEvents,
  GachaHistoryConversion,
  GachaHistoryCost,
  GachaHistoryImportSource,
} from "../lib/gacha-history-view";
import { renderBrowse, clearBrowseBar } from "./ui/browse";
import { facet } from "./ui/facet";
import { filterChip, iconButton, inputChip, rovingKeydown, segmented } from "./ui/controls";
import { icon } from "./ui/icon";
import { accordion } from "./ui/accordion";
import { collectionList, collectionTable, viewSwitch, type CollectionView } from "./ui/collection-view";
import { gachaPrizeCard } from "./shared/gacha-prize-card";
import { LazyImages } from "./ui/lazy-images";
import type { GachaHistoryReport, GachaHistoryReportCard } from "../lib/gacha-history-image";
import { emptyState, loadingState } from "./ui/state";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import "../styles/gacha-history.css";
import { renderLocalSaveSourcePicker } from "./shared/local-save-source-picker";
import { formatDate, formatTime } from "../lib/date-format";

type Axis = "category" | "pool" | "kind" | "rarity" | "pickup";
type Tab = "overview" | "pools" | "collection" | "records" | "trends" | "settings";
const TABS: readonly Tab[] = ["overview", "pools", "collection", "records", "trends", "settings"];
const HIGH = new Set([4, 10, 20]);
const OWNER = "gacha-history";
const isHigh = (prize: GachaHistoryPrize) =>
  (prize.kind === "member" || prize.kind === "support") && HIGH.has(Number(prize.rarity));
const rarityRank = (rarity: string | number) => ({ 20: 5, 10: 4, 4: 3, 3: 2, 2: 1 })[Number(rarity)] ?? 0;

interface CollectedCard {
  key: string;
  prize: GachaHistoryPrize;
  count: number;
  pickup: number;
  converted: number;
  pools: Set<string>;
  last: string | null;
}

export class GachaHistory extends LitElement {
  static properties = {
    cloudSignedIn: { type: Boolean },
    cloudBusy: { type: Boolean },
    cloudLinked: { type: Boolean },
    cloudRefreshPending: { type: Boolean },
    cloudErrorCode: {},
    imageFiles: { state: true },
    savingImage: { state: true },
    albumKind: { state: true },
    onlyPickup: { state: true },
    allCards: { state: true },
    importSources: { attribute: false },
    importSourceOpen: { state: true },
    currencyConversion: { attribute: false },
    exportingImage: { state: true },
    imageError: { state: true },
    locale: {},
    historyKinds: { attribute: false },
    selectedHistoryKind: {},
    accounts: { attribute: false },
    pools: { attribute: false },
    batches: { attribute: false },
    selectedAccountKey: {},
    busy: { type: Boolean },
    historyLoaded: { type: Boolean },
    catalogLoading: { type: Boolean },
    catalogError: {},
    canRetryCatalog: { type: Boolean },
    showAppLink: { type: Boolean },
    error: {},
    canImport: { type: Boolean },
    canRefresh: { type: Boolean },
    canExport: { type: Boolean },
    query: { state: true },
    filtersOpen: { state: true },
    filters: { state: true },
    from: { state: true },
    to: { state: true },
    oldest: { state: true },
    view: { state: true },
    expanded: { state: true },
    tab: { state: true },
  };
  declare cloudSignedIn: boolean;
  declare cloudBusy: boolean;
  declare cloudLinked: boolean;
  declare cloudRefreshPending: boolean;
  declare cloudErrorCode: string;
  private imageRequest?: AbortController;
  private imageGeneration = 0;
  declare private imageFiles: Array<{ blob: Blob; filename: string; url: string; width: number; height: number }>;
  declare private savingImage: boolean;
  declare private albumKind: "all" | "member" | "support";
  declare private onlyPickup: boolean;
  declare private allCards: boolean;
  declare importSources: readonly GachaHistoryImportSource[];
  declare private importSourceOpen: boolean;
  declare currencyConversion?: GachaHistoryConversion;
  declare private exportingImage: boolean;
  declare private imageError: string;
  declare locale: string;
  declare historyKinds: readonly string[];
  declare selectedHistoryKind: string;
  declare accounts: readonly GachaHistoryAccount[];
  declare pools: readonly GachaHistoryPool[];
  declare batches: readonly GachaHistoryBatch[];
  declare selectedAccountKey: string;
  declare busy: boolean;
  declare historyLoaded: boolean;
  declare catalogLoading: boolean;
  declare catalogError: string;
  declare canRetryCatalog: boolean;
  declare showAppLink: boolean;
  declare error: string;
  declare canImport: boolean;
  declare canRefresh: boolean;
  declare canExport: boolean;
  declare private query: string;
  declare private filtersOpen: boolean;
  declare private filters: Record<Axis, string[]>;
  declare private from: string;
  declare private to: string;
  declare private oldest: boolean;
  declare private view: CollectionView;
  declare private expanded: Set<string>;
  declare private tab: Tab;
  private images = new LazyImages();
  private indexedPools?: readonly GachaHistoryPool[];
  private poolIndex = new Map<string, GachaHistoryPool>();
  private expansionReady = false;
  private get poolMap() {
    if (this.indexedPools !== this.pools) {
      this.indexedPools = this.pools;
      this.poolIndex = new Map(this.pools.map((pool) => [pool.id, pool]));
    }
    return this.poolIndex;
  }
  constructor() {
    super();
    this.cloudSignedIn = false;
    this.cloudBusy = false;
    this.cloudLinked = false;
    this.cloudRefreshPending = false;
    this.cloudErrorCode = "";
    this.locale = "ja";
    this.imageFiles = [];
    this.savingImage = false;
    this.albumKind = "all";
    this.onlyPickup = false;
    this.allCards = false;
    this.historyLoaded = false;
    this.catalogLoading = false;
    this.catalogError = "";
    this.canRetryCatalog = false;
    this.showAppLink = false;
    this.importSources = [];
    this.importSourceOpen = false;
    this.exportingImage = false;
    this.imageError = "";
    this.historyKinds = [];
    this.selectedHistoryKind = "";
    this.accounts = [];
    this.pools = [];
    this.batches = [];
    this.selectedAccountKey = "";
    this.busy = false;
    this.error = "";
    this.canImport = false;
    this.canRefresh = false;
    this.canExport = false;
    this.query = "";
    this.filtersOpen = false;
    this.filters = { category: [], pool: [], kind: [], rarity: [], pickup: [] };
    this.from = "";
    this.to = "";
    this.oldest = false;
    this.view = "grid";
    this.expanded = new Set();
    this.tab = "overview";
  }
  connectedCallback() {
    super.connectedCallback();
    void Promise.all([
      import("@material/web/select/outlined-select.js"),
      import("@material/web/select/select-option.js"),
      import("@material/web/progress/linear-progress.js"),
    ]);
  }
  createRenderRoot() {
    return this;
  }
  protected firstUpdated() {
    const tab = location.hash.slice(1) as Tab;
    if (TABS.includes(tab)) this.tab = tab;
  }
  private number(value: number, digits = 0) {
    return value.toLocaleString(this.locale, { maximumFractionDigits: digits });
  }
  private percent(value: number, total = 1, digits = 2) {
    return total
      ? new Intl.NumberFormat(this.locale, { style: "percent", maximumFractionDigits: digits }).format(value / total)
      : "—";
  }
  private interval(range: GachaDrawInterval | null) {
    return range == null
      ? "—"
      : range.min === range.max
        ? this.number(range.min, 2)
        : `${this.number(range.min, 2)}–${this.number(range.max, 2)}`;
  }
  private get offsetMinutes() {
    const account = this.accounts.find((row) => row.key === this.selectedAccountKey);
    return (
      account?.offsetMinutes ??
      ({ jp: 540, "global-hmt": 480, "global-en": 0, "global-kr": 540 } as Record<string, number>)[
        account?.server ?? ""
      ] ??
      480
    );
  }
  private analysis(batches: readonly GachaHistoryBatch[]) {
    return analyzeGachaHistory(batches, this.offsetMinutes);
  }
  private serverTime(value: string, kind: "time" | "date" | "dateTime") {
    const shifted = new Date(value).getTime() + this.offsetMinutes * 60000;
    return kind === "time"
      ? formatTime(this.locale, shifted, { timeZone: "UTC" })
      : formatDate(this.locale, shifted, { timeZone: "UTC", time: kind !== "date" });
  }
  private t(key: string, values: Record<string, string | number> = {}) {
    return clientText(this.locale, `catalog.gachaHistory.${key}`, "", values);
  }
  private emit<K extends keyof GachaHistoryEvents>(type: K, detail: GachaHistoryEvents[K]["detail"]) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }
  protected update(changed: PropertyValues) {
    const priorFilters = changed.get("filters") as Record<Axis, string[]> | undefined;
    if (
      ["selectedAccountKey", "selectedHistoryKind", "batches", "from", "to"].some((key) => changed.has(key)) ||
      (priorFilters &&
        ["pool", "category"].some((key) => priorFilters[key as Axis].join("|") !== this.filters[key as Axis].join("|")))
    )
      this.cancelImageExport();
    if (this.hasAttribute("data-prerendered")) {
      hydrate(this.render(), this, this.renderOptions);
      this.removeAttribute("data-prerendered");
    }
    super.update(changed);
  }
  renderStaticChrome() {
    setAppBarSearch(OWNER, {
      value: this.query,
      label: this.t("search"),
      onInput: (value) => {
        this.query = value;
      },
    });
  }
  protected updated(changed: PropertyValues) {
    this.renderStaticChrome();
    this.images.observe(this);
    if (changed.has("selectedAccountKey")) {
      this.expansionReady = false;
      this.expanded = new Set();
      this.reset();
    }
  }
  disconnectedCallback() {
    this.cancelImageExport();
    this.images.disconnect();
    clearAppBarSearch(OWNER);
    clearBrowseBar();
    super.disconnectedCallback();
  }
  private toggle(axis: Axis, value: string) {
    this.filters = {
      ...this.filters,
      [axis]: this.filters[axis].includes(value)
        ? this.filters[axis].filter((v) => v !== value)
        : [...this.filters[axis], value],
    };
  }
  private toggleExpanded(id: string, open: boolean) {
    const next = new Set(this.expanded);
    if (open) next.add(id);
    else next.delete(id);
    this.expanded = next;
  }
  private fold(id: string, label: unknown, content: unknown, metadata?: unknown) {
    return accordion({
      id,
      label,
      metadata,
      expanded: this.expanded.has(id),
      onExpandedChange: (open) => this.toggleExpanded(id, open),
      content,
    });
  }
  private selectTab(tab: Tab) {
    this.tab = tab;
    history.replaceState(history.state, "", tab === "overview" ? location.pathname + location.search : `#${tab}`);
  }
  private reset() {
    this.filters = { category: [], pool: [], kind: [], rarity: [], pickup: [] };
    this.from = "";
    this.to = "";
  }
  private prizes(batch: GachaHistoryBatch) {
    const query = this.query.normalize("NFKC").toLocaleLowerCase(this.locale).trim();
    const poolMatches = this.poolMap
      .get(batch.poolId)
      ?.name.normalize("NFKC")
      .toLocaleLowerCase(this.locale)
      .includes(query);
    return batch.prizes.filter(
      (prize) =>
        (!this.filters.pickup.length ||
          this.filters.pickup.includes(prize.pickup == null ? "unknown" : prize.pickup ? "yes" : "no")) &&
        (!this.filters.kind.length || this.filters.kind.includes(prize.kind)) &&
        (!this.filters.rarity.length || this.filters.rarity.includes(String(prize.rarity))) &&
        (!query || poolMatches || prize.name.normalize("NFKC").toLocaleLowerCase(this.locale).includes(query)),
    );
  }
  private poolName(poolId: string | null) {
    return this.poolMap.get(poolId ?? "")?.name || poolId || this.t("unknown");
  }
  private poolLogo(pool: GachaHistoryPool | undefined) {
    return html`
      <span class="gacha-history__logo" aria-hidden="true">
        ${
          pool?.imageUrl
            ? html`
                <img
                  src=${pool.imageUrl}
                  width="96"
                  height="48"
                  loading="lazy"
                  decoding="async"
                  alt=""
                  @error=${(event: Event) => {
                    (event.currentTarget as HTMLImageElement).hidden = true;
                  }}
                />
              `
            : icon("casino", 24)
        }
      </span>
    `;
  }
  /** Draw-weighted official rate across the pools that publish one. */
  private officialRate(
    stats: ReturnType<GachaHistory["analysis"]>,
    rate: (rates: NonNullable<GachaHistoryPool["rates"]>) => number,
  ) {
    let draws = 0,
      sum = 0;
    for (const pool of stats.pools) {
      const rates = this.poolMap.get(pool.poolId ?? "")?.rates;
      if (!rates) continue;
      draws += pool.total;
      sum += rate(rates) * pool.total;
    }
    return draws ? sum / draws : null;
  }
  private luckTier(luck: GachaLuck) {
    const p = luck.percentile;
    return p >= 0.9 ? 1 : p >= 0.65 ? 2 : p > 0.35 ? 3 : p > 0.1 ? 4 : 5;
  }
  private luckValue(luck: GachaLuck) {
    const share = (value: number) => (value < 0.001 ? `< ${this.percent(0.001, 1, 1)}` : this.percent(value, 1, 1));
    return luck.percentile >= 0.5
      ? this.t("luckTop", { value: share(1 - luck.percentile) })
      : this.t("luckBottom", { value: share(luck.percentile) });
  }
  private luckMeter(label: string, luck: GachaLuck | null) {
    if (!luck) return nothing;
    const tier = this.luckTier(luck);
    return html`
      <div class="gacha-luck" data-tier=${tier}>
        <div class="row row--between row--baseline">
          <span class="md-title-small">${label}</span>
          <span class="gacha-luck__tier">${this.t(`luckTier${tier}`)}</span>
        </div>
        <div
          class="gacha-luck__track"
          role="meter"
          aria-label=${label}
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow=${Math.round(luck.percentile * 100)}
          aria-valuetext=${this.luckValue(luck)}
        >
          <span class="gacha-luck__fill" style=${`inline-size:${(luck.percentile * 100).toFixed(1)}%`}></span>
          <span class="gacha-luck__mark" style=${`inset-inline-start:${(luck.percentile * 100).toFixed(1)}%`}></span>
        </div>
        <dl class="spec-list spec-list--split spec-list--numeric">
          <div>
            <dt>${this.t("observed")}</dt>
            <dd>${this.number(luck.observed)}</dd>
          </div>
          <div>
            <dt>${this.t("expected")}</dt>
            <dd>${this.number(luck.expected, 2)}</dd>
          </div>
          <div>
            <dt>${this.t("luck")}</dt>
            <dd>${this.luckValue(luck)}</dd>
          </div>
          <div>
            <dt>${this.t("atLeastChance")}</dt>
            <dd>${luck.atLeast < 0.001 ? `< ${this.percent(0.001, 1, 1)}` : this.percent(luck.atLeast, 1, 1)}</dd>
          </div>
        </dl>
      </div>
    `;
  }
  private stat(options: { icon: TemplateResult; label: string; value: unknown; supporting?: unknown; tone?: string }) {
    return html`
      <div class="gacha-stat" data-tone=${options.tone ?? "neutral"}>
        <span class="gacha-stat__icon" aria-hidden="true">${options.icon}</span>
        <span class="gacha-stat__label">${options.label}</span>
        <span class="gacha-stat__value">${options.value}</span>
        <span class="gacha-stat__supporting">${options.supporting ?? nothing}</span>
      </div>
    `;
  }
  private collected(batches: readonly GachaHistoryBatch[]) {
    const cards = new Map<string, CollectedCard>();
    for (const batch of batches)
      for (const prize of batch.prizes) {
        if (prize.kind !== "member" && prize.kind !== "support") continue;
        const key = `${prize.kind}:${prize.id}`;
        const card = cards.get(key) ?? {
          key,
          prize,
          count: 0,
          pickup: 0,
          converted: 0,
          pools: new Set<string>(),
          last: null,
        };
        card.count++;
        if (prize.pickup === true) card.pickup++;
        if (prize.converted) card.converted++;
        card.pools.add(batch.poolId);
        if (batch.pulledAt && (!card.last || batch.pulledAt > card.last)) card.last = batch.pulledAt;
        cards.set(key, card);
      }
    return [...cards.values()];
  }
  render() {
    const poolMap = this.poolMap;
    const accountBatches = this.batches.filter((batch) => batch.accountKey === this.selectedAccountKey);
    const scoped = accountBatches.filter((batch) => {
      const pool = poolMap.get(batch.poolId),
        day = gachaHistoryDay(batch.pulledAt, this.offsetMinutes) ?? "";
      return (
        (!this.filters.pool.length || this.filters.pool.includes(batch.poolId)) &&
        (!this.filters.category.length || (pool && this.filters.category.includes(pool.category))) &&
        (!this.from || (day && day >= this.from)) &&
        (!this.to || (day && day <= this.to))
      );
    });
    const filtered = scoped
      .filter(
        (batch) =>
          (!this.query.trim() &&
            !this.filters.kind.length &&
            !this.filters.rarity.length &&
            !this.filters.pickup.length) ||
          this.prizes(batch).length,
      )
      .sort((a, b) => {
        if (!a.pulledAt) return b.pulledAt ? 1 : 0;
        if (!b.pulledAt) return -1;
        return (new Date(a.pulledAt).getTime() - new Date(b.pulledAt).getTime()) * (this.oldest ? 1 : -1);
      });
    const options = (axis: Axis) => {
      const entries = new Map<string, { value: string; label: string; count: number }>();
      for (const batch of accountBatches) {
        const pool = poolMap.get(batch.poolId);
        if (axis === "pool" || axis === "category") {
          const value = axis === "pool" ? batch.poolId : pool?.category;
          if (value) {
            const current = entries.get(value);
            entries.set(value, {
              value,
              label: axis === "pool" ? (pool?.name ?? value) : value,
              count: (current?.count ?? 0) + 1,
            });
          }
        } else
          for (const prize of batch.prizes) {
            if (axis === "pickup" && prize.pickup == null) continue;
            const value =
              axis === "pickup"
                ? prize.pickup == null
                  ? "unknown"
                  : prize.pickup
                    ? "yes"
                    : "no"
                : axis === "kind"
                  ? prize.kind
                  : String(prize.rarity);
            const label =
              axis === "pickup"
                ? this.t(prize.pickup ? "pickup" : "nonPickup")
                : axis === "kind"
                  ? this.t(prize.kind)
                  : prize.rarityLabel;
            if (label) {
              const current = entries.get(value);
              entries.set(value, { value, label, count: (current?.count ?? 0) + prize.quantity });
            }
          }
      }
      return [...entries.values()];
    };
    const applied = (Object.keys(this.filters) as Axis[]).flatMap((axis) =>
      this.filters[axis].map((value) =>
        inputChip(options(axis).find((option) => option.value === value)?.label ?? value, this.t("remove"), () =>
          this.toggle(axis, value),
        ),
      ),
    );
    if (this.from)
      applied.push(
        inputChip(`${this.t("from")} · ${this.from}`, this.t("remove"), () => {
          this.from = "";
        }),
      );
    if (this.to)
      applied.push(
        inputChip(`${this.t("to")} · ${this.to}`, this.t("remove"), () => {
          this.to = "";
        }),
      );
    const stats = scoped.length ? this.analysis(scoped) : null;
    const report = stats ? this.report(scoped, stats) : null;
    const viewTab = this.tab === "records" || this.tab === "collection";
    return html`
      <div class="gacha-history">
        ${this.renderImagePreview()}
        ${
          this.importSourceOpen
            ? renderLocalSaveSourcePicker({
                locale: this.locale,
                sources: this.importSources,
                historyGuidance: true,
                onClose: () => {
                  this.importSourceOpen = false;
                },
                onSelect: (source) => {
                  this.importSourceOpen = false;
                  this.emit("gacha-import-source", { source });
                },
              })
            : nothing
        }
        ${renderBrowse({
          kind: "gacha-history",
          count: { value: filtered.length, label: this.t("batches", { count: filtered.length }) },
          controls: html`
            ${iconButton({ label: this.t("exportImage"), icon: "image", disabled: !report || this.exportingImage, onClick: () => report && void this.exportImage(report) })}
            ${this.canExport ? iconButton({ label: this.t("export"), icon: "file_download", disabled: !filtered.length, onClick: () => this.emit("gacha-export", { accountKey: this.selectedAccountKey, historyKind: this.selectedHistoryKind, batches: filtered }) }) : nothing}
            ${
              this.tab === "records"
                ? iconButton({
                    label: this.oldest ? this.t("oldest") : this.t("newest"),
                    icon: "swap_vert",
                    pressed: this.oldest,
                    onClick: () => {
                      this.oldest = !this.oldest;
                    },
                  })
                : nothing
            }
          `,
          modes: viewTab
            ? viewSwitch(this.locale, this.view, (view) => {
                this.view = view;
              })
            : undefined,
          applied,
          filters: {
            label: this.t("filter"),
            open: this.filtersOpen,
            count: applied.length,
            closeLabel: this.t("close"),
            resetLabel: this.t("reset"),
            onOpen: () => {
              this.filtersOpen = true;
            },
            onClose: () => {
              this.filtersOpen = false;
            },
            onReset: () => this.reset(),
            body: html`
              ${(Object.keys(this.filters) as Axis[]).map((axis) => facet(this.t(axis), this.locale, options(axis), this.filters[axis], (value) => this.toggle(axis, value)))}
              <div class="stack">
                <label class="field">
                  <span>${this.t("from")}</span>
                  <input
                    type="date"
                    ?disabled=${!accountBatches.some((batch) => batch.pulledAt)}
                    .value=${this.from}
                    max=${this.to || nothing}
                    @change=${(e: Event) => {
                      this.from = (e.target as HTMLInputElement).value;
                    }}
                  />
                </label>
                <label class="field">
                  <span>${this.t("to")}</span>
                  <input
                    type="date"
                    ?disabled=${!accountBatches.some((batch) => batch.pulledAt)}
                    .value=${this.to}
                    min=${this.from || nothing}
                    @change=${(e: Event) => {
                      this.to = (e.target as HTMLInputElement).value;
                    }}
                  />
                </label>
              </div>
            `,
          },
          results: html`
            <div class="stack stack--loose" aria-busy=${String(this.busy)}>
              ${this.renderHero(scoped, stats)}
              ${this.busy || this.exportingImage ? loadingState(this.t(this.exportingImage ? "exportingImage" : "loading")) : nothing}
              ${
                stats
                  ? html`
                      ${this.renderTabs()}
                      <div
                        class="gacha-history__panel"
                        role="tabpanel"
                        id="gacha-history-panel"
                        aria-labelledby=${`gacha-tab-${this.tab}`}
                      >
                        ${this.renderPanel(scoped, filtered, stats)}
                      </div>
                    `
                  : html`
                      ${emptyState({
                        title: !this.selectedAccountKey
                          ? this.t("emptyAccount")
                          : !accountBatches.length
                            ? this.t(this.historyLoaded ? "empty" : "historyNotLoaded")
                            : this.t("noResults"),
                        icon: "history",
                      })}
                      ${this.selectedAccountKey ? this.renderSettings() : nothing}
                    `
              }
            </div>
          `,
        })}
      </div>
    `;
  }

  private renderHero(scoped: readonly GachaHistoryBatch[], stats: ReturnType<GachaHistory["analysis"]> | null) {
    const account = this.accounts.find((row) => row.key === this.selectedAccountKey);
    const dates = scoped
      .map((batch) => batch.pulledAt)
      .filter((value): value is string => Boolean(value))
      .sort();
    const luck = stats ? gachaHistoryLuck(scoped, "high") : null;
    const official = stats ? this.officialRate(stats, (rates) => rates.high) : null;
    const gems = stats ? (stats.cost.freeGems.value ?? 0) + (stats.cost.paidGems.value ?? 0) : 0;
    const latest = [...scoped]
      .filter((batch) => batch.pulledAt)
      .sort((a, b) => (b.pulledAt! > a.pulledAt! ? 1 : -1))[0];
    const streak = latest
      ? gachaHistoryHits(
          scoped.filter((batch) => batch.poolId === latest.poolId),
          "high",
        )[0]?.trailing
      : null;
    const money =
      stats && this.currencyConversion ? summarizeGachaHistoryMoney(stats.cost, this.currencyConversion) : null;
    const status =
      this.imageError || this.error || (this.catalogLoading ? this.t("catalogLoading") : this.catalogError);
    return html`
      <section class="gacha-hero surface stack" aria-label=${this.t("account")}>
        <div class="gacha-hero__account">
          <md-outlined-select
            label=${this.t("account")}
            .value=${this.selectedAccountKey}
            .displayText=${account ? [account.serverLabel, account.label].filter(Boolean).join(" · ") : ""}
            ?disabled=${!this.accounts.length || this.busy}
            @change=${(event: Event) => this.emit("gacha-account-change", { accountKey: (event.target as HTMLSelectElement).value })}
          >
            <md-select-option value=""><div slot="headline">${this.t("selectAccount")}</div></md-select-option>
            ${this.accounts.map(
              (row) => html`
                <md-select-option value=${row.key} ?selected=${row.key === this.selectedAccountKey}>
                  <div slot="headline">${[row.serverLabel, row.label].filter(Boolean).join(" · ")}</div>
                </md-select-option>
              `,
            )}
          </md-outlined-select>
          <div class="gacha-hero__actions">
            ${
              this.canRefresh
                ? html`
                    <button
                      class="button button--filled"
                      type="button"
                      ?disabled=${this.busy || !this.selectedAccountKey}
                      @click=${() => this.emit("gacha-refresh", { accountKey: this.selectedAccountKey })}
                    >
                      ${icon("history")}${this.t("readHistory")}
                    </button>
                  `
                : nothing
            }
            ${
              this.canImport
                ? html`
                    <button
                      class="button button--tonal"
                      type="button"
                      ?disabled=${this.busy}
                      @click=${() => this.openImport()}
                    >
                      ${icon("file_upload")}${this.t("import")}
                    </button>
                  `
                : nothing
            }
            ${
              this.showAppLink
                ? html`
                    <button
                      class="button button--text"
                      type="button"
                      @click=${() => this.dispatchEvent(new CustomEvent("gacha-open-app", { bubbles: true, composed: true }))}
                    >
                      ${icon("open_in_new")}${this.t("openApp")}
                    </button>
                  `
                : nothing
            }
          </div>
        </div>
        ${
          dates.length || stats
            ? html`
                <div class="gacha-hero__meta md-body-medium">
                  ${
            dates.length
              ? html`
                  <span>
                    ${icon("date_range", 18)}${this.serverTime(dates[0], "date")} –
                    ${this.serverTime(dates.at(-1)!, "date")}
                  </span>
                `
              : nothing
          }
                  ${
            stats
              ? html`
                  <span>${icon("receipt_long", 18)}${this.t("batches", { count: stats.batches })}</span>
                `
              : nothing
          }
                  ${
            this.historyKinds.length > 1
              ? html`
                  <span>
                    ${icon("history", 18)}${this.t(this.selectedHistoryKind === "legacy" ? "historyLegacy" : "historyExecution")}
                  </span>
                `
              : nothing
          }
                </div>
              `
            : nothing
        }
        <p class="gacha-hero__status" role="status" aria-live="polite">
          ${status}
          ${
            this.canRetryCatalog && this.catalogError && !this.catalogLoading
              ? html`
                  <button
                    type="button"
                    class="button button--text"
                    @click=${() => this.dispatchEvent(new CustomEvent("gacha-catalog-retry", { bubbles: true, composed: true }))}
                  >
                    ${this.t("retryCatalog")}
                  </button>
                `
              : nothing
          }
        </p>
        ${
          stats
            ? html`
                <div class="gacha-hero__stats">
                  ${this.stat({
                    icon: icon("casino", 24),
                    label: this.t("total"),
                    value: this.number(stats.total),
                    supporting: `${this.t("member")} ${this.number(stats.member)} · ${this.t("support")} ${this.number(stats.support)}`,
                    tone: "primary",
                  })}
                  ${this.stat({
                    icon: icon("star", 24),
                    label: "SSR+",
                    value: this.number(stats.high),
                    supporting: `${this.percent(stats.high, stats.total)}${official == null ? "" : ` · ${this.t("officialRate")} ${this.percent(official)}`}`,
                    tone: "tertiary",
                  })}
                  ${this.stat({
                    icon: icon("trending_up", 24),
                    label: this.t("pickup"),
                    value: this.number(stats.pickup),
                    supporting: stats.pickup
                      ? this.t("pullsEach", { count: this.number(stats.total / stats.pickup, 1) })
                      : stats.pickupUnknown
                        ? `${this.t("unknown")} ${this.number(stats.pickupUnknown)}`
                        : "",
                    tone: "secondary",
                  })}
                  ${this.stat({
                    icon: icon("hourglass_bottom", 24),
                    label: this.t("sinceLastHigh"),
                    value: streak ? this.interval(streak) : "—",
                    supporting: latest ? this.poolName(latest.poolId) : "",
                  })}
                  ${this.stat({
                    icon: icon("auto_awesome", 24),
                    label: this.t("luck"),
                    value: luck ? this.t(`luckTier${this.luckTier(luck)}`) : "—",
                    supporting: luck ? this.luckValue(luck) : "",
                    tone: luck ? `luck-${this.luckTier(luck)}` : "neutral",
                  })}
                  ${this.stat({
                    icon: icon("diamond", 24),
                    label: this.t("gemsSpent"),
                    value:
                      stats.cost.freeGems.value == null && stats.cost.paidGems.value == null ? "—" : this.number(gems),
                    supporting:
                      money?.sum != null
                        ? new Intl.NumberFormat(this.locale, {
                            style: "currency",
                            currency: this.currencyConversion!.currencyCode,
                          }).format(money.sum)
                        : stats.cost.tickets.value
                          ? `${this.t("tickets")} ${this.number(stats.cost.tickets.value)}`
                          : "",
                  })}
                </div>
              `
            : nothing
        }
      </section>
    `;
  }

  private renderTabs() {
    const labels: Record<Tab, [string, TemplateResult]> = {
      overview: [this.t("tabOverview"), icon("insights", 18)],
      pools: [this.t("tabPools"), icon("layers", 18)],
      collection: [this.t("tabCollection"), icon("collections_bookmark", 18)],
      records: [this.t("tabRecords"), icon("receipt_long", 18)],
      trends: [this.t("tabTrends"), icon("show_chart", 18)],
      settings: [this.t("tabSettings"), icon("tune", 18)],
    };
    return html`
      <nav
        class="tabs tabs--pills gacha-history__tabs"
        role="tablist"
        aria-label=${this.t("title")}
        @keydown=${rovingKeydown(TABS, this.tab, (tab) => this.selectTab(tab))}
      >
        ${TABS.map(
          (tab) => html`
            <button
              class="tab"
              type="button"
              role="tab"
              id=${`gacha-tab-${tab}`}
              aria-controls="gacha-history-panel"
              aria-selected=${String(this.tab === tab)}
              tabindex=${this.tab === tab ? "0" : "-1"}
              @click=${() => this.selectTab(tab)}
            >
              ${labels[tab][1]}
              <span>${labels[tab][0]}</span>
            </button>
          `,
        )}
      </nav>
    `;
  }

  private renderPanel(
    scoped: readonly GachaHistoryBatch[],
    filtered: readonly GachaHistoryBatch[],
    stats: ReturnType<GachaHistory["analysis"]>,
  ) {
    switch (this.tab) {
      case "pools":
        return this.renderPools(scoped, stats);
      case "collection":
        return this.renderCollection(scoped);
      case "records":
        return this.renderRecords(filtered);
      case "trends":
        return this.renderTrends(scoped, stats);
      case "settings":
        return this.renderSettings();
      default:
        return this.renderOverview(scoped, stats);
    }
  }

  private chart(
    label: string,
    categories: string[],
    series: Array<{ name: string; values: number[] }>,
    options: { horizontal?: boolean; caption?: string; details?: string[]; wide?: boolean } = {},
  ) {
    return html`
      <section class=${`surface stack${options.wide ? " gacha-history__wide" : ""}`}>
        ${renderDetailSectionHeading(label, "stats", { level: 3 })}
        ${
          options.caption
            ? html`
                <div class="md-body-small">${options.caption}</div>
              `
            : nothing
        }
        <gacha-history-chart
          .data=${{ label, categories, series, horizontal: !!options.horizontal, grouped: false, details: options.details ?? [] }}
        ></gacha-history-chart>
      </section>
    `;
  }

  private distributionCharts(stats: ReturnType<GachaHistory["analysis"]>) {
    return stats.kinds
      .filter((kind) => (kind.kind === "member" || kind.kind === "support") && kind.total)
      .map((kind) => {
        const rows = kind.distribution.filter(
          (row) =>
            ["SSR", "SR", "R"].includes(row.rarity) ||
            (row.count > 0 && row.rarity !== "item" && row.rarity !== "unknown"),
        );
        return this.chart(
          `${this.t(kind.kind)} · ${this.t("rarityDistribution")}`,
          rows.map((row) => `${row.rarity} · ${this.percent(row.count, kind.total)}`),
          (["nonPickup", "pickup"] as const).map((key) => ({ name: this.t(key), values: rows.map((row) => row[key]) })),
          {
            horizontal: true,
            caption: `${this.t(kind.kind)} ${this.number(kind.total)} · SSR+ ${this.percent(kind.high, kind.total)}`,
          },
        );
      });
  }

  private renderOverview(scoped: readonly GachaHistoryBatch[], stats: ReturnType<GachaHistory["analysis"]>) {
    const rows: Array<[string, number, number | null]> = [
      ["SSR+", stats.high, this.officialRate(stats, (r) => r.high)],
      [
        `${this.t("member")} SSR+`,
        stats.kinds.find((k) => k.kind === "member")!.high,
        this.officialRate(stats, (r) => r.memberHigh),
      ],
      [
        `${this.t("support")} SSR+`,
        stats.kinds.find((k) => k.kind === "support")!.high,
        this.officialRate(stats, (r) => r.supportHigh),
      ],
      [
        "BD",
        stats.distribution.find((row) => row.rarity === "BD")!.count,
        this.officialRate(stats, (r) => r.rarities.BD),
      ],
      [
        "EX",
        stats.distribution.find((row) => row.rarity === "EX")!.count,
        this.officialRate(stats, (r) => r.rarities.EX),
      ],
      [
        "SR",
        stats.distribution.find((row) => row.rarity === "SR")!.count,
        this.officialRate(stats, (r) => r.rarities.SR),
      ],
      ["R", stats.distribution.find((row) => row.rarity === "R")!.count, this.officialRate(stats, (r) => r.rarities.R)],
      [this.t("pickup"), stats.pickup, this.officialRate(stats, (r) => r.pickup)],
    ];
    const hits = gachaHistoryHits(scoped, "high")
      .flatMap((pool) => pool.hits.map((hit) => ({ ...hit, poolId: pool.poolId })))
      .sort((a, b) => (a.pulledAt < b.pulledAt ? 1 : a.pulledAt > b.pulledAt ? -1 : 0));
    return html`
      <div class="gacha-history__grid">
        <section class="surface stack">
          ${renderDetailSectionHeading(this.t("luck"), "stats", { level: 3 })}
          ${this.luckMeter("SSR+", gachaHistoryLuck(scoped, "high"))}
          ${this.luckMeter(this.t("pickup"), gachaHistoryLuck(scoped, "pickup"))}
          ${
            !gachaHistoryLuck(scoped, "high")
              ? html`
                  <p class="md-body-medium">—</p>
                `
              : nothing
          }
        </section>
        <section class="surface stack">
          ${renderDetailSectionHeading(this.t("rateComparison"), "difficulty", { level: 3 })}
          ${collectionTable(
            this.t("rateComparison"),
            [this.t("resultType"), this.t("quantity"), this.t("observedRate"), this.t("officialRate")],
            rows
              .filter(([, count, official], index) => index < 3 || count > 0 || (official ?? 0) > 0)
              .map(([label, count, official]) => [
                label,
                this.number(count),
                this.percent(count, stats.total),
                official == null ? "—" : this.percent(official),
              ]),
            { numeric: true },
          )}
        </section>
        <section class="surface stack gacha-history__wide">
          ${renderDetailSectionHeading(this.t("recentHits"), "cards", { level: 3, count: this.number(hits.length) })}
          ${
            hits.length
              ? this.hitList(hits.slice(0, 12), true)
              : html`
                  <p class="md-body-medium">—</p>
                `
          }
          ${
            hits.length > 12
              ? html`
                  <button class="button button--text" type="button" @click=${() => this.selectTab("pools")}>
                    ${this.t("allHits")}${icon("chevron_right", 18)}
                  </button>
                `
              : nothing
          }
        </section>
        ${this.distributionCharts(stats)}
        <section class="surface stack gacha-history__wide">
          ${renderDetailSectionHeading(this.t("cost"), "stats", { level: 3 })}
          <dl class="spec-list spec-list--split spec-list--numeric">
            ${this.costMetrics(scoped).map(
              (metric) => html`
                <div>
                  <dt>${metric.label}</dt>
                  <dd>${metric.value}</dd>
                </div>
              `,
            )}
          </dl>
        </section>
        ${this.renderHighlights(scoped)}
      </div>
    `;
  }

  private hitList(hits: ReadonlyArray<GachaHit & { poolId?: string | null }>, showPool: boolean) {
    const largest = Math.max(1, ...hits.map((hit) => hit.since.max));
    return html`
      <ol class="gacha-hits">
        ${hits.map((entry) => {
          const prize = entry.prize as GachaHistoryPrize;
          const middle = (entry.since.min + entry.since.max) / 2;
          return html`
            <li class="gacha-hit" data-pickup=${String(prize.pickup === true)}>
              <span class="gacha-hit__card">
                ${gachaPrizeCard({
                  label: prize.name,
                  kind: prize.kind,
                  rarity: prize.rarity,
                  href: prize.href,
                  image: prize.imageUrl,
                  attribute: prize.attributeImageUrl,
                  rarityMark: prize.rarityImageUrl,
                  pickup: prize.pickup === true,
                })}
              </span>
              <span class="gacha-hit__body">
                ${
                  prize.href
                    ? html`
                        <a class="gacha-hit__name" href=${prize.href}>${prize.name}</a>
                      `
                    : html`
                        <span class="gacha-hit__name">${prize.name}</span>
                      `
                }
                <span class="gacha-hit__meta">
                  ${[
                    showPool ? this.poolName(entry.poolId ?? null) : "",
                    this.serverTime(entry.pulledAt, "dateTime"),
                    `#${this.interval(entry.position)}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span class="gacha-hit__gap">
                <span class="gacha-hit__count">${this.t("draws", { count: this.interval(entry.since) })}</span>
                <span class="gacha-hit__bar" aria-hidden="true">
                  <span style=${`inline-size:${Math.max(2, (middle / largest) * 100).toFixed(1)}%`}></span>
                </span>
              </span>
            </li>
          `;
        })}
      </ol>
    `;
  }

  private renderPools(scoped: readonly GachaHistoryBatch[], stats: ReturnType<GachaHistory["analysis"]>) {
    const highHits = new Map(gachaHistoryHits(scoped, "high").map((row) => [row.poolId, row]));
    const pickupHits = new Map(gachaHistoryHits(scoped, "pickup").map((row) => [row.poolId, row]));
    return html`
      <div class="stack stack--loose">
        ${repeat(
          stats.pools,
          (pool) => pool.poolId ?? "unknown",
          (pool) => {
            const view = this.poolMap.get(pool.poolId ?? "");
            const batches = scoped.filter((batch) => (batch.poolId || null) === (pool.poolId || null));
            const high = highHits.get(pool.poolId) as GachaPoolHits | undefined;
            const pickup = pickupHits.get(pool.poolId) as GachaPoolHits | undefined;
            const owned = new Map(this.collected(batches).map((card) => [card.key, card]));
            const period =
              view?.startAt && view.endAt
                ? `${this.serverTime(view.startAt, "date")} – ${this.serverTime(view.endAt, "date")}`
                : "";
            const id = `pool-${pool.poolId ?? "unknown"}`;
            return html`
              <article class="surface stack gacha-pool">
                <header class="gacha-pool__header">
                  ${this.poolLogo(view)}
                  <div class="gacha-pool__title">
                    <h3 class="md-title-medium">${this.poolName(pool.poolId)}</h3>
                    <span class="md-body-small">${[view?.category, period].filter(Boolean).join(" · ")}</span>
                  </div>
                  <span class="gacha-pool__total">${this.t("draws", { count: this.number(pool.total) })}</span>
                </header>
                <div class="gacha-pool__stats">
                  ${this.stat({
                    icon: icon("star", 20),
                    label: "SSR+",
                    value: this.number(pool.high),
                    supporting: `${this.percent(pool.high, pool.total)}${view?.rates ? ` · ${this.t("officialRate")} ${this.percent(view.rates.high)}` : ""}`,
                    tone: "tertiary",
                  })}
                  ${this.stat({
                    icon: icon("trending_up", 20),
                    label: this.t("pickup"),
                    value: this.number(pool.pickup),
                    supporting: `${this.percent(pool.pickup, pool.total)}${view?.rates?.pickup ? ` · ${this.t("officialRate")} ${this.percent(view.rates.pickup)}` : ""}`,
                    tone: "secondary",
                  })}
                  ${this.stat({
                    icon: icon("hourglass_bottom", 20),
                    label: this.t("sinceLastHigh"),
                    value: this.interval(high?.trailing ?? null),
                    supporting: pickup?.trailing
                      ? `${this.t("sinceLastPickup")} ${this.interval(pickup.trailing)}`
                      : "",
                  })}
                  ${this.stat({
                    icon: icon("functions", 20),
                    label: this.t("pullsPerHigh"),
                    value: pool.pullsPerHigh == null ? "—" : this.number(pool.pullsPerHigh, 1),
                    supporting:
                      pool.expectedHigh == null
                        ? ""
                        : `${this.t("expected")} ${this.number(pool.expectedHigh, 2)} · ${this.t("difference")} ${new Intl.NumberFormat(this.locale, { maximumFractionDigits: 2, signDisplay: "always" }).format(pool.delta ?? 0)}`,
                  })}
                </div>
                ${this.luckMeter(this.t("luck"), gachaHistoryLuck(batches, "high"))}
                ${
                  view?.featured?.length
                    ? html`
                        <section class="stack">
                          <h4 class="detail-section-title">
                            ${this.t("pickupCollected")}
                            <small class="detail-section-title__count">
                              ${view.featured.filter((card) => owned.has(card.key)).length} / ${view.featured.length}
                            </small>
                          </h4>
                          ${(["member", "support"] as const)
                            .filter((kind) => view.featured!.some((card) => card.kind === kind))
                            .map(
                              (kind) => html`
                                <div class="gacha-stats gacha-pool__featured" data-kind=${kind}>
                                  ${view
                                    .featured!.filter((card) => card.kind === kind)
                                    .map((card) => {
                                      const got = owned.get(card.key);
                                      return html`
                                        <span class="gacha-pool__featured-card" data-owned=${String(!!got)}>
                                          ${gachaPrizeCard({
                                      label: `${card.name} · ${got ? `×${got.count}` : this.t("notObtained")}`,
                                      kind: card.kind,
                                      rarity: card.rarity,
                                      href: card.href,
                                      image: card.imageUrl,
                                      attribute: card.attributeImageUrl,
                                      rarityMark: card.rarityImageUrl,
                                      count: got?.count ?? 0,
                                    })}
                                        </span>
                                      `;
                                    })}
                                </div>
                              `,
                            )}
                        </section>
                      `
                    : nothing
                }
                ${this.exchangeProgress(view)}
                ${
                  high?.hits.length
                    ? this.fold(
                        `${id}-high`,
                        this.t("highHistory"),
                        this.hitList([...high.hits].reverse(), false),
                        this.number(high.hits.length),
                      )
                    : nothing
                }
                ${
                  pickup?.hits.length
                    ? this.fold(
                        `${id}-pickup`,
                        this.t("pickupHistory"),
                        this.hitList([...pickup.hits].reverse(), false),
                        this.number(pickup.hits.length),
                      )
                    : nothing
                }
              </article>
            `;
          },
        )}
      </div>
    `;
  }

  private renderHighlights(scoped: readonly GachaHistoryBatch[]) {
    const cards = this.collected(scoped)
      .filter((card) => isHigh(card.prize))
      .sort(
        (a, b) => b.pickup - a.pickup || rarityRank(b.prize.rarity) - rarityRank(a.prize.rarity) || b.count - a.count,
      )
      .slice(0, 12);
    if (!cards.length) return nothing;
    return html`
      <section class="surface stack gacha-history__wide">
        ${renderDetailSectionHeading(this.t("highlights"), "cards", { level: 3 })}
        <div class="gacha-stats">
          ${cards.map((card) =>
            gachaPrizeCard({
              label: `${card.prize.name} · ×${card.count}`,
              kind: card.prize.kind,
              rarity: card.prize.rarity,
              href: card.prize.href,
              image: card.prize.imageUrl,
              attribute: card.prize.attributeImageUrl,
              rarityMark: card.prize.rarityImageUrl,
              count: card.count,
              pickupCount: card.pickup,
              pickup: card.pickup > 0,
            }),
          )}
        </div>
        <button class="button button--text" type="button" @click=${() => this.selectTab("collection")}>
          ${this.t("tabCollection")}${icon("chevron_right", 18)}
        </button>
      </section>
    `;
  }

  private renderCollection(scoped: readonly GachaHistoryBatch[]) {
    const all = this.collected(scoped);
    const cards = all
      .filter(
        (card) =>
          (this.albumKind === "all" || card.prize.kind === this.albumKind) &&
          (this.allCards || isHigh(card.prize) || card.pickup > 0) &&
          (!this.onlyPickup || card.pickup > 0),
      )
      .sort(
        (a, b) =>
          rarityRank(b.prize.rarity) - rarityRank(a.prize.rarity) || b.count - a.count || a.key.localeCompare(b.key),
      );
    const copies = all.reduce((sum, card) => sum + card.count, 0);
    const high = all.filter((card) => isHigh(card.prize));
    return html`
      <div class="stack stack--loose">
        <section class="surface stack">
          <dl class="spec-list spec-list--split spec-list--numeric">
            <div>
              <dt>${this.t("distinctCards")}</dt>
              <dd>${this.number(all.length)}</dd>
            </div>
            <div>
              <dt>${this.t("distinctHigh")}</dt>
              <dd>${this.number(high.length)}</dd>
            </div>
            <div>
              <dt>${this.t("duplicates")}</dt>
              <dd>${this.number(copies - all.length)}</dd>
            </div>
            <div>
              <dt>${this.t("converted")}</dt>
              <dd>${this.number(all.reduce((sum, card) => sum + card.converted, 0))}</dd>
            </div>
          </dl>
          <div class="cluster">
            ${segmented({
              label: this.t("kind"),
              value: this.albumKind,
              grow: false,
              options: [
                { value: "all", label: this.t("allKinds") },
                { value: "member", label: this.t("member") },
                { value: "support", label: this.t("support") },
              ],
              onSelect: (value) => {
                this.albumKind = value;
              },
            })}
            ${filterChip({
              label: this.t("allCards"),
              selected: this.allCards,
              onToggle: () => {
                this.allCards = !this.allCards;
              },
            })}
            ${filterChip({
              label: this.t("onlyPickup"),
              selected: this.onlyPickup,
              onToggle: () => {
                this.onlyPickup = !this.onlyPickup;
              },
            })}
          </div>
        </section>
        ${
          !cards.length
            ? emptyState({ title: this.t("noResults"), icon: "collections_bookmark" })
            : this.view === "table"
              ? collectionTable(
                  this.t("tabCollection"),
                  [
                    this.t("card"),
                    this.t("kind"),
                    this.t("rarity"),
                    this.t("quantity"),
                    this.t("pickup"),
                    this.t("converted"),
                    this.t("pool"),
                  ],
                  cards.map((card) => [
                    card.prize.href
                      ? html`
                          <a href=${card.prize.href}>${card.prize.name}</a>
                        `
                      : card.prize.name,
                    this.t(card.prize.kind),
                    card.prize.rarityLabel || "—",
                    this.number(card.count),
                    this.number(card.pickup),
                    this.number(card.converted),
                    [...card.pools].map((pool) => this.poolName(pool)).join(" / "),
                  ]),
                )
              : this.view === "list"
                ? collectionList(
                    cards.map((card) => ({
                      id: card.key,
                      title: card.prize.name,
                      subtitle: [
                        this.t(card.prize.kind),
                        card.prize.rarityLabel,
                        `×${card.count}`,
                        card.pickup ? `${this.t("pickup")} ×${card.pickup}` : "",
                        card.last ? this.serverTime(card.last, "date") : "",
                      ]
                        .filter(Boolean)
                        .join(" · "),
                      href: card.prize.href,
                      media: card.prize.imageUrl
                        ? html`
                            <img
                              src=${card.prize.imageUrl}
                              alt=""
                              loading="lazy"
                              decoding="async"
                              width="56"
                              height="56"
                            />
                          `
                        : icon("image"),
                    })),
                  )
                : (["member", "support"] as const)
                    .filter((kind) => cards.some((card) => card.prize.kind === kind))
                    .map(
                      (kind) => html`
                        <section class="stack">
                          ${renderDetailSectionHeading(
                            this.t(kind),
                            kind === "member" ? "memberCards" : "supportCards",
                            {
                              level: 3,
                              count: this.number(cards.filter((card) => card.prize.kind === kind).length),
                            },
                          )}
                          <div class="gacha-stats" data-kind=${kind}>
                            ${cards
                              .filter((card) => card.prize.kind === kind)
                              .map((card) =>
                                gachaPrizeCard({
                                  label: `${card.prize.name} · ×${card.count} · ${this.t("pickup")} ${card.pickup}`,
                                  kind,
                                  rarity: card.prize.rarity,
                                  href: card.prize.href,
                                  image: card.prize.imageUrl,
                                  attribute: card.prize.attributeImageUrl,
                                  rarityMark: card.prize.rarityImageUrl,
                                  count: card.count,
                                  pickupCount: card.pickup,
                                  pickup: card.pickup > 0,
                                }),
                              )}
                          </div>
                        </section>
                      `,
                    )
        }
      </div>
    `;
  }

  private renderRecords(filtered: readonly GachaHistoryBatch[]) {
    if (!filtered.length) return emptyState({ title: this.t("noResults"), icon: "receipt_long" });
    const groups = new Map<string, GachaHistoryBatch[]>();
    for (const batch of filtered) {
      const day = gachaHistoryDay(batch.pulledAt, this.offsetMinutes) ?? "unknown";
      const group = groups.get(day);
      if (group) group.push(batch);
      else groups.set(day, [batch]);
    }
    if (!this.expansionReady && groups.size) {
      const first = groups.keys().next().value!;
      if (first !== "unknown") this.expanded.add(first);
      this.expansionReady = true;
    }
    return html`
      <section class="stack">
        ${repeat(
          [...groups],
          ([day]) => day,
          ([day, batches]) =>
            accordion({
              id: `gacha-day-${day}`,
              label:
                day === "unknown"
                  ? this.t("unknownTime")
                  : formatDate(this.locale, `${day}T12:00:00`),
              metadata: this.drawSummary(batches),
              expanded: this.expanded.has(day),
              onExpandedChange: (open) => this.toggleExpanded(day, open),
              content: this.expanded.has(day)
                ? html`
                    <div class="stack stack--loose">
                      ${repeat(
                        batches,
                        (batch) => batch.id,
                        (batch) => {
                          const high = batch.prizes.filter(isHigh).length;
                          const gems = (batch.cost?.freeGems ?? 0) + (batch.cost?.paidGems ?? 0);
                          return html`
                            <article class="gacha-batch stack">
                              <header class="gacha-batch__header">
                                ${this.poolLogo(this.poolMap.get(batch.poolId))}
                                <div class="gacha-pool__title">
                                  <strong>${this.poolName(batch.poolId)}</strong>
                                  <span class="md-body-small">
                                    ${
                                      batch.pulledAt
                                        ? html`
                                            <time datetime=${batch.pulledAt}>
                                              ${this.serverTime(batch.pulledAt, "time")}
                                            </time>
                                          `
                                        : this.t("unknownTime")
                                    }
                                    ·
                                    ${batch.drawCount == null ? this.t("unknownCount") : this.t("draws", { count: batch.drawCount })}
                                  </span>
                                </div>
                                <span class="cluster gacha-batch__chips">
                                  ${
                                    high
                                      ? html`
                                          <span class="gacha-chip" data-tone="tertiary">
                                            ${icon("star", 16)}SSR+ ${high}
                                          </span>
                                        `
                                      : nothing
                                  }
                                  ${
                                    gems
                                      ? html`
                                          <span class="gacha-chip">${icon("diamond", 16)}${this.number(gems)}</span>
                                        `
                                      : nothing
                                  }
                                  ${
                                    batch.cost?.tickets
                                      ? html`
                                          <span class="gacha-chip">
                                            ${icon("confirmation_number", 16)}${this.number(batch.cost.tickets)}
                                          </span>
                                        `
                                      : nothing
                                  }
                                </span>
                              </header>
                              ${this.renderPrizes(this.prizes(batch))}
                            </article>
                          `;
                        },
                      )}
                    </div>
                  `
                : nothing,
            }),
        )}
      </section>
    `;
  }

  private renderTrends(scoped: readonly GachaHistoryBatch[], stats: ReturnType<GachaHistory["analysis"]>) {
    const months = gachaHistoryMonths(scoped, this.offsetMinutes);
    const composition = (rows: Array<{ member: number; support: number; other: number }>) =>
      (["member", "support", "other"] as const).map((key) => ({
        name: this.t(key === "other" ? "item" : key),
        values: rows.map((row) => row[key]),
      }));
    const monthLabel = (month: string) =>
      new Intl.DateTimeFormat(this.locale, { year: "numeric", month: "short", timeZone: "UTC" }).format(
        new Date(`${month}-01T00:00:00Z`),
      );
    return html`
      <div class="gacha-history__grid">
        ${this.chart(
          this.t("monthlyTrend"),
          months.map((row) => monthLabel(row.month)),
          composition(months),
          {
            details: months.map((row) => `SSR+ ${row.high} · ${this.t("pickup")} ${row.pickup}`),
          },
        )}
        ${this.chart(
          `SSR+ · ${this.t("monthlyTrend")}`,
          months.map((row) => monthLabel(row.month)),
          [
            { name: this.t("nonPickup"), values: months.map((row) => row.high - Math.min(row.high, row.pickup)) },
            { name: this.t("pickup"), values: months.map((row) => Math.min(row.high, row.pickup)) },
          ],
        )}
        ${this.chart(
          this.t("dailyTrend"),
          stats.days.map((day) => day.day ?? this.t("unknownTime")),
          composition(stats.days),
          { details: stats.days.map((day) => `SSR+ ${day.high} · ${this.t("pickup")} ${day.pickup}`), wide: true },
        )}
        ${this.chart(
          this.t("poolComposition"),
          stats.pools.map((pool) => this.poolName(pool.poolId)),
          composition(stats.pools),
          { horizontal: true, wide: true },
        )}
        <section class="surface stack gacha-history__wide">
          ${renderDetailSectionHeading(this.t("monthlyTrend"), "stats", { level: 3 })}
          ${collectionTable(
            this.t("monthlyTrend"),
            [
              this.t("month"),
              this.t("total"),
              "SSR+",
              this.t("pickup"),
              this.t("observedRate"),
              this.t("freeGems"),
              this.t("paidGems"),
              this.t("tickets"),
            ],
            [...months]
              .reverse()
              .map((row) => [
                monthLabel(row.month),
                this.number(row.total),
                this.number(row.high),
                this.number(row.pickup),
                this.percent(row.high, row.total),
                row.cost.freeGems.value == null ? "—" : this.number(row.cost.freeGems.value),
                row.cost.paidGems.value == null ? "—" : this.number(row.cost.paidGems.value),
                row.cost.tickets.value == null ? "—" : this.number(row.cost.tickets.value),
              ]),
            { numeric: true },
          )}
        </section>
      </div>
    `;
  }

  private renderSettings() {
    return html`
      <div class="gacha-history__grid">
        <section class="surface stack">
          ${renderDetailSectionHeading(this.t("account"), "accounts", { level: 3 })}
          ${
            this.historyKinds.length > 1
              ? html`
                  <md-outlined-select
                    label=${this.t("historyKind")}
                    .value=${this.selectedHistoryKind}
                    .displayText=${this.t(this.selectedHistoryKind === "legacy" ? "historyLegacy" : "historyExecution")}
                    @change=${(event: Event) => this.emit("gacha-history-kind-change", { historyKind: (event.target as HTMLSelectElement).value })}
                  >
                    ${this.historyKinds.map(
                      (kind) => html`
                        <md-select-option value=${kind} ?selected=${kind === this.selectedHistoryKind}>
                          <div slot="headline">${this.t(kind === "legacy" ? "historyLegacy" : "historyExecution")}</div>
                        </md-select-option>
                      `,
                    )}
                  </md-outlined-select>
                `
              : nothing
          }
          ${this.cloudControls()}
        </section>
        <section class="surface stack">
          ${renderDetailSectionHeading(this.t("conversion"), "stats", { level: 3 })} ${this.conversionEditor()}
        </section>
      </div>
    `;
  }

  private report(
    batches: readonly GachaHistoryBatch[],
    stats: ReturnType<GachaHistory["analysis"]>,
  ): GachaHistoryReport {
    const luck = gachaHistoryLuck(batches, "high");
    const metrics = [
      { label: this.t("total"), value: this.number(stats.total) },
      { label: "SSR+", value: `${this.number(stats.high)} · ${this.percent(stats.high, stats.total)}` },
      { label: this.t("pickup"), value: this.number(stats.pickup) },
      {
        label: this.t("luck"),
        value: luck ? `${this.t(`luckTier${this.luckTier(luck)}`)} · ${this.luckValue(luck)}` : "—",
      },
    ];
    const groups = stats.pools.flatMap((pool) => {
      const selected = batches.filter((batch) => batch.poolId === pool.poolId);
      return (["member", "support"] as const).map((kind) => ({
        label: `${this.poolName(pool.poolId)} · ${this.t(kind)}`,
        imageUrl: this.poolMap.get(pool.poolId ?? "")?.imageUrl,
        cards: this.collected(selected)
          .filter((card) => card.prize.kind === kind && (isHigh(card.prize) || card.pickup > 0))
          .sort(
            (a, b) =>
              b.pickup - a.pickup || rarityRank(b.prize.rarity) - rarityRank(a.prize.rarity) || b.count - a.count,
          )
          .map((card): GachaHistoryReportCard => ({
            name: card.prize.name,
            kindLabel: this.t(kind),
            quantity: card.count,
            imageUrl: card.prize.imageUrl,
            attributeImageUrl: card.prize.attributeImageUrl,
            rarityImageUrl: card.prize.rarityImageUrl,
            pickup: card.pickup,
          })),
      }));
    });
    const charts = stats.kinds
      .filter((kind) => kind.kind === "member" || kind.kind === "support")
      .map((kind) => ({
        label: `${this.t(kind.kind)} · ${this.t("rarityDistribution")}`,
        caption: `${this.t(kind.kind)} ${this.number(kind.total)} · SSR+ ${this.percent(kind.high, kind.total)}`,
        legend: [this.t("nonPickup"), this.t("pickup")],
        rows: kind.distribution
          .filter(
            (row) =>
              ["SSR", "SR", "R"].includes(row.rarity) ||
              (row.count > 0 && row.rarity !== "item" && row.rarity !== "unknown"),
          )
          .map((row) => ({
            label: `${row.rarity} · ${this.percent(row.count, kind.total)}`,
            values: [row.nonPickup, row.pickup],
          })),
      }));
    const dates = batches
      .map((batch) => batch.pulledAt)
      .filter((value): value is string => Boolean(value))
      .sort();
    const scope = [
      dates.length
        ? `${this.serverTime(dates[0], "date")} – ${this.serverTime(dates.at(-1)!, "date")}`
        : this.t("unknownTime"),
    ];
    if (dates.length && dates.length !== batches.length) scope.push(this.t("unknownTime"));
    return { title: this.t("title"), scope, metrics, groups, charts };
  }
  private cloudControls() {
    const disabled = this.cloudBusy || this.busy || !this.selectedAccountKey;
    const accountError = ["authentication_required", "email_verification_required", "account_restricted"].includes(
      this.cloudErrorCode,
    );
    const errors: Record<string, string> = {
      authentication_required: "cloudSignIn",
      email_verification_required: "cloudVerifyEmail",
      account_restricted: "cloudAccountRestricted",
      history_too_large: "cloudTooLarge",
      history_account_limit: "cloudAccountLimit",
      history_account_mismatch: "cloudAccountMismatch",
      history_server_mismatch: "cloudServerMismatch",
      history_session_expired: "errorSessionExpired",
      history_network_error: "cloudNetworkError",
      history_cloud_unavailable: "cloudUnavailable",
    };
    return html`
      <div class="stack">
        <h4 class="detail-section-title">${this.t("cloudTitle")}</h4>
        ${
          !this.cloudSignedIn || accountError
            ? html`
                <a class="button button--tonal" href=${`/${this.locale}/account/`}>
                  ${this.t(this.cloudSignedIn ? "cloudAccount" : "cloudSignIn")}
                </a>
              `
            : nothing
        }
        ${
          this.cloudSignedIn
            ? html`
                <div class="row row--wrap">
                  <button
                    class="button button--tonal"
                    type="button"
                    ?disabled=${disabled}
                    @click=${() => this.emit("gacha-cloud-link", { accountKey: this.selectedAccountKey, linked: !this.cloudLinked })}
                  >
                    ${this.t(this.cloudLinked ? "cloudUnlink" : "cloudLink")}
                  </button>
                  <button
                    class="button button--tonal"
                    type="button"
                    ?disabled=${disabled || !this.cloudLinked}
                    @click=${() => this.emit("gacha-cloud-sync", { accountKey: this.selectedAccountKey })}
                  >
                    ${this.t(this.cloudBusy ? "cloudSyncing" : "cloudSync")}
                  </button>
                  <button
                    class="button button--tonal"
                    type="button"
                    ?disabled=${disabled || !this.cloudLinked || this.cloudRefreshPending}
                    @click=${() => this.emit("gacha-cloud-refresh", { accountKey: this.selectedAccountKey })}
                  >
                    ${this.t(this.cloudRefreshPending ? "cloudRefreshPending" : "cloudRefresh")}
                  </button>
                </div>
              `
            : nothing
        }
        ${
          errors[this.cloudErrorCode]
            ? html`
                <span role="alert">${this.t(errors[this.cloudErrorCode])}</span>
              `
            : nothing
        }
      </div>
    `;
  }
  private exchangeProgress(pool: GachaHistoryPool | undefined) {
    const targets = pool?.exchangeTargets ?? [];
    if (!targets.length) return nothing;
    const groups = new Map<string, GachaTargetProgress[]>();
    for (const target of targets) {
      const key = JSON.stringify([
        target.reward.resourceType,
        target.pointCost,
        target.basePointCost,
        target.pointBalance,
        target.pointsNeeded,
        target.additionalDrawsNeeded,
        target.remainingExchangeLimit,
        target.resetType,
      ]);
      const group = groups.get(key) ?? [];
      group.push(target);
      groups.set(key, group);
    }
    const fold = (id: string, label: string, content: unknown) =>
      accordion({
        id,
        label,
        expanded: this.expanded.has(id),
        onExpandedChange: (open) => {
          const next = new Set(this.expanded);
          if (open) next.add(id);
          else next.delete(id);
          this.expanded = next;
        },
        content,
      });
    const number = (value: number) => value.toLocaleString(this.locale);
    return fold(
      `exchange-${pool!.id}`,
      this.t("exchangeProgress"),
      html`
        <div class="stack stack--loose">
          ${[...groups.values()].map((group) => {
            const target = group[0];
            const facts: Array<[string, number]> = [
              [target.pointCost == null ? "basePointCost" : "pointCost", target.pointCost ?? target.basePointCost],
            ];
            if (target.pointBalance != null) facts.push(["pointBalance", target.pointBalance]);
            if (target.pointsNeeded != null) facts.push(["pointsNeeded", target.pointsNeeded]);
            if (target.additionalDrawsNeeded != null)
              facts.push(["additionalDrawsNeeded", target.additionalDrawsNeeded]);
            if (target.remainingExchangeLimit != null)
              facts.push(["remainingExchangeLimit", target.remainingExchangeLimit]);
            return html`
              <section class="stack">
                <h4 class="detail-section-title">${this.t(target.reward.resourceType === 2 ? "member" : "support")}</h4>
                <dl class="spec-list">
                  ${facts.map(
                    ([label, value]) => html`
                      <div>
                        <dt>${this.t(label)}</dt>
                        <dd>${number(value)}</dd>
                      </div>
                    `,
                  )}
                </dl>
                ${
                  target.pointBalance != null && target.pointCost != null
                    ? html`
                        <md-linear-progress
                          .value=${target.pointCost === 0 ? 1 : Math.min(1, target.pointBalance / target.pointCost)}
                          aria-label=${`${this.t("pointBalance")} ${number(target.pointBalance)} / ${this.t("pointCost")} ${number(target.pointCost)}`}
                        ></md-linear-progress>
                      `
                    : nothing
                }
                ${fold(
                  `exchange-targets-${pool!.id}-${target.exchangeProductId}`,
                  `${this.t("exchangeTargets")} · ${number(group.length)}`,
                  group.map((entry) => {
                    const reward = entry.reward;
                    const name = String(reward.name ?? reward.resourceId ?? "");
                    const details: Array<[string, string]> = [
                      [
                        this.t(entry.pointCost == null ? "basePointCost" : "pointCost"),
                        number(entry.pointCost ?? entry.basePointCost),
                      ],
                    ];
                    if (entry.redeemedCount != null)
                      details.push([this.t("redeemedCount"), number(entry.redeemedCount)]);
                    if (entry.remainingExchangeLimit != null)
                      details.push([this.t("remainingExchangeLimit"), number(entry.remainingExchangeLimit)]);
                    if (entry.resetType != null)
                      details.push([
                        this.t("resetType"),
                        this.t(
                          (
                            { 1: "resetNever", 2: "resetDaily", 3: "resetWeekly", 4: "resetMonthly" } as Record<
                              number,
                              string
                            >
                          )[entry.resetType],
                        ),
                      ]);
                    return html`
                      <section class="stack">
                        ${collectionList([
                          {
                            id: entry.exchangeProductId,
                            title: name,
                            subtitle: details[0].join(" · "),
                            href: typeof reward.href === "string" ? reward.href : undefined,
                            media: html`
                              <span style="display:block;width:56px;height:56px">
                                ${gachaPrizeCard({
                                  label: name,
                                  kind: reward.resourceType === 2 ? "member" : "support",
                                  rarity:
                                    typeof reward.rarity === "number" || typeof reward.rarity === "string"
                                      ? reward.rarity
                                      : "",
                                  image: String(reward.image ?? ""),
                                  attribute: String(reward.attributeImageUrl ?? ""),
                                  rarityMark: String(reward.rarityImageUrl ?? ""),
                                  count: Number(reward.count ?? 1),
                                })}
                              </span>
                            `,
                          },
                        ])}
                        <dl class="spec-list">
                          ${details.slice(1).map(
                            ([label, value]) => html`
                              <div>
                                <dt>${label}</dt>
                                <dd>${value}</dd>
                              </div>
                            `,
                          )}
                        </dl>
                      </section>
                    `;
                  }),
                )}
              </section>
            `;
          })}
        </div>
      `,
    );
  }

  private conversionEditor() {
    const conversion = this.currencyConversion;
    if (!conversion) return nothing;
    return keyed(
      this.selectedAccountKey,
      html`
        <form
          class="stack"
          @submit=${(event: SubmitEvent) => {
            event.preventDefault();
            const form = event.currentTarget as HTMLFormElement;
            if (form.reportValidity())
              this.emit("gacha-conversion-change", {
                currencyCode: conversion.currencyCode,
                freeUnitGemPrice:
                  (form.elements.namedItem("freeUnitGemPrice") as HTMLInputElement).value === ""
                    ? null
                    : (form.elements.namedItem("freeUnitGemPrice") as HTMLInputElement).valueAsNumber,
                paidUnitGemPrice:
                  (form.elements.namedItem("paidUnitGemPrice") as HTMLInputElement).value === ""
                    ? null
                    : (form.elements.namedItem("paidUnitGemPrice") as HTMLInputElement).valueAsNumber,
              });
          }}
        >
          <md-outlined-select
            label=${this.t("currency")}
            .value=${conversion.currencyCode}
            .displayText=${conversion.currencyCode}
            @change=${(event: Event) => this.emit("gacha-conversion-change", { currencyCode: (event.target as HTMLSelectElement).value, freeUnitGemPrice: 0, paidUnitGemPrice: null })}
          >
            ${["JPY", "TWD", "HKD", "MOP", "USD", "KRW", "CNY"].map(
              (code) => html`
                <md-select-option value=${code} ?selected=${code === conversion.currencyCode}>
                  <div slot="headline">${code}</div>
                </md-select-option>
              `,
            )}
          </md-outlined-select>
          ${(["freeUnitGemPrice", "paidUnitGemPrice"] as const).map(
            (key) => html`
              <label class="field">
                <span>${this.t(key)} · ${conversion.currencyCode}</span>
                <input
                  name=${key}
                  type="number"
                  min="0"
                  step="any"
                  inputmode="decimal"
                  .value=${conversion[key] == null ? "" : String(conversion[key])}
                />
              </label>
            `,
          )}
          <button class="button button--tonal" type="submit">${this.t("applyPrice")}</button>
        </form>
      `,
    );
  }
  private openImport() {
    if (this.importSources.length) this.importSourceOpen = true;
    else this.emit("gacha-import", undefined);
  }
  private costMetrics(batches: readonly GachaHistoryBatch[]) {
    const stats = this.analysis(batches),
      costs = stats.cost;
    const metrics = (Object.keys(costs) as (keyof GachaHistoryCost)[]).map((key) => ({
      label: this.t(key),
      value:
        costs[key].value == null
          ? "—"
          : `${costs[key].partial ? "≥ " : ""}${costs[key].value!.toLocaleString(this.locale)}`,
    }));
    const conversion = this.currencyConversion;
    if (conversion) {
      const amounts = summarizeGachaHistoryMoney(costs, conversion);
      const money = (amount: { value: number | null; partial: boolean }) =>
        amount.value == null
          ? "—"
          : `${amount.partial ? "≥ " : ""}${new Intl.NumberFormat(this.locale, { style: "currency", currency: conversion.currencyCode }).format(amount.value)}`;
      metrics.push(
        { label: this.t("freeValue"), value: money(amounts.freeGems) },
        { label: this.t("paidValue"), value: money(amounts.paidGems) },
      );
      if (amounts.sum != null && stats.high)
        metrics.push({
          label: this.t("moneyPerHigh"),
          value: money({ value: amounts.sum / stats.high, partial: false }),
        });
    }
    const gems =
      costs.freeGems.value == null && costs.paidGems.value == null
        ? null
        : (costs.freeGems.value ?? 0) + (costs.paidGems.value ?? 0);
    if (gems != null && stats.high)
      metrics.push({ label: this.t("gemsPerHigh"), value: this.number(gems / stats.high) });
    if (gems != null && stats.pickup)
      metrics.push({ label: this.t("gemsPerPickup"), value: this.number(gems / stats.pickup) });
    return metrics;
  }
  private cancelImageExport() {
    ++this.imageGeneration;
    this.imageRequest?.abort();
    this.imageRequest = undefined;
    for (const file of this.imageFiles) URL.revokeObjectURL(file.url);
    if (this.imageFiles.length) this.imageFiles = [];
    this.exportingImage = false;
  }
  private renderImagePreview() {
    if (!this.imageFiles.length) return nothing;
    return html`
      <dialog class="dialog" aria-label=${this.t("imagePreview")} ${modal(() => this.cancelImageExport())}>
        <header class="dialog__header">
          <div class="row row--between">
            <h2>${this.t("imagePreview")}</h2>
            ${iconButton({ icon: "close", label: this.t("close"), onClick: () => this.cancelImageExport() })}
          </div>
        </header>
        <div class="dialog__body">
          <image-gallery
            natural
            .locale=${this.locale}
            .title=${this.t("imagePreview")}
            .images=${this.imageFiles.map((file, index) => ({ id: file.filename, source: file.url, label: `${index + 1} / ${this.imageFiles.length}`, width: file.width, height: file.height }))}
          ></image-gallery>
        </div>
        <footer class="dialog__actions">
          <button
            class="button button--filled"
            ?disabled=${this.savingImage}
            @click=${() => void this.saveImageFiles()}
          >
            ${icon("file_download")}${this.t("saveImage")}
          </button>
        </footer>
      </dialog>
    `;
  }
  private async exportImage(report: GachaHistoryReport) {
    this.cancelImageExport();
    const request = (this.imageRequest = new AbortController());
    this.exportingImage = true;
    this.imageError = "";
    try {
      const { renderGachaHistoryImages } = await import("../lib/gacha-history-image");
      const images = await renderGachaHistoryImages(report, { signal: request.signal });
      const files = [];
      for (const [index, blob] of images.entries()) {
        const bitmap = await createImageBitmap(blob);
        files.push({
          blob,
          filename: `haneoka-gacha-history-${index + 1}.png`,
          width: bitmap.width,
          height: bitmap.height,
        });
        bitmap.close();
      }
      request.signal.throwIfAborted();
      this.imageFiles = files.map((file) => ({ ...file, url: URL.createObjectURL(file.blob) }));
    } catch {
      if (!request.signal.aborted) this.imageError = this.t("exportImageFailed");
    } finally {
      if (this.imageRequest === request) {
        this.imageRequest = undefined;
        this.exportingImage = false;
      }
    }
  }
  private async saveImageFiles() {
    const files = this.imageFiles,
      generation = this.imageGeneration;
    if (!files.length || this.savingImage) return;
    this.savingImage = true;
    try {
      const handled = !this.dispatchEvent(
        new CustomEvent("gacha-export-image", { detail: { files }, bubbles: true, composed: true, cancelable: true }),
      );
      if (!handled) {
        let file: { blob: Blob; filename: string } = files[0];
        if (files.length > 1) {
          const { zipSync } = await import("fflate");
          const entries = Object.fromEntries(
            await Promise.all(
              files.map(async (item) => [item.filename, new Uint8Array(await item.blob.arrayBuffer())]),
            ),
          );
          const archive = Uint8Array.from(zipSync(entries, { level: 0 }));
          file = {
            filename: "haneoka-gacha-history.zip",
            blob: new Blob([archive.buffer], { type: "application/zip" }),
          };
        }
        if (generation !== this.imageGeneration) return;
        const url = URL.createObjectURL(file.blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = file.filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    } catch {
      this.imageError = this.t("exportImageFailed");
    } finally {
      this.savingImage = false;
    }
  }
  private drawSummary(batches: readonly GachaHistoryBatch[]) {
    const known = batches.filter((batch) => batch.drawCount != null);
    const unknown = batches.length - known.length;
    return [
      known.length ? this.t("draws", { count: known.reduce((sum, batch) => sum + batch.drawCount!, 0) }) : "",
      unknown ? this.t("unknownDraws", { count: unknown }) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }
  private renderPrizes(prizes: readonly GachaHistoryPrize[]) {
    const subtitle = (prize: GachaHistoryPrize) =>
      [
        this.t(prize.kind),
        prize.rarityLabel,
        `×${prize.quantity}`,
        prize.pickup === true ? this.t("pickup") : "",
        prize.converted ? this.t("converted") : "",
      ]
        .filter(Boolean)
        .join(" · ");
    if (this.view === "table")
      return collectionTable(
        this.t("records"),
        [this.t("card"), this.t("kind"), this.t("rarity"), this.t("quantity"), this.t("pickup"), this.t("converted")],
        prizes.map((prize) => [
          prize.href
            ? html`
                <a href=${prize.href}>${prize.name}</a>
              `
            : prize.name,
          this.t(prize.kind),
          prize.rarityLabel || "—",
          prize.quantity,
          prize.pickup == null ? "—" : prize.pickup ? this.t("yes") : this.t("no"),
          prize.converted == null ? "—" : prize.converted ? this.t("yes") : this.t("no"),
        ]),
      );
    if (this.view === "list")
      return collectionList(
        prizes.map((prize, index) => ({
          id: `${prize.id}-${index}`,
          title: prize.name,
          subtitle: subtitle(prize),
          href: prize.href,
          media: prize.imageUrl
            ? html`
                <img src=${prize.imageUrl} alt="" loading="lazy" decoding="async" width="56" height="56" />
              `
            : icon("image"),
        })),
      );
    return html`
      <div class="gacha-pulls__cards">
        ${prizes.map((prize) => gachaPrizeCard({ label: `${prize.name} · ${subtitle(prize)}`, kind: prize.kind, rarity: prize.rarity, href: prize.href, image: prize.imageUrl, attribute: prize.attributeImageUrl, rarityMark: prize.rarityImageUrl, count: prize.quantity, pickup: prize.pickup === true }))}
      </div>
    `;
  }
}
if (!customElements.get("gacha-history")) customElements.define("gacha-history", GachaHistory);
