import { html } from "lit";
import { resolveLocalizedText } from "../../lib/localized-text";
import { live2dModelName } from "../../lib/model-name";
import { localizedText } from "../shared/catalog";
import { modelPreviewSources } from "../../lib/model-artwork";
export { modelPreviewSources } from "../../lib/model-artwork";
import { tile, type TileOptions } from "./tile";
import { uiText } from "../shared/catalog";
import { icon } from "./icon";
import { nextImageCandidate } from "./lazy-images";
import "../../styles/model-tile.css";

type Model = Record<string, unknown>;
export function modelTitle(model: Model, locale: string) {
  return resolveLocalizedText(live2dModelName(model), locale);
}
export function subCharacterLabel(key: string) {
  return key
    .replace(/^sub_/, "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
interface ModelTileOptions {
  model: Model;
  character?: Model;
  locale: string;
  href?: string;
  onOpen?: () => void;
  serverMark?: { image: string; label: string };
  referrerPolicy?: ReferrerPolicy;
}
export function modelTileOptions(options: ModelTileOptions): TileOptions {
  const { model, character, locale } = options;
  const title = modelTitle(model, locale);
  const images = modelPreviewSources(model);
  const face = String(character?.faceImage || model.faceImage || "");
  return {
    kind: "model",
    title: title.text,
    titleLanguage: title.locale,
    subtitle:
      localizedText(model.characterName || character?.characterName, locale) ||
      subCharacterLabel(String(model.characterKey || "")) ||
      String(model.live2dKey || ""),
    adornment: face
      ? html`
          <img
            src=${face}
            alt=""
            width="16"
            height="16"
            loading="lazy"
            referrerpolicy=${options.referrerPolicy || ""}
          />
        `
      : undefined,
    label: title.text,
    image: images[0] || "",
    imageCandidates: images,
    referrerPolicy: options.referrerPolicy,
    aspectRatio: 1,
    placeholder: icon("animation", 32),
    natural: false,
    fit: "cover",
    href: options.href,
    serverMark: options.serverMark,
    onOpen: options.onOpen,
    onImageError: nextImageCandidate,
  };
}
export function modelTile(options: ModelTileOptions) {
  return tile(modelTileOptions(options));
}
export function spineModelTitle(model: Model, locale: string) {
  return (
    String(model.sourcePathKey || model.id || uiText(locale, "navigation.spine"))
      .split("/")
      .at(-1)
      ?.replace(/_SkeletonData(?:\.asset)?$/i, "") || String(model.id)
  );
}
export function spineModelFamily(value: unknown, locale: string) {
  const family = String(value || "");
  return family === "home-spot" ? uiText(locale, "media.spine.families.homeSpot") : family || "—";
}
export function spineTileOptions(options: ModelTileOptions): TileOptions {
  const { model, locale } = options;
  const title = spineModelTitle(model, locale);
  return {
    kind: "model",
    title,
    subtitle: spineModelFamily(model.family || model.spineVersion || "Spine", locale),
    label: title,
    image: String((model.preview as Model | undefined)?.url || ""),
    placeholder: icon("animation", 32),
    fit: "contain",
    serverMark: options.serverMark,
    referrerPolicy: options.referrerPolicy,
    onOpen: options.onOpen,
  };
}
