import { html, nothing } from "lit";
import { uiText } from "../shared/catalog";
import { iconButton } from "./controls";
import { orderFacetOptions } from "../../lib/facet-order";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "../../styles/character-pair.css";

export interface PairCharacter {
  value: string;
  label: string;
  image?: string;
}
export function characterPair(options: {
  locale: string;
  characters: PairCharacter[];
  first: string;
  second: string;
  onFirst?: (value: string) => void;
  onSecond: (value: string) => void;
  onSwap?: () => void;
}) {
  const characters = orderFacetOptions(options.characters);
  const choices = (first: boolean) => html`
    <md-outlined-select
      label=${uiText(options.locale, first ? "firstCharacter" : "secondCharacter")}
      .value=${first ? options.first : options.second}
      ?disabled=${first && !options.onFirst}
      @change=${(event: Event) => {
        const value = (event.target as HTMLElement & { value: string }).value;
        if (first) options.onFirst?.(value);
        else options.onSecond(value);
      }}
    >
      ${
        !first
          ? html`
              <md-select-option value="">
                <span slot="headline">${uiText(options.locale, "all")}</span>
              </md-select-option>
            `
          : nothing
      }
      ${characters
        .filter((character) => first || character.value !== options.first)
        .map(
          (character) => html`
            <md-select-option value=${character.value}>
              ${
                character.image
                  ? html`
                      <img slot="start" src=${character.image} alt="" width="24" height="24" />
                    `
                  : nothing
              }
              <span slot="headline">${character.label}</span>
            </md-select-option>
          `,
        )}
    </md-outlined-select>
  `;
  return html`
    <section class="character-pair" aria-label=${uiText(options.locale, "characters")}>
      ${choices(true)}
      ${iconButton({ icon: "swap_horiz", label: uiText(options.locale, "swap"), disabled: !options.second || !options.onSwap, onClick: () => options.onSwap?.() })}
      ${choices(false)}
    </section>
  `;
}
