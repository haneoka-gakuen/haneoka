import { html, nothing } from "lit";
import { nextImageCandidate } from "./lazy-images";
import "../../styles/story-media.css";
export function storyCastMedia(characters: ReadonlyArray<{ name: string; image: string }>, background = "") {
  return html`
    <span class=${`story-cast-media ${background ? "story-cast-media--home" : ""}`}>
      ${
        background
          ? html`
              <img class="story-cast-media__background" data-src=${background} alt="" @error=${nextImageCandidate} />
            `
          : nothing
      }
      <span class="story-cast-media__people">
        ${characters.map(
          (character) => html`
            <span title=${character.name}>
              ${
                character.image
                  ? html`
                      <img data-src=${character.image} alt=${character.name} @error=${nextImageCandidate} />
                    `
                  : html`
                      <span>${character.name}</span>
                    `
              }
            </span>
          `,
        )}
      </span>
    </span>
  `;
}
