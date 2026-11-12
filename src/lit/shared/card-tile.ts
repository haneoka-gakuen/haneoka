import { html } from "lit";
import { icon } from "../ui/icon";
import type { TileOptions } from "../ui/tile";
import { cardGrowth, type CardGrowth } from "./card-growth";

/** Catalogue card anatomy: native marks and character faces belong to the tile. */
export function cardTile(options: {
  kind: "member" | "support";
  title: string;
  titleLanguage?: string;
  subtitle: unknown;
  label: string;
  image: string;
  attributeIcon: string;
  attributeLabel: string;
  rarityIcon: string;
  rarityLabel: string;
  avatars?: ReadonlyArray<{ image: string; name: string }>;
  adornment?: unknown;
  growth?: CardGrowth;
}): TileOptions {
  return {
    kind: options.kind,
    title: options.title,
    titleLanguage: options.titleLanguage,
    subtitle: options.subtitle,
    label: options.label,
    image: options.image,
    fit: "contain",
    placeholder: icon("image", 32),
    mediaOverlay: options.growth ? cardGrowth(options.growth) : undefined,
    adornment:
      options.adornment ??
      html`
        <span class="avatar-stack">
          ${(options.avatars ?? [])
            .filter((avatar) => avatar.image)
            .slice(0, 5)
            .map(
              (avatar) => html`
                <img src=${avatar.image} alt=${avatar.name} loading="lazy" decoding="async" />
              `,
            )}
        </span>
      `,
    marks: [
      options.attributeIcon
        ? { at: "start", image: options.attributeIcon, label: options.attributeLabel }
        : options.attributeLabel
          ? { at: "start", text: options.attributeLabel, label: options.attributeLabel }
          : null,
      options.rarityIcon
        ? { at: "end", image: options.rarityIcon, label: options.rarityLabel }
        : options.rarityLabel
          ? { at: "end", text: options.rarityLabel, label: options.rarityLabel }
          : null,
    ],
  };
}
