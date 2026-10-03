import "@material/web/progress/linear-progress.js";
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { live } from "lit/directives/live.js";
import type { GalleryImage } from "./ui/image-gallery";
import { clientText } from "../i18n/client";
import { preferredLocale, fetchJson, JsonResponseError } from "./shared/catalog";
import type { ReleaseServer } from "../lib/release-server";
import { RequestScope } from "../lib/request-scope";
import { downloadBlob } from "../lib/canvas-capture";
import { icon } from "./ui/icon";
import { iconButton } from "./ui/controls";
import "../styles/settings.css";
import type { Locale } from "../i18n/locales";
import { readPageData } from "../lib/page-data";
import { navigationDocumentUrl } from "../lib/document-url";
import { entityReturnHref } from "../lib/detail-navigation";
import { localizedText } from "./shared/catalog";
import { resourcePath } from "../lib/resource-route";
import type { RankingCardCatalog, RankingCardArtwork } from "../lib/game-records";
import { emptyState, errorState, loadingState } from "./ui/state";
import { clearAppBarActions, clearAppBarSearch, setAppBarActions, setAppBarSearch } from "../lib/app-bar";
import {
  GAME_RECORDS_REGIONS as REGIONS,
  defaultGameRecordsRegion as defaultRegion,
  gameRecordsRegionPicker,
  moenotesBrand,
} from "./shared/game-records";

import type {
  GameRecordsRegion,
  GameProfileCardPageDto,
  GameRankingDto,
  SongRankingRowDto,
  PlayerProfileDto,
  GameRecordsErrorDto,
} from "../lib/game-records";
type Region = GameRecordsRegion;
type View = "ranking" | "profile";
type Phase = "idle" | "loading" | "ready" | "error";

type RankingEntry = SongRankingRowDto;
type PlayerProfile = PlayerProfileDto["profile"];
interface RankingCache {
  rows: RankingEntry[];
  storedAt: number;
  reportedAt: number;
  stale: boolean;
}

const CACHE_TTL = 5 * 60 * 1000;
let pageAppBarOwnerSequence = 0;

export class SongRanking extends LitElement {
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
    view: { state: true },
    phase: { state: true },
    rows: { state: true },
    stale: { state: true },
    expanded: { state: true },
    profilePhase: { state: true },
    profile: { state: true },
    profileImageId: { state: true },
    profileImageDownloading: { state: true },
    profileImageError: { state: true },
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
  declare view: View;
  declare phase: Phase;
  declare rows: RankingEntry[];
  declare stale: boolean;
  declare expanded: boolean;
  declare profilePhase: Phase | "unavailable";
  declare profile: PlayerProfile | null;
  declare profileImageId: string;
  declare profileImageDownloading: boolean;
  declare profileImageError: boolean;

  private rankingRequests = new RequestScope();
  private profileRequests = new RequestScope();
  private profileDownloads = new RequestScope();
  private lifetime?: AbortController;
  private cardCatalogs: Partial<Record<"jp" | "intl", RankingCardCatalog>> = {};
  private cache = new Map<string, RankingCache>();
  private selectedEntry: RankingEntry | null = null;
  private selectedProfileId = "";
  private profileQuery = "";
  private rankingFailure: GameRecordsErrorDto["error"] | null = null;
  private retryAt = 0;
  private retryTimer = 0;
  private readyImages = new Set<string>();
  private failedImages = new Set<string>();
  private readonly pageAppBarOwner = `song-ranking-page-${++pageAppBarOwnerSequence}`;
  private pageBackLink?: HTMLAnchorElement;
  private pageBackHref = "";
  private rankingScrollTop = 0;

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
    this.view = "ranking";
    this.phase = "idle";
    this.rows = [];
    this.stale = false;
    this.expanded = false;
    this.profilePhase = "idle";
    this.profile = null;
    this.profileImageId = "";
    this.profileImageDownloading = false;
    this.profileImageError = false;
  }

  private initializePage() {
    this.cardCatalogs = this.cardCatalogData || readPageData<typeof this.cardCatalogs>(this) || this.cardCatalogs;
    const requested = navigationDocumentUrl().searchParams.get("region");
    if (!this.embedded)
      this.region = REGIONS.some((option) => option.value === requested)
        ? (requested as Region)
        : defaultRegion(this.server, this.locale);
    this.phase = "loading";
    void this.loadRanking(this.region, true);
    const profileId = navigationDocumentUrl().searchParams.get("profileId");
    if (!this.embedded && profileId && /^[1-9][0-9]{0,18}$/u.test(profileId))
      void this.openProfileById(profileId);
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.lifetime = new AbortController();
    addEventListener("haneoka:locale-ready", this.onLocale, { signal: this.lifetime.signal });
    this.initializePage();
  }

  disconnectedCallback() {
    this.rankingRequests.cancel();
    this.profileRequests.cancel();
    this.resetProfileImage();
    this.lifetime?.abort();
    this.lifetime = undefined;
    window.clearTimeout(this.retryTimer);
    this.pageBackLink?.removeEventListener("click", this.onPageBackClick);
    this.pageBackLink = undefined;
    clearAppBarActions(this.pageAppBarOwner);
    clearAppBarSearch(this.pageAppBarOwner);
    super.disconnectedCallback();
  }

  private onLocale = () => {
    this.locale = preferredLocale(this.locale);
    this.requestUpdate();
  };

  private label(key: string, fallback: string) {
    return clientText(this.locale, `songRanking.${key}`, fallback);
  }

  private rankingUrl(region: Region) {
    return this.rankingEndpoint || `/api/v1/game/records/${region}/songs/${encodeURIComponent(this.songId)}/ranking`;
  }

  private profileUrl(region: Region, profileId: string) {
    return `/api/v1/game/records/${region}/players/${encodeURIComponent(profileId)}`;
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
    this.view = "ranking";
    this.profileRequests.cancel();
    this.resetProfileImage();
    this.profile = null;
    this.selectedEntry = null;
    this.selectedProfileId = "";
    this.profileQuery = "";
    this.profilePhase = "idle";
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

  private refreshCurrent() {
    if (this.view === "profile") {
      if (this.selectedProfileId && this.profilePhase !== "loading")
        void this.openProfileById(this.selectedProfileId, this.selectedEntry);
      return;
    }
    this.refresh();
  }

  private async openProfile(entry: RankingEntry) {
    if (!entry.profileId) return;
    return this.openProfileById(entry.profileId, entry);
  }

  private async openProfileById(profileId: string, entry: RankingEntry | null = null) {
    this.rankingScrollTop = document.querySelector<HTMLElement>("#main-content")?.scrollTop || 0;
    const signal = this.profileRequests.begin();
    this.resetProfileImage();
    this.view = "profile";
    this.selectedEntry = entry;
    this.selectedProfileId = profileId;
    this.profileQuery = profileId;
    if (!this.embedded) {
      const url = new URL(navigationDocumentUrl());
      url.searchParams.set("region", this.region);
      url.searchParams.set("profileId", profileId);
      if (url.pathname === location.pathname) history.replaceState(history.state, "", url);
    }
    this.profile = null;
    this.profilePhase = "loading";
    try {
      const value = await fetchJson<PlayerProfileDto>(this.profileUrl(this.region, profileId), {
        signal,
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!this.isConnected || this.view !== "profile" || !this.profileRequests.current(signal)) return;
      this.profile = value.profile;
      this.selectedProfileId = value.profileId;
      const pages = this.profilePages();
      this.profileImageId = pages.length ? String(pages[0].page) : "";
      if (pages.length) void import("./ui/image-gallery");
      this.profilePhase = "ready";
    } catch (error) {
      if (!this.isConnected || this.view !== "profile" || !this.profileRequests.current(signal)) return;
      this.profilePhase =
        error instanceof JsonResponseError && (error.status === 403 || error.status === 404)
          ? "unavailable"
          : "error";
    }
  }

  private backToRanking() {
    this.profileRequests.cancel();
    this.resetProfileImage();
    this.view = "ranking";
    this.profile = null;
    this.selectedEntry = null;
    this.selectedProfileId = "";
    this.profilePhase = "idle";
    if (!this.embedded) {
      const url = new URL(location.href);
      url.searchParams.delete("profileId");
      history.replaceState(history.state, "", url);
    }
    void this.updateComplete.then(() => {
      requestAnimationFrame(() => {
        const main = document.querySelector<HTMLElement>("#main-content");
        if (main && this.isConnected && this.view === "ranking") main.scrollTop = this.rankingScrollTop;
      });
    });
  }

  private formatScore(value: number | null) {
    return value === null ? "—" : value.toLocaleString(this.locale);
  }

  private formatTime(region: Region) {
    const cached = this.cache.get(this.rankingUrl(region));
    const value = cached?.reportedAt || 0;
    if (!value) return "";
    return new Intl.DateTimeFormat(this.locale, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
  }

  private initials(name: string) {
    const value = name.trim();
    return Array.from(value || "?")
      .slice(0, 2)
      .join("")
      .toLocaleUpperCase(this.locale);
  }

  private profileMedia(name: string, image: string) {
    return image
      ? html`
          <span
            class=${live(`song-ranking__player-media${this.failedImages.has(image) ? " is-error" : this.readyImages.has(image) ? " is-loaded" : ""}`)}
          >
            ${
              !this.readyImages.has(image)
                ? html`
                    <md-circular-progress
                      indeterminate
                      aria-label=${this.label("loading", "Loading")}
                    ></md-circular-progress>
                  `
                : nothing
            }
            <img
              src=${image}
              alt=""
              loading="lazy"
              decoding="async"
              @load=${(event: Event) => {
                this.readyImages.add(image);
                this.failedImages.delete(image);
                const media = (event.currentTarget as HTMLImageElement).parentElement;
                media?.classList.remove("is-error");
                media?.classList.add("is-loaded");
              }}
              @error=${(event: Event) => {
                this.failedImages.add(image);
                (event.currentTarget as HTMLImageElement).parentElement?.classList.add("is-error");
              }}
            />
          </span>
        `
      : html`
          <span class="song-ranking__initial" aria-hidden="true">${this.initials(name)}</span>
        `;
  }

  private renderPageActions() {
    return html`
      ${gameRecordsRegionPicker(this.locale, this.region, (region) => this.selectRegion(region))}
      ${iconButton({
        label:
          this.view === "profile"
            ? clientText(this.locale, "refresh", "Refresh")
            : this.label("refresh", "Refresh ranking"),
        icon: "refresh",
        disabled:
          this.view === "profile"
            ? this.profilePhase === "loading"
            : this.phase === "loading" || Date.now() < this.retryAt,
        onClick: () => this.refreshCurrent(),
      })}
    `;
  }

  private onPageBackClick = (event: MouseEvent) => {
    if (this.view !== "profile") return;
    event.preventDefault();
    event.stopPropagation();
    this.backToRanking();
  };

  private syncPageChrome() {
    const back = document.querySelector<HTMLAnchorElement>("[data-entity-back]");
    if (back && back !== this.pageBackLink) {
      this.pageBackLink?.removeEventListener("click", this.onPageBackClick);
      this.pageBackLink = back;
      this.pageBackHref = entityReturnHref() || back.href;
      back.addEventListener("click", this.onPageBackClick);
    }
    if (back) {
      if (this.view === "profile") {
        back.href = "#ranking";
        back.setAttribute("aria-label", this.label("back", "Back"));
      } else {
        back.href = entityReturnHref() || this.pageBackHref;
        back.setAttribute("aria-label", clientText(this.locale, "back", "Back"));
      }
    }
    setAppBarActions(this.pageAppBarOwner, this.renderPageActions(), this);
    const pattern =
      this.region === "jp"
        ? "[1-9][0-9]{0,18}"
        : `[${this.region === "tw" ? "2" : this.region === "en" ? "3" : "4"}][0-9]{10}`;
    setAppBarSearch(this.pageAppBarOwner, {
      value: this.profileQuery,
      label: this.label("profileSearch", "Player profile ID"),
      onInput: (value) => {
        this.profileQuery = value;
      },
      onSubmit: (value) => {
        const profileId = value.trim();
        if (new RegExp(`^${pattern}$`, "u").test(profileId)) void this.openProfileById(profileId);
      },
    });
    const search = document.querySelector<HTMLInputElement>(
      `[data-app-bar-search-owner="${this.pageAppBarOwner}"] input`,
    );
    if (search) {
      search.inputMode = "numeric";
      search.maxLength = this.region === "jp" ? 19 : 11;
      search.pattern = pattern;
      search.required = true;
    }
  }

  private cardArtwork(cardId: number | null, support: boolean) {
    if (cardId == null) return undefined;
    const source = this.region === "jp" ? "jp" : "intl";
    const preferred = this.cardCatalogs[source];
    const fallback = this.cardCatalogs[source === "jp" ? "intl" : "jp"];
    const key = support ? "support" : "member";
    return preferred?.[key][String(cardId)] || fallback?.[key][String(cardId)];
  }

  private sourceCatalog() {
    return this.cardCatalogs[this.region === "jp" ? "jp" : "intl"];
  }
  private levelFromExp(rows: Array<{ level: number; exp: number }> | undefined, exp: number | null) {
    if (exp == null || !rows?.length) return null;
    let level = 1;
    for (const row of rows) {
      if (row.exp > exp) break;
      level = row.level;
    }
    return level;
  }
  private cardLevel(artwork: RankingCardArtwork, card: RankingEntry["cards"][number], support: boolean) {
    const catalog = this.cardCatalogs[artwork.server];
    const level = this.levelFromExp(
      catalog?.levels[support ? "support" : "member"][String(artwork.levelGroup)],
      support ? card.supportExp : card.memberExp,
    );
    const cap = support
      ? catalog?.supportLimits[`${artwork.rankGroup}:${card.supportRank ?? 1}`]
      : catalog?.memberLimits[`${artwork.rarity}:${card.memberAwakeCount ?? 1}`];
    return level == null ? null : cap ? Math.min(level, cap) : level;
  }
  private renderCard(card: RankingEntry["cards"][number], support = false) {
    const id = support ? card.supportCardId : card.memberCardId;
    const artwork = this.cardArtwork(id, support);
    const name = artwork ? localizedText(artwork.name, this.locale) : this.label("unavailableCard", "Card unavailable");
    const level = artwork ? this.cardLevel(artwork, card, support) : null;
    const body = html`
      <span class=${`song-ranking__card-media${support ? " song-ranking__card-media--support" : ""}`}>
        ${artwork?.image ? this.profileMedia(name, artwork.image) : icon("broken_image", 24)}
        ${
          artwork?.attributeIcon
            ? html`
                <img class="song-ranking__card-attribute" src=${artwork.attributeIcon} alt="" />
              `
            : nothing
        }
        ${
          artwork?.rarityIcon
            ? html`
                <img class="song-ranking__card-rarity" src=${artwork.rarityIcon} alt="" />
              `
            : nothing
        }
        ${
          level != null
            ? html`
                <span class="song-ranking__card-level">
                  ${this.label("cardLevel", "Lv. {level}").replace("{level}", String(level))}
                </span>
              `
            : nothing
        }
      </span>
    `;
    return artwork
      ? html`
          <a
            class="song-ranking__card"
            href=${resourcePath({ server: artwork.server, locale: this.locale as Locale, kind: support ? "support-cards" : "member-cards", id: String(id) })}
            aria-label=${name}
            title=${name}
          >
            ${body}
          </a>
        `
      : html`
          <span class="song-ranking__card" aria-label=${name}>${body}</span>
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
                  <button
                    class="song-ranking__player-copy state-layer"
                    type="button"
                    data-profile-id=${entry.profileId}
                    @click=${() => void this.openProfile(entry)}
                  >
                    ${identity}
                  </button>
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
        ${
          this.stale
            ? html`
                <p class="song-ranking__notice song-ranking__notice--stale" role="status">
                  ${this.label("stale", "Showing cached results")}
                </p>
              `
            : nothing
        }
        <div class="song-ranking__meta">
          ${
            cached && cached.reportedAt > 0
              ? html`
                  <p class="song-ranking__fetched" role="status">
                    ${this.label("updated", "Updated")}${this.formatTime(this.region) ? ` · ${this.formatTime(this.region)}` : ""}
                  </p>
                `
              : nothing
          }
          ${this.embedded ? nothing : moenotesBrand()}
        </div>
        ${
          this.phase === "error" && !this.rows.length
            ? errorState(failureText, this.label("retry", "Retry"), () => this.refresh())
            : this.phase === "loading" && !this.rows.length
              ? loadingState(this.label("loading", "Loading ranking"))
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

  private resetProfileImage() {
    this.profileDownloads.cancel();
    this.profileImageId = "";
    this.profileImageDownloading = false;
    this.profileImageError = false;
  }

  private profilePages(): Array<GameProfileCardPageDto & { imageUrl: string }> {
    const card = this.profile?.profileCard;
    const pages = card?.pages ?? card?.thumbnailUrls.map((imageUrl, index) => ({ page: index + 1, imageUrl, sourceUrl: imageUrl })) ?? [];
    return pages.filter((page): page is GameProfileCardPageDto & { imageUrl: string } => Boolean(page.imageUrl));
  }

  private async downloadProfileImage() {
    const page = this.profilePages().find((page) => String(page.page) === this.profileImageId);
    if (!page?.downloadUrl || this.profileImageDownloading) return;
    const signal = this.profileDownloads.begin();
    this.profileImageDownloading = true;
    this.profileImageError = false;
    try {
      const response = await fetch(page.downloadUrl, {
        credentials: "omit",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) throw new Error("Image download failed");
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) throw new Error("Image download failed");
      if (!this.isConnected || !this.profileDownloads.current(signal)) return;
      const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" } as Record<string, string>)[blob.type] || "image";
      await downloadBlob(blob, `profile-${this.selectedProfileId}-${page.page}.${extension}`);
    } catch {
      if (this.isConnected && this.profileDownloads.current(signal)) this.profileImageError = true;
    } finally {
      if (this.profileDownloads.current(signal)) this.profileImageDownloading = false;
    }
  }

  private profileFact(label: string, value: unknown) {
    return value == null || value === ""
      ? nothing
      : html`
          <div>
            <dt>${label}</dt>
            <dd>${value}</dd>
          </div>
        `;
  }

  private renderProfile() {
    if (this.profilePhase === "loading") return loadingState(this.label("loading", "Loading ranking"));
    if (this.profilePhase === "unavailable")
      return emptyState({ title: this.label("profileUnavailable", "Profile unavailable"), icon: "person_off" });
    if (this.profilePhase === "error")
      return errorState(
        this.label("profileUnavailable", "Profile unavailable"),
        this.label("retry", "Retry"),
        () => this.selectedProfileId && void this.openProfileById(this.selectedProfileId, this.selectedEntry),
      );
    const profile = this.profile;
    if (!profile) return nothing;
    const name = profile.name || this.label("privatePlayer", "Unknown player");
    const favorite = profile.favoriteMemberCard;
    const favoriteId = profile.favoriteMemberCardMasterId ?? (favorite?.cardId == null ? null : String(favorite.cardId));
    const catalog = this.sourceCatalog();
    const artwork = favoriteId ? catalog?.member[favoriteId] : undefined;
    const cardName = artwork ? localizedText(artwork.name, this.locale) : "";
    const cardHref =
      artwork && favoriteId
        ? resourcePath({
            server: artwork.server,
            locale: this.locale as Locale,
            kind: "member-cards",
            id: favoriteId,
          })
        : "";
    const level = profile.level ?? this.levelFromExp(this.sourceCatalog()?.playerLevels, profile.rankExp);
    const namecard = profile.profileCard;
    const images: GalleryImage[] = this.profilePages().map((page) => ({
      id: String(page.page),
      source: page.imageUrl,
      label: `${namecard?.name || this.label("profileCard", "Profile card")} · ${page.page}`,
    }));
    const favoriteLevel = artwork ? this.levelFromExp(catalog?.levels.member[String(artwork.levelGroup)], favorite?.exp ?? null) : null;
    const favoriteCap = artwork && favorite?.awakeCount != null ? catalog?.memberLimits[`${artwork.rarity}:${favorite.awakeCount}`] : null;
    const favoriteLevelDisplay = favoriteLevel == null ? null : favoriteCap ? Math.min(favoriteLevel, favoriteCap) : favoriteLevel;
    const favorites = profile.totalFavoriteExact != null && /^\d+$/.test(profile.totalFavoriteExact)
      ? BigInt(profile.totalFavoriteExact).toLocaleString(this.locale)
      : profile.totalFavorite?.toLocaleString(this.locale);
    const entry = this.selectedEntry;
    const hasFavorite = Boolean(favoriteId) || (favorite && Object.values(favorite).some((value) => value != null));
    const hasDetails = profile.rankExp != null || favorites != null || hasFavorite;
    return html`
      <div class="song-ranking__profile">
        <header class="song-ranking__profile-head">
          ${
            cardHref
              ? html`
                  <a class="song-ranking__avatar" href=${cardHref} aria-label=${cardName} title=${cardName}>
                    ${this.profileMedia(name, artwork?.avatar || "")}
                  </a>
                `
              : html`
                  <span class="song-ranking__avatar">${this.profileMedia(name, artwork?.avatar || "")}</span>
                `
          }
          <div class="song-ranking__profile-identity">
            <h2>${name}</h2>
            <p class="song-ranking__profile-id">
              ${this.label("profileSearch", "Player profile ID")} · ${this.selectedProfileId}
            </p>
            ${
              level != null
                ? html`
                    <span class="song-ranking__profile-level">
                      ${this.label("cardLevel", "Lv. {level}").replace("{level}", String(level))}
                    </span>
                  `
                : nothing
            }
          </div>
        </header>
        <div class="song-ranking__profile-layout">
          ${
            namecard && (images.length || namecard.name || namecard.slot != null)
              ? html`
                  <section class="song-ranking__profile-namecard">
                    <header class="song-ranking__profile-section-head">
                      <h3>${namecard.name || this.label("profileCard", "Profile card")}</h3>
                      ${
                    namecard.slot != null
                      ? html`
                          <span>
                            ${this.label("profileCardSlot", "Slot {slot}").replace("{slot}", String(namecard.slot))}
                          </span>
                        `
                      : nothing
                  }
                      ${images.length ? iconButton({
                        icon: "download",
                        label: clientText(this.locale, "download", "Download"),
                        disabled: this.profileImageDownloading || !this.profilePages().find((page) => String(page.page) === this.profileImageId)?.downloadUrl,
                        onClick: () => void this.downloadProfileImage(),
                      }) : nothing}
                    </header>
                    ${this.profileImageDownloading ? html`<md-linear-progress indeterminate aria-label=${clientText(this.locale, "loading", "Loading")}></md-linear-progress>` : nothing}
                    ${this.profileImageError ? html`<p role="alert">${clientText(this.locale, "unavailable", "Unavailable")}</p>` : nothing}
                    ${
                  images.length
                    ? html`
                        <image-gallery
                          natural
                          .images=${images}
                          .active=${this.profileImageId}
                          @image-change=${(event: CustomEvent<string>) => {
                            this.profileImageId = event.detail;
                            this.profileImageError = false;
                          }}
                          .locale=${this.locale}
                          .title=${this.label("profileCard", "Profile card")}
                        ></image-gallery>
                      `
                    : nothing
                }
                  </section>
                `
              : nothing
          }
          ${
            hasDetails
              ? html`
                  <div class="song-ranking__profile-details">
                    ${
              profile.rankExp != null || favorites != null
                ? html`
                    <dl class="spec-list song-ranking__profile-facts">
                      ${this.profileFact(clientText(this.locale, "exp", "EXP"), profile.rankExp?.toLocaleString(this.locale))}
                      ${this.profileFact(this.label("favorites", "Likes received"), favorites)}
                    </dl>
                  `
                : nothing
            }
                    ${
              hasFavorite
                ? html`
                    <section class="song-ranking__profile-favorite">
                      <h3>${this.label("favoriteCard", "Favorite member card")}</h3>
                      ${
                    cardHref
                      ? html`
                          <a class="song-ranking__profile-favorite-card state-layer" href=${cardHref}>
                            <span class="song-ranking__profile-favorite-art">
                              ${this.profileMedia(cardName, artwork?.image || "")}
                            </span>
                            <strong>${cardName}</strong>
                          </a>
                        `
                      : nothing
                  }
                      <dl class="spec-list song-ranking__profile-facts">
                        ${!artwork ? this.profileFact(clientText(this.locale, "cards", "Cards"), favoriteId) : nothing}
                        ${this.profileFact(clientText(this.locale, "level", "Level"), favoriteLevelDisplay)}
                        ${this.profileFact(clientText(this.locale, "exp", "EXP"), favorite?.exp?.toLocaleString(this.locale))}
                        ${this.profileFact(clientText(this.locale, "training", "Training"), favorite?.awakeCount)}
                        ${this.profileFact(clientText(this.locale, "awakening", "Awakening"), favorite?.cardRank)}
                        ${this.profileFact(clientText(this.locale, "liveSkill", "LIVE Skill"), favorite?.liveSkillLevel)}
                        ${this.profileFact(clientText(this.locale, "gekisouSkill", "Gekisou Skill"), favorite?.performanceSkillLevel)}
                      </dl>
                    </section>
                  `
                : nothing
            }
                  </div>
                `
              : nothing
          }
        </div>
        ${
          entry && (entry.deckName || entry.totalPower != null || entry.cards.length || entry.score != null)
            ? html`
                <section class="song-ranking__profile-deck">
                  <header class="song-ranking__profile-section-head">
                    <h3>${entry.deckName || this.label("deck", "Deck")}</h3>
                  </header>
                  <dl class="spec-list spec-list--split song-ranking__profile-facts">
                    ${this.profileFact(this.label("power", "Power"), entry.totalPower?.toLocaleString(this.locale))}
                    ${this.profileFact(this.points ? this.label("points", "Points") : this.label("score", "Score"), entry.score?.toLocaleString(this.locale))}
                    ${this.profileFact(this.label("rank", "Rank"), entry.rank)}
                  </dl>
                  ${
                entry.cards.length
                  ? html`
                      <div class="song-ranking__deck-cards" aria-label=${this.label("cards", "Cards")}>
                        ${entry.cards.map(
                  (card) => html`
                    <span class="song-ranking__deck-slot">
                      ${this.renderCard(card)}${card.supportCardId != null ? this.renderCard(card, true) : nothing}
                    </span>
                  `,
                )}
                      </div>
                    `
                  : nothing
              }
                </section>
              `
            : nothing
        }
        ${
          profile.lastUpdatedAtMs != null && Number.isFinite(profile.lastUpdatedAtMs)
            ? html`
                <p class="song-ranking__profile-updated">
                  ${this.label("updated", "Updated")} ·
                  <time datetime=${new Date(profile.lastUpdatedAtMs).toISOString()}>
                    ${new Intl.DateTimeFormat(this.locale, { dateStyle: "medium", timeStyle: "medium" }).format(profile.lastUpdatedAtMs)}
                  </time>
                </p>
              `
            : nothing
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
      this.profileRequests.cancel();
      this.resetProfileImage();
      this.profile = null;
      this.selectedEntry = null;
      this.selectedProfileId = "";
      this.profilePhase = "idle";
      this.view = "ranking";
      this.expanded = false;
      void this.loadRanking(this.region);
    }
    if (!this.embedded) this.syncPageChrome();
  }

  public refreshRanking() {
    if (this.view === "ranking") this.refresh();
  }

  render() {
    const loading = this.view === "ranking" ? this.phase === "loading" : this.profilePhase === "loading";
    return html`
      <section class="song-ranking-page" aria-label=${this.rankingTitle || this.label("title", "Song ranking")}>
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
        ${
          this.embedded && this.view === "profile"
            ? html`
                <button class="button button--text" type="button" @click=${() => this.backToRanking()}>
                  ${icon("arrow_back", 18)}${this.label("back", "Back")}
                </button>
              `
            : nothing
        }
        ${this.view === "profile" ? this.renderProfile() : this.renderRanking()}
      </section>
    `;
  }
}

if (!customElements.get("song-ranking")) customElements.define("song-ranking", SongRanking);
