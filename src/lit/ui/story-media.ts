import { html, nothing } from "lit";
import { nextImageCandidate } from "./lazy-images";
import "../../styles/story-media.css";
export function storyCastMedia(
  characters: ReadonlyArray<{ name: string; image: string }>,
  background = "",
  referrerPolicy?: ReferrerPolicy,
) {
  return html`
    <span class=${`story-cast-media ${background ? "story-cast-media--home" : ""}`}>
      ${
        background
          ? html`
              <img
                class="story-cast-media__background"
                data-src=${background}
                alt=""
                referrerpolicy=${referrerPolicy || nothing}
                @error=${nextImageCandidate}
              />
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
                      <img
                        data-src=${character.image}
                        alt=${character.name}
                        referrerpolicy=${referrerPolicy || nothing}
                        @error=${nextImageCandidate}
                      />
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

export function storyCardMedia(episode: Record<string, unknown>) {
  const thumbnails = episode.cardThumbnails as Record<string, unknown> | undefined;
  const images = episode.cardImages as Record<string, unknown> | undefined;
  const variants = ["normal", "trained"].flatMap((key) => {
    const image = String(thumbnails?.[key] || images?.[key] || (key === "normal" ? episode.cardImage || "" : ""));
    return image ? [{ image, fallback: String(images?.[key] || "") }] : [];
  });
  return variants.length
    ? html`
        <span class="story-card-media">
          ${variants.map(
      ({ image, fallback }) => html`
        <img data-src=${image} data-fallback=${fallback} alt="" decoding="async" @error=${nextImageCandidate} />
      `,
    )}
        </span>
      `
    : undefined;
}

export function storyThumbnailMedia(image: string, fallback = "") {
  return html`
    <img
      class="story-thumbnail"
      data-src=${image}
      data-fallback=${fallback}
      style="width:100%;height:auto;aspect-ratio:16/9;object-fit:fill"
      alt=""
      @error=${nextImageCandidate}
    />
  `;
}

export function storyEpisodeGroup(title: string, count: number, content: unknown) {
  return html`
    <section class="story-episode-group">
      <h3>
        ${title}
        <small>${count}</small>
      </h3>
      ${content}
    </section>
  `;
}
