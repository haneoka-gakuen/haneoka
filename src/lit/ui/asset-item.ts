import { html, nothing } from "lit";
import { icon } from "./icon";
import { uiText } from "../shared/catalog";
import "../../styles/tools.css";

export function assetKindIcon(kind: string) {
  return kind === "image"
    ? "image"
    : kind === "audio"
      ? "graphic_eq"
      : kind === "video"
        ? "movie"
        : kind === "model"
          ? "view_in_ar"
          : kind === "text"
            ? "code"
            : "draft";
}
export function assetKindText(kind: string, locale: string) {
  return uiText(
    locale,
    `navigation.asset${({ image: "Images", audio: "Audio", video: "Video", model: "Models", text: "Data" } as Record<string, string>)[kind] ?? "Other"}`,
  );
}

export function assetItem(options: {
  name: string;
  image: string;
  icon: string;
  meta: unknown;
  selected?: boolean;
  referrerPolicy?: ReferrerPolicy;
  role?: "tab";
  controls?: string;
  tabIndex?: number;
  onOpen(): void;
}) {
  return html`
    <button
      class=${`asset-item${options.selected ? " is-selected" : ""}`}
      title=${options.name}
      role=${options.role || nothing}
      aria-selected=${options.role ? String(Boolean(options.selected)) : nothing}
      aria-controls=${options.controls || nothing}
      tabindex=${options.tabIndex ?? nothing}
      @click=${options.onOpen}
    >
      <span class="asset-item__media">
        ${
          options.image
            ? html`
                <img
                  src=${options.image}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  referrerpolicy=${options.referrerPolicy || nothing}
                />
              `
            : icon(options.icon, 24)
        }
      </span>
      <span class="asset-item__name md-body-medium">${options.name}</span>
      <span class="asset-item__meta md-body-small">${options.meta}</span>
    </button>
  `;
}
