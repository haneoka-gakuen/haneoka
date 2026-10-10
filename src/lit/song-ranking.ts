import { GameRecordsCardsElement } from "./shared/game-records-cards";
import { playerProfileHref, validPlayerProfileId } from "../lib/player-profile-route";
import { navigateDetailPage } from "../lib/detail-navigation";
import "@material/web/progress/linear-progress.js";
import { html, nothing, type PropertyValues } from "lit";
import { preferredLocale, fetchJson, JsonResponseError } from "./shared/catalog";
import type { ReleaseServer } from "../lib/release-server";
import { RequestScope } from "../lib/request-scope";
import { icon } from "./ui/icon";
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
  moenotesBrand,
} from "./shared/game-records";

import type { GameRecordsRegion, GameRankingDto, SongRankingRowDto, GameRecordsErrorDto } from "../lib/game-records";
type Region = GameRecordsRegion;
type Phase = "idle" | "loading" | "ready" | "error";

type RankingEntry = SongRankingRowDto;
interface RankingCache {
  rows: RankingEntry[];
  storedAt: number;
  reportedAt: number;
  stale: boolean;
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
    rankingTitle: { type: String, attribute: "ranking-title" },
    cardCatalogData: { attribute: false },
    region: { state: true },
    phase: { state: true },
    rows: { state: true },
    stale: { state: true },
    expanded: { state: true },
  };

  declare locale: string;
  declare server: ReleaseServer;
  declare songId: string;
  declare rankingEndpoint: string;
  declare embedded: boolean;
  declare points: boolean;
  declare rankingTitle: string;
  declare cardCatalogData: Partial<Record<"jp" | "intl", RankingCardCatalog>> | undefined;
  declare region: Region;
  declare phase: Phase;
  declare rows: RankingEntry[];
  declare stale: boolean;
  declare expanded: boolean;

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
    this.rankingTitle = "";
    this.region = "tw";
    this.phase = "idle";
    this.rows = [];
    this.stale = false;
    this.expanded = false;
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
    super.connectedCallback();
    this.lifetime = new AbortController();
    addEventListener("haneoka:locale-ready", this.onLocale, { signal: this.lifetime.signal });
    this.initializePage();
  }

  disconnectedCallback() {
    this.rankingRequests.cancel();
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

  private rankingUrl(region: Region) {
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
      return;
    }
    const endpoint = this.rankingUrl(region);
    const signal = this.rankingRequests.begin();
    this.rows = cached?.rows || [];
    this.phase = "loading";
    this.stale = Boolean(cached);
    try {
      const value = await fetchJson<GameRankingDto>(endpoint, {
        signal,
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!this.currentRanking(signal, region, endpoint)) return;
      const entry = {
        rows: value.rows.slice(0, 100),
        storedAt: Date.now(),
        reportedAt: value.fetchedAtMs ?? 0,
        stale: value.stale,
      };
      this.cache.set(endpoint, entry);
      if (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value!);
      this.rows = entry.rows;
      this.phase = "ready";
      this.stale = entry.stale;
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

  private refresh() {
    if (Date.now() < this.retryAt) return;
    this.rankingRequests.cancel();
    void this.loadRanking(this.region, true);
  }

  private formatTime(region: Region) {
    const cached = this.cache.get(this.rankingUrl(region));
    const value = cached?.reportedAt || 0;
    if (!value) return "";
    return new Intl.DateTimeFormat(this.locale, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
  }

  private renderPageActions() {
    return html`
      ${gameRecordsRegionPicker(this.locale, this.region, (region) => this.selectRegion(region))}
      ${iconButton({ label: this.label("refresh", "Refresh ranking"), icon: "refresh", disabled: this.phase === "loading" || Date.now() < this.retryAt, onClick: () => this.refresh() })}
    `;
  }

  private renderRow(entry: RankingEntry) {
    const name = entry.name || this.label("privatePlayer", "Unknown player");
    const favorite = this.cardArtwork(entry.favoriteMemberCardId, false);
    const image = entry.profileCard?.thumbnailUrls[0] || "";
    const cardTitle = [
      entry.profileCard?.name,
      entry.profileCard?.slot != null
        ? this.label("profileCardSlot", "Slot {slot}").replace("{slot}", String(entry.profileCard.slot))
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const level = this.levelFromExp(this.sourceCatalog()?.playerLevels, entry.rankExp);
    const identity = html`
      <strong>${name}</strong>
      <small class="song-ranking__player-stats">
        ${
          level != null
            ? html`
                <span>${this.label("cardLevel", "Lv. {level}").replace("{level}", String(level))}</span>
              `
            : nothing
        }
        ${
          entry.totalPower != null
            ? html`
                <span>${this.label("power", "Power")} ${this.formatScore(entry.totalPower)}</span>
              `
            : nothing
        }
      </small>
    `;
    return html`
      <li class="song-ranking__entry">
        <div class=${`song-ranking__row${this.points ? " song-ranking__row--points" : ""}`}>
          <span class="song-ranking__rank" aria-label=${`${this.label("rank", "Rank")} ${entry.rank}`}>
            ${entry.rank}
          </span>
          ${
            image
              ? html`
                  <a
                    class="song-ranking__namecard"
                    href=${image}
                    target="_blank"
                    rel="noopener"
                    title=${cardTitle}
                    aria-label=${cardTitle || this.label("profileCard", "Profile card")}
                  >
                    ${this.profileMedia(name, image)}
                  </a>
                `
              : html`
                  <span
                    class="song-ranking__namecard song-ranking__namecard--empty"
                    aria-label=${this.label("noProfileCard", "No profile card")}
                  >
                    ${icon("badge", 24)}
                  </span>
                `
          }
          <span class="song-ranking__avatar">
            ${
              favorite?.avatar
                ? this.profileMedia(name, favorite.avatar)
                : html`
                    <span class="song-ranking__initial" aria-hidden="true">${this.initials(name)}</span>
                  `
            }
          </span>
          ${
            entry.profileId
              ? html`
                  <a
                    class="song-ranking__player-copy state-layer"
                    href=${playerProfileHref(this.locale, this.region, entry.profileId, this.rankingUrl(this.region), navigationDocumentUrl())}
                    data-profile-id=${entry.profileId}
                  >
                    ${identity}
                  </a>
                `
              : html`
                  <span class="song-ranking__player-copy">${identity}</span>
                `
          }
          <span
            class="song-ranking__score"
            aria-label=${`${this.points ? this.label("points", "Points") : this.label("score", "Score")} ${this.formatScore(entry.score)}`}
          >
            <strong>${this.formatScore(entry.score)}</strong>
            ${
              entry.tied
                ? html`
                    <small>${this.label("tied", "Tied rank")}</small>
                  `
                : nothing
            }
          </span>
          ${
            this.points
              ? nothing
              : html`
                  <span class="song-ranking__deck-preview" aria-label=${this.label("cards", "Cards")}>
                    ${entry.cards.map(
                      (card) => html`
                        <span class="song-ranking__deck-slot">
                          ${this.renderCard(card)}${
                    card.supportCardId != null
                      ? this.renderCard(card, true)
                      : html`
                          <span
                            class="song-ranking__card-media song-ranking__card-media--support song-ranking__card-empty"
                            aria-label=${this.label("noSupportCard", "No support card")}
                          ></span>
                        `
                  }
                        </span>
                      `,
                    )}
                  </span>
                `
          }
        </div>
      </li>
    `;
  }
  /**
   * The first page of a ranking is always 20 rows, so while it loads the
   * list is drawn as 20 placeholder rows built from the same grid, media
   * boxes and text lines as a real row: when the data arrives every row
   * fills in place and nothing below the list moves.
   */
  private renderSkeleton() {
    const rows = Array.from({ length: 20 });
    return html`
      <ol class="song-ranking__list song-ranking__list--skeleton" aria-busy="true" aria-label=${this.label("loading", "Loading ranking")}>
        ${rows.map(
          () => html`
            <li class="song-ranking__entry" aria-hidden="true">
              <div class=${`song-ranking__row${this.points ? " song-ranking__row--points" : ""}`}>
                <span class="song-ranking__rank"><span class="skeleton-line">00</span></span>
                <span class="song-ranking__namecard song-ranking__namecard--empty"></span>
                <span class="song-ranking__avatar"><span class="song-ranking__initial"></span></span>
                <span class="song-ranking__player-copy">
                  <strong><span class="skeleton-line">\u00a0</span></strong>
                  <small class="song-ranking__player-stats"><span class="skeleton-line">\u00a0</span></small>
                </span>
                <span class="song-ranking__score"><strong><span class="skeleton-line">00,000,000</span></strong></span>
                ${
                  this.points
                    ? nothing
                    : html`
                        <span class="song-ranking__deck-preview">
                          ${[0, 1, 2, 3, 4].map(
                            () => html`
                              <span class="song-ranking__deck-slot">
                                <span class="song-ranking__card"><span class="song-ranking__card-media"></span></span>
                                <span class="song-ranking__card"><span class="song-ranking__card-media song-ranking__card-media--support"></span></span>
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
      <span class="button button--tonal song-ranking__more song-ranking__more--placeholder" aria-hidden="true">
        ${this.label("showMore", "Show top 100")}
      </span>
      ${loadingState(this.label("loading", "Loading ranking"))}
    `;
  }

  private renderRanking() {
    const cached = this.cache.get(this.rankingUrl(this.region));
    const visible = this.rows.slice(0, this.expanded ? 100 : 20);
    const showMore = this.rows.length > 20 && !this.expanded;
    const failed = this.rankingFailure?.kind;
    const failureText =
      failed === "pending"
        ? this.label("pending", "Ranking is being collected. Try again in {seconds}s.").replace(
            "{seconds}",
            String(Math.max(0, Math.ceil((this.retryAt - Date.now()) / 1000))),
          )
        : failed === "timeout"
          ? this.label("timeout", "The ranking request timed out.")
          : this.label("error", "Ranking unavailable");
    return html`
      <div class="song-ranking__content">
        <div class="song-ranking__meta">
          ${
            cached && cached.reportedAt > 0
              ? html`
                  <p class="song-ranking__fetched" role="status">
                    ${this.stale ? this.label("stale", "Showing cached results") : this.label("updated", "Updated")}${this.formatTime(this.region) ? ` · ${this.formatTime(this.region)}` : ""}
                  </p>
                `
              : this.phase === "loading" && !this.rows.length
                ? html`<p class="song-ranking__fetched" aria-hidden="true"><span class="skeleton-line">${this.label("updated", "Updated")} · 00/00/0000, 00:00:00</span></p>`
                : nothing
          }
          ${this.embedded ? nothing : moenotesBrand()}
        </div>
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
                    ${
                      this.phase === "error"
                        ? html`
                            <div class="song-ranking__notice song-ranking__notice--error" role="alert">
                              <span>${failureText}</span>
                              <button class="button button--text" type="button" @click=${() => this.refresh()}>
                                ${this.label("retry", "Retry")}
                              </button>
                            </div>
                          `
                        : nothing
                    }
                    <ol
                      class="song-ranking__list"
                      aria-label=${this.rankingTitle || this.label("title", "Song ranking")}
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

  updated(changed: PropertyValues) {
    if (changed.has("cardCatalogData") && this.cardCatalogData) this.cardCatalogs = this.cardCatalogData;
    if (
      this.embedded &&
      ((changed.has("rankingEndpoint") && changed.get("rankingEndpoint") !== undefined) ||
        (changed.has("region") && changed.get("region") !== undefined))
    ) {
      this.rankingRequests.cancel();
      this.expanded = false;
      void this.loadRanking(this.region);
    }
    if (!this.embedded) setAppBarActions(this.pageAppBarOwner, this.renderPageActions(), this);
  }

  public refreshRanking() {
    this.refresh();
  }

  render() {
    const loading = this.phase === "loading";
    return html`
      <section class="song-ranking-page" aria-label=${this.rankingTitle || this.label("title", "Song ranking")}>
        <div class="song-ranking__progress" aria-hidden=${loading ? nothing : "true"}>
          ${
   loading
     ? html`
         <md-linear-progress indeterminate aria-label=${this.label("loading", "Loading ranking")}></md-linear-progress>
       `
     : nothing
 }
        </div>
        ${this.renderRanking()}
      </section>
    `;
  }
}
if (!customElements.get("song-ranking")) customElements.define("song-ranking", SongRanking);
