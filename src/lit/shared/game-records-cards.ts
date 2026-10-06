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
type RankingEntry = SongRankingRowDto;
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
    return clientText(this.locale, `songRanking.${key}`, fallback);
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

  protected profileMedia(name: string, image: string) {
    return image
      ? html`
          <span
            class=${live(`song-ranking__player-media${this.failedImages.has(image) ? " is-error" : this.readyImages.has(image) ? " is-loaded" : ""}`)}
          >
            ${
              !this.readyImages.has(image)
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
}
