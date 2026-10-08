import { html } from "lit";
import { resolveLocalizedText } from "../../lib/localized-text";
import { localizedText } from "../shared/catalog";
import { modelPreviewSources } from "../../lib/model-artwork";
export { modelPreviewSources } from "../../lib/model-artwork";
import { tile } from "./tile";
import { icon } from "./icon";
import { nextImageCandidate } from "./lazy-images";
import "../../styles/model-tile.css";

type Model = Record<string, unknown>;
export function modelTitle(model: Model, locale: string) {
  return resolveLocalizedText(model.title || model.live2dName || model.characterName || model.live2dKey || "", locale);
}
export function subCharacterLabel(key: string) {
  return key
    .replace(/^sub_/, "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
export function modelTile(options: {
  model: Model;
  character?: Model;
  locale: string;
  href?: string;
  onOpen?: () => void;
  serverMark?: { image: string; label: string };
}) {
  const { model, character, locale } = options;
  const title = modelTitle(model, locale);
  const images = modelPreviewSources(model);
  const face = String(character?.faceImage || model.faceImage || "");
  return tile({
    kind: "model",
    title: title.text,
    titleLanguage: title.locale,
    subtitle:
      localizedText(model.characterName || character?.characterName, locale) ||
      subCharacterLabel(String(model.characterKey || "")) ||
      String(model.live2dKey || ""),
    adornment: face
      ? html`
          <img src=${face} alt="" width="16" height="16" loading="lazy" />
        `
      : undefined,
    label: title.text,
    image: images[0] || "",
    imageCandidates: images,
    aspectRatio: 1,
    placeholder: icon("animation", 32),
    natural: false,
    fit: "cover",
    href: options.href,
    serverMark: options.serverMark,
    onOpen: options.onOpen,
    onImageError: nextImageCandidate,
  });
}
