import { LitElement, html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { clientText } from "../../i18n/client";
import { localizedText } from "./catalog";
import { icon } from "../ui/icon";
import { resourcePath } from "../../lib/resource-route";
import type { Locale } from "../../i18n/locales";
import type {
  GameRecordsRegion,
  RankingCardCatalog,
  RankingCardArtwork,
  SongRankingRowDto,
} from "../../lib/game-records";
import { loadingIndicator } from "../ui/loading-indicator";
import { cardGrowth } from "./card-growth";
import { cardGrowthIcons } from "../../lib/ui-marks";
type RankingEntry = SongRankingRowDto;
export interface RankingRowView {
  rank: number;
  name: string;
  profileId: string | null;
  href: string;
  favoriteMemberCardId: number | null;
  profileCard: RankingEntry["profileCard"];
  level: number | null;
  totalPower?: number | null;
  score: string;
  scoreLabel: string;
  tied: boolean;
  /** Shown beneath the score, such as an Arena tier. */
  detail?: unknown;
  /** Omitted on rankings that have no deck to show. */
  cards?: RankingEntry["cards"];
  /** Rank, player and score only, for a short summary list. */
  bare?: boolean;
  target?: boolean;
}
/** Card artwork and native progression shared by rankings and the independent public player view. */
export abstract class GameRecordsCardsElement extends LitElement {
  declare locale: string;
  declare region: GameRecordsRegion;
  protected cardCatalogs: Partial<Record<"jp" | "intl", RankingCardCatalog>> = {};
  private readyImages = new Set<string>();
  private failedImages = new Set<string>();
  createRenderRoot() {
    return this;
  }
  protected label(key: string, fallback: string) {
    return clientText(this.locale, `catalog.rankings.songs.${key}`, fallback);
  }

  protected formatScore(value: number | null) {
    return value === null ? "—" : value.toLocaleString(this.locale);
  }

  protected initials(name: string) {
    const value = name.trim();
    return Array.from(value || "?")
      .slice(0, 2)
      .join("")
      .toLocaleUpperCase(this.locale);
  }

  /** `indicator` is off for card art: hundreds of spinning indicators on a full board cost more than they tell. */
  protected profileMedia(name: string, image: string, indicator = true) {
    return image
      ? html`
          <span
            class=${live(`song-ranking__player-media${this.failedImages.has(image) ? " is-error" : this.readyImages.has(image) ? " is-loaded" : ""}`)}
          >
            ${
              indicator && !this.readyImages.has(image)
                ? html`
                    ${loadingIndicator({ label: this.label("loading", "Loading") })}
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

  protected cardArtwork(cardId: number | null, support: boolean) {
    if (cardId == null) return undefined;
    const source = this.region === "jp" ? "jp" : "intl";
    const preferred = this.cardCatalogs[source];
    const fallback = this.cardCatalogs[source === "jp" ? "intl" : "jp"];
    const key = support ? "support" : "member";
    return preferred?.[key][String(cardId)] || fallback?.[key][String(cardId)];
  }

  protected sourceCatalog() {
    return this.cardCatalogs[this.region === "jp" ? "jp" : "intl"];
  }

  protected levelFromExp(rows: Array<{ level: number; exp: number }> | undefined, exp: number | null) {
    if (exp == null || !rows?.length) return null;
    let level = 1;
    for (const row of rows) {
      if (row.exp > exp) break;
      level = row.level;
    }
    return level;
  }

  protected cardLevel(artwork: RankingCardArtwork, card: RankingEntry["cards"][number], support: boolean) {
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

  protected renderCard(card: RankingEntry["cards"][number], support = false) {
    const id = support ? card.supportCardId : card.memberCardId;
    const artwork = this.cardArtwork(id, support);
    const name = artwork ? localizedText(artwork.name, this.locale) : this.label("unavailableCard", "Card unavailable");
    const level = artwork ? this.cardLevel(artwork, card, support) : null;
    const body = html`
      <span class=${`song-ranking__card-media card-media card-media--${support ? "support" : "member"}${support ? " song-ranking__card-media--support" : ""}`}>
        ${artwork?.image ? this.profileMedia(name, artwork.image, false) : icon("broken_image", 24)}
        ${
          artwork?.attributeIcon
            ? html`
                <img class="card-media__attribute" src=${artwork.attributeIcon} alt="" />
              `
            : nothing
        }
        ${
          artwork?.rarityIcon
            ? html`
                <img class="card-media__rarity" src=${artwork.rarityIcon} alt="" />
              `
            : nothing
        }
        ${artwork ? this.renderCardProgress(artwork, {
          level, training: support ? undefined : card.memberAwakeCount,
          rank: support ? card.supportRank : card.memberRank,
        }, support) : nothing}
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

  /** One leaderboard row: every ranking draws this same template on the same grid. */
  protected renderRankingRow(row: RankingRowView) {
    const name = row.name || this.label("privatePlayer", "Unknown player");
    const favorite = this.cardArtwork(row.favoriteMemberCardId, false);
    const profileCard = row.profileCard;
    const image = profileCard?.thumbnailUrls[0] || "";
    const cardTitle = [
      profileCard?.name,
      profileCard?.slot != null ? this.label("profileCardSlot", "Slot {slot}").replace("{slot}", String(profileCard.slot)) : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const identity = html`
      <strong>${name}</strong>
      <small class="song-ranking__player-stats">
        ${row.level != null ? html`<span>${this.label("cardLevel", "Lv. {level}").replace("{level}", String(row.level))}</span>` : nothing}
        ${row.totalPower != null ? html`<span>${this.label("power", "Power")} ${this.formatScore(row.totalPower)}</span>` : nothing}
      </small>
    `;
    return html`
      <li class="song-ranking__entry" data-rank=${row.rank} data-profile=${row.profileId ?? nothing} data-target=${row.target ? "true" : nothing}>
        <div class=${`song-ranking__row${row.cards ? "" : " song-ranking__row--points"}${row.bare ? " song-ranking__row--bare" : ""}`}>
          <span class="song-ranking__rank" aria-label=${`${this.label("rank", "Rank")} ${row.rank}`}>${row.rank}</span>
          ${
            row.bare
              ? nothing
              : image
                ? html`
                    <a class="song-ranking__namecard" href=${image} target="_blank" rel="noopener" title=${cardTitle} aria-label=${cardTitle || this.label("profileCard", "Profile card")}>
                      ${this.profileMedia(name, image)}
                    </a>
                  `
                : html`
                    <span class="song-ranking__namecard song-ranking__namecard--empty" aria-label=${this.label("noProfileCard", "No profile card")}>${icon("badge", 24)}</span>
                  `
          }
          <span class="song-ranking__avatar">
            ${favorite?.avatar ? this.profileMedia(name, favorite.avatar) : html`<span class="song-ranking__initial" aria-hidden="true">${this.initials(name)}</span>`}
          </span>
          ${
            row.href
              ? html`<a class="song-ranking__player-copy state-layer" href=${row.href} data-profile-id=${row.profileId ?? nothing}>${identity}</a>`
              : html`<span class="song-ranking__player-copy">${identity}</span>`
          }
          <span class="song-ranking__score" aria-label=${`${row.scoreLabel} ${row.score}`}>
            <strong>${row.score}</strong>
            ${row.tied ? html`<small>${this.label("tied", "Tied rank")}</small>` : nothing}
            ${row.detail ?? nothing}
          </span>
          ${
            row.cards
              ? html`
                  <span class="song-ranking__deck-preview" aria-label=${this.label("cards", "Cards")}>
                    ${row.cards.map(
                      (card) => html`
                        <span class="song-ranking__deck-slot">
                          ${this.renderCard(card)}${
                            card.supportCardId != null
                              ? this.renderCard(card, true)
                              : html`<span class="song-ranking__card-media song-ranking__card-media--support song-ranking__card-empty" aria-label=${this.label("noSupportCard", "No support card")}></span>`
                          }
                        </span>
                      `,
                    )}
                  </span>
                `
              : nothing
          }
        </div>
      </li>
    `;
  }

  protected renderCardProgress(
    artwork: RankingCardArtwork,
    values: { level: number | null; training?: number | null; rank: number | null; liveSkillLevel?: number | null; gekisoSkillLevel?: number | null },
    support = false,
  ) {
    return cardGrowth({
      ...values,
      kind: support ? "support" : "member",
      icons: this.cardCatalogs[artwork.server]?.growthIcons ?? cardGrowthIcons(() => ""),
      trainingLabel: clientText(this.locale, "catalog.cards.fields.training", "Training"),
      rankLabel: clientText(this.locale, "catalog.cards.fields.awakening", "Awakening"),
      liveSkill: values.liveSkillLevel !== undefined ? {
        level: values.liveSkillLevel, icon: artwork.liveSkillIcon ?? "",
        label: clientText(this.locale, "catalog.cards.fields.liveSkill", "LIVE Skill"),
      } : undefined,
      gekisoSkill: values.gekisoSkillLevel !== undefined ? {
        level: values.gekisoSkillLevel, icon: artwork.gekisoSkillIcon ?? "",
        label: clientText(this.locale, "catalog.cards.fields.gekisouSkill", "Gekisou Skill"),
      } : undefined,
    });
  }
}
