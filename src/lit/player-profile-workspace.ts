import "@lit-labs/ssr-client/lit-element-hydrate-support.js";
import { hydrateWorkspace } from "./shared/hydrate-workspace";
import "@material/web/progress/linear-progress.js";
import { html, nothing, type PropertyValues } from "lit";
import type { GalleryImage } from "./ui/image-gallery";
import { GameRecordsCardsElement } from "./shared/game-records-cards";
import { clientText } from "../i18n/client";
import { preferredLocale, fetchJson, JsonResponseError, localizedText } from "./shared/catalog";
import { readReleaseServer } from "../lib/release-server";
import { RequestScope } from "../lib/request-scope";
import { downloadBlob } from "../lib/canvas-capture";
import { iconButton } from "./ui/controls";
import { icon } from "./ui/icon";
import type { Locale } from "../i18n/locales";
import { readPageData } from "../lib/page-data";
import { navigationDocumentUrl } from "../lib/document-url";
import { updateEntityHeading } from "../lib/detail-navigation";
import { resourcePath } from "../lib/resource-route";
import {
  playerProfileIdPattern,
  validPlayerProfileId,
  playerProfileReturn,
  playerProfileRankingEndpoint,
} from "../lib/player-profile-route";
import { emptyState, errorState } from "./ui/state";
import { clearAppBarActions, clearAppBarSearch, setAppBarActions, setAppBarSearch } from "../lib/app-bar";
import { GAME_RECORDS_REGIONS, defaultGameRecordsRegion, gameAccountRegion } from "./shared/game-records";
import "../styles/player-profile.css";
import { signedInHint } from "../lib/community-viewer";
import type { GameRecordsErrorDto,
  GameRecordsRegion,
  GameProfileCardPageDto,
  GameRankingDto,
  SongRankingRowDto,
  PlayerProfileDto,
  RankingCardCatalog,
} from "../lib/game-records";
import { snackbar } from "../lib/snackbar";
import { profileRegion } from "../lib/game-records";
import "../styles/settings.css";
import "../styles/song-ranking.css";
import { formatDate } from "../lib/date-format";
type Phase = "idle" | "loading" | "ready" | "error" | "unavailable";
let profileOwnerSequence = 0;
interface RecentPlayer {
  region: string;
  id: string;
  name: string;
}
const RECENT_PLAYERS_KEY = "haneoka.player-profile.recent.v1";
const PROFILE_RETRIES = 20;
function readRecentPlayers(): RecentPlayer[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_PLAYERS_KEY) || "[]");
    return Array.isArray(value) ? (value as RecentPlayer[]) : [];
  } catch {
    return [];
  }
}

/** Leading zeros are dropped so a pasted ID matches the stored form. */
function normalizedProfileId(value: string): string {
  const input = value.trim();
  return /^[0-9]{1,19}$/u.test(input) ? BigInt(input).toString() : input;
}
/** 11-digit IDs name their region by the first digit; other positive int64 IDs belong to JP. */
function detectedProfileRegion(id: string): GameRecordsRegion | null {
  return profileRegion(id) ?? (validPlayerProfileId("jp", id) ? "jp" : null);
}

export class PlayerProfileWorkspace extends GameRecordsCardsElement {
  static properties = {
    locale: { type: String },
    region: { state: true },
    profilePhase: { state: true },
    profile: { state: true },
    profileImageId: { state: true },
    profileImageDownloading: { state: true },
    selectedEntry: { state: true },
    queryInvalid: { state: true },
    recent: { state: true },
    linked: { state: true },
    communityOwner: { state: true },
  };
  declare profilePhase: Phase;
  declare profile: PlayerProfileDto["profile"] | null;
  declare profileImageId: string;
  declare profileImageDownloading: boolean;
  declare selectedEntry: SongRankingRowDto | null;
  declare queryInvalid: boolean;
  declare recent: RecentPlayer[];
  declare linked: RecentPlayer[];
  /** The community member who publicly linked the open profile. */
  declare communityOwner: { uid: number; name: string } | null;
  private profileRequests = new RequestScope();
  private profileDownloads = new RequestScope();
  private lifetime?: AbortController;
  private selectedProfileId = "";
  private profileQuery = "";
  private rankingEndpoint: string | null = null;
  private points = false;
  private searchInitialized = false;
  private readonly owner = `player-profile-${++profileOwnerSequence}`;
  constructor() {
    super();
    this.locale = "en";
    this.region = "tw";
    this.profilePhase = "idle";
    this.profile = null;
    this.profileImageId = "";
    this.profileImageDownloading = false;
    this.selectedEntry = null;
    this.queryInvalid = false;
    this.recent = [];
    this.linked = [];
    this.communityOwner = null;
  }
  connectedCallback() {
    const cards = readPageData<typeof this.cardCatalogs>(this);
    if (cards) this.preparePage(cards);
    super.connectedCallback();
    if (this.hasAttribute("data-prerendered")) void this.updateComplete.then(() => this.connectProfile());
    else this.connectProfile();
  }
  preparePage(cards: Partial<Record<"jp" | "intl", RankingCardCatalog>>) {
    this.cardCatalogs = cards;
    this.region = defaultGameRecordsRegion("intl", this.locale);
  }
  protected update(changed: PropertyValues) {
    if (this.hasAttribute("data-prerendered")) {
      hydrateWorkspace(this.render(), this, this.renderOptions);
      this.removeAttribute("data-prerendered");
    }
    super.update(changed);
  }
  renderStaticChrome() { this.syncChrome(true); }
  private connectProfile() {
    if (!this.isConnected) return;
    this.lifetime = new AbortController();
    this.searchInitialized = false;
    this.cardCatalogs = readPageData<typeof this.cardCatalogs>(this) || this.cardCatalogs;
    this.locale = preferredLocale(this.locale);
    const url = navigationDocumentUrl();
    const requested = url.searchParams.get("region");
    this.profileQuery = normalizedProfileId(url.searchParams.get("profileId") || "");
    const linkedRegion = GAME_RECORDS_REGIONS.find((option) => option.value === requested)?.value;
    this.region =
      detectedProfileRegion(this.profileQuery) ??
      (!this.profileQuery ? linkedRegion : null) ??
      defaultGameRecordsRegion(readReleaseServer(), this.locale);
    this.rankingEndpoint = playerProfileRankingEndpoint(url.searchParams.get("ranking"), this.region);
    this.points = Boolean(this.rankingEndpoint && /\/events\/[1-9][0-9]*\/latest$/u.test(this.rankingEndpoint));
    addEventListener(
      "haneoka:locale-ready",
      () => {
        this.locale = preferredLocale(this.locale);
        this.requestUpdate();
      },
      { signal: this.lifetime.signal },
    );
    this.recent = readRecentPlayers();
    if (signedInHint())
      void fetchJson<{ accounts: Array<{ region: string; playerUid: string; displayName: string | null }> }>("/api/v1/account/game-accounts", {
        credentials: "same-origin",
        signal: this.lifetime.signal,
      })
        .then(({ accounts }) => {
          this.linked = accounts.map((account) => ({
            region: gameAccountRegion(account.region, this.locale, account.playerUid),
            id: account.playerUid,
            name: account.displayName || account.playerUid,
          }));
        })
        .catch(() => undefined);
    if (this.profileQuery) {
      if (validPlayerProfileId(this.region, this.profileQuery)) void this.loadProfile(this.profileQuery);
      else this.queryInvalid = true;
    }
  }
  disconnectedCallback() {
    this.profileRequests.cancel();
    this.resetProfileImage();
    this.lifetime?.abort();
    clearAppBarActions(this.owner);
    clearAppBarSearch(this.owner);
    super.disconnectedCallback();
  }
  private currentProfile(signal: AbortSignal, region: GameRecordsRegion, id: string) {
    return (
      this.isConnected &&
      this.region === region &&
      this.selectedProfileId === id &&
      this.profileRequests.current(signal)
    );
  }
  private async loadProfile(id: string, attempt = 0): Promise<void> {
    if (!validPlayerProfileId(this.region, id)) {
      this.queryInvalid = true;
      return;
    }
    const region = this.region;
    const signal = this.profileRequests.begin();
    this.resetProfileImage();
    this.queryInvalid = false;
    this.selectedProfileId = id;
    this.profileQuery = id;
    this.selectedEntry = null;
    this.profile = null;
    this.profilePhase = "loading";
    const endpoint = this.rankingEndpoint;
    if (endpoint)
      void fetchJson<GameRankingDto>(endpoint, { signal, cache: "no-store", credentials: "same-origin" })
        .then((value) => {
          if (this.currentProfile(signal, region, id))
            this.selectedEntry = value.rows.find((row) => row.profileId === id) || null;
        })
        .catch(() => undefined);
    try {
      const value = await fetchJson<PlayerProfileDto>(
        `/api/v1/game/records/${region}/players/${encodeURIComponent(id)}`,
        { signal, cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" } },
      );
      if (!this.currentProfile(signal, region, id)) return;
      const owner = await this.readCommunityOwner(region, id, signal);
      if (!this.currentProfile(signal, region, id)) return;
      this.profile = value.profile;
      this.communityOwner = owner;
      this.rememberPlayer({ region, id, name: value.profile.name || id });
      const pages = this.profilePages();
      this.profileImageId = pages.length ? String(pages[0].page) : "";
      if (pages.length) void import("./ui/image-gallery");
      this.profilePhase = "ready";
    } catch (error) {
      const retryAfter = error instanceof JsonResponseError && error.status === 503 ? (error.body as GameRecordsErrorDto | null)?.error?.retryAfter : null;
      if (retryAfter && attempt < PROFILE_RETRIES && this.currentProfile(signal, region, id)) {
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        if (this.currentProfile(signal, region, id)) return this.loadProfile(id, attempt + 1);
        return;
      }
      if (this.currentProfile(signal, region, id))
        this.profilePhase =
          error instanceof JsonResponseError && (error.status === 403 || error.status === 404)
            ? "unavailable"
            : "error";
    }
  }
  private async readCommunityOwner(region: GameRecordsRegion, id: string, parent: AbortSignal) {
    const request = new RequestScope();
    const signal = request.begin(parent);
    const timeout = setTimeout(() => request.cancel(), 5_000);
    try {
      const { owner } = await fetchJson<{ owner: { uid: number; name: string } | null }>(
        `/api/v1/community/game-accounts/${region === "jp" ? "jp" : "intl"}/${encodeURIComponent(id)}`,
        { signal, credentials: "same-origin" },
      );
      return owner;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
      request.cancel();
    }
  }
  private rememberPlayer(player: RecentPlayer) {
    this.recent = [player, ...this.recent.filter((entry) => entry.id !== player.id || entry.region !== player.region)].slice(0, 8);
    try {
      localStorage.setItem(RECENT_PLAYERS_KEY, JSON.stringify(this.recent));
    } catch {
      // Private mode keeps the list for this page view.
    }
  }
  private openPlayer(player: RecentPlayer) {
    this.submitProfile(player.id);
  }
  private renderLanding() {
    const group = (title: string, glyph: string, players: RecentPlayer[]) =>
      players.length
        ? html`
            <section class="surface song-ranking__landing-group">
              <h2 class="detail-section-title">
                <span class="detail-section-title__icon" aria-hidden="true">${icon(glyph, 18)}</span>
                <span class="detail-section-title__label">${title}</span>
              </h2>
              <ul class="list" role="list">
                ${players.map(
                  (player) => html`
                    <li>
                      <button class="list-item list-item--two-line list-item--interactive" type="button" @click=${() => this.openPlayer(player)}>
                        <span class="list-item__avatar">${this.regionFlag(detectedProfileRegion(player.id) ?? player.region, 24)}</span>
                        <span class="list-item__body">
                          <span class="list-item__headline">${player.name}</span>
                          <span class="list-item__supporting">${player.id}</span>
                        </span>
                      </button>
                    </li>
                  `,
                )}
              </ul>
            </section>
          `
        : nothing;
    if (!this.recent.length && !this.linked.length)
      return emptyState({ title: clientText(this.locale, "tools.playerProfile.queryIdle", "Enter a player ID"), icon: "person_search" });
    return html`
      <div class="song-ranking__landing">
        ${group(clientText(this.locale, "tools.playerProfile.linked", "Your game accounts"), "sports_esports", this.linked)}
        ${group(clientText(this.locale, "tools.playerProfile.recent", "Recent lookups"), "history", this.recent)}
      </div>
    `;
  }
  private syncUrl(id: string) {
    const url = new URL(navigationDocumentUrl());
    url.searchParams.set("region", this.region);
    if (id) url.searchParams.set("profileId", id);
    else url.searchParams.delete("profileId");
    if (this.rankingEndpoint) url.searchParams.set("ranking", this.rankingEndpoint);
    else url.searchParams.delete("ranking");
    if (url.pathname === location.pathname) history.replaceState(history.state, "", url);
  }
  private submitProfile(value: string) {
    const id = normalizedProfileId(value);
    const region = detectedProfileRegion(id);
    if (!region) {
      this.profileRequests.cancel();
      this.queryInvalid = true;
      return;
    }
    this.openProfile(region, id);
  }
  private openProfile(region: GameRecordsRegion, id: string) {
    if (region !== this.region) {
      this.region = region;
      this.rankingEndpoint = null;
      this.points = false;
    }
    this.syncUrl(id);
    void this.loadProfile(id);
  }
  private regionFlag(region: string, size: number) {
    const option = GAME_RECORDS_REGIONS.find((entry) => entry.value === region);
    return option ? html`<img src=${option.flag} width=${size} height=${size} alt="" />` : icon("person", 20);
  }
  private syncChrome(staticPage = false) {
    const returnTo = staticPage ? null : playerProfileReturn(navigationDocumentUrl().searchParams.get("return"));
    setAppBarActions(
      this.owner,
      html`
        ${
          returnTo
            ? html`
                <a
                  class="icon-button"
                  href=${returnTo}
                  aria-label=${clientText(this.locale, "common.actions.back", "Back")}
                  title=${clientText(this.locale, "common.actions.back", "Back")}
                >
                  ${icon("arrow_back", 24)}
                </a>
              `
            : nothing
        }
        ${iconButton({ label: clientText(this.locale, "common.actions.refresh", "Refresh"), icon: "refresh", disabled: !this.selectedProfileId || this.profilePhase === "loading", onClick: () => void this.loadProfile(this.selectedProfileId) })}
      `,
      this,
    );
    setAppBarSearch(this.owner, {
      value: this.profileQuery,
      label: this.label("profileSearch", "Player profile ID"),
      onInput: (value) => {
        this.profileQuery = value;
        this.queryInvalid = false;
      },
      onSubmit: (value) => this.submitProfile(value),
      expanded: staticPage && this.profilePhase === "idle",
    });
    if (staticPage) return;
    const input = document.querySelector<HTMLInputElement>(`[data-app-bar-search-owner="${this.owner}"] input`);
    if (input) {
      input.inputMode = "numeric";
      input.maxLength = 19;
      input.pattern = playerProfileIdPattern("jp");
      input.required = true;
    }
    // The shared compact search normally starts as an icon. A new lookup must expose its input.
    if (!this.searchInitialized) {
      this.searchInitialized = true;
      if (this.profilePhase === "idle")
        document
          .querySelector<HTMLButtonElement>(`[data-app-bar-search-owner="${this.owner}"] .top-app-bar__search-toggle`)
          ?.click();
    }
    updateEntityHeading(this, clientText(this.locale, "tools.playerProfile.title", "Player lookup"));
  }
  updated(_changed: PropertyValues) {
    if (this.isConnected) this.syncChrome();
  }
  render() {
    const loading = this.profilePhase === "loading";
    return html`
      <section class="song-ranking-page player-profile-page" aria-label=${clientText(this.locale, "tools.playerProfile.title", "Player lookup")}>
        <div class="song-ranking__progress" aria-hidden=${loading ? nothing : "true"}>
          ${
            loading
              ? html`
                  <md-linear-progress
                    indeterminate
                    aria-label=${clientText(this.locale, "common.states.loading", "Loading")}
                  ></md-linear-progress>
                `
              : nothing
          }
        </div>
        ${this.queryInvalid ? emptyState({ title: clientText(this.locale, "tools.playerProfile.invalidId", "Check the player ID"), icon: "error" }) : this.profilePhase === "idle" ? this.renderLanding() : this.renderProfile()}
      </section>
    `;
  }

  private resetProfileImage() {
    this.profileDownloads.cancel();
    this.profileImageId = "";
    this.profileImageDownloading = false;
  }

  private profilePages(): Array<GameProfileCardPageDto & { imageUrl: string }> {
    const card = this.profile?.profileCard;
    const pages =
      card?.pages ??
      card?.thumbnailUrls.map((imageUrl, index) => ({ page: index + 1, imageUrl, sourceUrl: imageUrl })) ??
      [];
    return pages.filter((page): page is GameProfileCardPageDto & { imageUrl: string } => Boolean(page.imageUrl));
  }

  private async downloadProfileImage() {
    const page = this.profilePages().find((page) => String(page.page) === this.profileImageId);
    if (!page?.downloadUrl || this.profileImageDownloading) return;
    const signal = this.profileDownloads.begin();
    this.profileImageDownloading = true;
    try {
      const response = await fetch(page.downloadUrl, {
        credentials: "omit",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) throw new Error("Image download failed");
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) throw new Error("Image download failed");
      if (!this.isConnected || !this.profileDownloads.current(signal)) return;
      const extension =
        (
          { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" } as Record<
            string,
            string
          >
        )[blob.type] || "image";
      await downloadBlob(blob, `profile-${this.selectedProfileId}-${page.page}.${extension}`);
    } catch {
      if (this.isConnected && this.profileDownloads.current(signal)) snackbar(clientText(this.locale, "tools.playerProfile.downloadFailed", "Profile card download failed"), { error: true });
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
    if (this.profilePhase === "loading") return nothing;
    if (this.profilePhase === "unavailable")
      return emptyState({ title: this.label("profileUnavailable", "Profile unavailable"), icon: "person_off" });
    if (this.profilePhase === "error")
      return errorState(
        this.label("profileUnavailable", "Profile unavailable"),
        this.label("retry", "Retry"),
        () => this.selectedProfileId && void this.loadProfile(this.selectedProfileId),
      );
    const profile = this.profile;
    if (!profile) return nothing;
    const name = profile.name || this.label("privatePlayer", "Unknown player");
    const favorite = profile.favoriteMemberCard;
    const favoriteId =
      profile.favoriteMemberCardMasterId ?? (favorite?.cardId == null ? null : String(favorite.cardId));
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
      label: `${namecard?.name || this.label("profileCard", "Profile card")} / ${page.page}`,
    }));
    const favoriteLevel = artwork
      ? this.levelFromExp(catalog?.levels.member[String(artwork.levelGroup)], favorite?.exp ?? null)
      : null;
    const favoriteCap =
      artwork && favorite?.awakeCount != null
        ? catalog?.memberLimits[`${artwork.rarity}:${favorite.awakeCount}`]
        : null;
    const favoriteLevelDisplay =
      favoriteLevel == null ? null : favoriteCap ? Math.min(favoriteLevel, favoriteCap) : favoriteLevel;
    const favorites =
      profile.totalFavoriteExact != null && /^\d+$/.test(profile.totalFavoriteExact)
        ? BigInt(profile.totalFavoriteExact).toLocaleString(this.locale)
        : profile.totalFavorite?.toLocaleString(this.locale);
    const entry = this.selectedEntry;
    const region = GAME_RECORDS_REGIONS.find((option) => option.value === this.region)!;
    return html`
      <div class="song-ranking__profile">
        <header class="player-profile-hero">
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
          <div class="player-profile-hero__identity">
            <h2>${name}</h2>
            <p class="player-profile-hero__id">
              ${this.regionFlag(this.region, 20)}
              <span>${this.label(region.key, this.region)}</span>
              <span aria-hidden="true">/</span>
              <span>${this.selectedProfileId}</span>
            </p>
            ${
              level != null || favorites != null
                ? html`
                    <div class="cluster player-profile-hero__chips">
                      ${
                        level != null
                          ? html`
                              <span class="chip chip--tonal chip--static">
                                <span class="chip__label">${this.label("cardLevel", "Lv. {level}").replace("{level}", String(level))}</span>
                              </span>
                            `
                          : nothing
                      }
                      ${
                        favorites != null
                          ? html`
                              <span class="chip chip--tonal chip--static">
                                ${icon("favorite", 18)}<span class="sr-only">${this.label("favorites", "Likes received")}</span><span class="chip__label">${favorites}</span>
                              </span>
                            `
                          : nothing
                      }
                    </div>
                  `
                : nothing
            }
          </div>
          ${
            this.communityOwner
              ? html`
                  <a class="player-profile-owner" href=${`/${this.locale}/community/users/${this.communityOwner.uid}/`}>
                    <span class="player-profile-owner__icon" aria-hidden="true">${icon("account_circle", 24)}</span>
                    <span class="player-profile-owner__copy">
                      <span>${clientText(this.locale, "tools.playerProfile.communityOwner", "Community profile")}</span>
                      <strong>${this.communityOwner.name}</strong>
                    </span>
                    ${icon("chevron_right", 24)}
                  </a>
                `
              : nothing
          }
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
                      ${
                        images.length
                          ? iconButton({
                              icon: "download",
                              label: clientText(this.locale, "common.actions.download", "Download"),
                              disabled:
                                this.profileImageDownloading ||
                                !this.profilePages().find((page) => String(page.page) === this.profileImageId)
                                  ?.downloadUrl,
                              onClick: () => void this.downloadProfileImage(),
                            })
                          : nothing
                      }
                    </header>
                    ${
                      this.profileImageDownloading
                        ? html`
                            <md-linear-progress
                              indeterminate
                              aria-label=${clientText(this.locale, "common.states.loading", "Loading")}
                            ></md-linear-progress>
                          `
                        : nothing
                    }
                    ${
                      images.length
                        ? html`
                            <image-gallery
                              natural
                              .images=${images}
                              .active=${this.profileImageId}
                              @image-change=${(event: CustomEvent<string>) => {
                                this.profileImageId = event.detail;
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
            cardHref
              ? html`
                  <section class="song-ranking__profile-favorite surface">
                    <h3>${this.label("favoriteCard", "Favorite member card")}</h3>
                    <a class="song-ranking__profile-favorite-card" href=${cardHref}>
                      <span class="song-ranking__profile-favorite-art card-media card-media--member">
                        ${this.profileMedia(cardName, artwork?.image || "")}
                        ${artwork?.attributeIcon ? html`<img class="card-media__attribute" src=${artwork.attributeIcon} alt="" />` : nothing}
                        ${artwork?.rarityIcon ? html`<img class="card-media__rarity" src=${artwork.rarityIcon} alt="" />` : nothing}
                        ${artwork ? this.renderCardProgress(artwork, {
                          level: favoriteLevelDisplay,
                          training: favorite?.awakeCount ?? null,
                          rank: favorite?.cardRank ?? null,
                          liveSkillLevel: favorite?.liveSkillLevel,
                          gekisoSkillLevel: favorite?.performanceSkillLevel,
                        }) : nothing}
                      </span>
                      <strong>${cardName}</strong>
                    </a>
                  </section>
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
                  ${this.label("updated", "Updated")} /
                  <time datetime=${new Date(profile.lastUpdatedAtMs).toISOString()}>
                    ${formatDate(this.locale, profile.lastUpdatedAtMs, { time: true })}
                  </time>
                </p>
              `
            : nothing
        }
      </div>
    `;
  }
}
if (!customElements.get("player-profile-workspace"))
  customElements.define("player-profile-workspace", PlayerProfileWorkspace);
