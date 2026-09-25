/**
 * The song tile, built once.
 *
 * The catalogue screen and the home page's latest-songs grid show the same
 * object; this module is that tile's single construction, so the two can
 * never drift apart in anatomy or styling. Callers supply their own data
 * access (band lookup, marks map, localized text) and any extra marks —
 * home adds the release date, the catalogue adds the genre.
 */

import { html, nothing } from "lit";
import type { TemplateResult } from "lit";
import type { TileMark, TileOptions } from "../ui/tile";

type Item = Record<string, unknown>;

export interface SongTileDeps {
  locale: string;
  /** The tile headline, already localized. */
  title(item: Item): { text: string; locale?: string };
  /** Jacket artwork source. */
  image(item: Item): string;
  /** Localized artist line for the subhead; a list joins into one line. */
  artist(item: Item): string | ReadonlyArray<string | TemplateResult> | TemplateResult;
  /** Localized band emblem, or "". */
  bandIcon(item: Item): string;
  /** Locale-resolved artwork URL. */
  imageForLocale(source: string): string;
  /** The live music-type emblem, or "". */
  attributeMark(item: Item): string;
  /** Localized attribute name for the emblem's label. */
  attributeLabel(item: Item): string;
}

const CARD_TYPE_SPRITES: Record<number, string> = {
  1: "CardType-Red.png",
  2: "CardType-Blue.png",
  3: "CardType-Green.png",
  4: "CardType-Yellow.png",
  5: "CardType-Purple.png",
};

/**
 * The live music-type emblem. The sprite atlas ships per-type icons, but the
 * atlas scan misses the blue one — the card-type emblem of the same colour is
 * the standing fallback, exactly as the catalogue renders it.
 */
export function liveMusicTypeMark(marks: Map<string, string>, musicType: unknown): string {
  const id = Number(musicType || 0);
  const primary = marks.get(`sp_icon_live_music_type_${id}.png`);
  if (primary) return primary;
  const fallback = CARD_TYPE_SPRITES[id];
  return (fallback && marks.get(fallback)) || "";
}

export function songTile(
  item: Item,
  deps: SongTileDeps,
  href: string,
  extraMarks: ReadonlyArray<TileMark | null | undefined> = [],
): TileOptions {
  const title = deps.title(item);
  const bandIcon = deps.bandIcon(item);
  const attribute = deps.attributeMark(item);
  return {
    kind: "song",
    title: title.text,
    titleLanguage: title.locale,
    subtitle: deps.artist(item) as string,
    adornment: bandIcon
      ? html`
          <img
            src=${deps.imageForLocale(bandIcon)}
            alt=""
            @error=${(event: Event) => {
              (event.currentTarget as HTMLImageElement).hidden = true;
            }}
          />
        `
      : nothing,
    label: title.text,
    image: deps.image(item),
    href,
    marks: [
      attribute ? { at: "start" as const, image: attribute, label: deps.attributeLabel(item) } : null,
      ...extraMarks,
    ],
  };
}
