import "@material/web/progress/linear-progress.js";
import "@material/web/menu/menu.js";
import "@material/web/menu/menu-item.js";
import { html, nothing, type PropertyValues } from "lit";
import type { GalleryImage } from "./ui/image-gallery";
import { GameRecordsCardsElement } from "./shared/game-records-cards";
import { clientText } from "../i18n/client";
import { preferredLocale, fetchJson, JsonResponseError, localizedText } from "./shared/catalog";
import { readReleaseServer } from "../lib/release-server";
import { RequestScope } from "../lib/request-scope";
import { downloadBlob } from "../lib/canvas-capture";
import { iconButton } from "./ui/controls";
import type { Locale } from "../i18n/locales";
import { readPageData } from "../lib/page-data";
import { navigationDocumentUrl } from "../lib/document-url";
import { updateEntityHeading } from "../lib/detail-navigation";
import { resourcePath, homePath } from "../lib/resource-route";
import {
  playerProfileIdPattern,
  validPlayerProfileId,
  playerProfileReturn,
  playerProfileRankingEndpoint,
} from "../lib/player-profile-route";
import { emptyState, errorState } from "./ui/state";
import { clearAppBarActions, clearAppBarSearch, setAppBarActions, setAppBarSearch } from "../lib/app-bar";
import { GAME_RECORDS_REGIONS, defaultGameRecordsRegion } from "./shared/game-records";
import type {
  GameRecordsRegion,
  GameProfileCardPageDto,
  GameRankingDto,
  SongRankingRowDto,
  PlayerProfileDto,
  RankingCardCatalog,
} from "../lib/game-records";
import "../styles/settings.css";
import "../styles/song-ranking.css";
type Phase = "idle" | "loading" | "ready" | "error" | "unavailable";
let profileOwnerSequence = 0;
export class PlayerProfileWorkspace extends GameRecordsCardsElement {
  static properties = {
    locale: { type: String },
    region: { state: true },
    profilePhase: { state: true },
    profile: { state: true },
    profileImageId: { state: true },
    profileImageDownloading: { state: true },
    profileImageError: { state: true },
    selectedEntry: { state: true },
    queryInvalid: { state: true },
  };
  declare profilePhase: Phase;
  declare profile: PlayerProfileDto["profile"] | null;
  declare profileImageId: string;
  declare profileImageDownloading: boolean;
  declare profileImageError: boolean;
  declare selectedEntry: SongRankingRowDto | null;
  declare queryInvalid: boolean;
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
    this.profileImageError = false;
    this.selectedEntry = null;
    this.queryInvalid = false;
  }
  connectedCallback() {
    super.connectedCallback();
    this.lifetime = new AbortController();
    this.searchInitialized = false;
    this.cardCatalogs = readPageData<typeof this.cardCatalogs>(this) || this.cardCatalogs;
    this.locale = preferredLocale(this.locale);
    const url = navigationDocumentUrl();
    const requested = url.searchParams.get("region");
    this.region = GAME_RECORDS_REGIONS.some((option) => option.value === requested)
      ? (requested as GameRecordsRegion)
      : defaultGameRecordsRegion(readReleaseServer(), this.locale);
    this.rankingEndpoint = playerProfileRankingEndpoint(url.searchParams.get("ranking"), this.region);
    this.points = Boolean(this.rankingEndpoint?.endsWith("/latest"));
    this.profileQuery = url.searchParams.get("profileId") || "";
    addEventListener(
      "haneoka:locale-ready",
      () => {
        this.locale = preferredLocale(this.locale);
        this.requestUpdate();
      },
      { signal: this.lifetime.signal },
    );
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
  private async loadProfile(id: string) {
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
      this.profile = value.profile;
      const pages = this.profilePages();
      this.profileImageId = pages.length ? String(pages[0].page) : "";
      if (pages.length) void import("./ui/image-gallery");
      this.profilePhase = "ready";
    } catch (error) {
      if (this.currentProfile(signal, region, id))
        this.profilePhase =
          error instanceof JsonResponseError && (error.status === 403 || error.status === 404)
            ? "unavailable"
            : "error";
    }
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
    const input = value.trim();
    const id = validPlayerProfileId(this.region, input) ? BigInt(input).toString() : input;
    if (!validPlayerProfileId(this.region, id)) {
      this.queryInvalid = true;
      return;
    }
    this.syncUrl(id);
    void this.loadProfile(id);
  }
  private selectRegion(region: GameRecordsRegion) {
    if (region === this.region) return;
    this.profileRequests.cancel();
    this.resetProfileImage();
    this.region = region;
    this.profile = null;
    this.selectedEntry = null;
    this.selectedProfileId = "";
    this.profilePhase = "idle";
    this.queryInvalid = false;
    this.rankingEndpoint = null;
    this.points = false;
    this.searchInitialized = false;
    this.syncUrl("");
  }
  private syncChrome() {
    const back = document.querySelector<HTMLAnchorElement>("[data-entity-back]");
    if (back)
      back.href =
        playerProfileReturn(navigationDocumentUrl().searchParams.get("return")) ||
        homePath(readReleaseServer(), this.locale as Locale);
    setAppBarActions(
      this.owner,
      html`
        <div>
          <button
            type="button"
            class="icon-button"
            id=${`${this.owner}-server`}
            aria-haspopup="menu"
            aria-label=${`${clientText(this.locale, "server", "Server")} · ${this.label(GAME_RECORDS_REGIONS.find((option) => option.value === this.region)!.key, this.region)}`}
            @click=${(event: Event) => (event.currentTarget as HTMLElement).parentElement?.querySelector("md-menu")?.show()}
          >
            <img
              src=${GAME_RECORDS_REGIONS.find((option) => option.value === this.region)!.flag}
              width="28"
              height="28"
              alt=""
            />
          </button>
          <md-menu anchor=${`${this.owner}-server`} positioning="popover">
            ${GAME_RECORDS_REGIONS.map(
              (option) => html`
                <md-menu-item type="button" @click=${() => this.selectRegion(option.value)}>
                  <img slot="start" src=${option.flag} width="24" height="24" alt="" />
                  <span slot="headline">${this.label(option.key, option.value)}</span>
                </md-menu-item>
              `,
            )}
          </md-menu>
        </div>
        ${iconButton({ label: clientText(this.locale, "refresh", "Refresh"), icon: "refresh", disabled: !this.selectedProfileId || this.profilePhase === "loading", onClick: () => void this.loadProfile(this.selectedProfileId) })}
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
    });
    const input = document.querySelector<HTMLInputElement>(`[data-app-bar-search-owner="${this.owner}"] input`);
    if (input) {
      input.inputMode = "numeric";
      input.maxLength = this.region === "jp" ? 19 : 11;
      input.pattern = playerProfileIdPattern(this.region);
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
    updateEntityHeading(this, clientText(this.locale, "playerProfile.title", "Player lookup"));
  }
  updated(_changed: PropertyValues) {
    if (this.isConnected) this.syncChrome();
  }
  render() {
    const loading = this.profilePhase === "loading";
    return html`
      <section class="song-ranking-page" aria-label=${clientText(this.locale, "playerProfile.title", "Player lookup")}>
        <div class="song-ranking__progress" aria-hidden=${loading ? nothing : "true"}>
          ${
            loading
              ? html`
                  <md-linear-progress
                    indeterminate
                    aria-label=${clientText(this.locale, "loading", "Loading")}
                  ></md-linear-progress>
                `
              : nothing
          }
        </div>
        ${this.queryInvalid ? emptyState({ title: clientText(this.locale, "playerProfile.invalidId", "Check the player ID"), icon: "error" }) : this.profilePhase === "idle" ? emptyState({ title: clientText(this.locale, "playerProfile.queryIdle", "Enter a player ID"), icon: "person_search" }) : this.renderProfile()}
      </section>
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
      const extension =
        (
          { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" } as Record<
            string,
            string
          >
        )[blob.type] || "image";
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
      label: `${namecard?.name || this.label("profileCard", "Profile card")} · ${page.page}`,
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
                      ${
                        images.length
                          ? iconButton({
                              icon: "download",
                              label: clientText(this.locale, "download", "Download"),
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
                              aria-label=${clientText(this.locale, "loading", "Loading")}
                            ></md-linear-progress>
                          `
                        : nothing
                    }
                    ${
                      this.profileImageError
                        ? html`
                            <p role="alert">${clientText(this.locale, "unavailable", "Unavailable")}</p>
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
}
if (!customElements.get("player-profile-workspace"))
  customElements.define("player-profile-workspace", PlayerProfileWorkspace);
