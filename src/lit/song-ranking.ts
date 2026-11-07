// L3 — GEB
// Input: Complete score boards or paged point boards, active page state and card catalogues.
// Output: Shared ranking rows, player search beside rank jumps, match selection, rank jumps and pagination.
// Pos: [Map](L2-2.md); common leaderboard implementation for songs, events and Arena.
// Effects/Dependencies: Reads saved ranking APIs; cancels obsolete board/search requests and restores page actions.
import "@lit-labs/ssr-client/lit-element-hydrate-support.js";
import { hydrateWorkspace } from "./shared/hydrate-workspace";
import { GameRecordsCardsElement } from "./shared/game-records-cards";
import { playerProfileHref, validPlayerProfileId } from "../lib/player-profile-route";
import { navigateDetailPage } from "../lib/detail-navigation";
import "@material/web/progress/linear-progress.js";
import { clientText } from "../i18n/client";
import { html, nothing, type PropertyValues } from "lit";
import { preferredLocale, fetchJson, JsonResponseError } from "./shared/catalog";
import type { ReleaseServer } from "../lib/release-server";
import { RequestScope } from "../lib/request-scope";
import { icon } from "./ui/icon";
import { snackbar } from "../lib/snackbar";
import { modal } from "./ui/modal";
import { iconButton } from "./ui/controls";
import "../styles/settings.css";
import { readPageData } from "../lib/page-data";
import { navigationDocumentUrl } from "../lib/document-url";
import type { RankingCardCatalog } from "../lib/game-records";
import { emptyState, errorState, loadingState } from "./ui/state";
import { clearAppBarActions, setAppBarActions } from "../lib/app-bar";
import {
  GAME_RECORDS_REGIONS as REGIONS,
  defaultGameRecordsRegion as defaultRegion,
  gameRecordsRegionPicker,
} from "./shared/game-records";

import type {
  GameRecordsRegion,
  GameRankingDto,
  SongRankingRowDto,
  GameRecordsErrorDto,
  ArenaRankingDto,
  RankingPlayerMatchDto,
  ArenaPlayerSearchDto,
  TrackedEventDto,
} from "../lib/game-records";
import { formatDate } from "../lib/date-format";
type Region = GameRecordsRegion;
type Phase = "idle" | "loading" | "ready" | "error";

type RankingEntry = SongRankingRowDto;
interface RankingCache {
  data: GameRankingDto;
  rows: RankingEntry[];
  snapshotId?: string;
  provider?: "official" | "moenotes";
  storedAt: number;
  reportedAt: number;
  stale: boolean;
  maxRank?: number | null;
}

const CACHE_TTL = 5 * 60 * 1000;
let pageAppBarOwnerSequence = 0;

export class SongRanking extends GameRecordsCardsElement {
  static properties = {
    locale: { type: String },
    server: { type: String },
    songId: { type: String, attribute: "song-id" },
    rankingEndpoint: { type: String, attribute: "ranking-endpoint" },
    embedded: { type: Boolean },
    points: { type: Boolean },
    summary: { type: Boolean },
    rankingTitle: { type: String, attribute: "ranking-title" },
    cardCatalogData: { attribute: false },
    summaryHeading: { attribute: false },
    summaryActions: { attribute: false },
    analysisEvent: { attribute: false },
    analysisChallengeId: { type: String, attribute: false },
    region: { state: true },
    phase: { state: true },
    rows: { state: true },
    stale: { state: true },
    expanded: { state: true },
    active: { type: Boolean },
    limit: { type: Number },
    start: { state: true },
    target: { state: true },
    searching: { state: true },
    searchMatches: { state: true },
    nextSearchCursor: { state: true },
  };

  declare locale: string;
  declare server: ReleaseServer;
  declare songId: string;
  declare rankingEndpoint: string;
  declare embedded: boolean;
  declare points: boolean;
  declare summary: boolean;
  declare rankingTitle: string;
  declare summaryHeading: unknown;
  declare summaryActions: unknown;
  declare cardCatalogData: Partial<Record<"jp" | "intl", RankingCardCatalog>> | undefined;
  declare analysisEvent: TrackedEventDto | undefined;
  declare analysisChallengeId: string;
  private closeAnalysis?: () => void;
  declare region: Region;
  declare phase: Phase;
  declare rows: RankingEntry[];
  declare stale: boolean;
  declare expanded: boolean;

  declare active: boolean;
  declare limit: number;
  declare protected start: number;
  declare protected target: number;
  declare private searching: boolean;
  declare private searchMatches: RankingPlayerMatchDto[] | null;
  declare private nextSearchCursor: number | null;
  protected windowed = false;
  private query = "";
  private searchRequests = new RequestScope();
  private rankingRequests = new RequestScope();
  private lifetime?: AbortController;
  private cache = new Map<string, RankingCache>();
  private rankingFailure: GameRecordsErrorDto["error"] | null = null;
  private retryAt = 0;
  private retryTimer = 0;
  private readonly pageAppBarOwner = `song-ranking-page-${++pageAppBarOwnerSequence}`;

  constructor() {
    super();
    this.locale = "en";
    this.server = "intl";
    this.songId = "";
    this.rankingEndpoint = "";
    this.embedded = false;
    this.points = false;
    this.summary = false;
    this.rankingTitle = "";
    this.analysisChallengeId = "";
    this.summaryHeading = nothing;
    this.summaryActions = nothing;
    this.region = "tw";
    this.phase = "idle";
    this.rows = [];
    this.stale = false;
    this.expanded = false;
    this.active = true;
    this.limit = 0;
    this.start = 1;
    this.target = 0;
    this.searching = false;
    this.searchMatches = null;
    this.nextSearchCursor = null;
  }

  private initializePage() {
    this.cardCatalogs = this.cardCatalogData || readPageData<typeof this.cardCatalogs>(this) || this.cardCatalogs;
    const requested = navigationDocumentUrl().searchParams.get("region");
    if (!this.embedded)
      this.region = REGIONS.some((option) => option.value === requested)
        ? (requested as Region)
        : defaultRegion(this.server, this.locale);
    const oldProfileId = navigationDocumentUrl().searchParams.get("profileId");
    if (!this.embedded && oldProfileId && validPlayerProfileId(this.region, oldProfileId)) {
      void navigateDetailPage(
        playerProfileHref(
          this.locale,
          this.region,
          oldProfileId,
          this.rankingUrl(this.region),
          navigationDocumentUrl(),
        ),
        "replace",
      );
      return;
    }
    this.phase = "loading";
    void this.loadRanking(this.region, true);
  }

  connectedCallback() {
    if (this.hasAttribute("data-static-initial")) this.preparePage(readPageData<typeof this.cardCatalogs>(this) || {});
    super.connectedCallback();
    this.lifetime = new AbortController();
    addEventListener("haneoka:locale-ready", this.onLocale, { signal: this.lifetime.signal });
    if (this.hasAttribute("data-prerendered"))
      void this.updateComplete.then(() => {
        if (this.isConnected) this.initializePage();
      });
    else this.initializePage();
  }
  preparePage(cards: Partial<Record<"jp" | "intl", RankingCardCatalog>>) {
    this.cardCatalogs = cards;
    this.region = defaultRegion(this.server, this.locale);
    this.phase = "loading";
  }
  protected update(changed: PropertyValues) {
    if (this.hasAttribute("data-prerendered")) {
      hydrateWorkspace(this.render(), this, this.renderOptions);
      this.removeAttribute("data-prerendered");
    }
    super.update(changed);
  }
  renderStaticChrome() {
    this.syncChrome();
  }

  disconnectedCallback() {
    this.closeAnalysis?.();
    this.rankingRequests.cancel();
    this.searchRequests.cancel();
    this.lifetime?.abort();
    this.lifetime = undefined;
    window.clearTimeout(this.retryTimer);
    clearAppBarActions(this.pageAppBarOwner);
    super.disconnectedCallback();
  }

  private onLocale = () => {
    this.locale = preferredLocale(this.locale);
    this.requestUpdate();
  };

  protected get boardTitle() {
    return this.rankingTitle || this.label("title", "Song ranking");
  }

  protected rankingUrl(region: Region) {
    return this.rankingEndpoint || `/api/v1/game/records/${region}/songs/${encodeURIComponent(this.songId)}/ranking`;
  }

  private currentRanking(signal: AbortSignal, region: Region, endpoint: string) {
    return (
      this.isConnected &&
      this.region === region &&
      this.rankingUrl(region) === endpoint &&
      this.rankingRequests.current(signal)
    );
  }

  private async loadRanking(region: Region, force = false) {
    this.rankingFailure = null;
    this.retryAt = 0;
    window.clearTimeout(this.retryTimer);
    const cached = this.cache.get(this.rankingUrl(region));
    if (!force && cached && Date.now() - cached.storedAt < CACHE_TTL) {
      this.rows = cached.rows;
      this.phase = "ready";
      this.stale = cached.stale;
      this.rankingLoaded(cached.data);
      return;
    }
    const endpoint = this.rankingUrl(region);
    const signal = this.rankingRequests.begin();
    this.rows = cached?.rows || [];
    this.phase = "loading";
    this.stale = Boolean(cached);
    try {
      const value = await fetchJson<GameRankingDto & Partial<ArenaRankingDto>>(endpoint, {
        signal,
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!this.currentRanking(signal, region, endpoint)) return;
      const entry = {
        data: value,
        rows: value.snapshotId && value.snapshotId === cached?.snapshotId ? cached.rows : value.rows.slice(0, 100),
        snapshotId: value.snapshotId,
        provider: value.provider,
        storedAt: Date.now(),
        reportedAt: value.observedAtMs ?? value.fetchedAtMs ?? 0,
        stale: value.stale,
        maxRank: value.maxRank,
      };
      this.cache.set(endpoint, entry);
      if (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value!);
      this.rows = entry.rows;
      this.phase = "ready";
      this.stale = entry.stale;
      this.rankingLoaded(value);
      if (this.target) void this.updateComplete.then(() => this.scrollToTarget());
    } catch (error) {
      if (!this.currentRanking(signal, region, endpoint)) return;
      if (error instanceof JsonResponseError) {
        const failure = (error.body as GameRecordsErrorDto | null)?.error;
        if (failure && typeof failure.kind === "string") this.rankingFailure = failure;
      }
      const retry = this.rankingFailure?.retryAfter;
      if (retry != null && Number.isFinite(retry) && retry > 0) {
        this.retryAt = Date.now() + retry * 1000;
        this.retryTimer = window.setTimeout(() => this.requestUpdate(), retry * 1000);
      }
      const notFound = this.rankingFailure?.kind === "not_found";
      if (notFound) this.cache.delete(endpoint);
      this.rows = notFound ? [] : cached?.rows || [];
      this.phase = notFound ? "ready" : "error";
      this.stale = !notFound && Boolean(cached);
      this.rankingLoaded(notFound ? null : (cached?.data ?? null));
    }
  }

  private selectRegion(value: string) {
    if (!REGIONS.some((option) => option.value === value) || value === this.region) return;
    const region = value as Region;
    this.rankingFailure = null;
    this.retryAt = 0;
    window.clearTimeout(this.retryTimer);
    this.region = region;
    const url = new URL(location.href);
    url.searchParams.set("region", region);
    url.searchParams.delete("profileId");
    history.replaceState(history.state, "", url);
    this.expanded = false;
    this.rankingRequests.cancel();
    const cached = this.cache.get(this.rankingUrl(region));
    this.rows = cached?.rows || [];
    this.stale = cached ? cached.stale : false;
    this.phase = cached && Date.now() - cached.storedAt < CACHE_TTL ? "ready" : "loading";
    if (this.phase !== "ready") void this.loadRanking(region, true);
  }

  protected refresh() {
    if (Date.now() < this.retryAt) return;
    this.rankingRequests.cancel();
    void this.loadRanking(this.region, true);
  }

  private formatTime(region: Region) {
    const cached = this.cache.get(this.rankingUrl(region));
    const value = cached?.reportedAt || 0;
    if (!value) return "";
    return formatDate(this.locale, value, { time: true });
  }

  private renderPageActions() {
    return html`
      ${gameRecordsRegionPicker(this.locale, this.region, (region) => this.selectRegion(region))}
      ${iconButton({ label: this.label("refresh", "Refresh ranking"), icon: "refresh", disabled: this.phase === "loading" || Date.now() < this.retryAt, onClick: () => this.refresh() })}
    `;
  }

  protected renderRow(entry: RankingEntry) {
    const score = entry.scoreExact
      ? BigInt(entry.scoreExact).toLocaleString(this.locale)
      : this.formatScore(entry.score);
    return this.renderRankingRow({
      ...entry,
      target: entry.rank === this.target,
      bare: this.limit > 0,
      level: this.levelFromExp(this.sourceCatalog()?.playerLevels, entry.rankExp),
      href: entry.profileId
        ? playerProfileHref(
            this.locale,
            this.region,
            entry.profileId,
            this.rankingUrl(this.region),
            navigationDocumentUrl(),
          )
        : "",
      score,
      scoreLabel: this.points ? this.label("points", "Points") : this.label("score", "Score"),
      ...(this.analysisEvent && entry.totalPower ? { scoreAction: {
        label: clientText(this.locale, "catalog.rankings.analysis.title", "Team analysis"),
        onClick: () => void this.analyzeTeam(entry),
      } } : {}),
      ...(this.points || this.summary || this.limit ? { cards: undefined } : {}),
    });
  }
  protected async analyzeTeam(row: RankingEntry) {
    const event = this.analysisEvent;
    if (!event) return;
    const { showEventTeamAnalysis } = await import("./event-team-analysis");
    if (!this.isConnected || !this.active || this.analysisEvent !== event) return;
    this.closeAnalysis?.();
    this.closeAnalysis = showEventTeamAnalysis({ locale: this.locale, region: this.region, event,
      challengeId: this.analysisChallengeId, kind: this.points ? "points" : this.analysisChallengeId ? "challenge" : "total", row,
      observedAtMs: this.cache.get(this.rankingUrl(this.region))?.reportedAt ?? 0 });
  }
  protected get skeletonDecks() {
    return !this.points && !this.summary && !this.limit;
  }

  private renderSkeleton() {
    const rows = Array.from({ length: this.limit || 20 });
    return html`
      <ol
        class="song-ranking__list song-ranking__list--skeleton"
        aria-busy="true"
        aria-label=${this.label("loading", "Loading ranking")}
      >
        ${rows.map(
          () => html`
            <li class="song-ranking__entry" aria-hidden="true">
              <div
                class=${`song-ranking__row${this.skeletonDecks ? "" : " song-ranking__row--points"}${this.limit ? " song-ranking__row--bare" : ""}`}
              >
                <span class="song-ranking__rank"><span class="skeleton-line">00</span></span>
                ${
                  this.limit
                    ? nothing
                    : html`
                        <span class="song-ranking__namecard song-ranking__namecard--empty"></span>
                      `
                }
                <span class="song-ranking__avatar"><span class="song-ranking__initial"></span></span>
                <span class="song-ranking__player-copy">
                  <strong><span class="skeleton-line"> </span></strong>
                  <small class="song-ranking__player-stats"><span class="skeleton-line"> </span></small>
                </span>
                <span class="song-ranking__score">
                  <strong><span class="skeleton-line">00,000,000</span></strong>
                </span>
                ${
                  !this.skeletonDecks
                    ? nothing
                    : html`
                        <span class="song-ranking__deck-preview">
                          ${[0, 1, 2, 3, 4].map(
                            () => html`
                              <span class="song-ranking__deck-slot">
                                <span class="song-ranking__card"><span class="song-ranking__card-media"></span></span>
                                <span class="song-ranking__card">
                                  <span class="song-ranking__card-media song-ranking__card-media--support"></span>
                                </span>
                              </span>
                            `,
                          )}
                        </span>
                      `
                }
              </div>
            </li>
          `,
        )}
      </ol>
      ${
        !this.limit && !this.windowed
          ? html`
              <span class="button button--tonal song-ranking__more song-ranking__more--placeholder" aria-hidden="true">
                ${this.label("showMore", "Show top 100")}
              </span>
              ${loadingState(this.label("loading", "Loading ranking"))}
            `
          : nothing
      }
    `;
  }

  private renderRanking() {
    const visible = this.rows.slice(0, this.limit || (this.windowed || this.expanded ? 100 : 20));
    const showMore = !this.limit && !this.windowed && this.rows.length > 20 && !this.expanded;
    const failed = this.rankingFailure?.kind;
    const failureText =
      failed === "pending" && this.retryAt > 0
        ? this.label("pending", "Ranking is being collected. Try again in {seconds}s.").replace(
            "{seconds}",
            String(Math.max(0, Math.ceil((this.retryAt - Date.now()) / 1000))),
          )
        : failed === "timeout"
          ? this.label("timeout", "The ranking request timed out.")
          : this.label("error", "Ranking unavailable");
    return html`
      <div class="song-ranking__content">
        ${
          this.phase === "error" && !this.rows.length
            ? errorState(failureText, this.label("retry", "Retry"), () => this.refresh())
            : this.phase === "loading" && !this.rows.length
              ? this.renderSkeleton()
              : !this.rows.length
                ? emptyState({
                    title:
                      failed === "not_found"
                        ? this.label("notFound", "No ranking is available for this song.")
                        : this.label("empty", "No scores yet"),
                    icon: "leaderboard",
                  })
                : html`
                    <ol
                      class="song-ranking__list"
                      style=${`--rank-digits: ${String(Math.max(0, ...visible.map((entry) => Number(entry.rank) || 0))).length}`}
                      aria-label=${this.boardTitle}
                    >
                      ${visible.map((entry) => this.renderRow(entry))}
                    </ol>
                    ${
                      showMore
                        ? html`
                            <button
                              class="button button--tonal song-ranking__more"
                              type="button"
                              @click=${() => (this.expanded = true)}
                            >
                              ${this.label("showMore", "Show top 100")}
                            </button>
                          `
                        : nothing
                    }
                  `
        }
      </div>
    `;
  }

  protected rankingLoaded(_value: GameRankingDto | null) {}

  protected get identityProperties() {
    return ["rankingEndpoint", "region", "songId"];
  }

  protected willUpdate(changed: PropertyValues) {
    if (this.identityProperties.some((key) => changed.has(key)) || (changed.has("active") && !this.active)) {
      this.closeAnalysis?.();
      this.closeAnalysis = undefined;
    }
    if (this.identityProperties.some((key) => changed.has(key))) {
      this.start = 1;
      this.target = 0;
      this.query = "";
      this.searchMatches = null;
      this.searchRequests.cancel();
      this.searching = false;
    }
  }

  updated(changed: PropertyValues) {
    if (changed.has("cardCatalogData") && this.cardCatalogData) this.cardCatalogs = this.cardCatalogData;
    if (
      this.identityProperties.some((key) => changed.has(key) && changed.get(key) !== undefined) ||
      (this.windowed && changed.has("start") && changed.get("start") !== undefined)
    ) {
      this.expanded = false;
      void this.loadRanking(this.region);
    }
    if (!this.active) {
      this.searchRequests.cancel();
      this.searching = false;
      this.searchMatches = null;
    }
    this.syncChrome();
  }

  private syncChrome() {
    if (!this.embedded) setAppBarActions(this.pageAppBarOwner, this.renderPageActions(), this);
  }

  private scrollToTarget() {
    this.querySelector<HTMLElement>(`[data-rank="${this.target}"]`)?.scrollIntoView({ block: "center" });
  }

  private moveWindow(start: number) {
    this.searchRequests.cancel();
    this.searching = false;
    this.searchMatches = null;
    this.target = 0;
    this.start = start;
  }

  protected jump(rank: number) {
    this.searchRequests.cancel();
    this.searching = false;
    this.target = rank;
    this.searchMatches = null;
    if (this.windowed) this.start = Math.floor((rank - 1) / 100) * 100 + 1;
    else this.expanded = true;
    void this.updateComplete.then(() => this.scrollToTarget());
  }

  protected async findPlayers(
    query: string,
    signal: AbortSignal,
    after = 0,
  ): Promise<{
    matches: RankingPlayerMatchDto[];
    searchedTo: number;
    nextCursor?: number | null;
    complete?: boolean;
    retryAfter?: number | null;
  }> {
    if (this.windowed) {
      const url = new URL(this.rankingUrl(this.region), location.origin);
      url.pathname = url.pathname.replace(/\/ranking$/u, "/search");
      url.search = new URLSearchParams({ query, partial: "1", ...(after ? { after: String(after) } : {}) }).toString();
      for (;;) {
        try {
          return await fetchJson<ArenaPlayerSearchDto>(url.pathname + url.search, { signal });
        } catch (error) {
          const failure = error instanceof JsonResponseError ? (error.body as GameRecordsErrorDto | null)?.error : null;
          if (failure?.kind !== "pending" || !failure.retryAfter || signal.aborted) throw error;
          await this.waitForSearch(signal, failure.retryAfter);
        }
      }
    }
    const normalized = query.normalize("NFKC").toLowerCase();
    return {
      searchedTo: this.rows.length,
      matches: this.rows
        .filter((row) => row.profileId === query || row.name.normalize("NFKC").toLowerCase().includes(normalized))
        .map((row) => ({ rank: row.rank, profileId: row.profileId, name: row.name, point: row.score ?? 0 })),
    };
  }

  private waitForSearch(signal: AbortSignal, seconds: number) {
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        window.clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = window.setTimeout(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        Math.max(3, seconds) * 1000,
      );
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private mergeMatches(rows: RankingPlayerMatchDto[]) {
    const key = (row: RankingPlayerMatchDto) => row.profileId || `${row.rank}/${row.name}/${row.point}`;
    const incoming = new Map(rows.map((row) => [key(row), row]));
    const current = this.searchMatches ?? [];
    const seen = new Set(current.map(key));
    this.searchMatches = [
      ...current.map((row) => incoming.get(key(row)) ?? row),
      ...rows.filter((row) => !seen.has(key(row))),
    ];
  }

  private async search(query: string, after = 0) {
    const signal = this.searchRequests.begin();
    this.searching = true;
    if (!after) {
      const normalized = query.normalize("NFKC").toLowerCase();
      const local = this.rows
        .filter((row) => row.profileId === normalized || row.name.normalize("NFKC").toLowerCase().includes(normalized))
        .map((row) => ({ rank: row.rank, profileId: row.profileId, name: row.name, point: row.score ?? 0 }));
      const exact = local.find((row) => row.profileId === normalized);
      if (exact) {
        this.jump(exact.rank);
        return;
      }
      this.searchMatches = local.length ? local : null;
      this.nextSearchCursor = null;
    }
    try {
      for (;;) {
        const result = await this.findPlayers(query, signal, after);
        if (!this.searchRequests.current(signal)) return;
        const complete = result.complete !== false;
        this.nextSearchCursor = complete ? (result.nextCursor ?? null) : null;
        const exact = result.matches.find((row) => row.profileId === query.normalize("NFKC"));
        if (exact && !after) {
          this.jump(exact.rank);
          return;
        }
        if (result.matches.length) this.mergeMatches(result.matches);
        if (complete) {
          if (!this.searchMatches?.length)
            snackbar(
              clientText(this.locale, "catalog.arena.ranking.notFound", "Not in the top {count}").replace(
                "{count}",
                result.searchedTo.toLocaleString(this.locale),
              ),
            );
          return;
        }
        if (!result.retryAfter) {
          snackbar(this.label("error", "Ranking unavailable"));
          return;
        }
        await this.waitForSearch(signal, result.retryAfter);
      }
    } catch {
      if (this.searchRequests.current(signal)) snackbar(this.label("error", "Ranking unavailable"));
    } finally {
      if (this.searchRequests.current(signal)) this.searching = false;
    }
  }

  private renderMatches() {
    if (!this.searchMatches) return nothing;
    const close = () => {
      this.searchRequests.cancel();
      this.searching = false;
      this.searchMatches = null;
    };
    return html`
      <dialog
        class="dialog"
        ${modal(close)}
        aria-label=${clientText(this.locale, "catalog.arena.ranking.searchResults", "Matching players")}
      >
        <div class="dialog__surface">
          <header class="dialog__header">
            <h2>${clientText(this.locale, "catalog.arena.ranking.searchResults", "Matching players")}</h2>
          </header>
          <div class="song-ranking__progress" aria-hidden=${this.searching ? nothing : "true"}>
            ${
              this.searching
                ? html`
                    <md-linear-progress
                      indeterminate
                      aria-label=${this.label("loading", "Loading ranking")}
                    ></md-linear-progress>
                  `
                : nothing
            }
          </div>
          <div class="dialog__body">
            <ul class="list">
              ${this.searchMatches.map(
                (row) => html`
                  <li>
                    <button
                      class="list-item list-item--two-line list-item--interactive"
                      type="button"
                      @click=${() => this.jump(row.rank)}
                    >
                      <span class="list-item__leading" aria-label=${this.label("rank", "Rank")}>
                        ${row.rank.toLocaleString(this.locale)}
                      </span>
                      <span class="list-item__body">
                        <span class="list-item__headline">
                          ${row.name || this.label("privatePlayer", "Unknown player")}
                        </span>
                        <span class="list-item__supporting">${row.profileId || "—"}</span>
                      </span>
                      <span class="list-item__trailing">${icon("arrow_forward")}</span>
                    </button>
                  </li>
                `,
              )}
            </ul>
          </div>
          <footer class="dialog__actions">
            ${
              this.nextSearchCursor
                ? html`
                    <button
                      class="button button--tonal"
                      type="button"
                      ?disabled=${this.searching}
                      @click=${() => void this.search(this.query.trim(), this.nextSearchCursor!)}
                    >
                      ${clientText(this.locale, "catalog.arena.ranking.next", "Next 100")}
                    </button>
                  `
                : nothing
            }
            <button class="button button--text" type="button" @click=${close}>
              ${clientText(this.locale, "common.actions.close", "Close")}
            </button>
          </footer>
        </div>
      </dialog>
    `;
  }

  private renderTimestamp() {
    const cached = this.cache.get(this.rankingUrl(this.region));
    const value = cached?.reportedAt || 0;
    const text = this.formatTime(this.region);
    const label = `${this.label(cached?.provider === "official" ? "observed" : "updated", "Updated")} ${text}`;
    return html`
      <time
        class="ranking-timestamp"
        datetime=${value ? new Date(value).toISOString() : nothing}
        title=${label}
        aria-label=${label}
        aria-hidden=${value ? nothing : "true"}
      >
        ${
          text ||
          (this.phase === "loading"
            ? html`
                <span class="skeleton-line" aria-hidden="true">00/00 00:00</span>
              `
            : "—")
        }
      </time>
    `;
  }

  private renderControls() {
    if (this.limit)
      return html`
        <div class="ranking-summary-heading row row--between">
          ${this.summaryHeading}
          <span class="ranking-status">${this.renderTimestamp()}${this.summaryActions}</span>
        </div>
      `;
    const maximum = this.windowed ? this.cache.get(this.rankingUrl(this.region))?.maxRank : this.rows.length;
    const t = (key: string, fallback: string) => clientText(this.locale, `catalog.arena.ranking.${key}`, fallback);
    return html`
      <div class="ranking-controls">
        <div class="ranking-search cluster">
          <form
            class="ranking-jump ranking-jump--rank"
            @submit=${(event: SubmitEvent) => {
              event.preventDefault();
              const rank = Number(new FormData(event.currentTarget as HTMLFormElement).get("rank"));
              if (Number.isSafeInteger(rank) && rank > 0) this.jump(rank);
            }}
          >
            <label class="field">
              <input
                name="rank"
                type="number"
                inputmode="numeric"
                min="1"
                max=${maximum || nothing}
                step="1"
                required
                placeholder=${this.label("rank", "Rank")}
                aria-label=${t("jump", "Go to rank")}
              />
            </label>
            <button
              class="icon-button icon-button--tonal"
              type="submit"
              aria-label=${t("go", "Go")}
              title=${t("go", "Go")}
            >
              ${icon("arrow_forward")}
            </button>
          </form>
          <form
            class="ranking-jump"
            @submit=${(event: SubmitEvent) => {
              event.preventDefault();
              const value = String(new FormData(event.currentTarget as HTMLFormElement).get("query") ?? "").trim();
              if (value && !this.searching) void this.search(value);
            }}
          >
            <label class="field">
              <input
                name="query"
                type="search"
                maxlength="100"
                required
                .value=${this.query}
                placeholder=${t("playerSearch", "Player ID or username")}
                aria-label=${t("playerSearch", "Player ID or username")}
                @input=${(event: InputEvent) => {
                  this.query = (event.target as HTMLInputElement).value;
                  this.searchRequests.cancel();
                  this.searching = false;
                }}
              />
            </label>
            <button
              class="button button--tonal"
              type="submit"
              ?disabled=${this.searching || (!this.windowed && this.phase !== "ready")}
            >
              ${icon("search")}${t("find", "Find")}
            </button>
          </form>
        </div>
        <div class="ranking-secondary">
          ${
            this.windowed
              ? html`
                  <span class="ranking-pagination">
                    <span class="ranking-top">
                      ${iconButton({ icon: "first_page", label: t("top", "Top"), disabled: this.start === 1, onClick: () => this.moveWindow(1) })}
                    </span>
                    ${iconButton({ icon: "chevron_left", label: t("previous", "Previous 100"), disabled: this.start === 1, onClick: () => this.moveWindow(Math.max(1, this.start - 100)) })}
                    <span class="ranking-window md-body-medium">
                      ${this.start.toLocaleString(this.locale)}–${Math.min(this.start + 99, maximum ?? Infinity).toLocaleString(this.locale)}
                      / ${maximum?.toLocaleString(this.locale) ?? "—"}
                    </span>
                    ${iconButton({ icon: "chevron_right", label: t("next", "Next 100"), disabled: maximum != null && this.start + 100 > maximum, onClick: () => this.moveWindow(this.start + 100) })}
                  </span>
                `
              : nothing
          }
          <span class="ranking-status">
            ${this.renderTimestamp()}
            ${iconButton({ icon: "refresh", label: this.label("refresh", "Refresh ranking"), disabled: this.phase === "loading" || Date.now() < this.retryAt, onClick: () => this.refresh() })}
          </span>
        </div>
      </div>
    `;
  }

  public refreshRanking() {
    this.refresh();
  }

  render() {
    const loading = this.phase === "loading" || this.searching;
    return html`
      <section class="song-ranking-page" aria-label=${this.boardTitle}>
        <div class="song-ranking__progress" aria-hidden=${loading ? nothing : "true"}>
          ${
            loading
              ? html`
                  <md-linear-progress
                    indeterminate
                    aria-label=${this.label("loading", "Loading ranking")}
                  ></md-linear-progress>
                `
              : nothing
          }
        </div>
        ${this.renderControls()} ${this.renderRanking()} ${this.renderMatches()}
      </section>
    `;
  }
}
if (!customElements.get("song-ranking")) customElements.define("song-ranking", SongRanking);
