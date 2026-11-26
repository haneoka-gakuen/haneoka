// L3 — GEB
// Input: 工作区提供的账号、规范记录、卡池规则、统计及云状态。
// Output: 账号概览、卡池、收获、长龙、明细与趋势及其图片导出。
// Pos: [Map](L2-2.md)；抽卡历史展示与资料边界。
// Effects/Dependencies: light DOM 与 SSR 共用；消费共享分析／图表／卡牌，导入及云状态由工作区持有。
import { dateField } from "./ui/date-field";
import { normalizeSearchText } from "../lib/search-text";
import { scrollableTabBar } from "./ui/scrollable-tabs";
import { cardRarityName, cardRarityRank } from "../lib/card-rarity";
import type { GachaTargetProgress } from "@haneoka/game-data-exporter/gacha-history-points";
import { modal } from "./ui/modal";
import { gameHistoryHelp } from "./ui/game-history-help";
import "./ui/image-gallery";
import {
  analyzeGachaHistory,
  gachaHistoryDay,
  gachaHistoryMonths,
  summarizeGachaHistoryMoney,
  type GachaDrawInterval,
} from "@haneoka/game-data-exporter/gacha-history-analysis";
import "@lit-labs/ssr-client/lit-element-hydrate-support.js";
import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { hydrateWorkspace as hydrate } from "./shared/hydrate-workspace";
import { keyed } from "lit/directives/keyed.js";
import { clientText } from "../i18n/client";
import { setAppBarSearch } from "../lib/app-bar";
import type {
  GachaHistoryAccount,
  GachaHistoryPool,
  GachaHistoryBatch,
  GachaHistoryPrize,
  GachaHistoryEvents,
  GachaHistoryConversion,
  GachaHistoryCost,
  GachaHistoryItemArt,
  GachaHistoryImportSource,
} from "../lib/gacha-history-view";
import { renderBrowse } from "./ui/browse";
import { facet } from "./ui/facet";
import { filterChip, iconButton, inputChip, rovingKeydown, segmented } from "./ui/controls";
import { icon } from "./ui/icon";
import { accordion } from "./ui/accordion";
import { collectionList, collectionTable, viewSwitch, type CollectionView } from "./ui/collection-view";
import { gachaPrizeCard } from "./shared/gacha-prize-card";
import { LazyImages, localeTaggedCandidates } from "./ui/lazy-images";
import type { GachaHistoryReport, GachaTimelineBadge, GachaTimelineGroup } from "../lib/gacha-history-image";
import { emptyState, loadingState } from "./ui/state";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import "../styles/gacha-history.css";
import { renderLocalSaveSourcePicker } from "./shared/local-save-source-picker";
import { formatDate, formatTime } from "../lib/date-format";
import { GachaLuckClient } from "./shared/gacha-history-luck";
import type { GachaLuckResult, GachaLuckSummary, GachaLuckValue } from "../lib/gacha-history-luck";
import {
  gachaHighStreak,
  gachaRecordedHits,
  gachaRateComparisons,
  isItemOnlyGacha,
  latestGachaHigh,
  type GachaRateComparison,
  type GachaRateSample,
  type GachaRecordedHit,
} from "../lib/gacha-history-statistics";

type Axis = "category" | "pool" | "kind" | "rarity" | "pickup";
type Tab = "overview" | "pools" | "collection" | "timeline" | "records" | "trends" | "settings";
const TABS: readonly Tab[] = ["overview", "pools", "collection", "timeline", "records", "trends", "settings"];
const HIGH = new Set([4, 10, 20]);
const OWNER = "gacha-history";
const isHigh = (prize: GachaHistoryPrize) =>
  (prize.kind === "member" || prize.kind === "support") && HIGH.has(Number(prize.rarity));

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
    gemItems: { attribute: false },
    exportingImage: { state: true },
    imageError: { state: true },
    locale: {},
    historyKinds: { attribute: false },
    selectedHistoryKind: {},
    accounts: { attribute: false },
    pools: { attribute: false },
    batches: { attribute: false },
    selectedAccountKey: {},
    scopedGameAccount: { type: Boolean },
    scopedGameRead: { type: Boolean },
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
    accountsOpen: { state: true },
    readHelpOpen: { state: true },
    mergingAccounts: { state: true },
    mergeKeys: { state: true },
  };
  declare readHelpOpen: boolean;
  openReadHelp() { this.readHelpOpen = true; }
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
  declare gemItems?: { free?: GachaHistoryItemArt; paid?: GachaHistoryItemArt };
  declare private exportingImage: boolean;
  declare private imageError: string;
  declare locale: string;
  declare historyKinds: readonly string[];
  declare selectedHistoryKind: string;
  declare accounts: readonly GachaHistoryAccount[];
  declare pools: readonly GachaHistoryPool[];
  declare batches: readonly GachaHistoryBatch[];
  declare selectedAccountKey: string;
  declare scopedGameAccount: boolean;
  declare scopedGameRead: boolean;
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
  private declare accountsOpen: boolean;
  private declare mergingAccounts: boolean;
  private declare mergeKeys: Set<string>;
  private images = new LazyImages();
  private luckClient = new GachaLuckClient(() => this.requestUpdate());
  private luckResult?: GachaLuckResult;
  private scopeInputs: unknown[] = [];
  private scopeRows: readonly GachaHistoryBatch[] = [];
  private analysisCache = new WeakMap<readonly GachaHistoryBatch[], ReturnType<typeof analyzeGachaHistory>>();
  private statisticsCache = new WeakMap<readonly GachaHistoryBatch[], {
    streak: ReturnType<typeof latestGachaHigh>;
    rates: ReturnType<typeof gachaRateComparisons>;
  }>();
  private reportInputs: unknown[] = [];
  private reportValue?: GachaHistoryReport;
  private recorded = new WeakMap<readonly GachaHistoryBatch[], {
    high: ReturnType<typeof gachaRecordedHits>;
    pickup?: ReturnType<typeof gachaRecordedHits>;
  }>();
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
    this.readHelpOpen = false;
    this.accountsOpen = false; this.mergingAccounts = false; this.mergeKeys = new Set();
  }
  connectedCallback() {
    super.connectedCallback();
    void Promise.all([
      import("@material/web/select/outlined-select.js"),
      import("@material/web/select/select-option.js"),
      import("@material/web/progress/linear-progress.js"),
      import("@material/web/checkbox/checkbox.js"),
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
    let value = this.analysisCache.get(batches);
    if (!value) { value = analyzeGachaHistory(batches, this.offsetMinutes); this.analysisCache.set(batches, value); }
    return value;
  }
  private scopedHistory(): readonly GachaHistoryBatch[] {
    const inputs = [this.batches, this.selectedAccountKey, this.pools, this.filters.pool, this.filters.category, this.from, this.to, this.offsetMinutes];
    if (inputs.every((value, index) => value === this.scopeInputs[index])) return this.scopeRows;
    this.scopeInputs = inputs;
    this.scopeRows = this.batches.filter(batch => {
      const pool = this.poolMap.get(batch.poolId), day = gachaHistoryDay(batch.pulledAt, this.offsetMinutes) ?? "";
      return batch.accountKey === this.selectedAccountKey && (!this.filters.pool.length || this.filters.pool.includes(batch.poolId)) &&
        (!this.filters.category.length || pool && this.filters.category.includes(pool.category)) &&
        (!this.from || day && day >= this.from) && (!this.to || day && day <= this.to);
    });
    return this.scopeRows;
  }
  private statistics(batches: readonly GachaHistoryBatch[]) {
    let value = this.statisticsCache.get(batches);
    if (!value) {
      const pools = this.poolMap;
      value = { streak: latestGachaHigh(batches, pools), rates: gachaRateComparisons(batches, pools) };
      this.statisticsCache.set(batches, value);
    }
    return value;
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
    setAppBarSearch(this, OWNER, {
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
    this.luckClient.reset(); this.luckResult = undefined; this.scopeInputs = []; this.scopeRows = [];
    this.reportInputs = []; this.reportValue = undefined;
    this.cancelImageExport();
    this.images.disconnect();
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
    const query = normalizeSearchText(this.query, this.locale).trim();
    const poolMatches = normalizeSearchText(this.poolMap.get(batch.poolId)?.name || "", this.locale).includes(query);
    return batch.prizes.filter(
      (prize) =>
        (!this.filters.pickup.length ||
          this.filters.pickup.includes(prize.pickup == null ? "unknown" : prize.pickup ? "yes" : "no")) &&
        (!this.filters.kind.length || this.filters.kind.includes(prize.kind)) &&
        (!this.filters.rarity.length || this.filters.rarity.includes(String(prize.rarity))) &&
        (!query || poolMatches || normalizeSearchText(prize.name, this.locale).includes(query)),
    );
  }
  /** Pools by their period, newest first; a pool without one by its latest draw. */
  private newestPoolsFirst<T extends { poolId: string | null }>(pools: readonly T[], batches: readonly GachaHistoryBatch[]): T[] {
    const latest = new Map<string | null, string>();
    for (const batch of batches) {
      const key = batch.poolId || null;
      if (batch.pulledAt && (latest.get(key) ?? "") < batch.pulledAt) latest.set(key, batch.pulledAt);
    }
    const at = (pool: T) => {
      const start = this.poolMap.get(pool.poolId ?? "")?.startAt;
      return start ? Date.parse(start) : Date.parse(latest.get(pool.poolId || null) ?? "") || 0;
    };
    return [...pools].sort((a, b) => at(b) - at(a));
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
                  src=${localeTaggedCandidates(pool.imageUrl, this.locale)[0]}
                  data-candidates=${JSON.stringify(localeTaggedCandidates(pool.imageUrl, this.locale))}
                  width="96"
                  height="48"
                  loading="lazy"
                  decoding="async"
                  alt=""
                  @error=${(event: Event) => {
                    const image = event.currentTarget as HTMLImageElement;
                    const candidates = JSON.parse(image.dataset.candidates || "[]") as string[];
                    const next = Number(image.dataset.candidateIndex || 0) + 1;
                    if (candidates[next]) {
                      image.dataset.candidateIndex = String(next);
                      image.src = candidates[next];
                    } else image.hidden = true;
                  }}
                />
              `
            : nothing
        }
        <span class="gacha-history__logo-fallback">${icon("casino", 22)}</span>
      </span>
    `;
  }
  private rateText(sample?: GachaRateSample) {
    return sample?.draws
      ? `${this.percent(sample.hits, sample.draws)} / ${this.t("officialRate")} ${this.percent(sample.expected, sample.draws)}`
      : "—";
  }
  private luckSummary(poolId?: string): GachaLuckSummary | undefined {
    return poolId === undefined ? this.luckResult?.overall : this.luckResult?.pools[poolId];
  }
  private luckRating(luck: GachaLuckValue) {
    return `${this.number(luck.score, 1)} ${this.t(`luckTier${luck.tier}`)}`;
  }
  private luckState(summary?: GachaLuckSummary, value: GachaLuckValue | null | undefined = summary?.combined) {
    if (this.luckClient.error) return this.t("luckCalculationFailed");
    if (this.luckClient.pending) return this.t("luckCalculating");
    if (value && !value.variable && value.expected === 0) return this.t("luckNoTarget");
    if (summary?.combined) return this.t("luckFixed");
    if (summary?.itemDraws && !summary.unknownDraws) return this.t("luckItemOnly");
    return summary?.unknownDraws ? this.t("luckUnavailable") : "—";
  }
  private luckMeter(label: string, luck: GachaLuckValue | null | undefined, summary?: GachaLuckSummary, combined = false) {
    const value = luck?.variable ? luck : undefined;
    const tier = value ? this.t(`luckTier${value.tier}`) : this.luckState(summary, luck);
    return html`<div class="gacha-luck" data-tier=${value?.tier ?? "neutral"} aria-busy=${String(this.luckClient.pending)}>
      <div class="row row--between row--baseline"><span class="md-title-small">${label}</span>
        <span class="row row--baseline">
          ${value ? html`<span class="md-title-small tabular">${this.number(value.score, 1)}</span>` : nothing}
          <span class="gacha-luck__tier">${tier}</span>
        </span></div>
      <div class="gacha-luck__track" role="meter" aria-label=${label} aria-valuemin="0" aria-valuemax="100"
        aria-valuenow=${value ? Math.round(value.score * 10) / 10 : nothing} aria-valuetext=${value ? this.luckRating(value) : tier}>
        <span class="gacha-luck__fill" style=${`inline-size:${value?.score ?? 0}%`}></span>
        <span class="gacha-luck__mark" ?hidden=${!value} style=${`inset-inline-start:${value?.score ?? 0}%`}></span>
      </div>
      ${combined ? nothing : html`<dl class="spec-list spec-list--split spec-list--numeric">
        <div><dt>${this.t("observed")}</dt><dd>${luck ? this.number(luck.observed) : "—"}</dd></div>
        <div><dt>${this.t("expected")}</dt><dd>${luck ? this.number(luck.expected, 2) : "—"}</dd></div>
      </dl>`}
    </div>`;
  }
  private luckMeters(summary?: GachaLuckSummary) {
    return html`
      ${this.luckMeter(this.t("luckCombined"), summary?.combined, summary, true)}
      ${this.luckMeter("SSR+", summary?.high, summary)}
      ${this.luckMeter(this.t("luckPickupHigh"), summary?.pickup, summary)}
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
  private itemArt(item?: GachaHistoryItemArt, size = 24) {
    return item ? html`<img class="gacha-item-art" src=${item.imageUrl} width=${size} height=${size} alt="" loading="lazy" decoding="async" />` : nothing;
  }
  private costChip(value: number | undefined, label: string, item?: GachaHistoryItemArt) {
    if (!value) return nothing;
    return html`<span class="gacha-chip" title=${item?.name || label} aria-label=${`${item?.name || label} ${this.number(value)}`}>
      ${item ? this.itemArt(item) : label} ${this.number(value)}
    </span>`;
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
    const scoped = this.scopedHistory();
    this.luckResult = this.luckClient.read(scoped, this.isConnected);
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
      const values = [...entries.values()];
      return axis === "rarity" ? values.sort((a, b) => cardRarityRank(b.value) - cardRarityRank(a.value)) : values;
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
        inputChip(`${this.t("from")} / ${this.from}`, this.t("remove"), () => {
          this.from = "";
        }),
      );
    if (this.to)
      applied.push(
        inputChip(`${this.t("to")} / ${this.to}`, this.t("remove"), () => {
          this.to = "";
        }),
      );
    const stats = scoped.length ? this.analysis(scoped) : null;
    const report = stats && !this.luckClient.pending ? this.cachedReport(scoped, stats) : null;
    const viewTab = this.tab === "records" || this.tab === "collection";
    return html`
      <div class="gacha-history">
        ${this.readHelpOpen ? gameHistoryHelp(key => this.t(key), () => { this.readHelpOpen = false; }) : nothing}
        ${this.renderAccountPicker()}
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
            ${iconButton({ label: this.t("readHelp"), icon: "help", onClick: () => this.openReadHelp() })}
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
                ${dateField({ label: this.t("from"), value: this.from, max: this.to,
                  disabled: !accountBatches.some((batch) => batch.pulledAt), onChange: (value) => { this.from = value; } })}
                ${dateField({ label: this.t("to"), value: this.to, min: this.from,
                  disabled: !accountBatches.some((batch) => batch.pulledAt), onChange: (value) => { this.to = value; } })}
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

  public openAccountPicker() {
    this.accountsOpen = true; this.mergingAccounts = false; this.mergeKeys = new Set();
  }
  private renderAccountPicker() {
    if (!this.accountsOpen) return nothing;
    const selected = this.accounts.filter(row => this.mergeKeys.has(row.key) && row.canMerge);
    const enabled = (row: GachaHistoryAccount) => row.canMerge && !this.busy && selected.every(other => row.server === other.server);
    const identities = new Set(selected.flatMap(row => row.identity ? [row.identity] : []));
    const label = (row: GachaHistoryAccount) => [row.serverLabel, row.label].filter(Boolean).join(" / ");
    const subtitle = (row: GachaHistoryAccount) => html`<span class="stack stack--flush">
      ${row.range ? html`<span>${row.range}</span>` : nothing}
      <span>${[row.batches === undefined ? "" : this.t("batches", { count: row.batches }), row.local === undefined ? "" : this.t(row.local ? "localRecords" : "cloudRecords")].filter(Boolean).join(" / ")}</span>
    </span>`;
    const active = this.accounts.find(row => row.key === this.selectedAccountKey);
    return html`<dialog class="dialog" aria-label=${this.t(this.mergingAccounts ? "mergeRecords" : "savedSource")} ${modal(() => { this.accountsOpen = false; })}>
      <header class="dialog__header"><div class="row row--between"><h2>${this.t(this.mergingAccounts ? "mergeRecords" : "savedSource")}</h2>
        ${iconButton({ icon: "close", label: this.t("close"), onClick: () => { this.accountsOpen = false; } })}</div></header>
      <div class="dialog__body">
        ${this.mergingAccounts ? html`<ul class="list">${this.accounts.map(row => html`<li><label class=${`list-item list-item--three-line list-item--interactive${this.mergeKeys.has(row.key) ? " is-selected" : ""}`}>
          <span class="list-item__leading"><md-checkbox touch-target="wrapper" .checked=${this.mergeKeys.has(row.key)}
            ?disabled=${!enabled(row)} aria-label=${[label(row), row.range, row.batches === undefined ? "" : this.t("batches", { count: row.batches })].filter(Boolean).join(" / ")} @change=${() => { const keys = new Set(this.mergeKeys); if (keys.has(row.key)) keys.delete(row.key); else keys.add(row.key); this.mergeKeys = keys; }}></md-checkbox></span>
          <span class="list-item__body"><strong class="list-item__headline">${label(row)}</strong><span class="list-item__supporting">${subtitle(row)}</span></span>
        </label></li>`)}</ul>` : collectionList(this.accounts.map(row => ({
          id: row.key, title: label(row), subtitle: subtitle(row), threeLine: true, media: icon("person", 24),
          trailing: row.key === this.selectedAccountKey ? icon("check", 20) : nothing,
          onOpen: () => { this.accountsOpen = false; this.emit("gacha-account-change", { accountKey: row.key }); },
        })))}
      </div>
      <footer class="dialog__actions">
        ${this.mergingAccounts ? html`
          <button class="button button--text" @click=${() => { this.mergingAccounts = false; this.mergeKeys = new Set(); }}>${this.t("backToAccounts")}</button>
          <button class="button button--filled" ?disabled=${this.busy || selected.length < 2} @click=${() => { this.accountsOpen = false; this.emit("gacha-history-merge", { accountKeys: selected.map(row => row.key), confirmIdentity: identities.size > 1 }); }}>${this.t(identities.size > 1 ? "mergeAsAccount" : "mergeRecordsCount", { count: selected.length })}</button>
        ` : html`
          ${active?.sourceCount ? html`<button class="button button--text" @click=${() => { this.accountsOpen = false; this.emit("gacha-history-originals", { accountKey: active.key }); }}>${this.t("exportOriginalRecords")}</button>` : nothing}
          <button class="button button--tonal" ?disabled=${this.busy || this.accounts.filter(row => row.canMerge).length < 2}
            @click=${() => { this.mergingAccounts = true; this.mergeKeys = new Set(); }}>${this.t("mergeRecords")}</button>
        `}
      </footer>
    </dialog>`;
  }
  private renderHero(scoped: readonly GachaHistoryBatch[], stats: ReturnType<GachaHistory["analysis"]> | null) {
    const account = this.accounts.find((row) => row.key === this.selectedAccountKey);
    const dates = scoped
      .map((batch) => batch.pulledAt)
      .filter((value): value is string => Boolean(value))
      .sort();
    const summary = this.luckSummary();
    const luck = summary?.combined?.variable ? summary.combined : null;
    const statistics = stats ? this.statistics(scoped) : null;
    const rates = statistics?.rates.overall;
    const streak = statistics?.streak;
    const pools = streak?.poolIds.map((poolId) => this.poolName(poolId)) ?? [];
    const gems = stats ? (stats.cost.freeGems.value ?? 0) + (stats.cost.paidGems.value ?? 0) : 0;
    const money =
      stats && this.currencyConversion ? summarizeGachaHistoryMoney(stats.cost, this.currencyConversion) : null;
    const status =
      this.imageError || this.error || (this.catalogLoading ? this.t("catalogLoading") : this.catalogError);
    return html`
      <section class="gacha-hero surface stack" aria-label=${this.t("account")}>
        <div class="gacha-hero__account">
          ${!this.scopedGameAccount || this.accounts.length > 1 ? html`<button class="button button--tonal gacha-account-button" type="button"
            aria-label=${[this.t("savedSource"), account?.serverLabel, account?.label].filter(Boolean).join(" / ")} ?disabled=${!this.accounts.length || this.busy} @click=${() => this.openAccountPicker()}>
            ${icon("history", 24)}<span>${account ? [account.serverLabel, account.label].filter(Boolean).join(" / ") : this.t("savedSource")}</span>${icon("swap_horiz", 20)}
          </button>` : nothing}
          <div class="gacha-hero__actions">
            ${
              this.canRefresh
                ? html`
                    <button
                      class="button button--filled"
                      type="button"
                      ?disabled=${this.busy || !this.selectedAccountKey && !this.scopedGameRead}
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
                    supporting: `${this.t("member")} ${this.number(stats.member)} / ${this.t("support")} ${this.number(stats.support)}`,
                    tone: "primary",
                  })}
                  ${this.stat({
                    icon: icon("star", 24),
                    label: "SSR+",
                    value: this.number(stats.high),
                    supporting: this.rateText(rates?.high),
                    tone: "tertiary",
                  })}
                  ${this.stat({
                    icon: icon("trending_up", 24),
                    label: this.t("pickup"),
                    value: this.number(stats.pickup),
                    supporting: rates?.pickup.hits
                      ? this.t("pullsEach", { count: this.number(rates.pickup.draws / rates.pickup.hits, 1) })
                      : stats.pickupUnknown
                        ? `${this.t("unknown")} ${this.number(stats.pickupUnknown)}`
                        : "",
                    tone: "secondary",
                  })}
                  ${this.stat({
                    icon: icon("hourglass_bottom", 24),
                    label: this.t("sinceLastHigh"),
                    value: this.interval(streak?.trailing ?? null),
                    supporting: pools.length
                      ? new Intl.ListFormat(this.locale).format(pools)
                      : streak?.hasHit ? "" : this.t("noRecordedHigh"),
                  })}
                  ${this.stat({
                    icon: icon("auto_awesome", 24),
                    label: this.t("luck"),
                    value: luck ? this.luckRating(luck) : this.luckState(summary),
                    tone: luck ? `luck-${luck.tier}` : "neutral",
                  })}
                  ${this.stat({
                    icon: html`${this.itemArt(!stats.cost.freeGems.value && stats.cost.paidGems.value ? this.gemItems?.paid : this.gemItems?.free, 30)}`,
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
      timeline: [this.t("tabTimeline"), icon("timeline", 18)],
      records: [this.t("tabRecords"), icon("receipt_long", 18)],
      trends: [this.t("tabTrends"), icon("show_chart", 18)],
      settings: [this.t("tabSettings"), icon("tune", 18)],
    };
    return scrollableTabBar(this.locale, html`
      <nav
        class="tabs tabs--secondary gacha-history__tabs"
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
              <span class="tab__indicator"></span>
            </button>
          `,
        )}
      </nav>
    `);
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
      case "timeline":
        return this.renderTimeline(scoped);
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
    options: { caption?: string; details?: string[]; wide?: boolean } = {},
  ) {
    const totals = categories.map((_, index) => series.reduce((sum, row) => sum + (row.values[index] ?? 0), 0));
    const largest = totals.reduce((max, total) => Math.max(max, total), 1);
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
        <ul class="gacha-series">
          ${categories.map((category, index) => html`
            <li>
              <div class="row row--between"><strong>${category}</strong><strong class="tabular">${this.number(totals[index])}</strong></div>
              <div class="gacha-series__track" aria-hidden="true">
                ${series.map((row, channel) => html`<span data-channel=${channel} style=${`inline-size:${(row.values[index] ?? 0) * 100 / largest}%`}></span>`)}
              </div>
              <div class="cluster gacha-series__values">
                ${series.map((row, channel) => html`
                  <span data-channel=${channel}>${row.name} <strong class="tabular">${this.number(row.values[index] ?? 0)}</strong></span>
                `)}
                ${options.details?.[index] ? html`<span>${options.details[index]}</span>` : nothing}
              </div>
            </li>`)}
        </ul>
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
          `${this.t(kind.kind)} / ${this.t("rarityDistribution")}`,
          rows.map((row) => `${row.rarity} / ${this.percent(row.count, kind.total)}`),
          (["nonPickup", "pickup"] as const).map((key) => ({ name: this.t(key), values: rows.map((row) => row[key]) })),
          {
            caption: `${this.t(kind.kind)} ${this.number(kind.total)} / SSR+ ${this.percent(kind.high, kind.total)}`,
          },
        );
      });
  }

  private renderOverview(scoped: readonly GachaHistoryBatch[], stats: ReturnType<GachaHistory["analysis"]>) {
    const { overall } = this.statistics(scoped).rates;
    const rows: readonly [string, keyof GachaRateComparison][] = [
      ["SSR+", "high"],
      [`${this.t("member")} SSR+`, "memberHigh"],
      [`${this.t("support")} SSR+`, "supportHigh"],
      ["SSR", "SSR"],
      ["BD", "BD"],
      ["EX", "EX"],
      ["SR", "SR"],
      ["R", "R"],
      [this.t("pickup"), "pickup"],
    ];
    const hits = this.recordedHits(scoped)
      .flatMap((pool) => pool.hits.map((hit) => ({ ...hit, poolId: pool.poolId })))
      .sort((a, b) => (b.pulledAt ?? "").localeCompare(a.pulledAt ?? "") || (b.position ?? 0) - (a.position ?? 0));
    return html`
      <div class="gacha-history__grid">
        <section class="surface stack">
          <div class="row row--between">${renderDetailSectionHeading(this.t("luckCombined"), "stats", { level: 3 })}
            ${this.luckClient.error ? iconButton({ icon: "refresh", label: this.t("luckRetry"), onClick: () => { this.luckClient.reset(); this.requestUpdate(); } }) : nothing}</div>
          ${this.luckMeters(this.luckSummary())}
        </section>
        <section class="surface stack">
          ${renderDetailSectionHeading(this.t("rateComparison"), "difficulty", { level: 3 })}
          ${collectionTable(
            this.t("rateComparison"),
            [this.t("resultType"), this.t("quantity"), this.t("observedRate"), this.t("officialRate")],
            rows
              .filter(([, key], index) => index < 3 || overall[key].hits > 0 || overall[key].expected > 0)
              .map(([label, key]) => {
                const { draws, hits, expected } = overall[key];
                return [
                  label,
                  draws ? this.number(hits) : "—",
                  this.percent(hits, draws),
                  this.percent(expected, draws),
                ];
              }),
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

  private recordedHits(batches: readonly GachaHistoryBatch[], target: "high" | "pickup" = "high") {
    let result = this.recorded.get(batches);
    if (!result) {
      result = { high: gachaRecordedHits(batches) };
      this.recorded.set(batches, result);
    }
    return result[target] ?? (result.pickup = gachaRecordedHits(batches, "pickup"));
  }

  private hitMeta(entry: GachaRecordedHit, pool?: string) {
    return [
      pool === undefined ? "" : this.poolName(pool),
      entry.pulledAt ? this.serverTime(entry.pulledAt, "dateTime") : this.t("unknownTime"),
      entry.position === null ? "" : `#${this.number(entry.position)}`,
    ].filter(Boolean).join(" / ");
  }

  private hitGap(entry: GachaRecordedHit) {
    return entry.gap === null ? "—" : this.t("draws", { count: this.number(entry.gap) });
  }

  private hasHighPickup(pool?: GachaHistoryPool) {
    return pool?.featured?.some(card => ["SSR", "EX", "BD"].includes(cardRarityName(card.rarity)));
  }

  private tenPullLabel(count: number) {
    return this.t("timelineMultiSsr", { count: this.number(count) });
  }

  private hitBadges(hit: GachaRecordedHit, pool?: GachaHistoryPool): GachaTimelineBadge[] {
    const badges: GachaTimelineBadge[] = [];
    if (hit.prize.pickup === true) badges.push({ label: this.t("pickup"), tone: "tertiary" });
    else if (hit.prize.pickup === false && this.hasHighPickup(pool))
      badges.push({ label: this.t("timelineOffBanner"), tone: "error" });
    if (hit.tenPullHits) badges.push({ label: this.tenPullLabel(hit.tenPullHits), tone: "tertiary" });
    if (hit.gap === 1) badges.push({ label: this.t("timelineOneShot"), tone: "primary" });
    if (hit.prize.converted) badges.push({ label: this.t("converted"), tone: "primary" });
    return badges;
  }

  private timelineHighlights(pools: ReturnType<typeof gachaRecordedHits>): GachaTimelineBadge[] {
    let oneShots = 0, bestPickup = 0, bestOffBanner = 0;
    const tenPulls = new Map<number, number>();
    for (const pool of pools) {
      const hasPickup = this.hasHighPickup(this.poolMap.get(pool.poolId));
      let pickup = 0, offBanner = 0;
      for (const hit of pool.hits) {
        if (hit.tenPullHits) tenPulls.set(hit.tenPullHits, (tenPulls.get(hit.tenPullHits) ?? 0) + 1);
        if (hit.gap === 1) oneShots++;
        if (hit.gap === null) pickup = offBanner = 0;
        pickup = hit.prize.pickup === true ? pickup + 1 : 0;
        offBanner = hasPickup && hit.prize.pickup === false ? offBanner + 1 : 0;
        bestPickup = Math.max(bestPickup, pickup);
        bestOffBanner = Math.max(bestOffBanner, offBanner);
      }
    }
    const badges: GachaTimelineBadge[] = [...tenPulls].sort((a, b) => b[0] - a[0])
      .map(([hits, count]) => ({ label: this.t("timelineBadgeTimes", { label: this.tenPullLabel(hits), count: this.number(count) }), tone: "tertiary" }));
    if (oneShots) badges.push({ label: this.t("timelineBadgeTimes", { label: this.t("timelineOneShot"), count: this.number(oneShots) }), tone: "primary" });
    if (bestPickup > 1) badges.push({ label: this.t("timelinePickupRun", { count: this.number(bestPickup) }), tone: "tertiary" });
    if (bestOffBanner > 1) badges.push({ label: this.t("timelineOffRun", { count: this.number(bestOffBanner) }), tone: "error" });
    return badges;
  }

  private timelineTags(badges: readonly GachaTimelineBadge[]) {
    return badges.length ? html`<span class="cluster gacha-timeline__marks">
      ${badges.map(badge => html`<span class="gacha-chip" data-tone=${badge.tone}>${badge.label}</span>`)}
    </span>` : nothing;
  }

  private hitList(
    hits: ReadonlyArray<GachaRecordedHit & { poolId?: string }>, showPool: boolean,
    timeline?: { pool?: GachaHistoryPool },
  ) {
    const largest = hits.reduce((max, hit) => Math.max(max, hit.gap ?? 0), 1);
    return html`
      <ol class="gacha-hits">
        ${hits.map((entry) => {
          const prize = entry.prize;
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
                  ${this.hitMeta(entry, showPool ? entry.poolId ?? "" : undefined)}
                </span>
                ${timeline ? this.timelineTags(this.hitBadges(entry, timeline.pool)) : nothing}
              </span>
              <span class="gacha-hit__gap">
                <span class="gacha-hit__count">${this.hitGap(entry)}</span>
                <span class="gacha-hit__bar" aria-hidden="true">
                  <span style=${`inline-size:${entry.gap === null ? 0 : Math.max(2, (entry.gap / largest) * 100).toFixed(1)}%`}></span>
                </span>
              </span>
            </li>
          `;
        })}
      </ol>
    `;
  }

  private poolPeriod(pool?: GachaHistoryPool) {
    const period = pool?.startAt && pool.endAt ? `${this.serverTime(pool.startAt, "date")} – ${this.serverTime(pool.endAt, "date")}` : "";
    return [pool?.category, period].filter(Boolean).join(" / ");
  }

  private timelinePools(scoped: readonly GachaHistoryBatch[]) {
    return this.newestPoolsFirst(this.recordedHits(scoped), scoped);
  }

  private renderTimeline(scoped: readonly GachaHistoryBatch[]) {
    const pools = this.timelinePools(scoped);
    return html`<div class="stack stack--loose gacha-timeline">
      ${this.timelineTags(this.timelineHighlights(pools))}
      ${repeat(pools, pool => pool.poolId, pool => {
        const view = this.poolMap.get(pool.poolId);
        return html`
          <article class="surface stack gacha-pool">
            <header class="gacha-pool__header">
              ${this.poolLogo(view)}
              <div class="gacha-pool__title">
                <h3 class="md-title-medium">${this.poolName(pool.poolId)}</h3>
                <span class="md-body-small">${this.poolPeriod(view)}</span>
              </div>
              <span class="gacha-pool__total">${this.t("draws", { count: this.number(pool.total) })}</span>
            </header>
            ${pool.hits.length ? this.hitList(pool.hits, false, { pool: view })
              : html`<span class="md-body-medium gacha-timeline__empty">${this.t("noRecordedHigh")}</span>`}
          </article>`;
      })}
    </div>`;
  }

  private renderPools(scoped: readonly GachaHistoryBatch[], stats: ReturnType<GachaHistory["analysis"]>) {
    const { byPool } = this.statistics(scoped).rates;
    const recordedHigh = new Map(this.recordedHits(scoped).map((row) => [row.poolId, row]));
    const pickupHits = new Map(this.recordedHits(scoped, "pickup").map((row) => [row.poolId, row]));
    const batchesByPool = new Map<string, GachaHistoryBatch[]>();
    for (const batch of scoped) {
      const rows = batchesByPool.get(batch.poolId) ?? [];
      rows.push(batch);
      batchesByPool.set(batch.poolId, rows);
    }
    return html`
      <div class="stack stack--loose">
        ${repeat(
          this.newestPoolsFirst(stats.pools, scoped),
          (pool) => pool.poolId ?? "unknown",
          (pool) => {
            const view = this.poolMap.get(pool.poolId ?? "");
            const rates = byPool.get(pool.poolId ?? "");
            const luck = this.luckSummary(pool.poolId ?? "");
            const expected = luck?.high;
            const batches = batchesByPool.get(pool.poolId ?? "") ?? [];
            const recorded = recordedHigh.get(pool.poolId ?? "");
            const streak = gachaHighStreak(batches, recorded, true);
            const pickup = pickupHits.get(pool.poolId ?? "");
            const owned = new Map(this.collected(batches).map((card) => [card.key, card]));
            const id = `pool-${pool.poolId ?? "unknown"}`;
            return html`
              <article class="surface stack gacha-pool">
                <header class="gacha-pool__header">
                  ${this.poolLogo(view)}
                  <div class="gacha-pool__title">
                    <h3 class="md-title-medium">${this.poolName(pool.poolId)}</h3>
                    <span class="md-body-small">${this.poolPeriod(view)}</span>
                  </div>
                  <span class="gacha-pool__total">${this.t("draws", { count: this.number(pool.total) })}</span>
                </header>
                <div class="gacha-pool__stats" ?hidden=${isItemOnlyGacha(view?.rates)}>
                  ${this.stat({
                    icon: icon("star", 20),
                    label: "SSR+",
                    value: this.number(pool.high),
                    supporting: this.rateText(rates?.high),
                    tone: "tertiary",
                  })}
                  ${this.stat({
                    icon: icon("trending_up", 20),
                    label: this.t("pickup"),
                    value: this.number(pool.pickup),
                    supporting: this.rateText(rates?.pickup),
                    tone: "secondary",
                  })}
                  ${this.stat({
                    icon: icon("hourglass_bottom", 20),
                    label: this.t(streak.hasHit ? "sinceLastHigh" : "consecutiveWithoutHigh"),
                    value: this.interval(streak.trailing),
                    supporting: pickup?.trailing != null
                      ? `${this.t("sinceLastPickup")} ${this.number(pickup.trailing)}`
                      : "",
                  })}
                  ${this.stat({
                    icon: icon("functions", 20),
                    label: this.t("pullsPerHigh"),
                    value: pool.high ? this.number((pool.total - pool.unknown - pool.unknownRarity) / pool.high, 1) : "—",
                    supporting: expected
                      ? `${this.t("expected")} ${this.number(expected.expected, 2)} / ${this.t("difference")} ${new Intl.NumberFormat(this.locale, { maximumFractionDigits: 2, signDisplay: "always" }).format(expected.observed - expected.expected)}`
                      : "",
                  })}
                </div>
                ${this.luckMeters(luck)}
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
                                      label: `${card.name} / ${got ? `×${got.count}` : this.t("notObtained")}`,
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
                ${this.fold(`${id}-timeline`, this.t("tabTimeline"),
                  this.expanded.has(`${id}-timeline`)
                    ? recorded?.hits.length ? this.hitList(recorded.hits, false, { pool: view }) : html`<span>${this.t("noRecordedHigh")}</span>`
                    : nothing,
                  this.number(recorded?.hits.length ?? 0))}
                ${
                  pickup?.hits.length
                    ? this.fold(
                        `${id}-pickup`,
                        this.t("pickupHistory"),
                        this.expanded.has(`${id}-pickup`) ? this.hitList([...pickup.hits].reverse(), false) : nothing,
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
        (a, b) => b.pickup - a.pickup || cardRarityRank(b.prize.rarity) - cardRarityRank(a.prize.rarity) || b.count - a.count,
      )
      .slice(0, 12);
    if (!cards.length) return nothing;
    return html`
      <section class="surface stack gacha-history__wide">
        ${renderDetailSectionHeading(this.t("highlights"), "cards", { level: 3 })}
        <div class="gacha-stats">
          ${cards.map((card) =>
            gachaPrizeCard({
              label: `${card.prize.name} / ×${card.count}`,
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
          cardRarityRank(b.prize.rarity) - cardRarityRank(a.prize.rarity) || b.count - a.count || a.key.localeCompare(b.key),
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
                        .join(" / "),
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
                                  label: `${card.prize.name} / ×${card.count} / ${this.t("pickup")} ${card.pickup}`,
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
                                    /
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
                                  ${this.costChip(batch.cost?.freeGems, this.t("freeGems"), this.gemItems?.free)}
                                  ${this.costChip(batch.cost?.paidGems, this.t("paidGems"), this.gemItems?.paid)}
                                  ${this.costChip(batch.cost?.tickets, this.t("tickets"), batch.ticketItem)}
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
            details: months.map((row) => `SSR+ ${row.high} / ${this.t("pickup")} ${row.pickup}`),
          },
        )}
        ${this.chart(
          `SSR+ / ${this.t("monthlyTrend")}`,
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
          { details: stats.days.map((day) => `SSR+ ${day.high} / ${this.t("pickup")} ${day.pickup}`), wide: true },
        )}
        ${this.chart(
          this.t("poolComposition"),
          stats.pools.map((pool) => this.poolName(pool.poolId)),
          composition(stats.pools),
          { wide: true },
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

  private cachedReport(batches: readonly GachaHistoryBatch[], stats: ReturnType<GachaHistory["analysis"]>) {
    const inputs = [batches, this.luckResult, this.pools, this.accounts, this.locale, this.currencyConversion];
    if (!this.reportValue || inputs.some((value, index) => value !== this.reportInputs[index])) {
      this.reportInputs = inputs; this.reportValue = this.report(batches, stats);
    }
    return this.reportValue;
  }
  private report(
    batches: readonly GachaHistoryBatch[],
    stats: ReturnType<GachaHistory["analysis"]>,
  ): GachaHistoryReport {
    const summary = this.luckSummary();
    const luck = summary?.combined?.variable ? summary.combined : null;
    const metrics = [
      { label: this.t("total"), value: this.number(stats.total) },
      { label: `SSR+ / ${this.t("luckActualExpected")}`, value: summary?.high ? `${this.number(summary.high.observed)} / ${this.number(summary.high.expected, 2)}` : `${this.number(stats.high)} / —` },
      { label: `${this.t("luckPickupHigh")} / ${this.t("luckActualExpected")}`, value: summary?.pickup ? `${this.number(summary.pickup.observed)} / ${this.number(summary.pickup.expected, 2)}` : `${this.number(stats.pickup)} / —` },
      {
        label: this.t("luckCombined"),
        value: luck ? this.luckRating(luck) : this.luckState(summary),
      },
    ];
    const pools = this.timelinePools(batches);
    const timeline: GachaTimelineGroup[] = pools.map(pool => {
      const view = this.poolMap.get(pool.poolId);
      return {
        label: this.poolName(pool.poolId),
        supporting: this.poolPeriod(view),
        total: this.t("draws", { count: this.number(pool.total) }),
        imageUrl: view?.imageUrl,
        empty: this.t("noRecordedHigh"),
        entries: pool.hits.map(hit => ({
          name: hit.prize.name,
          meta: this.hitMeta(hit),
          badges: this.hitBadges(hit, view),
          gapLabel: this.hitGap(hit),
          gap: hit.gap,
          pickup: hit.prize.pickup,
          kind: hit.prize.kind,
          imageUrl: hit.prize.imageUrl,
        })),
      };
    });
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
    return { title: this.t("title"), scope, metrics, charts: [], groups: [], timeline, timelineHighlights: this.timelineHighlights(pools) };
  }
  private cloudControls() {
    const disabled = this.cloudBusy || this.busy || !this.selectedAccountKey;
    const accountError = ["authentication_required", "email_verification_required", "account_restricted", "history_session_expired"].includes(
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
      history_session_expired: "cloudSessionExpired",
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
                  `${this.t("exchangeTargets")} / ${number(group.length)}`,
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
                            subtitle: details[0].join(" / "),
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
                <span>${this.t(key)} / ${conversion.currencyCode}</span>
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
            .images=${this.imageFiles.map((file) => ({ id: file.filename, source: file.url, label: this.t("imagePreview"), width: file.width, height: file.height }))}
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
      const [blob] = await renderGachaHistoryImages(report, { signal: request.signal });
      const header = new DataView(await blob!.slice(16, 24).arrayBuffer());
      request.signal.throwIfAborted();
      this.imageFiles = [{
        blob: blob!, filename: "haneoka-gacha-history.png", url: URL.createObjectURL(blob!),
        width: header.getUint32(0), height: header.getUint32(4),
      }];
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
        const file = files[0]!;
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
      .join(" / ");
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
        .join(" / ");
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
        ${prizes.map((prize) => gachaPrizeCard({ label: `${prize.name} / ${subtitle(prize)}`, kind: prize.kind, rarity: prize.rarity, href: prize.href, image: prize.imageUrl, attribute: prize.attributeImageUrl, rarityMark: prize.rarityImageUrl, count: prize.quantity, pickup: prize.pickup === true }))}
      </div>
    `;
  }
}
if (!customElements.get("gacha-history")) customElements.define("gacha-history", GachaHistory);
