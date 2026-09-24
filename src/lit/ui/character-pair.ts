import { LitElement, html, nothing, type PropertyValues } from "lit";
import { uiText, currentReleaseServer } from "../shared/catalog";
import { iconButton } from "./controls";
import { icon } from "./icon";
import { orderFacetOptions } from "../../lib/facet-order";
import "../../styles/character-pair.css";

export interface PairCharacter {
  value: string;
  label: string;
  image?: string;
  bandId?: number;
}
interface PairOptions {
  locale: string;
  characters: PairCharacter[];
  bands?: { id: number; label: string; image?: string }[];
  first: string;
  second: string;
  onFirst?: (value: string) => void;
  onSecond: (value: string) => void;
  onSwap?: () => void;
}
const FRIENDSHIP_SELF_SLOTS = [
  ["18.82622%", "43.36100%", "90.85714%", "68.57143%", "-11.853991deg"],
  ["27.59146%", "77.80083%", "93.28571%", "33.08571%", "-44.430576deg"],
  ["74.16159%", "67.20954%", "3.51429%", "40.37143%", "29.744215deg"],
  ["73.93293%", "25.82988%", "7.42857%", "80.62857%", "-29.195091deg"],
] as const;
const FRIENDSHIP_OTHER_SLOTS = [
  ["19.28354%", "30.18672%", "90.60000%", "75.37143%", "29.658096deg"],
  ["20.88415%", "69.91701%", "96.00000%", "44.85714%", "-36.740987deg"],
  ["68.90244%", "80.18672%", "10.71429%", "13.57143%", "52.050356deg"],
  ["79.64939%", "49.48133%", "-0.28571%", "50.00000%", "3.755137deg"],
  ["71.95122%", "20.12448%", "9.34286%", "86.82857%", "-43.944990deg"],
] as const;

class CharacterPairBoard extends LitElement {
  static properties = { options: { attribute: false }, activeBand: { state: true }, missingBoard: { state: true } };
  declare options: PairOptions;
  declare activeBand: number;
  declare missingBoard: boolean;
  constructor() {
    super();
    this.activeBand = 0;
    this.missingBoard = false;
  }
  createRenderRoot() {
    return this;
  }
  protected willUpdate(changed: PropertyValues) {
    const previous = changed.get("options") as PairOptions | undefined;
    if (
      changed.has("options") &&
      (!previous || previous.first !== this.options.first || previous.second !== this.options.second)
    ) {
      const selected = this.options.characters.find(
        (item) => item.value === (this.options.second || this.options.first),
      );
      this.activeBand = selected?.bandId || this.options.characters[0]?.bandId || 1;
      this.missingBoard = false;
    }
  }
  private imageFallback(event: Event) {
    const image = event.currentTarget as HTMLImageElement;
    if (!image.dataset.fallback && currentReleaseServer() === "intl") {
      image.dataset.fallback = "true";
      image.src = image.src.replace("/assets/intl/", "/assets/intl-cbt/");
    } else if (image.classList.contains("story-board__background")) this.missingBoard = true;
    else image.hidden = true;
  }
  render() {
    if (!this.options) return nothing;
    const o = this.options;
    const characters = orderFacetOptions(o.characters);
    const first = characters.find((item) => item.value === o.first);
    const partners = characters.filter((item) => item.value !== o.first && item.bandId === this.activeBand);
    const sameBand = first?.bandId === this.activeBand;
    const slots = sameBand ? FRIENDSHIP_SELF_SLOTS : FRIENDSHIP_OTHER_SLOTS;
    const bands =
      o.bands ||
      [...new Set(characters.map((item) => item.bandId || 0))]
        .filter(Boolean)
        .map((id) => ({ id, label: String(id), image: "" }));
    const root = `/assets/${currentReleaseServer()}/Assets/AddressableResources`;
    return html`
      <section class="character-pair" aria-label=${uiText(o.locale, "characters")}>
        <div class="character-pair__toolbar">
          <details class="character-pair__picker" ?hidden=${!o.onFirst}>
            <summary>
              ${
                first?.image
                  ? html`
                      <img src=${first.image} alt="" />
                    `
                  : icon("person", 24)
              }
              <span>${first?.label || uiText(o.locale, "firstCharacter")}</span>
              ${icon("expand_more", 20)}
            </summary>
            <div class="character-pair__choices">
              ${characters.map(
                (item) => html`
                  <button
                    type="button"
                    aria-pressed=${item.value === o.first}
                    @click=${(event: Event) => {
                      o.onFirst?.(item.value);
                      (event.currentTarget as HTMLElement).closest("details")?.removeAttribute("open");
                    }}
                  >
                    ${
                      item.image
                        ? html`
                            <img src=${item.image} alt="" loading="lazy" />
                          `
                        : icon("person", 24)
                    }
                    <span>${item.label}</span>
                  </button>
                `,
              )}
            </div>
          </details>
          ${
            !o.onFirst
              ? html`
                  <span class="character-pair__identity">
                    ${
                      first?.image
                        ? html`
                            <img src=${first.image} alt="" />
                          `
                        : nothing
                    }
                    <strong>${first?.label}</strong>
                  </span>
                `
              : nothing
          }
          <button class="button button--tonal" type="button" aria-pressed=${!o.second} @click=${() => o.onSecond("")}>
            ${uiText(o.locale, "all")}
          </button>
          ${o.onSwap ? iconButton({ icon: "swap_horiz", label: uiText(o.locale, "swap"), disabled: !o.second, onClick: o.onSwap }) : nothing}
        </div>
        <div class="character-pair__bands" role="group" aria-label=${uiText(o.locale, "bands")}>
          ${bands.map(
            (band) => html`
              <button
                type="button"
                aria-pressed=${this.activeBand === band.id}
                aria-label=${band.label}
                @click=${() => {
                  this.activeBand = band.id;
                  this.missingBoard = false;
                }}
              >
                ${
                  band.image
                    ? html`
                        <img src=${band.image} alt=${band.label} />
                      `
                    : band.label
                }
              </button>
            `,
          )}
        </div>
        ${
          this.missingBoard
            ? html`
                <div class="character-pair__choices character-pair__choices--fallback">
                  ${partners.map(
                    (item) => html`
                      <button
                        type="button"
                        aria-pressed=${item.value === o.second}
                        @click=${() => o.onSecond(o.second === item.value ? "" : item.value)}
                      >
                        ${
                          item.image
                            ? html`
                                <img src=${item.image} alt="" />
                              `
                            : icon("person", 32)
                        }
                        <span>${item.label}</span>
                      </button>
                    `,
                  )}
                </div>
              `
            : html`
                <div class="story-board">
                  <div class="story-board__stage">
                    <img
                      class="story-board__background"
                      src=${`${root}/Band/${this.activeBand}/Friendship/photo_board.png`}
                      alt=""
                      @error=${this.imageFallback}
                    />
                    ${
                      sameBand
                        ? html`
                            <img
                              class="story-board__logo"
                              src=${`${root}/Band/${this.activeBand}/band_logo.png`}
                              alt=""
                              @error=${this.imageFallback}
                            />
                          `
                        : nothing
                    }
                    <img
                      class="story-board__lead"
                      src=${`${root}/Character/Image/${o.first}/character_sprite.png`}
                      alt=${first?.label || ""}
                      @error=${this.imageFallback}
                    />
                    <div class="story-board__partners" role="group" aria-label=${uiText(o.locale, "secondCharacter")}>
                      ${partners.map((character, index) => {
                        const slot = slots[index] || FRIENDSHIP_OTHER_SLOTS[0];
                        return html`
                          <button
                            type="button"
                            class=${o.second === character.value ? "is-selected" : ""}
                            aria-pressed=${o.second === character.value}
                            aria-label=${character.label}
                            title=${character.label}
                            style=${`--slot-x:${slot[0]};--slot-y:${slot[1]};--arrow-x:${slot[2]};--arrow-y:${slot[3]};--arrow-rotation:${sameBand && this.activeBand === 2 && index === 0 ? "168.146055deg" : slot[4]}`}
                            @click=${() => o.onSecond(o.second === character.value ? "" : character.value)}
                          >
                            <img
                              class="story-board__arrow"
                              src=${`${root}/Band/${this.activeBand}/Friendship/FriendshipArrow_1.png`}
                              alt=""
                              @error=${this.imageFallback}
                            />
                            <span>
                              <img
                                src=${`${root}/Character/Image/${character.value}/board_icon.png`}
                                alt=""
                                @error=${this.imageFallback}
                              />
                            </span>
                          </button>
                        `;
                      })}
                    </div>
                  </div>
                </div>
              `
        }
      </section>
    `;
  }
}
customElements.define("character-pair-board", CharacterPairBoard);
export function characterPair(options: PairOptions) {
  return html`
    <character-pair-board .options=${options}></character-pair-board>
  `;
}
