import { nothing } from "lit";
import type { SongPerformer } from "../../lib/song-performer";
import { catalogPortraitStack } from "./catalog-relationships";

/** Round band emblems and source-qualified portraits share one avatar composition. */
export function songPerformerAdornment(
  value: SongPerformer,
  imageForLocale: (image: string) => string = (image) => image,
) {
  const images = [...value.logos.map((logo) => ({ ...logo, key: `band:${logo.id}` })), ...value.portraits];
  return images.length
    ? catalogPortraitStack(images.map((image) => ({ ...image, image: imageForLocale(image.image) })))
    : nothing;
}
