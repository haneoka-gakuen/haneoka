import { html, nothing } from "lit";
import type { SongPerformer } from "../../lib/song-performer";
import { catalogPortraitStack } from "./catalog-relationships";

/** Band logos and source-qualified portraits use the existing snapshot avatar composition. */
export function songPerformerAdornment(
  value: SongPerformer,
  imageForLocale: (image: string) => string = (image) => image,
) {
  return html`
    ${value.logos.map(
      (logo) => html`
        <img src=${imageForLocale(logo.image)} alt="" loading="lazy" decoding="async" />
      `,
    )}${
      value.portraits.length
        ? catalogPortraitStack(value.portraits.map((p) => ({ ...p, image: imageForLocale(p.image) })))
        : nothing
    }
  `;
}
